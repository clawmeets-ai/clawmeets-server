# SPDX-License-Identifier: BUSL-1.1
"""The serving-only rule (plan-owner-isolation section 5d, revision 3).

An owner-isolated agent's serving turns run without the ClawMeets sandbox,
so a visitor who hijacks one can read the agent's full token. While the
setting is STORED on (effective or not), a request made with that agent's own
token is allowed only on this allowlist; anything else is
``serving_only_agent`` [403]. It is an allowlist, so a route added later is
refused by default rather than allowed by accident.

Allowed:

* runner housekeeping on itself: ``/agents/{self}/…`` (socket helpers,
  heartbeat, status, in-flight turns, turn tokens, settings, env and skill
  answers; never deleting itself), read-only catalog and roster reads, and
  its own project list;
* inside one of its serving projects (scoped, coordinated by it):
  everything, under the turn-grant checks that already exist;
* inside its own owner DMs (``dm``, created by its owner, coordinated by it,
  no other agent in it): reads and posts, no file writes;
* revision 3: inside a project of its owner where it is a member, the same
  as any worker: read the project, read and post in the rooms it is a member
  of, and read and write those rooms' files. Never a room it is not in: the
  changelog it reads is cut to its own rooms (``member_room_scope``);
* ``POST /projects`` only with a live turn grant of one of its serving
  projects (the new project inherits that requester key).

Refused, in particular: creating projects otherwise, creating rooms,
inviting or adding agents, plan writes and project completion outside its
serving projects, DMs other than its own owner DMs, hub routes, SOP and to-do
publishing, and the home-folder relay to other agents.

A hijacked turn cannot widen this: the middleware keys on the token, not on
headers the caller chooses (``X-Agent-ID`` only narrows the lookup).
"""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING, Optional

from starlette.responses import JSONResponse

from clawmeets.models.agent import Agent
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project
from clawmeets.models.provenance import owner_isolated_home

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server.serving_only")

CODE = "serving_only_agent"
MESSAGE = "This agent runs without the ClawMeets sandbox, so it can only work in its own visitor conversations."

_SELF = re.compile(r"^/agents/(?P<agent>[^/]+)(?P<rest>/.*)?$")
_PROJECT = re.compile(r"^/projects/(?P<project>[^/]+)(?P<rest>/.*)?$")
_ROOM = re.compile(r"^/chatrooms/(?P<room>[^/]+)(?P<rest>/.*)?$")
_OWN_PROJECTS = re.compile(r"^/participants/(?P<agent>[^/]+)/projects$")
#: Read-only routes any runner reads during catch-up: rosters and catalogs.
_READS = re.compile(r"^/(agents|agents/search|agents/capabilities|auth/me|api/hub/retained"
                    r"|skills(/.*)?|mcps(/.*)?|knowledge-packs(/.*)?)$")
#: Inside a member room (revision 3): reads, posts and file writes.
_ROOM_WRITES = re.compile(r"^/(messages|files/.+)$")
#: Inside an owner DM: posts only.
_DM_WRITES = re.compile(r"^/messages$")


def refused(detail: str = MESSAGE) -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": {"code": CODE, "message": detail}})


def project_relation(model_ctx: "ModelContext", project: Project, agent: Agent) -> Optional[str]:
    """``serving`` | ``owner_dm`` | ``member`` | None for this agent."""
    home = owner_isolated_home(project, agent.id, model_ctx)
    if home is not None:
        return home
    if project.created_by != agent.registered_by:
        return None
    if agent.id in (project.participating_agents or []) or project.coordinator_id == agent.id:
        return "member"
    if member_rooms(model_ctx, project, agent):
        return "member"
    return None


def member_rooms(model_ctx: "ModelContext", project: Project, agent: Agent) -> frozenset[str]:
    """The rooms of ``project`` the agent is a participant of."""
    rooms = (Chatroom.get(project.id, name, model_ctx) for name in project.chatrooms)
    return frozenset(r.name for r in rooms if r is not None and agent.id in r.participants)


def member_room_scope(ctx: "ServerContext", project: Project, authorization: str) -> Optional[frozenset[str]]:
    """For a read route that returns every room's content (the changelog):
    the rooms the caller may see when the caller is an owner-isolated agent's
    own token on a project it is only a member of, else None (no cut)."""
    service = getattr(ctx, "owner_isolation", None)
    if service is None or not service.enabled_ids or not authorization.startswith("Bearer "):
        return None
    token = authorization[7:]
    if token.count(".") == 2:                       # a user or turn JWT
        return None
    agent = service.isolated_agent_for_token(token)
    if agent is None or project_relation(ctx.model_ctx, project, agent) != "member":
        return None
    return member_rooms(ctx.model_ctx, project, agent)


def allowed(model_ctx: "ModelContext", agent: Agent, method: str, path: str,
            grant_project_id: Optional[str]) -> bool:
    """The allowlist. ``grant_project_id``: the project of a live turn grant
    this request carries, or None."""
    if (m := _SELF.match(path)) and m["agent"] == agent.id:
        rest = m["rest"] or ""
        if not rest:
            return method == "GET"           # never edits, unpublishes or deletes itself
        return not rest.startswith("/owner-isolation")
    if method == "GET":
        if _READS.match(path) or ((m := _SELF.match(path)) and not m["rest"]):
            return True
        if (m := _OWN_PROJECTS.match(path)) and m["agent"] == agent.id:
            return True
    if path == "/projects" and method == "POST":
        return _is_serving(model_ctx, agent, grant_project_id)
    m = _PROJECT.match(path)
    if m is None:
        return False
    try:
        project = Project.get(m["project"], model_ctx)
    except ValueError:
        return True                          # the route answers 404 itself
    relation = project_relation(model_ctx, project, agent)
    rest = m["rest"] or ""
    if relation == "serving":
        return True
    if relation == "owner_dm":
        return method == "GET" or (method == "POST" and bool((r := _ROOM.match(rest))
                                                              and _DM_WRITES.match(r["rest"] or "")))
    if relation == "member":
        if method == "GET" and (rest in ("", "/changelog", "/chatrooms") or rest.startswith("/plan")):
            return True
        r = _ROOM.match(rest)
        if r is None:
            return False
        room = Chatroom.get(project.id, r["room"], model_ctx)
        if room is None or agent.id not in room.participants:
            return False
        sub = r["rest"] or ""
        return method == "GET" or (method in ("POST", "PUT") and bool(_ROOM_WRITES.match(sub)))
    return False


def _is_serving(model_ctx: "ModelContext", agent: Agent, project_id: Optional[str]) -> bool:
    if not project_id:
        return False
    try:
        project = Project.get(project_id, model_ctx)
    except ValueError:
        return False
    return project_relation(model_ctx, project, agent) == "serving"


class ServingOnlyMiddleware:
    """ASGI: holds an owner-isolated agent's own token to the allowlist."""

    def __init__(self, app, ctx_getter) -> None:
        self.app = app
        self._ctx_getter = ctx_getter

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        ctx: Optional["ServerContext"] = self._ctx_getter()
        service = getattr(ctx, "owner_isolation", None) if ctx is not None else None
        if service is None or not service.enabled_ids:
            return await self.app(scope, receive, send)
        token = grant_id = None
        for name, value in scope.get("headers") or ():
            if name == b"authorization":
                raw = value.decode("latin-1")
                token = raw[7:] if raw.startswith("Bearer ") else None
            elif name == b"x-clawmeets-turn-grant":
                grant_id = value.decode("latin-1")
        if not token or token.count(".") == 2:      # none, or a JWT (user or turn token)
            return await self.app(scope, receive, send)
        agent = service.isolated_agent_for_token(token)
        if agent is None:
            return await self.app(scope, receive, send)
        grant_project = None
        gate = getattr(ctx, "isolation_gate", None)
        if grant_id and gate is not None:
            grant = gate.turn_tokens.live_grant(grant_id, agent.id)
            grant_project = grant.project_id if grant is not None else None
        method, path = scope.get("method", ""), scope.get("path", "")
        if allowed(ctx.model_ctx, agent, method, path, grant_project):
            return await self.app(scope, receive, send)
        logger.info("serving_only_agent: %s %s refused for %s", method, path, agent.id[:8])
        return await refused()(scope, receive, send)
