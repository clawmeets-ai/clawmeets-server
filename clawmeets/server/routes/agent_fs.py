# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/agent_fs.py

An agent's home folder (its ``AGENT_DIR``), browsed and managed over HTTP and
carried out by the agent's OWN runner, wherever that runs.

The server never touches the folder: each request is authorized here, relayed
to the agent's most recently connected runner socket
(``server/home_fs_relay.py``, frames in ``api/fs_protocol.py``), and performed
there by ``runner/home_fs.py``, which owns every path and tier rule. This
module decides exactly one thing — WHO is asking, relative to the agent — and
passes it on as the caller kind.

## Endpoints

All take the home-relative path as the ``path`` query parameter (``""`` or
``"/"`` is the home folder itself).

=======  ==============================  ===================  =============================================
Method   Path                            Body                 Response
=======  ==============================  ===================  =============================================
GET      /agents/{id}/fs/list            —                    ``{path, tier, writable, truncated, entries[]}``
GET      /agents/{id}/fs/file            —                    ``{path, tier, writable, size, mtime,
                                                              is_text, text | null, content_b64 | null}``
GET      /agents/{id}/fs/download        —                    raw bytes, ``Content-Disposition: attachment``
PUT      /agents/{id}/fs/file            raw file bytes       ``{entry}`` (created or replaced, one file per
                                                              call — a multi-file upload is N calls)
POST     /agents/{id}/fs/folder          —                    ``{entry}``
DELETE   /agents/{id}/fs/entry           —                    ``{deleted: path}`` (file, link or folder)
=======  ==============================  ===================  =============================================

``entry`` / ``entries[]`` items: ``{name, type, size, mtime, tier, writable,
readable}``; ``writable`` / ``readable`` are for THIS caller. ``is_text`` is
true when the content decodes as UTF-8, and then ``text`` carries it;
otherwise ``content_b64`` does.

## Who may call

=====================================================  =========================
Credential                                             Caller kind / outcome
=====================================================  =========================
The agent's own bearer token                           ``self``
A user JWT of the agent's owner                        ``owner``
The owner's assistant agent's bearer (another agent)   ``assistant``
A user JWT of anyone else                              403 ``forbidden``
Any other agent's valid bearer (same owner or not)     403 ``forbidden``
Missing / invalid bearer                               401 ``unauthenticated``
Unknown agent id (or any id but the agent's own)       404 ``agent_not_found``
A hub stand-in id (``{fp}~{name}``), any credential    404 ``remote_agent``
=====================================================  =========================

A hub stand-in (a retained or messaged agent on another deployment) has no
runner here, so there is no folder to relay to; it is refused before any
credential check or relay, never left to time out. ``AgentResponse.
home_folder_browsable`` and ``RetainedAgent.home_folder_browsable`` tell the
browser when to offer the folder at all.

Decided with the existing helpers: ``Agent.verify_token`` for self (the check
``AuthService.authorize_agent_self_or_owner`` starts with), then
``AuthService.resolve_credential`` — the owner-or-their-assistant resolver
``authorize_agent_self_or_credential`` builds on — which also says WHICH hand
the credential came through, and ``AuthService.is_owner_assistant`` to confirm
an assistant bearer against the owner's recorded assistant link.

## Errors

Every failure is ``{"error": {"code", "message", "field": null,
"result_unknown"}, "detail": message}`` (``server/errors.error_envelope`` plus
the ``detail`` string the web client already reads). ``result_unknown`` is true
when a write / mkdir / delete got no answer but may have happened — it timed
out (code ``result_unknown``) or the runner disconnected mid-op (code
``agent_offline``) — so the client refreshes instead of reporting a failure.
Status by code:

======  ==========================================================================
Status  Codes
======  ==========================================================================
400     invalid_path, invalid_request, short_name, not_a_file, not_a_directory,
        too_deep
401     unauthenticated
403     forbidden, forbidden_secret, forbidden_owner_only, read_only, root_delete,
        symlink, hardlink, other_device, unsupported_entry, os_permission
404     agent_not_found, not_found, remote_agent
409     exists, not_empty, home_moved
413     too_large, request_too_large
429     busy
502     bad_reply, reply_too_large
503     agent_offline, runner_too_old
504     timeout, result_unknown (a write / mkdir / delete with no answer in time:
        it may have happened — refresh before retrying)
500     io_error, and any code not listed
======  ==========================================================================

## Audit

Every operation whose caller is not the agent itself appends one line to
``fs-audit/<owner_id>/<agent_id>.jsonl`` under the server data dir: when, who
(user id and/or agent id), caller kind, op, path, byte count and outcome code.
Never content. That covers the owner reading a secret file and the owner
writing into ``personal-skill-hub`` with no special case, and it covers
refusals: an attempt by another agent (``caller: "agent"``) or another user
(``caller: "user"``) is recorded with outcome ``forbidden`` in the TARGET
agent's log. A 401 (no identity to record) and a 404 (no agent to file it
under) are not.
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional
from urllib.parse import quote as _urlquote

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from clawmeets.api.fs_protocol import (
    FS_MAX_CONTENT_BYTES,
    TOO_LARGE,
    FsFileResult,
    b64encode,
)
from clawmeets.models.agent import Agent
from clawmeets.models.provenance import STAND_IN_SEPARATOR
from clawmeets.server.errors import error_envelope
from clawmeets.server.home_fs_relay import FsRelayError

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# Mirrors runner.home_fs.CallerKind values (the server does not import the
# runner's executor; the wire values are fs_protocol.FS_CALLERS).
OWNER, SELF, ASSISTANT = "owner", "self", "assistant"

# Agent ids are minted as ``secrets.token_hex(8)``. Anything with glob or path
# characters is refused before it reaches the participant store, whose lookups
# glob on ``*-{id}``.
_AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

HTTP_STATUS: dict[str, int] = {
    **dict.fromkeys(("invalid_path", "invalid_request", "short_name", "not_a_file",
                     "not_a_directory", "too_deep"), 400),
    "unauthenticated": 401,
    **dict.fromkeys(("forbidden", "forbidden_secret", "forbidden_owner_only", "read_only",
                     "root_delete", "symlink", "hardlink", "other_device",
                     "unsupported_entry", "os_permission"), 403),
    **dict.fromkeys(("agent_not_found", "not_found", "remote_agent"), 404),
    **dict.fromkeys(("exists", "not_empty", "home_moved"), 409),
    **dict.fromkeys(("too_large", "request_too_large"), 413),
    "busy": 429,
    **dict.fromkeys(("bad_reply", "reply_too_large"), 502),
    **dict.fromkeys(("agent_offline", "runner_too_old"), 503),
    **dict.fromkeys(("timeout", "result_unknown"), 504),
}


class FsHttpError(Exception):
    def __init__(self, code: str, message: str, *, result_unknown: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.result_unknown = result_unknown

    def response(self) -> JSONResponse:
        return error_response(self.code, self.message, result_unknown=self.result_unknown)


def error_response(code: str, message: str, *, result_unknown: bool = False) -> JSONResponse:
    body = error_envelope(code, message, None)
    body["error"]["result_unknown"] = result_unknown
    body["detail"] = message
    return JSONResponse(status_code=HTTP_STATUS.get(code, 500), content=body)


@dataclass(frozen=True)
class FsCaller:
    """The authorization decision for one request."""

    kind: str                       # OWNER | SELF | ASSISTANT ("agent" / "user": a refused caller, audit only)
    agent: Agent                    # the target agent
    owner_user_id: str              # the target agent's owner
    actor_user_id: Optional[str]    # the human, when the credential is a user's or their assistant's
    actor_agent_id: Optional[str]   # the agent whose token was presented (self / assistant)


def _content_disposition(name: str) -> str:
    """``attachment; filename="<ascii>"; filename*=UTF-8''<pct>`` — the same
    two-parameter form as the desk-todo attachment download, for the same
    reason: response headers are latin-1, so the ASCII fallback is what makes
    the header encodable and ``filename*`` is what carries the real name."""
    ascii_name = "".join(
        "_" if (ord(ch) > 126 or ord(ch) < 32 or ch in '"\\') else ch for ch in name
    ) or "file"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{_urlquote(name, safe='')}"


def create_agent_fs_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["agent-fs"])

    async def resolve_caller(
        request: Request, agent_id: str, op: str, path: str, authorization: str, x_agent_id: str,
    ) -> FsCaller:
        """Who is asking, relative to ``agent_id`` — or raise FsHttpError.
        A refusal of an identified caller is audited (``op`` / ``path`` are
        only for that line)."""

        def refused(target: Agent, kind: str, actor_user_id: Optional[str],
                    actor_agent_id: Optional[str]) -> None:
            audit(FsCaller(kind, target, target.registered_by, actor_user_id, actor_agent_id),
                  op, path, 0, "forbidden", request)

        if STAND_IN_SEPARATOR in (agent_id or ""):
            raise FsHttpError("remote_agent", "this agent runs on another deployment; "
                                              "its home folder cannot be browsed from here")
        if not _AGENT_ID_RE.match(agent_id or ""):
            raise FsHttpError("agent_not_found", "no such agent")
        agent = Agent.get(agent_id, ctx.model_ctx)
        # The store finds an agent by the suffix of its folder name, so a
        # trailing part of a hyphenated name plus the id ("wine-<id>") also
        # matches. Only the agent's own id names it here: otherwise the relay
        # (keyed by the real id) answers offline and the audit line lands in
        # a log named after the alias.
        if agent is None or not agent.registered_by or agent.card_id != agent_id:
            raise FsHttpError("agent_not_found", "no such agent")
        if not authorization.startswith("Bearer "):
            raise FsHttpError("unauthenticated", "missing bearer token")
        token = authorization[7:]

        # The agent itself.
        if Agent.verify_token(agent_id, token, ctx.model_ctx):
            return FsCaller(SELF, agent, agent.registered_by, None, agent_id)

        # A user session, or the owner's assistant acting with owner authority.
        try:
            user, acting = await ctx.auth.resolve_credential(authorization)
        except HTTPException:
            # Not a user and not anyone's assistant. If it is a valid token of
            # some OTHER agent, that agent is refused, not unauthenticated —
            # agents reach only their own home folder.
            if (
                x_agent_id
                and _AGENT_ID_RE.match(x_agent_id)
                and Agent.verify_token(x_agent_id, token, ctx.model_ctx)
            ):
                refused(agent, "agent", None, x_agent_id)
                raise FsHttpError("forbidden", "an agent can only reach its own home folder")
            raise FsHttpError("unauthenticated", "invalid or expired credentials")

        if agent.registered_by != user.id:
            refused(agent, "agent" if acting is not None else "user", user.id,
                    acting.id if acting is not None else None)
            raise FsHttpError("forbidden", "only the agent's owner can reach its home folder")
        if acting is None:
            return FsCaller(OWNER, agent, agent.registered_by, user.id, None)
        # ``resolve_credential`` recognizes an assistant by its name suffix;
        # require the owner's recorded assistant as well, so a worker that
        # merely ends in "-assistant" is not handed every peer's folder.
        if not ctx.auth.is_owner_assistant(acting):
            refused(agent, "agent", user.id, acting.id)
            raise FsHttpError("forbidden", "an agent can only reach its own home folder")
        if acting.id == agent_id:  # pragma: no cover - verify_token above answers this
            return FsCaller(SELF, agent, agent.registered_by, user.id, acting.id)
        return FsCaller(ASSISTANT, agent, agent.registered_by, user.id, acting.id)

    def audit(caller: FsCaller, op: str, path: str, nbytes: int, outcome: str, request: Request) -> None:
        if caller.kind == SELF or ctx.home_fs_relay is None:
            return
        ctx.home_fs_relay.audit(caller.owner_user_id, caller.agent.id, {
            "agent_name": caller.agent.name,
            "caller": caller.kind,
            "actor_user_id": caller.actor_user_id,
            "actor_agent_id": caller.actor_agent_id,
            "op": op,
            "path": path[:4096],
            "bytes": nbytes,
            "outcome": outcome,
            "ip": request.client.host if request.client else None,
        })

    async def run(
        request: Request,
        caller: FsCaller,
        op: str,
        path: str,
        content: Optional[bytes] = None,
    ):
        """Relay one authorized op and audit it. Returns the result or raises FsHttpError."""
        nbytes = len(content) if content is not None else 0
        relay = ctx.home_fs_relay
        if relay is None:  # pragma: no cover - create_app always sets it
            raise FsHttpError("agent_offline", "home-folder access is not available on this server")
        try:
            result = await relay.request(caller.agent.id, op, path, caller.kind, content)
        except FsRelayError as exc:
            audit(caller, op, path, nbytes, exc.code, request)
            raise FsHttpError(exc.code, exc.message, result_unknown=exc.result_unknown)
        except asyncio.CancelledError:
            # The HTTP client went away mid-request. The op may still run on
            # the runner, so it is recorded all the same.
            audit(caller, op, path, nbytes, "cancelled", request)
            raise
        if isinstance(result, FsFileResult):
            nbytes = result.size
        audit(caller, op, path, nbytes, "ok", request)
        return result

    async def read_body(request: Request) -> bytes:
        """The request body, refused past FS_MAX_CONTENT_BYTES without
        buffering more than that."""
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > FS_MAX_CONTENT_BYTES:
            raise FsHttpError(TOO_LARGE, f"files larger than {FS_MAX_CONTENT_BYTES} bytes cannot be uploaded")
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > FS_MAX_CONTENT_BYTES:
                raise FsHttpError(TOO_LARGE, f"files larger than {FS_MAX_CONTENT_BYTES} bytes cannot be uploaded")
            chunks.append(chunk)
        return b"".join(chunks)

    @router.get("/agents/{agent_id}/fs/list")
    async def fs_list(
        request: Request,
        agent_id: str,
        path: str = Query(default=""),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """One folder's entries (capped; ``truncated`` says when)."""
        try:
            caller = await resolve_caller(request, agent_id, "list", path, authorization, x_agent_id)
            result = await run(request, caller, "list", path)
        except FsHttpError as e:
            return e.response()
        return result.model_dump(exclude={"kind"})

    @router.get("/agents/{agent_id}/fs/file")
    async def fs_read(
        request: Request,
        agent_id: str,
        path: str = Query(default=""),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """One file's content and metadata, as text when it is UTF-8."""
        try:
            caller = await resolve_caller(request, agent_id, "read", path, authorization, x_agent_id)
            result = await run(request, caller, "read", path)
        except FsHttpError as e:
            return e.response()
        try:
            text: Optional[str] = result.content.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        body = result.model_dump(exclude={"kind"})
        body.update(
            is_text=text is not None,
            text=text,
            content_b64=None if text is not None else b64encode(result.content),
        )
        return body

    @router.get("/agents/{agent_id}/fs/download")
    async def fs_download(
        request: Request,
        agent_id: str,
        path: str = Query(default=""),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """One file's bytes, exactly, as an attachment."""
        try:
            caller = await resolve_caller(request, agent_id, "read", path, authorization, x_agent_id)
            result = await run(request, caller, "read", path)
        except FsHttpError as e:
            return e.response()
        name = result.path.rsplit("/", 1)[-1] or "file"
        return Response(
            content=result.content,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": _content_disposition(name),
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-store",
            },
        )

    @router.put("/agents/{agent_id}/fs/file")
    async def fs_write(
        request: Request,
        agent_id: str,
        path: str = Query(default=""),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Create or replace one file with the raw request body.

        Authorization runs BEFORE the body is read, so an unauthorized caller
        cannot make the server buffer an upload.
        """
        try:
            caller = await resolve_caller(request, agent_id, "write", path, authorization, x_agent_id)
            try:
                content = await read_body(request)
            except FsHttpError as e:
                audit(caller, "write", path, 0, e.code, request)
                raise
            result = await run(request, caller, "write", path, content)
        except FsHttpError as e:
            return e.response()
        return {"entry": result.entry.model_dump()}

    @router.post("/agents/{agent_id}/fs/folder")
    async def fs_mkdir(
        request: Request,
        agent_id: str,
        path: str = Query(default=""),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Make one folder (its parent must exist)."""
        try:
            caller = await resolve_caller(request, agent_id, "mkdir", path, authorization, x_agent_id)
            result = await run(request, caller, "mkdir", path)
        except FsHttpError as e:
            return e.response()
        return {"entry": result.entry.model_dump()}

    @router.delete("/agents/{agent_id}/fs/entry")
    async def fs_delete(
        request: Request,
        agent_id: str,
        path: str = Query(default=""),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Delete one file, link, or folder with everything in it."""
        try:
            caller = await resolve_caller(request, agent_id, "delete", path, authorization, x_agent_id)
            await run(request, caller, "delete", path)
        except FsHttpError as e:
            return e.response()
        return {"deleted": path}

    return router
