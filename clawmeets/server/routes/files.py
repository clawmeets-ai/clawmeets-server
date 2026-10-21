# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/files.py
File management routes.

Uses ModelContext for all file I/O. Files are written through the changelog
mechanism to ensure single-write semantics and consistent state across
all participants.
"""
from __future__ import annotations

import logging
import mimetypes
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Header, HTTPException, Request, Response

from clawmeets.api.retry_transport import IDEMPOTENCY_HEADER
from clawmeets.api.control import ChangelogUpdatePayload, ControlEnvelope, ControlMessageType
from clawmeets.models.agent import Agent
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project
from clawmeets.models.provenance import outside_author, owner_isolated_outside
from clawmeets.models.project_plan import (
    OWNER,
    PLAN_FILE,
    absorb_plan_upload,
    file_upload_refusal_note,
    publish_plan_state,
)
from clawmeets.server.isolation_gate import check_project_read
from clawmeets.server.turn_tokens import GRANT_HEADER
from clawmeets.sync.changelog import ChangelogEntryType, FilePayload
from clawmeets.utils.file_io import FileUtil

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# Reserved filenames that agents cannot upload or delete via the API.
# These are managed by the server and synced through special mechanisms.
RESERVED_FILENAMES = frozenset({
    "PARTICIPANTS.ndjson",  # Constructed from ROOM_CREATED entries with participant info
    "CHATS.ndjson",         # Message history (synced via messages API)
    "meta.json",            # Chatroom metadata (server-only, never synced)
})

# Cap a single file upload. File bytes are base64-inlined into the changelog
# (FilePayload.content_b64) and replayed by every participant runner, so an
# unbounded upload would bloat the changelog + WS fan-out. Default 25 MB
# (matches the gmail/mailbox attachment convention); override via
# CLAWMEETS_MAX_UPLOAD_BYTES. Media skills should emit short/compressed output
# to stay under this.
_DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def _max_upload_bytes() -> int:
    raw = os.environ.get("CLAWMEETS_MAX_UPLOAD_BYTES", "")
    try:
        val = int(raw)
        if val > 0:
            return val
    except (TypeError, ValueError):
        pass
    return _DEFAULT_MAX_UPLOAD_BYTES


def _check_upload_size(content: bytes, filename: str) -> None:
    limit = _max_upload_bytes()
    if len(content) > limit:
        raise HTTPException(
            413,
            f"file {filename!r} is {len(content)} bytes, exceeds the "
            f"{limit}-byte upload limit (raise CLAWMEETS_MAX_UPLOAD_BYTES "
            "to allow larger files)",
        )


def _validate_filename(filename: str, files_dir: Path) -> None:
    """Validate filename: check reserved names and path traversal.

    Args:
        filename: The filename to validate
        files_dir: The files directory to resolve against

    Raises:
        ValueError: If filename is reserved or contains path traversal
    """
    if filename in RESERVED_FILENAMES:
        raise ValueError(f"Cannot modify reserved filename: {filename!r}")
    file_path = (files_dir / filename).resolve()
    if not str(file_path).startswith(str(files_dir.resolve())):
        raise ValueError(f"Invalid filename: {filename!r}")


def _is_plan_file(filename: str) -> bool:
    """Is this upload the plan document?

    Case-**insensitive**, and that is not tidiness. On a case-insensitive
    filesystem — macOS, and every developer machine this runs on —
    ``plan.md`` and ``PLAN.md`` are the same bytes on disk, so an exact match
    would let an agent write ``plan.md``, sail past the interception on the
    ordinary file path, and **replace the whole document** with the funnel none
    the wiser. AC-2.8 is a property of the deployment, not of the string
    comparison.

    The cost on a case-sensitive filesystem is that ``shared-context`` cannot
    hold a *separate* file whose name differs from ``PLAN.md`` only in case.
    Nothing wants one, and the alternative is a bypass that depends on which
    machine the server booted on.

    A nested path (``sub/PLAN.md``) is a different file and is not intercepted:
    the plan lives at the room's root under exactly one name.
    """
    return filename.casefold() == PLAN_FILE.casefold()


async def _absorb_plan(
    project: Project,
    content: bytes,
    *,
    by: str,
    ctx: "ServerContext",
) -> dict:
    """§6.1's interception (D17, B11) — ``PLAN.md`` never reaches the ordinary
    file write, and **this path never returns 4xx from any identity** (AC-3.3).

    **Why the never-4xx rule is absolute here and nowhere else.** A worker's
    action set is ``["reply", "update_file"]`` and ``update_file`` names any file
    in any room it participates in; nothing in the worker contract tells it to
    write ``PLAN.md`` — it is told to *read* it — but nothing stopped it either,
    and **a rule enforced only in a prompt is not enforced.** This is where it
    becomes true. It cannot become true by refusing, because a failed action is
    swallowed and posted as a raw failure line into ``user-communication``
    (``api/action_executor.py:136-147``), which loses the write and shows the
    user a stack-shaped message. **So a write that is not allowed becomes notes,
    not an error.**

    ``absorb_plan_upload`` compares the incoming body to the current one section
    by section: from the keeper or the owner it applies **only the sections that
    differ**, so a whole-file upload cannot touch a section whose text it did not
    change; from any other agent it changes nothing and files one note ``to=user``
    per differing section, that section's incoming text as the proposal. Shorthand
    is extracted and notes survive on every path.

    **The one deliberate collision, resolved here.** §3.4 caps a plan body at
    512 KB and §10 requires the *plan routes* to answer ``413`` — but "never 4xx"
    and "413" cannot both hold on **this** path, because this path's caller is an
    agent action, not an API client that can read a status code. The cap wins on
    the routes; **never-4xx wins here**, and an upload the model refuses for any
    reason becomes a note on the user's desk saying so. Nothing is silently
    dropped and nothing is a stack trace in ``user-communication``.

    **No runner change.** The runner keeps emitting ``update_file`` exactly as it
    does today and never learns this exists.
    """
    runloop = await ctx.runloop_manager.get_or_create(project.id, project.name)
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        text = content.decode("utf-8", errors="replace")
    try:
        result = await absorb_plan_upload(
            project,
            text,
            by=by,
            ctx=ctx.model_ctx,
            runloop=runloop,
        )
    except Exception as exc:  # noqa: BLE001 — never 4xx; see the docstring
        logger.info(
            f"PLAN.md upload from {by!r} on project {project.id[:8]} was not "
            f"absorbed ({type(exc).__name__}: {exc}); filing it as a note"
        )
        note_ids: list[str] = []
        try:
            # NOT `add_note`: M2 made that door two-party (the user and the
            # coordinator), so filing this AS the uploading agent would be
            # refused for every specialist and swallowed by the `except` below
            # — the user would silently stop being told their upload bounced.
            # This is the plan layer speaking on the agent's behalf, which is
            # the same thing `file_conflict_note` already does for a refused
            # write. The rule did not move; the caller did.
            note_ids = await file_upload_refusal_note(
                project,
                ctx.model_ctx,
                by=by,
                comment=(
                    f"@{by} uploaded a {PLAN_FILE} that could not be applied: "
                    f"{exc}. The document is unchanged."
                ),
            )
        except Exception:  # noqa: BLE001 — a note that cannot be filed is still 2xx
            pass
        # A refused upload still moved the note count, so the projection the
        # gate reads has to move with it. Both exits publish; the publisher is
        # idempotent, so the one that changed nothing costs nothing.
        #
        # …and the push, for the reason `project_plans._sync` now has one: the
        # interception RETURNS HERE, above the `CHANGELOG_UPDATE` every
        # non-intercepted upload gets on the way out, so without this the
        # intercepted branch is strictly less-notified than the branch it
        # replaced and the refusal's notes sit unfetched.
        if await publish_plan_state(project, ctx.model_ctx, runloop):
            # Lazy, mirroring `project_plans._sync`'s import of the same helper:
            # `messages` cannot be imported at module scope here.
            from clawmeets.server.routes.messages import _broadcast_changelog

            await _broadcast_changelog(ctx, project, runloop.get_current_version())
        return {
            "status": "ok",
            "plan": {"absorbed": False, "note_ids": note_ids, "detail": str(exc)},
        }
    await _broadcast_plan_upload(project, ctx, by=by, result=result)
    return {
        "status": "ok",
        "plan": {
            "absorbed": bool(result.ok and not result.noop),
            "sections": list(result.sections),
            "note_ids": list(result.note_ids),
            "revision": result.revision,
            "sha": result.sha,
        },
    }


async def _broadcast_plan_upload(
    project: Project, ctx: "ServerContext", *, by: str, result
) -> None:
    """One ``PROJECT_PLAN_SYNC`` for an absorbed upload, and the ``meta.json``
    stamp beside it — the same pair every plan route emits, so an upload that
    moves the document is indistinguishable, to a client, from a write through
    ``PUT /plan``."""
    from clawmeets.api.control import ProjectPlanSyncPayload

    updated_at = datetime.now(UTC).isoformat()
    project.state().set_plan_updated_at(updated_at)
    runloop = await ctx.runloop_manager.get_or_create(project.id, project.name)
    moved = await publish_plan_state(project, ctx.model_ctx, runloop)
    envelope = ControlEnvelope(
        type=ControlMessageType.PROJECT_PLAN_SYNC,
        payload=ProjectPlanSyncPayload(
            project_id=project.id,
            action="write" if result.sections else "note",
            sections=list(result.sections),
            sha=result.sha,
            revision=result.revision,
            by_agent_name=by,
            updated_at=updated_at,
        ),
    )
    await ctx.ws_hub.broadcast_to_project(envelope, project)
    # The runner's half, same argument as the refusal exit above: an absorbed
    # upload returns before the router's own `CHANGELOG_UPDATE`.
    if moved:
        from clawmeets.server.routes.messages import _broadcast_changelog

        await _broadcast_changelog(ctx, project, runloop.get_current_version())


def _landed_upload_version(runloop, sender_id: str, request_key: str | None) -> int | None:
    """Version of the entry an earlier attempt of this upload already wrote.

    The retry of an upload whose first attempt landed but whose response
    the idempotency middleware never recorded (core died in between).
    """
    if not request_key:
        return None
    prior = runloop.find_recent_by_request_id(sender_id, request_key)
    return prior.version if prior is not None else None


def create_files_router(ctx: "ServerContext") -> APIRouter:
    """Create the files router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["files"])

    async def _gate_project_read(request: Request, project_id: str, chatroom_name: str,
                                 authorization: str, x_agent_id: Optional[str]) -> None:
        """The isolation gate on file download and listing. A caller limited
        to some rooms (the requester's own agent) gets 404 for any other, as
        if it did not exist."""
        if getattr(ctx, "isolation_gate", None) is None:
            return
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        rooms = await check_project_read(
            ctx, project, authorization=authorization, x_agent_id=x_agent_id,
            turn_grant=getattr(request.state, "turn_grant", None),
        )
        if rooms is not None and chatroom_name not in rooms:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

    @router.put("/projects/{project_id}/chatrooms/{chatroom_name}/files/{filename:path}")
    async def upload_file(
        project_id: str,
        chatroom_name: str,
        filename: str,
        request: Request,
        authorization: str = Header(default=""),
        source_version: int | None = None,
    ):
        """Upload or update a file in a chatroom."""
        # Get project and chatroom
        project = Project.get(project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(404, f"Project {project_id!r} not found")
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

        # Two auth modes share this endpoint:
        #   1. X-Agent-ID present -> classic agent upload (agent token, agent
        #      must be a chatroom participant; uploader = that agent).
        #   2. X-Agent-ID absent  -> owner upload via user JWT. The project's
        #      coordinator is recorded as the uploader so the FILE event sits
        #      cleanly inside the chatroom's participant model. Used by
        #      `clawmeets file upload --token <jwt>` to seed shared-context
        #      files (PRD.md, AUDIT_PROCEDURE.md, etc.) on a fresh project.
        agent_id = request.headers.get("X-Agent-ID")
        if agent_id:
            if agent_id not in room.participants:
                raise HTTPException(403, "Not a participant in this chatroom")
            await ctx.auth.check_agent_token(agent_id, authorization)
            if getattr(ctx, "isolation_gate", None) is not None:
                getattr(ctx, "isolation_gate", None).check_write(
                    project, agent_id=agent_id,
                    grant_id=request.headers.get(GRANT_HEADER),
                )
            uploader = Agent.get(agent_id, ctx.model_ctx)
            uploader_id = agent_id
            uploader_name = uploader.name if uploader is not None else agent_id
        else:
            user = await ctx.auth.get_current_user(authorization)
            if project.created_by != user.id:
                raise HTTPException(403, "Not authorized to upload to this project")
            coordinator = Agent.get(project.coordinator_id, ctx.model_ctx)
            if coordinator is None:
                raise HTTPException(500, "Project coordinator not found")
            if coordinator.id not in room.participants:
                raise HTTPException(
                    403,
                    "Project coordinator is not a participant in this chatroom",
                )
            uploader_id = coordinator.id
            uploader_name = coordinator.name

        # Validate filename using chatroom's files_dir
        try:
            _validate_filename(filename, room.files_dir)
        except ValueError as e:
            raise HTTPException(400, str(e))

        # Read file content
        content = await request.body()
        _check_upload_size(content, filename)

        # §6.1 (D17, B11): PLAN.md on shared-context is INTERCEPTED before the
        # write. Both auth modes above reach it — the agent's own name for an
        # agent upload, the OWNER token when the project's owner uploaded with
        # their JWT (the coordinator is only the changelog attribution, not the
        # identity that decides what may land). One branch, one filename, one
        # room; every other file falls straight through.
        if room.is_shared_context_room and _is_plan_file(filename):
            if agent_id and outside_author(project, agent_id, ctx.model_ctx) is not None:
                # Never-4xx is for the project's own agents. Another account's
                # agent seated here as an ``external`` member would file plan
                # notes that no inspection sees: refused.
                raise HTTPException(403, "Another account's agent cannot write this project's plan")
            return await _absorb_plan(
                project,
                content,
                by=uploader_name if agent_id else OWNER,
                ctx=ctx,
            )

        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)
        request_key = request.headers.get(IDEMPOTENCY_HEADER)
        prior_version = _landed_upload_version(runloop, uploader_id, request_key)
        if prior_version is not None:
            return {"status": "ok", "version": prior_version}

        # Determine entry type (CREATED vs UPDATED)
        file_exists = room.file_exists(filename)
        entry_type = (
            ChangelogEntryType.FILE_UPDATED
            if file_exists
            else ChangelogEntryType.FILE_CREATED
        )

        # Append to changelog and process through subscribers
        content_b64 = FileUtil.to_base64(content)
        sha256 = FileUtil.sha256(content)
        entry = await runloop.append(
            entry_type,
            FilePayload(
                chatroom_name=chatroom_name,
                filename=filename,
                content_b64=content_b64,
                sha256=sha256,
                from_participant_id=uploader_id,
                from_participant_name=uploader_name,
                client_request_id=request_key,
                outside_isolated=bool(agent_id) and owner_isolated_outside(project, uploader_id, ctx.model_ctx),
            ),
            source_version=source_version,
        )

        # Broadcast to all project participants
        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        return {"status": "ok", "version": entry.version}

    @router.put("/projects/{project_id}/chatrooms/{chatroom_name}/user-files/{filename:path}")
    async def upload_user_file(
        project_id: str,
        chatroom_name: str,
        filename: str,
        request: Request,
        authorization: str = Header(default=""),
    ):
        """Upload a file as a user (project owner)."""
        current_user = await ctx.auth.get_current_user(authorization)

        # Get project and chatroom
        project = Project.get(project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(404, f"Project {project_id!r} not found")
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

        # Verify user owns this project
        if project.created_by != current_user.id:
            raise HTTPException(403, "Not authorized to upload files to this project")

        # Validate filename using chatroom's files_dir
        try:
            _validate_filename(filename, room.files_dir)
        except ValueError as e:
            raise HTTPException(400, str(e))

        # Read file content
        content = await request.body()
        _check_upload_size(content, filename)

        # The same interception. §6.1's diff names only `upload_file`, but this
        # route is a SECOND generic writer of any filename in any room, reachable
        # with the owner's JWT — so without this branch the owner could still
        # replace PLAN.md wholesale and AC-2.8's "none of them is a
        # whole-document writer" would be false on a path nobody listed.
        if room.is_shared_context_room and _is_plan_file(filename):
            return await _absorb_plan(project, content, by=OWNER, ctx=ctx)

        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)
        request_key = request.headers.get(IDEMPOTENCY_HEADER)
        prior_version = _landed_upload_version(runloop, current_user.id, request_key)
        if prior_version is not None:
            return {"status": "ok", "version": prior_version}

        # Determine entry type (CREATED vs UPDATED)
        file_exists = room.file_exists(filename)
        entry_type = (
            ChangelogEntryType.FILE_UPDATED
            if file_exists
            else ChangelogEntryType.FILE_CREATED
        )

        # Append to changelog and process through subscribers
        content_b64 = FileUtil.to_base64(content)
        sha256 = FileUtil.sha256(content)
        entry = await runloop.append(
            entry_type,
            FilePayload(
                chatroom_name=chatroom_name,
                filename=filename,
                content_b64=content_b64,
                sha256=sha256,
                from_participant_id=current_user.id,
                from_participant_name=current_user.username,
                client_request_id=request_key,
            ),
        )

        # Broadcast to all project participants
        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        return {"status": "ok", "version": entry.version}

    @router.get("/projects/{project_id}/chatrooms/{chatroom_name}/files/{filename:path}")
    async def download_file(
        request: Request,
        project_id: str,
        chatroom_name: str,
        filename: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """Download a file from a chatroom."""
        await _gate_project_read(request, project_id, chatroom_name, authorization, x_agent_id)
        # Check chatroom exists
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

        # Validate filename (path traversal check)
        try:
            file_path = (room.files_dir / filename).resolve()
            if not str(file_path).startswith(str(room.files_dir.resolve())):
                raise ValueError(f"Invalid filename: {filename!r}")
        except ValueError as e:
            raise HTTPException(400, str(e))

        # Read file content using model method
        content = room.get_file(filename)
        if content is None:
            raise HTTPException(404, f"File {filename!r} not found")

        mime_type, _ = mimetypes.guess_type(filename)
        if mime_type is None:
            mime_type = "application/octet-stream"
        return Response(content=content, media_type=mime_type)

    @router.get("/projects/{project_id}/chatrooms/{chatroom_name}/files")
    async def list_files(
        request: Request,
        project_id: str,
        chatroom_name: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """List files in a chatroom."""
        await _gate_project_read(request, project_id, chatroom_name, authorization, x_agent_id)
        # Check chatroom exists via metadata (not data dir which may not exist yet)
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

        # Return list of files using model method
        return room.list_files()  # Frontend expects string[] directly

    return router
