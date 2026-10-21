# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/oauth.py

Server-relayed MCP + skill OAuth callbacks.

The runner mints a Google consent URL and a one-shot ``state`` token, posts
them to ``POST /agents/{agent_id}/{mcps|skills}/{name}/auth-init``, and the
server pushes the URL to the agent's owner so they click it in their own
browser. Google then redirects the user to
``GET /oauth/{mcp,skill}/callback?state=&code=``, where the server matches
the state, dispatches an ``{MCP,SKILL}_AUTH_CODE`` envelope to the runner
over WebSocket, and renders a "you can close this tab" page.

Tokens never transit through the server: the runner exchanges the code for
access/refresh tokens locally and writes them to disk at mode 0600.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    McpAuthCodePayload,
    McpAuthUrlForUserPayload,
    SkillAuthCodePayload,
    SkillAuthUrlForUserPayload,
)
from clawmeets.models.agent import Agent

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


_SUCCESS_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>ClawMeets — MCP authorized</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:480px;
margin:80px auto;padding:0 20px;color:#222}h1{font-size:20px}</style></head>
<body><h1>Authorization complete</h1>
<p>You can close this tab. Your runner is finalizing the connection now.</p>
</body></html>"""

_EXPIRED_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>ClawMeets — link expired</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:480px;
margin:80px auto;padding:0 20px;color:#222}h1{font-size:20px}</style></head>
<body><h1>This authorization link has expired</h1>
<p>Re-trigger the install from the ClawMeets web UI to get a fresh link.</p>
</body></html>"""


class _AuthInitBody(BaseModel):
    state: str
    auth_url: str


def create_oauth_router(ctx: "ServerContext") -> APIRouter:
    """Create the MCP OAuth relay router."""
    router = APIRouter(tags=["oauth"])

    @router.post("/agents/{agent_id}/mcps/{mcp_name}/auth-init")
    async def auth_init(
        agent_id: str,
        mcp_name: str,
        body: _AuthInitBody = Body(...),
        authorization: str = Header(default=""),
    ):
        """Runner-only: register a pending OAuth state and notify the user.

        The runner authenticates with its own agent bearer token. We don't
        accept a user JWT here because the user has no business minting
        OAuth states on behalf of an agent.
        """
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        token = authorization[7:]
        if not Agent.verify_token(agent_id, token, ctx.model_ctx):
            raise HTTPException(403, "auth-init requires the agent's own bearer token")

        await ctx.oauth_state_store.add(body.state, agent_id, mcp_name, kind="mcp")

        owner_id = agent.registered_by
        if owner_id:
            envelope = ControlEnvelope(
                type=ControlMessageType.MCP_AUTH_URL_FOR_USER,
                payload=McpAuthUrlForUserPayload(
                    agent_id=agent_id,
                    agent_name=agent.name,
                    mcp_name=mcp_name,
                    auth_url=body.auth_url,
                    state=body.state,
                ),
            )
            delivered = await ctx.ws_hub.send_to(owner_id, envelope)
            if not delivered:
                # Owner not connected — the state still lives until it expires,
                # so a UI that subscribes when it next connects can pick it up.
                logger.info(
                    f"MCP_AUTH_URL_FOR_USER for {agent.name}/{mcp_name} pending: "
                    f"owner {owner_id[:8]} not connected"
                )

        return {"ok": True}

    @router.get("/oauth/mcp/callback")
    async def oauth_callback(
        code: Optional[str] = None,
        state: Optional[str] = None,
        error: Optional[str] = None,
    ):
        """Google's redirect target.

        Validates the one-shot ``state``, forwards the auth code to the
        runner over WebSocket, and renders a confirmation page. The runner
        does the actual code-for-tokens exchange locally; the server never
        sees any access/refresh tokens.
        """
        if error:
            logger.warning(f"OAuth callback returned error: {error}")
            return HTMLResponse(_EXPIRED_HTML, status_code=400)
        if not state or not code:
            return HTMLResponse(_EXPIRED_HTML, status_code=400)

        entry = await ctx.oauth_state_store.take(state)
        if entry is None:
            return HTMLResponse(_EXPIRED_HTML, status_code=400)

        envelope = ControlEnvelope(
            type=ControlMessageType.MCP_AUTH_CODE,
            payload=McpAuthCodePayload(
                agent_id=entry.agent_id,
                mcp_name=entry.name,
                state=state,
                code=code,
            ),
        )
        delivered = await ctx.ws_hub.send_to(entry.agent_id, envelope)
        if not delivered:
            logger.warning(
                f"OAuth callback: runner for agent {entry.agent_id[:8]} not "
                f"connected; cannot deliver MCP_AUTH_CODE for {entry.name}"
            )
            return HTMLResponse(_EXPIRED_HTML, status_code=503)

        return HTMLResponse(_SUCCESS_HTML)

    @router.post("/agents/{agent_id}/skills/{skill_name}/auth-init")
    async def skill_auth_init(
        agent_id: str,
        skill_name: str,
        body: _AuthInitBody = Body(...),
        authorization: str = Header(default=""),
    ):
        """Skill-rail sibling of ``auth_init``. Agent-only bearer auth."""
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        token = authorization[7:]
        if not Agent.verify_token(agent_id, token, ctx.model_ctx):
            raise HTTPException(403, "auth-init requires the agent's own bearer token")

        await ctx.oauth_state_store.add(body.state, agent_id, skill_name, kind="skill")

        owner_id = agent.registered_by
        if owner_id:
            envelope = ControlEnvelope(
                type=ControlMessageType.SKILL_AUTH_URL_FOR_USER,
                payload=SkillAuthUrlForUserPayload(
                    agent_id=agent_id,
                    agent_name=agent.name,
                    skill_name=skill_name,
                    auth_url=body.auth_url,
                    state=body.state,
                ),
            )
            delivered = await ctx.ws_hub.send_to(owner_id, envelope)
            if not delivered:
                logger.info(
                    f"SKILL_AUTH_URL_FOR_USER for {agent.name}/{skill_name} pending: "
                    f"owner {owner_id[:8]} not connected"
                )

        return {"ok": True}

    @router.get("/oauth/skill/callback")
    async def skill_oauth_callback(
        code: Optional[str] = None,
        state: Optional[str] = None,
        error: Optional[str] = None,
    ):
        """Skill-rail sibling of ``oauth_callback``."""
        if error:
            logger.warning(f"Skill OAuth callback returned error: {error}")
            return HTMLResponse(_EXPIRED_HTML, status_code=400)
        if not state or not code:
            return HTMLResponse(_EXPIRED_HTML, status_code=400)

        entry = await ctx.oauth_state_store.take(state)
        if entry is None:
            return HTMLResponse(_EXPIRED_HTML, status_code=400)
        if entry.kind != "skill":
            # State was minted for the MCP rail — wrong endpoint.
            return HTMLResponse(_EXPIRED_HTML, status_code=400)

        envelope = ControlEnvelope(
            type=ControlMessageType.SKILL_AUTH_CODE,
            payload=SkillAuthCodePayload(
                agent_id=entry.agent_id,
                skill_name=entry.name,
                state=state,
                code=code,
            ),
        )
        delivered = await ctx.ws_hub.send_to(entry.agent_id, envelope)
        if not delivered:
            logger.warning(
                f"Skill OAuth callback: runner for agent {entry.agent_id[:8]} not "
                f"connected; cannot deliver SKILL_AUTH_CODE for {entry.name}"
            )
            return HTMLResponse(_EXPIRED_HTML, status_code=503)

        return HTMLResponse(_SUCCESS_HTML)

    return router
