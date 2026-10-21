# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/desk_sign_off.py

Desk "Signed off today" route — the read side of the My Desk sign-off stack.

Route (user JWT; the owner is always the authenticated caller, never a body/
query param):

- ``GET /me/desk/sign-offs?since=<iso8601>&limit=<n>`` — the caller's sign-offs
  at or after ``since`` as a ``SignOffFeed``, ordered by
  ``DeskReadState.updated_at`` DESC (most-recently-signed-off first), plus
  ``last_signed_off_at`` (the newest sign-off ever, ignoring the window).

``since`` is a caller-supplied boundary — historically the **viewer's** local
midnight, computed and sent by the client, because the server does not know the
viewer's timezone. It is parsed with ``datetime.fromisoformat`` (which accepts
both ``+00:00`` and a ``Z`` suffix on 3.11+), a naive value is assumed UTC, and
an unparseable one is a 422. Omitted ⇒ no window, every row.

``limit`` is the independent, unwindowed way to ask for a short feed: "the last
N cards, any date", which is what the desk's *Recently done* section wants. It
caps hydrated CARDS (a skipped row backfills from further down), which also
bounds the per-row chatroom-log read that makes an unwindowed request cheap.
Out of range ⇒ 422 from FastAPI's own validation, matching the 422 on an
unparseable ``since``. The two params are orthogonal and compose; omitting both
keeps today's behavior exactly.

There is deliberately no 404 / 403: the underlying watermark rows are always
the caller's own (keyed by JWT ``user_id``), so the endpoint returns an empty
``cards`` list when the user has signed nothing off in the window. Rows whose
project was deleted or that the caller no longer owns (viewer-only) are
silently skipped during hydration. Read-only — no write, no monotonic-clock
touch (see ``models/desk_sign_off.build_sign_off_feed``).
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header, HTTPException, Query

from clawmeets.models.desk_sign_off import build_sign_off_feed

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def _parse_since(since: str | None) -> datetime | None:
    """``since`` as an aware datetime, or ``None`` for "no window".

    Naive input is assumed UTC so a caller that drops its offset still gets a
    sane (if timezone-blind) boundary rather than a comparison that raises. The
    result is ALWAYS aware — ``list_sign_offs`` compares it against parsed
    aware row stamps, and mixing the two would ``TypeError``.
    """
    if not since:
        return None
    try:
        parsed = datetime.fromisoformat(since)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="`since` must be an ISO-8601 datetime (e.g. 2035-01-01T00:00:00-07:00)",
        )
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def create_desk_sign_off_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["desk-sign-offs"])

    @router.get("/me/desk/sign-offs")
    async def get_my_sign_offs(
        since: str | None = None,
        limit: int | None = Query(default=None, ge=1, le=100),
        authorization: str = Header(default=""),
    ):
        """Return the caller's sign-offs at or after ``since``, newest first,
        capped at ``limit`` cards when one is given."""
        boundary = _parse_since(since)
        user = await ctx.auth.get_current_user(authorization)
        feed = await build_sign_off_feed(ctx, user.id, boundary, limit)
        return feed.model_dump()

    return router
