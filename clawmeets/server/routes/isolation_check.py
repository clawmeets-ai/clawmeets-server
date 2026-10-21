# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/isolation_check.py

Re-run an agent's isolation check on demand, inside its RUNNING process.

Whether an agent may take a stranger's conversation lives in memory in its
runner (``runner/turn_capability.IsolatedTurnsCapability``) and reaches the
server only through the capabilities its socket advertises. So a re-check is
asked of that runner, not run here or in a separate CLI process: the server
relays ``ISOLATION_RECHECK_REQUEST`` to the agent's newest socket, the runner
re-runs its start canaries without first withdrawing what it advertises, and
reports the result (it reports every check, start-up ones included). A pass
on an agent that could not isolate reconnects its socket with the capability,
which releases the held work (``SocketEvents.agent_connected``).

A check can take minutes (each step may take up to 300 s), so the start route
answers at once and ``GET`` is polled (``clawmeets agent isolation-check
--wait``, the Hub card's "Re-run check").

## Who may call what

- Start / read — the agent itself, its owner (user JWT) or the owner's
  assistant (``authorize_agent_self_or_credential``). A turn token is refused
  by ``TurnTokenMiddleware``: these routes are not on ``TURN_TOKEN_ROUTES``, so
  a stranger's conversation cannot start checks, each of which makes a real,
  paid model call.
- Report — the agent's own bearer token only.
"""
from __future__ import annotations

import secrets
import time
from typing import TYPE_CHECKING, Literal, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel, Field

from clawmeets.api.control import ControlEnvelope, ControlMessageType, IsolationRecheckRequestPayload
from clawmeets.api.turn_protocol import CHECK_KINDS, ISOLATION_RECHECK_CAPABILITY

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

#: A running request older than this is treated as lost (the runner died or
#: restarted mid-check): a new one may start. Above the canaries' worst case.
RUNNING_STALE_SECONDS = 15 * 60


class IsolationCheckResult(BaseModel):
    """What a runner reports after one check."""

    recheck_id: Optional[str] = Field(default=None, max_length=64)
    provider: str = Field(default="unknown", max_length=64)
    passed: bool
    kind: Optional[str] = Field(default=None, max_length=32)
    failures: list[str] = Field(default_factory=list, max_length=20)


class IsolationCheckStatus(BaseModel):
    state: Literal["running", "passed", "failed", "unknown"]
    recheck_id: Optional[str] = None
    provider: Optional[str] = None
    kind: Optional[str] = None
    failures: list[str] = Field(default_factory=list)
    checked_at: Optional[float] = None
    #: The server's own view: may this agent be handed a stranger's
    #: conversation right now (every live socket can isolate).
    isolated_turns: bool
    held_conversations: int
    runner_connected: bool


def _refusal(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, {"code": code, "message": message})


def create_isolation_check_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["isolation-check"])

    def _notice():
        gate = ctx.isolation_gate
        notice = getattr(gate, "notice", None) if gate is not None else None
        if notice is None:
            raise _refusal(503, "isolation_unavailable", "this server does not run isolated conversations")
        return notice

    def _status(agent_id: str) -> IsolationCheckStatus:
        notice = _notice()
        check = notice.check(agent_id)
        gate = ctx.isolation_gate
        return IsolationCheckStatus(
            state=check.state, recheck_id=check.recheck_id, provider=check.provider, kind=check.kind,
            failures=check.failures, checked_at=check.checked_at,
            isolated_turns=gate.can_serve(agent_id), held_conversations=notice.held_count(agent_id),
            runner_connected=ctx.ws_hub.is_connected(agent_id),
        )

    @router.post("/agents/{agent_id}/isolation-check", status_code=202)
    async def start_isolation_check(agent_id: str, authorization: str = Header(default="")):
        """Ask the agent's running process to re-run its isolation check."""
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        notice = _notice()
        newest = ctx.ws_hub.newest_connection(agent_id)
        if newest is None:
            raise _refusal(409, "agent_offline",
                           "the agent isn't running; start it (`clawmeets start`), which runs the check")
        _conn, info = newest
        if ISOLATION_RECHECK_CAPABILITY not in (info.get("capabilities") or ()):
            raise _refusal(409, "runner_too_old",
                           "the agent's runner is too old to re-run the check; update and restart it")
        check = notice.check(agent_id)
        now = time.time()
        if check.state == "running" and check.started_at is not None and now - check.started_at < RUNNING_STALE_SECONDS:
            return {"recheck_id": check.recheck_id, "state": "running", "already_running": True}
        recheck_id = secrets.token_hex(8)
        delivered = await ctx.ws_hub.send_to(agent_id, ControlEnvelope(
            type=ControlMessageType.ISOLATION_RECHECK_REQUEST,
            payload=IsolationRecheckRequestPayload(agent_id=agent_id, recheck_id=recheck_id),
        ))
        if not delivered:
            raise _refusal(409, "agent_offline", "the agent's runner disconnected; start it and try again")
        notice.start_check(agent_id, recheck_id, now)
        return {"recheck_id": recheck_id, "state": "running", "already_running": False}

    @router.get("/agents/{agent_id}/isolation-check", response_model=IsolationCheckStatus)
    async def get_isolation_check(agent_id: str, authorization: str = Header(default="")):
        """The last check the runner reported, plus the server's own view."""
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        return _status(agent_id)

    @router.post("/agents/{agent_id}/isolation-check/result")
    async def report_isolation_check(
        agent_id: str, body: IsolationCheckResult = Body(...), authorization: str = Header(default=""),
    ):
        """Runner-only: the outcome of one isolation check."""
        await ctx.auth.check_agent_token(agent_id, authorization)
        kind = body.kind if body.kind in CHECK_KINDS else None
        _notice().report_check(
            agent_id, recheck_id=body.recheck_id, provider=body.provider, passed=body.passed,
            kind=kind, failures=[f[:2000] for f in body.failures], now=time.time(),
        )
        return {"ok": True}

    return router
