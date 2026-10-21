# SPDX-License-Identifier: BUSL-1.1
"""Room flow stop (design section 4.6): a per-chatroom switch on the inbound
flow of outside messages, ``open`` (default) or ``stopped``.

While a room is stopped, ``OutsideIngress.admit`` holds every outside message
for it (reason ``flow_stopped``) on every path; local users and agents keep
talking. The owner stops and reopens a room from the browser
(``PUT /projects/{id}/chatrooms/{name}/flow``); an inspector may stop one
(``stop_room=True``) but only the owner reopens it. Reopening releases the
held messages: each is inspected again and the passes are delivered oldest
first (``OutsideIngress.release_held``). Reopening an open room that still
holds messages runs the release again.

The state lives on the room's record (its meta.json), written only through a
CHATROOM_FLOW_CHANGED changelog entry, so runners and browsers see it; the
user sockets also get ``chatroom_flow_changed``. ``is_open`` reads the record
every time, no cache.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal, Optional

from clawmeets.models.chatroom import Chatroom, RoomFlow
from clawmeets.models.project import Project
from clawmeets.sync.changelog import ChangelogEntryType, ChatroomFlowChangedPayload

if TYPE_CHECKING:
    from clawmeets.models.user import User
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server.room_flow")

MAX_REASON_CHARS = 200


class RoomFlowSwitch:
    """Persist the new state, emit CHATROOM_FLOW_CHANGED and the WS event.
    Stop is idempotent; reopen triggers ``release_held``."""

    def __init__(self, ctx: "ServerContext") -> None:
        self._ctx = ctx

    def _room(self, project_id: str, chatroom: str) -> tuple[Project, Chatroom]:
        try:
            project = Project.get(project_id, self._ctx.model_ctx)
        except ValueError:
            raise LookupError(project_id) from None
        room = Chatroom.get_in(project, chatroom)
        if room is None:
            raise LookupError(chatroom)
        return project, room

    def flow(self, project_id: str, chatroom: str) -> RoomFlow:
        """The room's flow as the browser sees it, held count included."""
        _, room = self._room(project_id, chatroom)
        return self.with_held_count(room).flow

    def with_held_count(self, room: Chatroom) -> Chatroom:
        """The room with ``flow.held_count`` filled in from the held store."""
        ingress = getattr(self._ctx, "outside_ingress", None)
        held = ingress.held_count(room.project_id, room.name) if ingress is not None else 0
        if held == room.flow.held_count:
            return room
        out = room.model_copy(update={"flow": room.flow.model_copy(update={"held_count": held})})
        object.__setattr__(out, "_ctx", room._ctx)
        return out

    def is_open(self, project_id: str, chatroom: str) -> bool:
        room = Chatroom.get(project_id, chatroom, self._ctx.model_ctx)
        return room is None or room.flow.inbound_flow != "stopped"

    async def stop(
        self, project_id: str, chatroom: str, *,
        by: Literal["owner", "inspector"], reason: Optional[str],
    ) -> RoomFlow:
        project, room = self._room(project_id, chatroom)
        if room.flow.inbound_flow == "stopped":
            return self.with_held_count(room).flow                  # idempotent
        reason = (reason or None) and reason[:MAX_REASON_CHARS]
        await self._announce(project, chatroom, "stopped", stopped_by=by, reason=reason)
        return self.flow(project_id, chatroom)

    async def reopen(self, project_id: str, chatroom: str, *, by_user: "User") -> RoomFlow:
        project, room = self._room(project_id, chatroom)
        if by_user.id != project.created_by:
            raise PermissionError("only the project owner reopens a room")
        ingress = getattr(self._ctx, "outside_ingress", None)
        if room.flow.inbound_flow == "stopped":
            await self._announce(project, chatroom, "open", stopped_by=None, reason=None)
        elif ingress is None or not ingress.held_count(project_id, chatroom):
            return self.with_held_count(room).flow
        # An open room that still holds messages (one held again or whose
        # delivery failed on the last reopen): reopening runs the release again.
        if ingress is not None:
            released = await ingress.release_held(project_id, chatroom)
            if released:
                logger.info("Room %s/%s reopened: %d held message(s) delivered",
                            project_id[:8], chatroom, released)
        flow = self.flow(project_id, chatroom)
        await self._push(project, chatroom, flow)
        return flow

    async def _announce(
        self, project: Project, chatroom: str, state: str, *,
        stopped_by: Optional[str], reason: Optional[str],
    ) -> None:
        runloop = await self._ctx.runloop_manager.get_or_create(
            project.id, project.name, project.coordinator_id,
        )
        entry = await runloop.append(
            ChangelogEntryType.CHATROOM_FLOW_CHANGED,
            ChatroomFlowChangedPayload(
                chatroom_name=chatroom, inbound_flow=state, stopped_by=stopped_by, reason=reason,
            ),
        )
        from clawmeets.server.routes.messages import _broadcast_changelog

        try:
            await _broadcast_changelog(self._ctx, project, entry.version)
        except Exception as exc:  # noqa: BLE001 — a push never undoes the write
            logger.warning("Room flow changelog push failed: %s", type(exc).__name__)
        await self._push(project, chatroom, self.flow(project.id, chatroom))

    async def _push(self, project: Project, chatroom: str, flow: RoomFlow) -> None:
        """``chatroom_flow_changed`` to the owner's browser sockets."""
        from clawmeets.api.control import ControlEnvelope, ControlMessageType
        from clawmeets.server.hub.browser import ChatroomFlowChangedPayload

        hub = getattr(self._ctx, "ws_hub", None)
        if hub is None or not project.created_by:
            return
        try:
            payload = ChatroomFlowChangedPayload(project_id=project.id, chatroom_name=chatroom, flow=flow)
            await hub.send_to(project.created_by, ControlEnvelope(
                type=ControlMessageType.CHATROOM_FLOW_CHANGED, payload=payload.model_dump(mode="json"),
            ))
        except Exception as exc:  # noqa: BLE001
            logger.warning("chatroom_flow_changed push failed: %s", type(exc).__name__)
