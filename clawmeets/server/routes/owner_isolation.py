# SPDX-License-Identifier: BUSL-1.1
"""``/agents/{agent_id}/owner-isolation``: the owner's "runs in its own
environment" switch (plan-owner-isolation sections 2 and 8).

Only the owner, with a user JWT, reads or changes it. Every agent token is
``user_only`` [403], the owner's assistant acting for the user included: an
agent must never be able to lift its own sandbox.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException

from clawmeets.models.agent import Agent
from clawmeets.server.hub.browser import (
    ClearHostRequest, HubError, OwnerIsolationRequest, OwnerIsolationStatus,
)
from clawmeets.server.owner_isolation import OwnerIsolationRefused

if TYPE_CHECKING:
    from clawmeets.models.user import User
    from clawmeets.server.context import ServerContext


def create_owner_isolation_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["owner-isolation"])

    def _is_agent_token(authorization: str, x_agent_id: Optional[str]) -> bool:
        if not authorization.startswith("Bearer "):
            return False
        token = authorization[7:]
        if x_agent_id and Agent.verify_token(x_agent_id, token, ctx.model_ctx):
            return True
        return any(Agent.verify_token(a.id, token, ctx.model_ctx)
                   for a in Agent.list_all(ctx.model_ctx, discoverable_only=False, include_private=True))

    async def _owned(agent_id: str, authorization: str, x_agent_id: Optional[str]) -> tuple["User", Agent]:
        """The owner (user JWT only) and their agent."""
        try:
            user = await ctx.auth.get_current_user(authorization)
        except HTTPException as exc:
            if exc.status_code == 401 and _is_agent_token(authorization, x_agent_id):
                raise HubError("user_only", "only the owner can change this, never an agent") from None
            raise
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None or agent.registered_by != user.id:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        return user, agent

    @router.get("/agents/{agent_id}/owner-isolation", response_model=OwnerIsolationStatus)
    async def get_owner_isolation(
        agent_id: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None),
    ):
        _, agent = await _owned(agent_id, authorization, x_agent_id)
        return ctx.owner_isolation.status(agent)

    @router.put("/agents/{agent_id}/owner-isolation", response_model=OwnerIsolationStatus)
    async def put_owner_isolation(
        agent_id: str,
        body: OwnerIsolationRequest = Body(...),
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None),
    ):
        _, agent = await _owned(agent_id, authorization, x_agent_id)
        if body.enabled and not body.acknowledged:
            raise HTTPException(422, "turning this on needs acknowledged: true")
        try:
            return await ctx.owner_isolation.set(agent, enabled=body.enabled)
        except OwnerIsolationRefused as exc:
            raise HubError("owner_isolation_refused",
                           "this agent cannot run without the ClawMeets sandbox yet",
                           refusals=exc.refusals) from None

    @router.post("/agents/{agent_id}/owner-isolation/clear-host", response_model=OwnerIsolationStatus)
    async def clear_exposed_host(
        agent_id: str,
        body: ClearHostRequest = Body(...),
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None),
    ):
        """The owner confirms the agent's environment was wiped: the owner's
        other agents may connect from it again (section 5e)."""
        _, agent = await _owned(agent_id, authorization, x_agent_id)
        if not body.acknowledged:
            raise HTTPException(422, "clearing needs acknowledged: true")
        return await ctx.owner_isolation.clear_host(agent)

    return router
