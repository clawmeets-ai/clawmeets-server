# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/search.py

Chat message search route — ``GET /me/search/messages``.

Read-only, idempotent, safe to call on every debounced keystroke. The wire
format is pinned by ``SEARCH_API_CONTRACT.md`` v1.0; ``chat_search_index.py``
owns the index and the ranking.

The ``/me/*`` prefix is deliberate and matches ``/me/active-work`` and
``/me/dms/{agent}/threads``: **the result set is defined by the authenticated
caller**. There is no user, project or room selector in the request — v1
deliberately exposes no client-controlled filter, so there is no surface to
attack — and the scope is derived here, server-side, from the JWT alone.

Status codes (contract §6): 200 for success including zero hits and
short-after-tokenization queries; 401 for a missing/expired JWT **or an agent
bearer token** (agents do not search user history); 422 for out-of-range
``limit``/``offset`` or a missing/oversized ``q``; 503 when the index is
unavailable — FTS5 missing, the kill switch set, **or** the query itself failing
against a locked/corrupted index. There is deliberately no 403 — an inaccessible room simply
produces no hits, so the endpoint never confirms or denies the existence of
anything the caller cannot read.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header, HTTPException, Query
from starlette.concurrency import run_in_threadpool

from clawmeets.models.share_token import get_projects_for_viewer
from clawmeets.models.user import User
from clawmeets.server.chat_search_index import (
    MAX_LIMIT,
    MAX_OFFSET,
    SearchIndexError,
    SearchResponse,
    SearchScope,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def create_search_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["search"])

    def _scope_for(user: User) -> SearchScope:
        """Build the searchable scope from the authenticated user alone."""
        return SearchScope(
            user_id=user.id,
            username=user.username,
            viewer_project_ids=get_projects_for_viewer(
                user.id, ctx.model_ctx.participants_dir
            ),
        )

    @router.get("/me/search/messages", response_model=SearchResponse)
    async def search_messages(
        q: str = Query(..., min_length=1, max_length=256),
        limit: int = Query(20, ge=1, le=MAX_LIMIT),
        offset: int = Query(0, ge=0, le=MAX_OFFSET),
        authorization: str = Header(default=""),
    ) -> SearchResponse:
        """Ranked message hits across every chatroom the CALLER can read.

        Authorization is user-JWT only: this is a human UI surface, not a
        runner path, so an agent bearer token gets 401 even when valid.
        ``get_current_user`` rejects anything that is not a user access token.
        """
        user = await ctx.auth.get_current_user(authorization)

        index = ctx.chat_search_index
        if not index.available:
            raise HTTPException(503, "Search index unavailable")

        # SQLite is synchronous; a naive call here would stall the whole
        # single-process event loop, WebSocket traffic included.
        try:
            return await run_in_threadpool(
                index.search, q, _scope_for(user), limit=limit, offset=offset
            )
        except SearchIndexError:
            # A locked or corrupted index is "unavailable", not "no results":
            # answering 200 with hits: [] would make a real failure look like an
            # empty corpus and the client's retry path unreachable (§2.3).
            raise HTTPException(503, "Search index unavailable") from None

    return router
