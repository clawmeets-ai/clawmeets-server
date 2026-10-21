# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/desk_read_state.py

Desk read-state routes — server-side persistence of the My Desk **Sign Off**
action so read-state is consistent across a user's devices. Sign Off is the
only writer (Send Back leaves the card on the desk, re-laned to *Working*),
which is what lets the read side call itself "Signed off today" —
see ``routes/desk_sign_off.py``.

Routes (both user JWT; the owner is always the authenticated caller, never the
body):

- ``GET /me/desk/read-state`` — hydration; all of the caller's desk
  watermarks as ``DeskReadState[]``. A fresh device calls this on desk mount
  to become correct without waiting on the WebSocket.
- ``PUT /me/desk/read-state`` — idempotent upsert of ONE card's watermark
  (body ``{project_id, chatroom_name, last_seen_message_id}``) → the stored
  ``DeskReadState`` incl. server-assigned ``updated_at``. On success emits
  ``DESK_READ_STATE_SYNC`` to the owner's own sessions so already-open devices
  update live.

There is deliberately no 404 / 403: the row is always the caller's own
(keyed by JWT ``user_id``) and PUT is create-or-update. The sentinel
(``"__dismissed__"``) and unknown message ids are stored verbatim.

Single-user WS fan-out: ``WSHub`` keeps a *set* of queues per
``participant_id``, so ``send_to(user_id, ...)`` fans out to **every** open
session the owner holds — each device drops the card live without a refresh
(same for ``DESK_TODO_SYNC`` / ``BRIEF_TAB_SYNC``, which share the primitive).
The GET-hydration path remains the correctness backstop for a device that was
offline during the push.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    DeskReadStateSyncPayload,
)
from clawmeets.models.desk_read_state import (
    DeskReadState,
    DeskReadStateUpsert,
    list_read_state,
    upsert_read_state,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def create_desk_read_state_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["desk-read-state"])

    def _dir():
        return ctx.model_ctx.participants_dir

    async def _broadcast(owner_user_id: str, row: DeskReadState) -> None:
        """Push DESK_READ_STATE_SYNC to the owner's own sessions (single-user
        fan-out). The payload's ``updated_at`` is the same string stored on the
        row and returned in the PUT body, so every device merges on one clock."""
        envelope = ControlEnvelope(
            type=ControlMessageType.DESK_READ_STATE_SYNC,
            payload=DeskReadStateSyncPayload(
                project_id=row.project_id,
                chatroom_name=row.chatroom_name,
                last_seen_message_id=row.last_seen_message_id,
                updated_at=row.updated_at,
            ),
        )
        delivered = await ctx.ws_hub.send_to(owner_user_id, envelope)
        if delivered:
            logger.info(
                f"Sent DESK_READ_STATE_SYNC to user {owner_user_id[:8]}"
            )

    @router.get("/me/desk/read-state")
    async def get_my_read_state(
        authorization: str = Header(default=""),
    ):
        """Return all of the caller's desk watermarks (hydration)."""
        user = await ctx.auth.get_current_user(authorization)
        rows = await list_read_state(_dir(), user.id)
        return [r.model_dump() for r in rows]

    @router.put("/me/desk/read-state")
    async def put_my_read_state(
        body: DeskReadStateUpsert,
        authorization: str = Header(default=""),
    ):
        """Idempotent upsert of one card's watermark, then broadcast."""
        user = await ctx.auth.get_current_user(authorization)
        row = await upsert_read_state(
            _dir(),
            user.id,
            body.project_id,
            body.chatroom_name,
            body.last_seen_message_id,
        )
        await _broadcast(user.id, row)
        return row.model_dump()

    return router
