# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/desk_tour.py

My Desk welcome-tour routes — whether this account has seen the first-run
carousel, stored server-side so it shows once per ACCOUNT, not once per
browser.

- ``GET /me/desk/tour`` → ``{"seen_at": "<iso>" | null}``. The web app opens
  the tour on a ``null``.
- ``PUT /me/desk/tour`` → marks it seen (no body) and returns the same shape.
  Idempotent: the first stamp is kept, so replaying the tour from the ⓘ and
  closing it again changes nothing.

Owner-only by construction — both read the caller's own passwd row — and no
WS fan-out: another open session only needs the flag on its next desk mount,
and the GET is that mount's hydration.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Header

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext


def create_desk_tour_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["desk-tour"])

    @router.get("/me/desk/tour")
    async def get_my_desk_tour(authorization: str = Header(default="")):
        """Return when the caller first closed the tour (null = never)."""
        user = await ctx.auth.get_current_user(authorization)
        return {"seen_at": user.desk_tour_seen_at()}

    @router.put("/me/desk/tour")
    async def put_my_desk_tour(authorization: str = Header(default="")):
        """Mark the tour seen for the caller's account."""
        user = await ctx.auth.get_current_user(authorization)
        return {"seen_at": await user.mark_desk_tour_seen()}

    return router
