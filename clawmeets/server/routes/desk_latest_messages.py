# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/desk_latest_messages.py

My Desk card feed — the newest ``user-communication`` message (plus the files
that rode in with it) for many projects in ONE request.

Route (user JWT):

- ``GET /me/desk/latest-messages?project_ids=<id>,<id>,...`` →
  ``{"entries": {<project_id>: [ChatLogEntry, ...]}}``

The desk used to fetch each candidate room's entire message log (30 parallel
requests, several MB) just to read its last message. This returns only
``latest_message_slice`` per project. The log reads run in a worker thread so
a large batch never blocks the event loop.

Projects that are missing or not readable by the caller are silently omitted
(the client renders an omitted id exactly like an empty room). Readable means
owner or the requester of a Front Desk DM — the same rule the
per-room ``GET .../messages`` applies for a user JWT, minus share-token viewers
(a viewer's projects are never desk cards). Channel threads are omitted too:
an outside person's conversation is never a desk card.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import TypeAdapter

from clawmeets.models.chat_message import ChatLogEntry
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.desk_sign_off import latest_message_slice
from clawmeets.models.project import Project
from clawmeets.models.user import User
from clawmeets.server.routes.messages import _is_fd_requester

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.channels.store import ChannelStore
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

MAX_PROJECT_IDS = 100
_ROOM = "user-communication"
_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")
_FEED_ADAPTER = TypeAdapter(dict[str, dict[str, list[ChatLogEntry]]])


def _channel_threads(project_ids: list[str], store: "ChannelStore | None") -> set[str]:
    """The ids that are channel threads, live or with their connection removed.
    On the event loop: the store's SQLite connection belongs to its thread."""
    if store is None:
        return set()
    return {
        pid for pid in project_ids
        if store.thread_for_project(pid) is not None or store.removed_thread(pid) is not None
    }


def _build_feed(
    project_ids: list[str], user: User, model_ctx: "ModelContext",
    channel_threads: frozenset[str] = frozenset(),
) -> bytes:
    """Collect and serialize the slices. Blocking file I/O — call off-loop."""
    entries: dict[str, list[ChatLogEntry]] = {}
    for pid in project_ids:
        try:
            project = Project.get(pid, model_ctx)
        except ValueError:  # deleted / never existed
            continue
        room = Chatroom.get(pid, _ROOM, model_ctx)
        if room is None:
            continue
        if not (
            project.created_by == user.id
            or _is_fd_requester(project, room, user)
        ):
            continue
        # Channel threads never reach My Desk (decided 2026-10-07): an outside
        # person's messages belong in the Front Desk sidebar. The client leaves
        # them out of its candidates too; this keeps a future candidate change
        # from putting them on the desk. A removed connection's threads count.
        if pid in channel_threads:
            continue
        entries[pid] = latest_message_slice(room.get_log_entries())
    return _FEED_ADAPTER.dump_json({"entries": entries}, by_alias=True)


def create_desk_latest_messages_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["desk"])

    @router.get("/me/desk/latest-messages")
    async def get_desk_latest_messages(
        project_ids: str = Query(..., description="Comma-separated project ids"),
        authorization: str = Header(default=""),
    ) -> Response:
        ids = list(dict.fromkeys(p for p in (s.strip() for s in project_ids.split(",")) if p))
        # Ids feed a filesystem glob in Project.get — reject anything that
        # isn't a plain id rather than let "*" match someone's project dir.
        if any(not _ID_RE.fullmatch(p) for p in ids):
            raise HTTPException(422, "Malformed project id")
        if len(ids) > MAX_PROJECT_IDS:
            raise HTTPException(422, f"At most {MAX_PROJECT_IDS} project ids per request")
        user = await ctx.auth.get_current_user(authorization)
        channel_threads = frozenset(_channel_threads(ids, getattr(ctx, "channel_store", None)))
        body = await asyncio.to_thread(_build_feed, ids, user, ctx.model_ctx, channel_threads)
        return Response(content=body, media_type="application/json")

    return router
