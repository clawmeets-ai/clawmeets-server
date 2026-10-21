# SPDX-License-Identifier: BUSL-1.1
"""``/agents/{agent_id}/turn-tokens``: the runner asks for a scoped turn's
credential before it runs a requester or project turn, and revokes it when
the turn ends (server/turn_tokens.py).

Minting needs the agent's FULL token and an agent that currently advertises
``isolated_turns.v1`` on every live socket: a runner that cannot sandbox the
turn gets no token to hand it. The one exception is owner isolation
(plan-owner-isolation 5a): when the setting is effective against the host
report in the mint body, the answer is ``sandbox: "owner_isolated"`` and the
runner runs the turn unwrapped, still under the grant. The covered projects are computed here, never
taken from the request.
"""
from __future__ import annotations

import time

from typing import TYPE_CHECKING, Literal, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel

from clawmeets.models.agent import Agent
from clawmeets.models.project import Project, is_isolated
from clawmeets.server.isolation_gate import isolation_unavailable, turn_scope
from clawmeets.server.turn_tokens import TurnScopeError

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext


class TurnTokenRequest(BaseModel):
    project_id: str
    scope: Literal["project", "requester"]      # "project" kept for old runners
    #: This turn's fresh host report (plan-owner-isolation 5a). Only the report
    #: in the mint body counts for this turn; absent means "unreported".
    host: Optional[dict] = None


class TurnTokenResponse(BaseModel):
    token: str
    grant_id: str
    expires_at: float
    allowed_project_ids: list[str]
    #: How the runner must run this turn: in the OS sandbox, or unwrapped
    #: because the owner's own environment is the boundary and this mint's
    #: host report passed every check (plan-owner-isolation 5a).
    sandbox: Literal["required", "owner_isolated"] = "required"


def create_turn_tokens_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["turn-tokens"])

    @router.post("/agents/{agent_id}/turn-tokens", response_model=TurnTokenResponse)
    async def mint_turn_token(
        agent_id: str,
        body: TurnTokenRequest = Body(...),
        authorization: str = Header(default=""),
    ):
        await ctx.auth.check_agent_token(agent_id, authorization)
        gate = getattr(ctx, "isolation_gate", None)
        if gate is None:
            raise HTTPException(503, "isolation is not configured")
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        owner_isolation = getattr(ctx, "owner_isolation", None)
        report = None
        if owner_isolation is not None:
            from clawmeets.server.owner_isolation import parse_host_report

            report = parse_host_report(body.host)
            owner_isolation.observe(agent_id, report, live=False)
            exposed = owner_isolation.refuse_on_exposed_host(agent, report)
            if exposed:
                raise HTTPException(403, {"code": "host_exposed", "message": exposed})
        # Only the report in THIS mint body counts: none means the sandbox.
        mode = "required"
        if owner_isolation is not None and body.scope == "requester" \
                and owner_isolation.effective(agent, report, at_mint=True):
            mode = "owner_isolated"
        try:
            project = Project.get(body.project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {body.project_id!r} not found")
        if agent_id != project.coordinator_id and agent_id not in project.participating_agents:
            raise HTTPException(404, f"Project {body.project_id!r} not found")
        if not is_isolated(project):
            raise turn_scope("turn tokens are only for isolated projects")
        if mode == "required" and not gate.agent_capable(agent_id):
            # Held, not failed: replayed when the agent can serve again (a
            # clean report on reconnect), or closed past its ceiling.
            gate.held.hold(agent_id, project.id, time.time())
            raise isolation_unavailable()
        try:
            grant = gate.turn_tokens.mint(agent, project, body.scope, ctx.model_ctx)
        except TurnScopeError as exc:
            raise turn_scope(str(exc))
        if mode == "owner_isolated":
            owner_isolation.record_exposed(agent, report)
        return TurnTokenResponse(
            token=grant.token, grant_id=grant.grant_id, expires_at=grant.expires_at,
            allowed_project_ids=list(grant.allowed_project_ids), sandbox=mode,
        )

    @router.delete("/agents/{agent_id}/turn-tokens/{grant_id}")
    async def revoke_turn_token(
        agent_id: str,
        grant_id: str,
        authorization: str = Header(default=""),
    ):
        await ctx.auth.check_agent_token(agent_id, authorization)
        gate = getattr(ctx, "isolation_gate", None)
        if gate is None:
            raise HTTPException(503, "isolation is not configured")
        gate.turn_tokens.revoke(grant_id, agent_id)
        return {}

    return router
