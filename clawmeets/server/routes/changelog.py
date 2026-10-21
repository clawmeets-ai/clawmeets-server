# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/changelog.py
Changelog sync routes with server-side participant filtering.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Optional, Set

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from pydantic import TypeAdapter

from clawmeets.api.responses import ChangelogBatch
from clawmeets.models.project import Project, is_isolated
from clawmeets.server.isolation_gate import check_project_read
from clawmeets.server.serving_only import member_room_scope
from clawmeets.models.share_token import is_viewer
from clawmeets.sync.changelog import ChangelogEntry, ChangelogEntryType

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

#: Serialise inside the worker thread, like ``_LOG_ENTRIES_ADAPTER`` in
#: ``messages.py``. With ``content_b64`` inline a batch IS the file, so letting
#: FastAPI serialise on the event loop would put the biggest part of the work
#: back where it cannot be afforded.
_CHANGELOG_BATCH_ADAPTER = TypeAdapter(ChangelogBatch)

# Chatroom-lifecycle events describe structural state every mirror must enact
# (create/prune dirs), not membership-gated content. They must NEVER be dropped
# by the participant filter — otherwise a ROOM_DELETED is suppressed *because*
# the room is already gone from project.chatrooms (the server has rmtree'd it),
# so runners advance their version cursor past the delete without ever pruning
# their stale mirror. Room names are not sensitive, and the handlers on the
# runner side (_handle_room_deleted / _handle_room_created) are idempotent — a
# runner that never had the room no-ops; one that had it finally prunes/creates.
_LIFECYCLE_ALWAYS_PASS = frozenset({
    ChangelogEntryType.ROOM_DELETED,
    ChangelogEntryType.ROOM_CREATED,
})


def _compute_accessible_chatrooms(
    ctx: "ServerContext",
    project_id: str,
    participant_id: str,
) -> Set[str]:
    """Compute chatrooms accessible to a participant.

    Access rules:
    - Project owners see ALL chatrooms
    - Others see chatrooms where they're participants
    - Everyone sees __project__ (project-level events)

    Args:
        ctx: Server context
        project_id: The project ID
        participant_id: The participant ID to filter for

    Returns:
        Set of accessible chatroom names (always includes "__project__")
    """
    project = Project.get(project_id, ctx.model_ctx)
    if project is None:
        return {"__project__"}

    # Project owner sees all chatrooms
    if project.created_by == participant_id:
        return {"__project__"} | set(project.chatrooms)

    # Viewers see all chatrooms (read-only, enforced at write layer)
    if is_viewer(project_id, participant_id, ctx.model_ctx.participants_dir):
        return {"__project__"} | set(project.chatrooms)

    # Standard participants: chatrooms where they're members
    accessible_chatrooms = project.get_chatrooms_for_participant(participant_id)
    return {"__project__"} | {room.name for room in accessible_chatrooms}


def _filter_entries_for_participant(
    entries: list[ChangelogEntry],
    accessible_chatrooms: Set[str],
) -> list[ChangelogEntry]:
    """Filter entries to only those in accessible chatrooms.

    Room-lifecycle entries (ROOM_DELETED / ROOM_CREATED) always pass through —
    they are structural state every mirror must enact, not membership-gated
    content (see ``_LIFECYCLE_ALWAYS_PASS``).
    Project-level entries (no chatroom_name) always pass through.
    Chatroom-scoped entries must be in accessible_chatrooms.

    Args:
        entries: List of changelog entries
        accessible_chatrooms: Set of chatroom names the participant can access

    Returns:
        Filtered list of entries
    """
    result = []
    for entry in entries:
        # Lifecycle events bypass membership entirely — a ROOM_DELETED must
        # reach a runner even after the room is gone from its accessible set.
        if entry.entry_type in _LIFECYCLE_ALWAYS_PASS:
            result.append(entry)
            continue
        chatroom_name = getattr(entry.payload, 'chatroom_name', None)
        # Project-level entries (None) always pass; chatroom entries must match
        if chatroom_name is None or chatroom_name in accessible_chatrooms:
            result.append(entry)
    return result


async def _gate_read(ctx, project, request, authorization, x_agent_id, participant_id) -> Optional[frozenset[str]]:
    """The isolation gate on the changelog pull (what runner/resync.py calls on
    reconnect). For an isolated project: an incapable agent gets
    isolation_unavailable, and a capable one first has a held request that sat
    past its ceiling closed, so it reads the closing note, not stale work.
    Returns the rooms the caller is limited to (the requester's own agent on
    its Front Desk conversation), or None."""
    gate = getattr(ctx, "isolation_gate", None)
    if gate is None:
        return None
    grant = getattr(request.state, "turn_grant", None) if request is not None else None
    rooms = await check_project_read(
        ctx, project, authorization=authorization, x_agent_id=x_agent_id or participant_id,
        turn_grant=grant,
    )
    agent_id = x_agent_id or participant_id
    if grant is None and agent_id and is_isolated(project):
        await gate.close_expired_for_read(agent_id, project)
    return rooms


def create_changelog_router(ctx: "ServerContext") -> APIRouter:
    """Create the changelog router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["changelog"])

    @router.get("/projects/{project_id}/changelog", response_model=ChangelogBatch)
    async def get_changelog(
        request: Request,
        project_id: str,
        since: int = Query(0, description="Get entries after this version"),
        chatroom_names: Optional[str] = Query(None, description="Comma-separated chatroom names to filter"),
        participant_id: Optional[str] = Query(None, description="Filter to chatrooms accessible by this participant"),
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """Get changelog entries for a project.

        Returns entries with version > since.

        Filtering options (mutually exclusive, participant_id takes precedence):
        - participant_id: Filter to chatrooms the participant is a member of
        - chatroom_names: Filter to specific chatroom names (comma-separated)

        When participant_id is provided, the server computes which chatrooms
        the participant has access to based on chatroom membership, and only
        returns entries for those chatrooms.
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        scope = await _gate_read(ctx, project, request, authorization, x_agent_id, participant_id)
        # An owner-isolated agent working in an owner project reads its own
        # rooms only, whatever filter it asks for (plan-owner-isolation 5d).
        own_rooms = member_room_scope(ctx, project, authorization)
        if own_rooms is not None:
            scope = own_rooms if scope is None else scope & own_rooms

        # Get runloop for this project
        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)

        # **The one read here that cannot be made cheap.** `since >= tip` is now
        # a single stat, but a runner legitimately far behind needs the entries —
        # and while `FilePayload.content_b64` is inline, the response IS the
        # file. So read, filter AND serialise in one worker thread; a
        # single-process server must not stall every WebSocket handshake for it.
        def _build() -> bytes:
            entries = runloop.get_entries_since(since)

            # Apply participant-based filtering (takes precedence)
            if participant_id:
                accessible = _compute_accessible_chatrooms(
                    ctx, project_id, participant_id
                )
                filtered = _filter_entries_for_participant(entries, accessible)
                logger.debug(
                    f"Filtered changelog for participant {participant_id[:8]}: "
                    f"{len(filtered)} entries, accessible chatrooms: {len(accessible)}"
                )
            # Or apply explicit chatroom filter
            elif chatroom_names:
                chatroom_filter = set(c.strip() for c in chatroom_names.split(","))
                filtered = [
                    e for e in entries
                    if (chatroom := getattr(e.payload, 'chatroom_name', None)) is None or chatroom in chatroom_filter
                ]
            else:
                filtered = entries
            if scope is not None:
                # Whatever filter was asked for, never past the caller's rooms,
                # lifecycle entries included (a room's creation names its members).
                filtered = [e for e in filtered
                            if getattr(e.payload, "chatroom_name", None) in (None, *scope)]

            # AFTER the entries, so `to_version >= max(entry.version)` still
            # holds — the order the un-threaded version had.
            current_version = runloop.get_current_version()

            return _CHANGELOG_BATCH_ADAPTER.dump_json(
                ChangelogBatch(
                    project_id=project_id,
                    from_version=since,
                    to_version=current_version,
                    entries=filtered,
                ),
                by_alias=True,
            )

        # `response_model` stays on the decorator for the OpenAPI schema; a raw
        # Response bypasses its runtime validation, which is the point.
        return Response(content=await asyncio.to_thread(_build),
                        media_type="application/json")

    return router
