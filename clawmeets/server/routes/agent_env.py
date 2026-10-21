# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/agent_env.py

An agent's env vars, managed from its Agent Settings page and carried out by
the agent's OWN runner.

The store (``{agent_dir}/env.json``, see ``clawmeets/utils/env_store.py``)
lives on the runner's machine and nowhere else. The server never keeps a key
or a value: each request is relayed to the runner as an ``AGENT_ENV_REQUEST``
envelope, the runner performs it against the same store ``clawmeets env``
writes, and answers over HTTP with the resulting key NAMES. The browser
request is held open until that answer arrives (or a short timeout), so the
page gets a direct yes/no rather than polling.

## Who may call what

- List / set / unset — **user JWT only, agent owner only**. A secret typed into
  the browser is the user's own act; an agent that could write another agent's
  env would be an agent widening its own reach.
- Answer a request — **the agent's own bearer token**, for a request that was
  sent to that same agent.

The value of an ``env_set`` travels browser -> server -> runner exactly once.
It is never stored, logged, or returned; log lines and responses carry the key
alone.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel, Field

from clawmeets.api.control import (
    AgentEnvRequestPayload,
    ControlEnvelope,
    ControlMessageType,
)
from clawmeets.models.agent import Agent
from clawmeets.utils import env_store

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# How long a browser request waits for the runner. A store write is one small
# file; anything past this means the runner is wedged or mid-reconnect, and the
# page should say so rather than spin.
ENV_REQUEST_TIMEOUT_SECONDS = 15.0


class EnvRequestAnswer(BaseModel):
    """What the runner reports after performing one env request."""

    ok: bool = True
    detail: str = ""
    keys: list[str] = Field(default_factory=list)


def create_agent_env_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["agent-env"])

    # request_id -> (agent_id, future). In-memory and per-process, like the
    # websocket hub it rides on: a request outlives neither.
    pending: dict[str, tuple[str, asyncio.Future]] = {}

    async def _owned_agent(agent_id: str, authorization: str) -> Agent:
        user = await ctx.auth.get_current_user(authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None or agent.registered_by != user.id:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        return agent

    async def _relay(
        agent: Agent, action: str, key: Optional[str] = None, value: Optional[str] = None
    ) -> dict:
        """Send one request to the agent's runner and wait for its answer."""
        request_id = secrets.token_hex(8)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        pending[request_id] = (agent.id, future)
        try:
            delivered = await ctx.ws_hub.send_to(
                agent.id,
                ControlEnvelope(
                    type=ControlMessageType.AGENT_ENV_REQUEST,
                    payload=AgentEnvRequestPayload(
                        agent_id=agent.id,
                        request_id=request_id,
                        action=action,
                        key=key,
                        value=value,
                    ),
                ),
            )
            # Drop our reference as soon as it is on its way.
            del value
            if not delivered:
                raise HTTPException(
                    409,
                    f"{agent.name} isn't running, so its environment variables "
                    f"can't be reached. Start it, then try again.",
                )
            logger.info(
                f"Sent env {action!r}{f' key {key!r}' if key else ''} to agent {agent.name}"
            )
            try:
                answer: EnvRequestAnswer = await asyncio.wait_for(
                    future, ENV_REQUEST_TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                raise HTTPException(
                    504,
                    f"{agent.name} didn't answer within "
                    f"{int(ENV_REQUEST_TIMEOUT_SECONDS)} seconds. It may be out "
                    f"of date or restarting; try again shortly.",
                )
        finally:
            pending.pop(request_id, None)
        if not answer.ok:
            raise HTTPException(400, answer.detail or f"{agent.name} refused the change.")
        return {"keys": answer.keys}

    def _checked_key(key: str) -> str:
        try:
            env_store.validate_key(key)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return key

    @router.get("/agents/{agent_id}/env")
    async def list_env_keys(agent_id: str, authorization: str = Header(default="")):
        """Key NAMES in the agent's env-var store, read live from its runner."""
        agent = await _owned_agent(agent_id, authorization)
        return await _relay(agent, "list")

    @router.put("/agents/{agent_id}/env/{key}")
    async def set_env_var(
        agent_id: str,
        key: str,
        value: str = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Add or replace one key. The value is passed through, never kept."""
        agent = await _owned_agent(agent_id, authorization)
        _checked_key(key)
        if len(value.encode("utf-8")) > env_store.VALUE_MAX_BYTES:
            raise HTTPException(
                400, f"The value for {key} is over {env_store.VALUE_MAX_BYTES // 1024} KB."
            )
        return await _relay(agent, "set", key, value)

    @router.delete("/agents/{agent_id}/env/{key}")
    async def unset_env_var(
        agent_id: str, key: str, authorization: str = Header(default="")
    ):
        """Remove one key. Removing a key that isn't there is not an error."""
        agent = await _owned_agent(agent_id, authorization)
        _checked_key(key)
        return await _relay(agent, "unset", key)

    @router.post("/agents/{agent_id}/env/requests/{request_id}")
    async def answer_env_request(
        agent_id: str,
        request_id: str,
        body: EnvRequestAnswer = Body(...),
        authorization: str = Header(default=""),
    ):
        """Runner-only: the outcome of one ``AGENT_ENV_REQUEST``.

        A late answer (the browser already timed out) is accepted and dropped.
        """
        await ctx.auth.check_agent_token(agent_id, authorization)
        entry = pending.get(request_id)
        if entry is None:
            return {"ok": True, "delivered": False}
        owner_agent_id, future = entry
        if owner_agent_id != agent_id:
            raise HTTPException(403, "This request was not sent to this agent")
        if not future.done():
            future.set_result(body)
        return {"ok": True, "delivered": True}

    return router
