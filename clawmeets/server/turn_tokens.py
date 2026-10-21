# SPDX-License-Identifier: BUSL-1.1
"""Turn tokens: the credential a scoped turn's model gets instead of the
agent's full token.

A runner about to run a requester or project turn asks for one
(``POST /agents/{id}/turn-tokens``, with the agent's FULL token, from a
connection that currently advertises ``isolated_turns.v1``). The server, not
the runner, decides which projects the token covers (``allowed_project_ids``):
for a requester turn every project of this agent with the same
``requester_key``; for a project turn the one project. The token is a JWT
signed with the server's secret and bound to a grant row; the grant lasts the
agent's invoke timeout plus ten minutes and is revoked by the runner when the
turn ends. A revoked or expired grant kills the token, whatever its ``exp``.

The same grant id rides every write the runner's action executor makes during
that turn (``X-Clawmeets-Turn-Grant``); the isolation gate accepts a reply,
message ack or file write in an isolated project only with a live grant for
that project (``server/isolation_gate.py``).

Turn tokens are accepted only on ``TURN_TOKEN_ROUTES`` (read routes of the
granted projects). Everywhere else they get ``turn_scope`` [403] from
``TurnTokenMiddleware``, before any route runs, so a route added later is
closed to them by default.
"""
from __future__ import annotations

import re
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import jwt
from starlette.responses import JSONResponse

from clawmeets.models.project import Project, scope_key
from clawmeets.utils import invoke_timeout

if TYPE_CHECKING:
    from clawmeets.models.agent import Agent
    from clawmeets.models.context import ModelContext

TURN_TOKEN_TYPE = "turn"
GRANT_HEADER = "X-Clawmeets-Turn-Grant"
#: Added to the agent's invoke timeout, so a long turn's last replies are not
#: refused. Revocation at turn end keeps the longer window from widening exposure.
GRANT_SLACK_SECONDS = 600

#: (method, path pattern) pairs a turn token may call. ``{project_id}`` must be
#: one of the grant's projects. Read-only: a scoped turn writes through the
#: runner's action executor (full token + grant header), never directly.
TURN_TOKEN_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("GET", "/projects/{project_id}"),
    ("GET", "/projects/{project_id}/changelog"),
    ("GET", "/projects/{project_id}/chatrooms/{chatroom_name}/files"),
    ("GET", "/projects/{project_id}/chatrooms/{chatroom_name}/files/{filename:path}"),
    # A thread-scoped turn reads the remote agent's replies here, fenced.
    ("GET", "/api/hub/conversations/{project_id}/messages"),
})


def _route_regex(pattern: str) -> re.Pattern[str]:
    out = re.escape(pattern)
    out = out.replace(re.escape("{filename:path}"), "(?P<filename>.+)")
    out = re.sub(r"\\\{(\w+)\\\}", r"(?P<\1>[^/]+)", out)
    return re.compile(f"^{out}$")


_ROUTE_RES = [(m, _route_regex(p)) for m, p in TURN_TOKEN_ROUTES]


def match_turn_route(method: str, path: str) -> Optional[dict[str, str]]:
    """Path parameters when ``(method, path)`` is a turn-token route, else None."""
    for m, rx in _ROUTE_RES:
        if m == method:
            hit = rx.match(path)
            if hit:
                return hit.groupdict()
    return None


class TurnScopeError(Exception):
    """A turn token used outside its grant. Rendered as ``turn_scope`` [403]."""


@dataclass(frozen=True)
class TurnGrant:
    grant_id: str
    agent_id: str
    scope: str                      # "project" | "requester"
    project_id: str                 # the project the turn runs in
    allowed_project_ids: tuple[str, ...]
    expires_at: float
    token: str = ""

    def covers(self, project_id: str) -> bool:
        return project_id in self.allowed_project_ids


class TurnGrantStore:
    """Grant rows in a small SQLite file next to the server's data. Survives a
    restart, so a turn in flight across one keeps its grant, and a revoked
    grant stays revoked."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS turn_grants ("
            " grant_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, scope TEXT NOT NULL,"
            " project_id TEXT NOT NULL, allowed_project_ids TEXT NOT NULL,"
            " expires_at REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)"
        )

    def insert(self, grant: TurnGrant) -> None:
        with self._lock:
            self._db.execute(
                "DELETE FROM turn_grants WHERE expires_at < ?", (time.time() - 86400,),
            )
            self._db.execute(
                "INSERT INTO turn_grants VALUES (?, ?, ?, ?, ?, ?, 0)",
                (grant.grant_id, grant.agent_id, grant.scope, grant.project_id,
                 "\n".join(grant.allowed_project_ids), grant.expires_at),
            )

    def live(self, grant_id: str, *, now: Optional[float] = None) -> Optional[TurnGrant]:
        with self._lock:
            row = self._db.execute(
                "SELECT grant_id, agent_id, scope, project_id, allowed_project_ids, expires_at, revoked"
                " FROM turn_grants WHERE grant_id = ?", (grant_id,),
            ).fetchone()
        if row is None or row[6] or row[5] <= (now if now is not None else time.time()):
            return None
        return TurnGrant(
            grant_id=row[0], agent_id=row[1], scope=row[2], project_id=row[3],
            allowed_project_ids=tuple(p for p in row[4].split("\n") if p), expires_at=row[5],
        )

    def revoke(self, grant_id: str, agent_id: str) -> bool:
        with self._lock:
            cur = self._db.execute(
                "UPDATE turn_grants SET revoked = 1 WHERE grant_id = ? AND agent_id = ?",
                (grant_id, agent_id),
            )
        return cur.rowcount > 0

    def close(self) -> None:
        with self._lock:
            self._db.close()


def allowed_projects_for(
    agent: "Agent", project: Project, scope: str, model_ctx: "ModelContext",
) -> tuple[str, ...]:
    """The projects a turn token covers, computed here and never taken from
    the runner. Requester scope: every project this agent coordinates or takes
    part in whose ``requester_key`` equals this one's. Project scope: this one."""
    if scope == "project":
        return (project.id,)
    key = scope_key(project)
    if key is None:
        raise TurnScopeError("requester scope needs a project with a requester_key")
    out = [project.id]
    for other in Project.list_all(model_ctx):
        if other.id == project.id or scope_key(other) != key:
            continue
        if agent.id == other.coordinator_id or agent.id in other.participating_agents:
            out.append(other.id)
    return tuple(out)


class TurnTokenService:
    """Mints, verifies and revokes turn tokens."""

    def __init__(self, store: TurnGrantStore, secret: str, algorithm: str = "HS256") -> None:
        self._store = store
        self._secret = secret
        self._alg = algorithm

    @property
    def store(self) -> TurnGrantStore:
        return self._store

    def grant_seconds(self, agent: "Agent") -> int:
        settings = agent._load_card().get("local_settings") or {}
        return invoke_timeout.resolve(settings) + GRANT_SLACK_SECONDS

    def mint(self, agent: "Agent", project: Project, scope: str, model_ctx: "ModelContext",
             *, now: Optional[float] = None) -> TurnGrant:
        if scope not in ("project", "requester"):
            raise TurnScopeError(f"unknown scope {scope!r}")
        now = time.time() if now is None else now
        allowed = allowed_projects_for(agent, project, scope, model_ctx)
        grant_id = secrets.token_urlsafe(18)
        expires_at = now + self.grant_seconds(agent)
        token = jwt.encode(
            {"type": TURN_TOKEN_TYPE, "agent_id": agent.id, "gid": grant_id,
             "exp": int(expires_at) + 1},
            self._secret, algorithm=self._alg,
        )
        grant = TurnGrant(grant_id, agent.id, scope, project.id, allowed, expires_at, token)
        self._store.insert(grant)
        return grant

    def grant_for_token(self, token: str) -> Optional[TurnGrant]:
        """The live grant behind a turn token, or None for anything else
        (not a JWT, not a turn token, expired, revoked)."""
        try:
            claims = jwt.decode(token, self._secret, algorithms=[self._alg])
        except jwt.InvalidTokenError:
            return None
        if claims.get("type") != TURN_TOKEN_TYPE:
            return None
        grant = self._store.live(str(claims.get("gid") or ""))
        if grant is None or grant.agent_id != claims.get("agent_id"):
            return None
        return grant

    def looks_like_turn_token(self, token: str) -> bool:
        """True for any token that claims to be a turn token (signature
        checked, expiry not): used to answer ``turn_scope`` rather than a
        generic 401 when one is used where it does not belong."""
        try:
            claims = jwt.decode(token, self._secret, algorithms=[self._alg],
                                options={"verify_exp": False})
        except jwt.InvalidTokenError:
            return False
        return claims.get("type") == TURN_TOKEN_TYPE

    def live_grant(self, grant_id: str, agent_id: str) -> Optional[TurnGrant]:
        grant = self._store.live(grant_id)
        if grant is None or grant.agent_id != agent_id:
            return None
        return grant

    def revoke(self, grant_id: str, agent_id: str) -> bool:
        return self._store.revoke(grant_id, agent_id)


def turn_scope_response(message: str) -> JSONResponse:
    return JSONResponse(
        status_code=403, content={"detail": {"code": "turn_scope", "message": message}},
    )


class TurnTokenMiddleware:
    """ASGI middleware: a turn token reaches only ``TURN_TOKEN_ROUTES`` for
    its grant's projects. Every other request carrying one is answered
    ``turn_scope`` [403] here. A request without one passes untouched."""

    def __init__(self, app, service_getter) -> None:
        self.app = app
        self._service_getter = service_getter

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        service: Optional[TurnTokenService] = self._service_getter()
        token = None
        for name, value in scope.get("headers") or ():
            if name == b"authorization":
                raw = value.decode("latin-1")
                if raw.startswith("Bearer "):
                    token = raw[7:]
                break
        if service is None or not token or not service.looks_like_turn_token(token):
            return await self.app(scope, receive, send)
        grant = service.grant_for_token(token)
        if grant is None:
            return await turn_scope_response("turn token expired or revoked")(scope, receive, send)
        params = match_turn_route(scope.get("method", ""), scope.get("path", ""))
        if params is None:
            return await turn_scope_response(
                "a scoped turn may not call this route"
            )(scope, receive, send)
        if not grant.covers(params.get("project_id", "")):
            return await turn_scope_response(
                "this turn's token does not cover that project"
            )(scope, receive, send)
        scope.setdefault("state", {})["turn_grant"] = grant
        return await self.app(scope, receive, send)
