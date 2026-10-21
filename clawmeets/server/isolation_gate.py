# SPDX-License-Identifier: BUSL-1.1
"""The isolation gate: an isolated project reaches an agent only through a
runner that can run an isolated turn, and is written to only from inside one.

``is_isolated(project)`` (a requester conversation, or a remote-content
project) means every turn on it must be sandboxed and scoped. The runner
enforces that, but a runner can be old, degraded or on a host with no
sandbox, and then it would run the turn with full powers. So the server
decides, keyed on the agent's CURRENT capability (``AgentCapabilityRegistry``:
the intersection across its live sockets, cleared on a provider change):

* **Every read path** that hands project content to an agent credential calls
  ``check_read`` / ``may_deliver``: the WS changelog fan-out, the changelog
  pull, file download and listing, the project list and detail, the
  participant project list, chatroom messages, the chatroom list and detail,
  the plan and the report. An incapable agent gets nothing: isolated projects
  are absent from its lists and direct reads answer ``isolation_unavailable``
  [409]. A capable one's full token reads only from the runner's own client,
  which sends ``X-Clawmeets-Isolation: v1`` (a CLI a full turn shells does
  not; ``turn_scope`` [403]). A turn token passes only for its grant's projects.
* **Writes** (a reply, a message ack, a file write) in an isolated project need
  ``X-Clawmeets-Turn-Grant`` naming a live grant of that agent that covers the
  project (``check_write``). Changelog-cursor and sync bookkeeping need none.
* **Held, not lost.** A withheld project is recorded (``held_work``) and
  replayed oldest first when a capable runner connects, a few per pass. One
  held past its ceiling (hub conversations 72 h; Front Desk and channel
  conversations 7 days) is closed with a note instead, never replayed.

Browser (user JWT) reads and writes are unaffected; nothing here runs for a
project that is not isolated.
"""
from __future__ import annotations

import asyncio
import contextvars
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import jwt
from fastapi import HTTPException

from clawmeets.api.turn_protocol import ISOLATION_HEADER, ISOLATION_HEADER_VALUE
from clawmeets.models.agent import Agent
from clawmeets.models.project import Project, is_isolated, scope_key
from clawmeets.server.agent_capabilities import ISOLATED_TURNS, AgentCapabilityRegistry
from clawmeets.server.turn_tokens import GRANT_HEADER, TurnGrant, TurnTokenService

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server.isolation_gate")

HUB_HELD_CEILING_S = 72 * 3600
OTHER_HELD_CEILING_S = 7 * 24 * 3600
#: Held projects replayed per pass; the rest wait for the next pass.
REPLAY_PER_PASS = 5
REPLAY_INTERVAL_S = 60.0
UNAVAILABLE_NOTE = (
    "The agent was unavailable: its computer could not run this conversation "
    "safely in time, so the request was closed."
)


#: This request's ``X-Clawmeets-Isolation`` value, set by
#: ``IsolationHeaderMiddleware`` so every read gate sees it without each route
#: threading the request through.
_isolation_header: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "isolation_header", default=None,
)
_ISOLATION_HEADER_RAW = ISOLATION_HEADER.lower().encode("latin-1")


class IsolationHeaderMiddleware:
    """ASGI middleware: record the request's ``X-Clawmeets-Isolation`` header
    for ``IsolationGate.check_read``."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        value = None
        for name, raw in scope.get("headers") or ():
            if name == _ISOLATION_HEADER_RAW:
                value = raw.decode("latin-1")
                break
        reset = _isolation_header.set(value)
        try:
            return await self.app(scope, receive, send)
        finally:
            _isolation_header.reset(reset)


def isolation_unavailable() -> HTTPException:
    return HTTPException(409, {
        "code": "isolation_unavailable",
        "message": "this agent's runner cannot run an isolated turn; the work is held",
    })


def turn_scope(message: str) -> HTTPException:
    return HTTPException(403, {"code": "turn_scope", "message": message})


async def check_project_read(
    ctx: "ServerContext",
    project: Project,
    *,
    authorization: str,
    x_agent_id: Optional[str] = None,
    turn_grant: Optional[TurnGrant] = None,
) -> Optional[frozenset[str]]:
    """``check_read`` for a route handler, a no-op when the server has no gate
    or the project is not isolated. An agent bearer that arrived without
    ``X-Agent-ID`` (the owner's assistant shelling ``--as-user``) is resolved to
    its agent first, so it is gated as that agent rather than refused 401.

    Returns the rooms the caller may read when that is narrower than the
    project (``requester_rooms``: the requester's own agent), else None. A
    route that reads one room's content, or all of them, applies it."""
    gate = getattr(ctx, "isolation_gate", None)
    if gate is None or not is_isolated(project):
        return None
    if not x_agent_id and turn_grant is None and not gate.is_user_jwt(authorization):
        try:
            _user, acting = await ctx.auth.resolve_credential(authorization)
        except HTTPException:
            acting = None
        x_agent_id = acting.id if acting is not None else None
    gate.check_read(project, authorization=authorization, x_agent_id=x_agent_id,
                    turn_grant=turn_grant)
    if turn_grant is not None or not x_agent_id or gate.is_user_jwt(authorization):
        return None
    agent = Agent.get(x_agent_id, ctx.model_ctx)       # check_read verified the token
    if agent is None or not serves_requester(agent, project):
        return None
    return requester_rooms(agent, project, ctx.model_ctx)


def requester_rooms(agent: Agent, project: Project, model_ctx) -> frozenset[str]:
    """The rooms of the requester's conversation that the requester's own
    agent reads: ``user-communication``, plus any room it was made a member
    of. The host's internal rooms (a coordinator's workroom with the host's
    workers, shared-context) are the host's, whatever the gate let through."""
    from clawmeets.models.chatroom import Chatroom

    rooms = {"user-communication"}
    for name in project.chatrooms:
        room = Chatroom.get(project.id, name, model_ctx)
        if room is not None and agent.id in room.participants:
            rooms.add(name)
    return frozenset(rooms)


def serves_requester(agent: Agent, project: Project) -> bool:
    """Is this agent the requester's own hand on the requester's conversation
    (another account's assistant reading its Front Desk thread)? Its credential
    resolves to the requester, so it reads as the requester's JWT does: the
    isolation gate exists for the HOST's runners, which run the turns. Only an
    agent of a different account than the project's owner qualifies."""
    from clawmeets.server.routes.projects import account_requester_key

    owner = agent.registered_by
    return bool(owner) and owner != project.created_by and (
        project.requester_key == account_requester_key(owner)
    )


def _outsider(agent: Agent, project: Project) -> bool:
    """Another account's agent with no part in this project."""
    return (
        agent.registered_by != project.created_by
        and agent.id not in project.participating_agents
        and not serves_requester(agent, project)
    )


def held_ceiling_seconds(project: Project) -> int:
    key = scope_key(project) or ""
    return HUB_HELD_CEILING_S if key.startswith("hub:") else OTHER_HELD_CEILING_S


class HeldWorkStore:
    """(agent, project, first held at) rows; survives a restart."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS held_work (agent_id TEXT NOT NULL, project_id TEXT NOT NULL,"
            " held_at REAL NOT NULL, PRIMARY KEY (agent_id, project_id))"
        )
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS isolation_notices (agent_id TEXT PRIMARY KEY,"
            " notified_at REAL NOT NULL)"
        )
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS isolation_sender_notes (agent_id TEXT NOT NULL,"
            " project_id TEXT NOT NULL, PRIMARY KEY (agent_id, project_id))"
        )

    def hold(self, agent_id: str, project_id: str, now: float) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO held_work VALUES (?, ?, ?)", (agent_id, project_id, now),
            )

    def held_for(self, agent_id: str) -> list[tuple[str, float]]:
        with self._lock:
            return list(self._db.execute(
                "SELECT project_id, held_at FROM held_work WHERE agent_id = ? ORDER BY held_at, project_id",
                (agent_id,),
            ))

    def release(self, agent_id: str, project_id: str) -> None:
        with self._lock:
            self._db.execute(
                "DELETE FROM held_work WHERE agent_id = ? AND project_id = ?", (agent_id, project_id),
            )

    def agents(self) -> list[str]:
        with self._lock:
            return [r[0] for r in self._db.execute("SELECT DISTINCT agent_id FROM held_work")]

    # ── isolation notices (server/isolation_notice.py) ───────────────────

    def claim_owner_notice(self, agent_id: str, now: float, every: float) -> bool:
        """True (and the time recorded) when no owner notice for this agent
        went out in the last ``every`` seconds: the caller sends one."""
        with self._lock:
            row = self._db.execute(
                "SELECT notified_at FROM isolation_notices WHERE agent_id = ?", (agent_id,),
            ).fetchone()
            if row is not None and now - row[0] < every:
                return False
            self._db.execute(
                "INSERT OR REPLACE INTO isolation_notices VALUES (?, ?)", (agent_id, now),
            )
            return True

    def claim_sender_note(self, agent_id: str, project_id: str) -> bool:
        """True the first time this project is held for this agent since it
        was last capable: the requester is told once per conversation."""
        with self._lock:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO isolation_sender_notes VALUES (?, ?)", (agent_id, project_id),
            )
            return cur.rowcount == 1

    def clear_notices(self, agent_id: str) -> None:
        """The agent can isolate again: a later failure notifies afresh."""
        with self._lock:
            self._db.execute("DELETE FROM isolation_notices WHERE agent_id = ?", (agent_id,))
            self._db.execute("DELETE FROM isolation_sender_notes WHERE agent_id = ?", (agent_id,))

    def close(self) -> None:
        with self._lock:
            self._db.close()


class IsolationGate:
    """Fan-out filter, read gate and grant check for isolated projects."""

    def __init__(
        self,
        model_ctx: "ModelContext",
        capabilities: AgentCapabilityRegistry,
        turn_tokens: TurnTokenService,
        held: HeldWorkStore,
        jwt_secret: str,
        jwt_algorithm: str = "HS256",
    ) -> None:
        self._model_ctx = model_ctx
        self.capabilities = capabilities
        self.turn_tokens = turn_tokens
        self.held = held
        self._jwt_secret = jwt_secret
        self._jwt_alg = jwt_algorithm
        self._server: Optional["ServerContext"] = None
        self._replay_tasks: dict[str, asyncio.Task] = {}
        #: Tells the owner and the requester when work is held because the
        #: agent cannot isolate (server/isolation_notice.py); None in tests
        #: that build a bare gate.
        self.notice = None

    def bind(self, server_ctx: "ServerContext") -> None:
        self._server = server_ctx

    # ------------------------------------------------------------- predicates

    def agent_capable(self, agent_id: str) -> bool:
        return self.capabilities.has(agent_id, ISOLATED_TURNS)

    def can_serve(self, agent_id: str) -> bool:
        """May this agent be handed serving work: its runners can sandbox the
        turn, or owner isolation is effective on the report its LIVE runner
        sent (plan-owner-isolation 5a), judged as a mint judges it, so work
        the mint would refuse is held here instead of failing there. A stored
        report from an earlier connection never counts."""
        if self.agent_capable(agent_id):
            return True
        service = getattr(self._server, "owner_isolation", None) if self._server is not None else None
        agent = Agent.get(agent_id, self._model_ctx) if service is not None else None
        return agent is not None and service.effective(agent, service.live_report(agent_id), at_mint=True)

    def may_deliver(self, participant_id: str, project: Project) -> bool:
        """May this participant be handed this project's content? Users always,
        and so do the requester's own agents (``serves_requester``); another
        account's agent that is not a participant never; the owner's agents only
        when the project is not isolated or they are capable. Only a refused
        participant is recorded as held: replay nudges toward a project, so a
        hold for anyone else would hand it a project it has no part in."""
        if not is_isolated(project):
            return True
        agent = Agent.get(participant_id, self._model_ctx)
        if agent is None:
            return True                       # a user (browser), not an agent
        if serves_requester(agent, project):
            return True
        if _outsider(agent, project):
            return False
        if self.can_serve(participant_id):
            return True
        if participant_id in project.participating_agents:
            self.held.hold(participant_id, project.id, time.time())
            if self.notice is not None:
                self.notice.on_held(participant_id, project)
        return False

    def is_user_jwt(self, authorization: str) -> bool:
        if not authorization.startswith("Bearer "):
            return False
        try:
            claims = jwt.decode(authorization[7:], self._jwt_secret, algorithms=[self._jwt_alg])
        except jwt.InvalidTokenError:
            return False
        return claims.get("type") == "access"

    def check_read(
        self,
        project: Project,
        *,
        authorization: str = "",
        x_agent_id: Optional[str] = None,
        participant_id: Optional[str] = None,
        turn_grant: Optional[TurnGrant] = None,
    ) -> None:
        """Raise unless the caller may read this project's content. No-op for a
        project that is not isolated."""
        if not is_isolated(project):
            return
        if turn_grant is not None:
            if not turn_grant.covers(project.id):
                raise turn_scope("this turn's token does not cover that project")
            return
        if self.is_user_jwt(authorization):
            return
        token = authorization[7:] if authorization.startswith("Bearer ") else ""
        agent_id = x_agent_id or participant_id
        if not token or not agent_id or not Agent.verify_token(agent_id, token, self._model_ctx):
            # An isolated project is never served to an unauthenticated caller,
            # even on routes that serve ordinary projects without credentials.
            raise HTTPException(401, "Missing or invalid credentials")
        if not self.may_deliver(agent_id, project):
            agent = Agent.get(agent_id, self._model_ctx)
            if agent is not None and _outsider(agent, project):
                raise HTTPException(403, "Not a participant in this project")
            raise isolation_unavailable()
        agent = Agent.get(agent_id, self._model_ctx)
        if (
            agent is not None and not serves_requester(agent, project)
            and _isolation_header.get() != ISOLATION_HEADER_VALUE
        ):
            # A capable agent's full token, but not from its runner's client:
            # a CLI shelled by a full turn, which must not read the project.
            raise turn_scope(f"an isolated project is read by the runner ({ISOLATION_HEADER})"
                             " or a turn token")

    def visible_to_agent(self, agent_id: str, project: Project) -> bool:
        """For project lists: is this project shown to this agent caller?"""
        return self.may_deliver(agent_id, project)

    def check_write(self, project: Project, *, agent_id: str, grant_id: Optional[str]) -> None:
        """Raise ``turn_scope`` unless an agent write into an isolated project
        carries a live grant of that agent covering it, and unless a write that
        carries a grant (any write of a restricted turn) stays inside that
        grant's projects. Callers have already authenticated ``agent_id``."""
        if not grant_id:
            if is_isolated(project):
                raise turn_scope(f"writes in an isolated project need {GRANT_HEADER}")
            return
        # A write made during a restricted turn stays inside that turn's
        # projects, isolated or not: a hub-thread turn cannot post elsewhere.
        grant = self.turn_tokens.live_grant(grant_id, agent_id)
        if grant is None or not grant.covers(project.id):
            raise turn_scope("no live turn grant covers this project")

    # ----------------------------------------------------------------- replay

    def schedule_replay(self, agent_id: str) -> None:
        """Start a replay loop for the agent if none is running."""
        task = self._replay_tasks.get(agent_id)
        if task is not None and not task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._replay_tasks[agent_id] = loop.create_task(self._replay_loop(agent_id))

    async def _replay_loop(self, agent_id: str) -> None:
        try:
            while await self.replay(agent_id):
                await asyncio.sleep(REPLAY_INTERVAL_S)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("isolation replay for %s failed", agent_id)

    async def replay(self, agent_id: str, *, now: Optional[float] = None) -> int:
        """One pass over the agent's held projects, oldest first. Expired ones
        are closed with a note; up to ``REPLAY_PER_PASS`` live ones get a
        changelog nudge. Returns how many remain held. Does nothing while the
        agent is incapable."""
        if self._server is None or not self.can_serve(agent_id):
            return 0
        now = time.time() if now is None else now
        sent = 0
        remaining = 0
        for project_id, held_at in self.held.held_for(agent_id):
            try:
                project = Project.get(project_id, self._model_ctx)
            except ValueError:
                self.held.release(agent_id, project_id)
                continue
            if now - held_at > held_ceiling_seconds(project):
                await self._close_expired(agent_id, project)
                self.held.release(agent_id, project_id)
                continue
            if sent >= REPLAY_PER_PASS:
                remaining += 1
                continue
            await self._nudge(agent_id, project)
            self.held.release(agent_id, project_id)
            sent += 1
        return remaining

    async def expire_while_incapable(self, agent_id: str, *, now: Optional[float] = None) -> int:
        """Close the agent's held projects that sat past their ceiling while
        it still cannot isolate. ``replay`` does this only for a capable
        agent, so without this an agent that keeps failing its check would
        hold its requesters past the ceiling with no closing note. Returns
        how many were closed."""
        if self._server is None or self.can_serve(agent_id):
            return 0
        now = time.time() if now is None else now
        closed = 0
        for project_id, held_at in self.held.held_for(agent_id):
            try:
                project = Project.get(project_id, self._model_ctx)
            except ValueError:
                self.held.release(agent_id, project_id)
                continue
            if now - held_at > held_ceiling_seconds(project):
                await self._close_expired(agent_id, project)
                self.held.release(agent_id, project_id)
                closed += 1
        return closed

    async def _nudge(self, agent_id: str, project: Project) -> None:
        from clawmeets.api.control import ChangelogUpdatePayload, ControlEnvelope, ControlMessageType

        server = self._server
        assert server is not None
        runloop = await server.runloop_manager.get_or_create(project.id, project.name)
        await server.ws_hub.send_to(agent_id, ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project.id, project_name=project.name,
                new_version=runloop.get_current_version(), coordinator_id=project.coordinator_id,
            ),
        ))

    async def close_expired_for_read(self, agent_id: str, project: Project,
                                     *, now: Optional[float] = None) -> None:
        """Before a capable agent pulls a held project: close it first when it
        sat past its ceiling, so the runner reads the closing note, not a
        stale request. Releases the hold either way."""
        now = time.time() if now is None else now
        for project_id, held_at in self.held.held_for(agent_id):
            if project_id != project.id:
                continue
            if now - held_at > held_ceiling_seconds(project):
                await self._close_expired(agent_id, project)
            self.held.release(agent_id, project_id)

    async def _close_expired(self, agent_id: str, project: Project) -> None:
        from clawmeets.server.timeout_checker import close_undelivered_work

        server = self._server
        assert server is not None
        for work in await server.work_tracker.get_all_pending_work():
            if work.project_id != project.id or agent_id not in work.timed_out_participants:
                continue
            await close_undelivered_work(
                server.work_tracker, server.runloop_manager, work, UNAVAILABLE_NOTE,
            )
        logger.info("isolation: closed held project %s for %s (past its ceiling)",
                    project.id[:8], agent_id[:8])
