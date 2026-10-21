# SPDX-License-Identifier: BUSL-1.1
"""The room bridge: a retained hub agent taking part in a workroom
(plan-agent-access 4.2).

The stand-in is a ghost member of the room (``external``, kind
``hub_stand_in``): it has no runner and no changelog. ``RoomBridgeSubscriber``
relays a room message to it only when the message addresses it (a qualified
``@name@deployment`` mention, or it is expected to answer), the sender is a
local user or agent, the message is not itself a mirror, ``bridge_allowed``
holds at that moment, and the outbound inspection passes. Only the files
uploaded WITH that message go along. The remote agent's verified reply is
mirrored back into the room as the stand-in, fenced in every turn and kept
out of memory, and completes the batch it answers.

**One send-time predicate.** ``bridge_allowed`` is true iff the owner's
``hub_retained`` row for the stand-in is ``active``, the hub mode allows
sending, the stand-in's participant row in the room has ``bridge_state``
``active`` and the room's inbound flow is open. It reads the store every
time. ``RoomBridgeSubscriber`` asks it before every relay (the flow part is
asked by the outbound inspection itself, which holds a relay out of a
stopped room until reopen) and the hub adapter's ``prepare_relay`` asks it
again before every send of a bridge thread's envelope, so an unretain,
delisting or stop that races a queued envelope still wins.

**The bridge thread** is a hidden hub thread of the room's owner
(``hub_threads.kind = "room_bridge"``, bound to the workroom and the
stand-in), carried by ``RequesterMirror`` exactly like a DM thread: the
relayed message is appended there and sent signed once. Bridge thread
projects are plumbing: every project list filters them out server-side.

**Replies** are admitted once (path ``hub_reply_bridge``, against the
workroom), then appended to the bridge thread and mirrored into the workroom
as the stand-in on the SAME ingress ticket (``OutsideIngress.extend``), with
``mirrored_from`` and no wake: ``expects_response_from`` is empty and
mentions in remote text are never parsed. The reply closes the stand-in's
slot of the batch it answers, so BATCH_COMPLETE wakes the coordinator in its
normal full turn, where the reply is fenced and kept out of memory (it is a
hub stand-in's row: models/provenance.py). After an unretain (or any inactive
state) a late reply is appended to the hidden thread only.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import unicodedata
import uuid
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Any, Mapping, Optional, Sequence

from fastapi import HTTPException

from clawmeets.api.control import ControlMessageType
from clawmeets.models.agent import Agent
from clawmeets.models.chatroom import Chatroom, parse_mentions
from clawmeets.models.project import Project
from clawmeets.models.provenance import SYSTEM_AUTHORS, STAND_IN_SEPARATOR, outside_author
from clawmeets.models.user import User
from clawmeets.sync.changelog import (
    BatchCompletePayload,
    ChangelogEntry,
    ChangelogEntryType,
    FilePayload,
    MessagePayload,
    MirroredFromRef,
    ParticipantUpdatedPayload,
    RoomCreatedParticipant,
)
from clawmeets.sync.subscriber import ChangelogSubscriber
from clawmeets.utils.file_io import FileUtil

from .browser import BridgeDelivery, HubError

if TYPE_CHECKING:
    from clawmeets.server.channels.hub_store import BridgeRelay, HubThread, RemoteAgent
    from clawmeets.server.context import ServerContext

    from .runtime import HubRuntime

logger = logging.getLogger(__name__)

UC = "user-communication"
KIND_STAND_IN = "hub_stand_in"
#: BridgeDelivery states.
QUEUED, RELAYED, DELIVERED, ANSWERED, FAILED, CANCELLED = (
    "queued", "relayed", "delivered", "answered", "failed", "cancelled")
#: The deliverer key of a held relay (``OutsideIngress.register_deliverer``).
VIA_BRIDGE_OUTBOUND = "bridge_outbound"
VIA_BRIDGE_REPLY = "hub_reply_bridge"

#: Names an instruction or tool loader recognises; an incoming file with one
#: of these names is renamed ``<name>.remote.txt`` so nothing loads it.
LOADER_NAMES = frozenset({
    "skill.md", "claude.md", "agents.md", "gemini.md", ".mcp.json", "settings.json",
    "config.toml", "opencode.json",
})
#: Incoming files are flattened to at most this many path segments under
#: ``files/hub/<name>@<deployment>/``.
MAX_INCOMING_DEPTH = 2


def confine_incoming_path(sender_label: str, name: str) -> Optional[str]:
    """Where an incoming file from a retained agent is written in the room's
    files, or None when the name is refused.

    NFC-normalised; absolute paths, ``..``, empty segments and any segment
    starting with ``.`` refused; flattened to at most two levels; loader names
    renamed; always under ``hub/<sender_label>/``."""
    if not isinstance(name, str) or not name or "\x00" in name or "\\" in name:
        return None
    name = unicodedata.normalize("NFC", name)
    if name.startswith("/"):
        return None
    parts = name.split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return None
    if len(parts) > MAX_INCOMING_DEPTH:
        parts = [*parts[: MAX_INCOMING_DEPTH - 1], "_".join(parts[MAX_INCOMING_DEPTH - 1:])]
    if parts[-1].lower() in LOADER_NAMES:
        parts[-1] = f"{parts[-1]}.remote.txt"
    label = unicodedata.normalize("NFC", sender_label).replace("/", "_")
    if not label or label.startswith("."):
        return None
    return str(PurePosixPath("hub", label, *parts))


def incoming_file_payloads(sender_label: str, author_id: str, chatroom: str,
                           files: Sequence[tuple[str, bytes]]) -> list[FilePayload]:
    """FILE payloads for the files a remote agent sent with a reply, each
    under ``files/hub/<sender_label>/`` (``confine_incoming_path``) and
    authored by its stand-in, so the guard asks for the reply's ticket and the
    manifest lists them as outside content. A refused name is left out."""
    out = []
    for name, data in files:
        path = confine_incoming_path(sender_label, name)
        if path is None:
            logger.warning("Hub reply file with a refused name: not written")
            continue
        out.append(FilePayload(
            chatroom_name=chatroom, filename=path, content_b64=FileUtil.to_base64(data),
            sha256=hashlib.sha256(data).hexdigest(), from_participant_id=author_id,
            from_participant_name=sender_label,
        ))
    return out


def _now() -> float:
    return datetime.now(UTC).timestamp()


def stand_in_participant(stand_in: "RemoteAgent") -> RoomCreatedParticipant:
    """The ghost membership row of a stand-in: external (no runner), kind
    ``hub_stand_in``, bridge active."""
    return RoomCreatedParticipant(
        id=stand_in.id, name=stand_in.display, external=True, kind=KIND_STAND_IN,
        bridge_state="active", inactive_reason=None,
        hub={"hub_agent_id": stand_in.id, "name": stand_in.agent_name,
             "deployment_name": stand_in.deployment_name, "deployment_fingerprint": stand_in.genesis_fp},
    )


def _allowlist_admits(project: Project, stand_in: "RemoteAgent") -> bool:
    """As "Other accounts": ``Project.admits_hub_agent`` owns the rule."""
    return project.admits_hub_agent(
        stand_in.id, f"{stand_in.agent_name}@{stand_in.deployment_name}")


def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(409, detail={"code": code, "message": message})


def looks_like_hub_ref(ref: str) -> bool:
    """``name@deployment`` or a hub agent id (``{genesis}~{name}``)."""
    return STAND_IN_SEPARATOR in ref or ("@" in ref.strip("@") and not ref.startswith("@"))


class RoomBridge:
    """The room bridge of one server (built beside the requester mirror)."""

    def __init__(self, runtime: "HubRuntime") -> None:
        self.runtime = runtime
        self._tasks: set[asyncio.Task] = set()

    @property
    def hub(self):
        return self.runtime.hub

    @property
    def _ctx(self) -> "ServerContext":
        return self.runtime._ctx

    @property
    def mirror(self):
        return self.runtime.mirror

    def _ingress(self):
        return getattr(self._ctx, "outside_ingress", None)

    # ── the predicate ───────────────────────────────────────────────────

    def mode_allows_sending(self) -> bool:
        config = self.runtime.config
        if not config.enabled or self.runtime.mode != "full":
            return False
        reg = self.runtime.registration()
        return reg is not None and reg.status == "active"

    def bridge_allowed(self, owner_user_id: str, stand_in_id: str, project_id: str, room: str, *,
                       check_flow: bool = True) -> bool:
        """See the module docstring. Read straight from the store."""
        row = self.hub.retained_row(owner_user_id, stand_in_id)
        if row is None or row.state != "active" or not self.mode_allows_sending():
            return False
        chatroom = Chatroom.get(project_id, room, self._ctx.model_ctx)
        if chatroom is None:
            return False
        member = chatroom.participant_rows().get(stand_in_id)
        if member is None or member.get("kind") != KIND_STAND_IN or member.get("bridge_state") != "active":
            return False
        return not check_flow or chatroom.flow.inbound_flow != "stopped"

    def why_not(self, owner_user_id: str, stand_in_id: str) -> str:
        row = self.hub.retained_row(owner_user_id, stand_in_id)
        if row is None:
            return "unretained"
        if row.state != "active":
            return "agent_unlisted" if row.state == "unlisted" else row.state
        if not self.mode_allows_sending():
            return "hub_off"
        return "inactive"

    # ── invite ──────────────────────────────────────────────────────────

    def resolve_invitee(self, project: Project, ref: str, room: Optional[str]) -> RoomCreatedParticipant:
        """A ``name@deployment`` or hub agent id the project owner retained:
        its stand-in's membership row. ``not_retained`` [409] when it is not
        retained (active), 403 outside the allowlist, ``room_flow_stopped``
        [409] when the room is stopped."""
        ref = ref.strip().lstrip("@")
        stand_in = None
        owner = project.created_by or ""
        for row in self.hub.retained_for(owner):
            handle = f"{row.agent_name}@{row.deployment_name}".lower()
            if ref.lower() in (row.stand_in_id.lower(), handle) and row.state == "active":
                stand_in = self.hub.remote_agent(row.stand_in_id)
                break
        if stand_in is None:
            raise _conflict("not_retained", f"{ref!r} is not a hub agent your user retained")
        if not _allowlist_admits(project, stand_in):
            raise HTTPException(403, f"{stand_in.display!r} is not in this project's invitable allowlist")
        if room is not None and not self.runtime._ctx.room_flow.is_open(project.id, room):
            raise _conflict("room_flow_stopped", "this room's flow is stopped")
        return stand_in_participant(stand_in)

    # ── the bridge thread ───────────────────────────────────────────────

    async def ensure(self, project: Project, room: str, stand_in: "RemoteAgent") -> "HubThread":
        """The owner's hidden bridge thread for (room, stand-in); idempotent."""
        user = User.get(project.created_by or "", self._ctx.model_ctx)
        if user is None:
            raise HubError("project_not_found", "the room has no owner")
        thread = self.hub.bridge_thread(user.id, project.id, room, stand_in.id)
        if thread is None:
            thread = self.hub.open_bridge_thread(
                user_id=user.id, project_id=str(uuid.uuid4()), stand_in=stand_in,
                bound_project_id=project.id, bound_room=room, now=self.runtime._now())
        await self.mirror._ensure_project(thread, stand_in, user)
        return thread

    # ── room -> B ───────────────────────────────────────────────────────

    def addressed_stand_ins(self, room: Chatroom, payload: MessagePayload) -> list[str]:
        """Stand-in members this message addresses: a qualified mention of
        one, or one in ``expects_response_from``."""
        rows = room.participant_rows()
        out: list[str] = []
        for pid in payload.expects_response_from or []:
            if (rows.get(pid) or {}).get("kind") == KIND_STAND_IN and pid not in out:
                out.append(pid)
        for name, deployment in parse_mentions(payload.content).qualified:
            pid = room.stand_in_member(name, deployment)
            if pid is not None and pid not in out:
                out.append(pid)
        # An inactive member (unretained, delisted) is addressed by nobody:
        # its room note was posted when it went inactive.
        return [pid for pid in out if (rows.get(pid) or {}).get("bridge_state") == "active"]

    def _attached_files(self, project: Project, entry: ChangelogEntry) -> list[tuple[str, bytes]]:
        """Only files uploaded WITH this message: FILE entries in the same
        room, by the same author, appended before it, and either linked to
        it (``source_version`` is the message's version: a user's message
        with attachments, one batch) or carrying its non-null
        ``source_version`` (one agent action block). Nothing else ever goes
        along."""
        payload = entry.payload
        from clawmeets.sync.changelog import iter_entries

        path = self._ctx.model_ctx.changelog_dir(project.id, project.name) / "changelog.ndjson"
        names: list[str] = []
        for e in iter_entries(path) if path.exists() else []:
            if e.version >= entry.version:
                break
            p = e.payload
            if (e.entry_type in (ChangelogEntryType.FILE_CREATED, ChangelogEntryType.FILE_UPDATED)
                    and e.source_version is not None
                    and e.source_version in (entry.version, entry.source_version)
                    and p.chatroom_name == payload.chatroom_name
                    and p.from_participant_id == payload.from_participant_id and p.filename not in names):
                names.append(p.filename)
        room = Chatroom.get_in(project, payload.chatroom_name)
        out = []
        for name in names:
            data = room.get_file(name) if room is not None else None
            if data:
                out.append((name, data))
        return out

    async def relay(self, project: Project, entry: ChangelogEntry, stand_in_id: str) -> None:
        """Relay one addressed room message to one stand-in (see the module
        docstring). Idempotent on the room message id."""
        from clawmeets.server.inspection import FileRef, InspectionRequest, OutsidePath

        payload: MessagePayload = entry.payload
        room = payload.chatroom_name
        owner = project.created_by or ""
        now = self.runtime._now()
        if not self.hub.claim_relay(room_project_id=project.id, room=room, room_message_id=payload.id,
                                    stand_in_id=stand_in_id, user_id=owner, state=QUEUED, reason=None, now=now):
            return                                           # a replay: decided already
        if not self.bridge_allowed(owner, stand_in_id, project.id, room, check_flow=False):
            await self._end(project, room, payload.id, stand_in_id, FAILED, self.why_not(owner, stand_in_id),
                            close_slot=True)
            return
        try:
            from .agent_send_guard import via_agent_name

            guard = self._send_guard()
            sender_agent = Agent.get(payload.via_agent_id or payload.from_participant_id, self._ctx.model_ctx)
            via_agent_name(sender_agent, self._ctx.model_ctx)   # a name the hub refuses costs nothing
            guard.charge(user_id=owner, agent_id=sender_agent.id if sender_agent else None,
                         target=stand_in_id, room=(project.id, room))
        except HubError as exc:
            await self._end(project, room, payload.id, stand_in_id, FAILED, exc.code, close_slot=True)
            return
        files = self._attached_files(project, entry)
        stand_in = self.hub.remote_agent(stand_in_id)
        label = stand_in.display if stand_in is not None else stand_in_id
        replay = {"via": VIA_BRIDGE_OUTBOUND, "project_id": project.id, "room": room,
                  "room_message_id": payload.id, "stand_in_id": stand_in_id,
                  "sender_id": payload.from_participant_id, "sender_name": payload.from_participant_name,
                  "via_agent_id": payload.via_agent_id,
                  "text": payload.content,
                  # Each file's sha256 as inspected: a held relay sends these
                  # bytes or nothing (send_relay).
                  "files": [{"name": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in files],
                  "version": entry.version}
        ingress = self._ingress()
        if ingress is not None:
            admission = await ingress.admit(InspectionRequest(
                path=OutsidePath.BRIDGE_OUTBOUND, direction="outbound", owner_user_id=owner,
                project_id=project.id, chatroom=room, author_id=payload.from_participant_id,
                author_label=f"{payload.from_participant_name} to {label}", text=payload.content,
                files=tuple(FileRef(name=n, sha256=hashlib.sha256(d).hexdigest(), size=len(d)) for n, d in files),
                source_ref=f"{payload.id}/{stand_in_id}",
            ), replay=replay)
            if admission.verdict.value == "hold":
                reason = admission.reason_code if admission.reason_code == "flow_stopped" else "held"
                self.hub.set_relay(payload.id, stand_in_id, state=QUEUED, reason=reason, now=self.runtime._now())
                await self._push(project, room, payload.id, stand_in_id)
                return
            if admission.verdict.value == "block":
                await self._end(project, room, payload.id, stand_in_id, FAILED, "blocked", close_slot=True)
                return
        await self.send_relay(replay)

    async def close_held_relay(self, replay: Mapping[str, Any]) -> None:
        """A relay held while the room was stopped that expired: its delivery
        line fails (``held_expired``) and the stand-in's slot closes."""
        try:
            project = Project.get(replay["project_id"], self._ctx.model_ctx)
        except ValueError:
            return
        await self._end(project, replay["room"], replay["room_message_id"], replay["stand_in_id"], FAILED,
                        "held_expired", close_slot=True)

    async def block_held_relay(self, replay: Mapping[str, Any]) -> None:
        """A held relay blocked on release: its delivery line fails
        (``blocked``) and the stand-in's slot closes, as on a live block."""
        try:
            project = Project.get(replay["project_id"], self._ctx.model_ctx)
        except ValueError:
            return
        await self._end(project, replay["room"], replay["room_message_id"], replay["stand_in_id"], FAILED,
                        "blocked", close_slot=True)

    async def send_relay(self, replay: Mapping[str, Any], _ticket: Any = None) -> None:
        """The send itself (also the deliverer of a relay held while the room
        was stopped): only a relay still ``queued`` (an unretain cancelled
        it otherwise), re-check the predicate, re-read each file and refuse
        the relay (``file_changed``) when its bytes are not the ones the
        inspection saw, append to the bridge thread, sign once and queue."""
        from .agent_send_guard import via_agent_name
        from .mirror import OutgoingFile

        try:
            project = Project.get(replay["project_id"], self._ctx.model_ctx)
        except ValueError:
            return
        room, stand_in_id, message_id = replay["room"], replay["stand_in_id"], replay["room_message_id"]
        row = self.hub.relay_row(message_id, stand_in_id)
        if row is None or row.state != QUEUED:
            return                                           # cancelled or decided meanwhile
        owner = project.created_by or ""
        if not self.bridge_allowed(owner, stand_in_id, project.id, room):
            await self._end(project, room, message_id, stand_in_id, FAILED, self.why_not(owner, stand_in_id),
                            close_slot=True)
            return
        stand_in = self.hub.remote_agent(stand_in_id)
        user = User.get(owner, self._ctx.model_ctx)
        chatroom = Chatroom.get_in(project, room)
        if stand_in is None or user is None or chatroom is None:
            return
        files = []
        for ref in replay.get("files") or []:
            data = chatroom.get_file(ref["name"])
            if not data or hashlib.sha256(data).hexdigest() != ref["sha256"]:
                await self._end(project, room, message_id, stand_in_id, FAILED, "file_changed", close_slot=True)
                return
            files.append(OutgoingFile(name=PurePosixPath(ref["name"]).name, mime="application/octet-stream",
                                      data=data))
        # The agent sending: the message's agent author, or the agent whose
        # credential posted a user-authored message; None for the user's own.
        sender = Agent.get(replay.get("via_agent_id") or replay.get("sender_id") or "", self._ctx.model_ctx)
        try:
            via = via_agent_name(sender, self._ctx.model_ctx)
            thread = await self.ensure(project, room, stand_in)
            sent = await self.mirror.send(
                user, thread.project_id, text=replay["text"], client_message_id=f"bridge-{message_id}",
                files=files, via_agent=via, author=sender)
        except HubError as exc:
            await self._end(project, room, message_id, stand_in_id, FAILED, exc.code, close_slot=True)
            return
        self.hub.set_relay(message_id, stand_in_id, state=RELAYED, reason=None, now=self.runtime._now(),
                           thread_project_id=thread.project_id, hub_message_id=sent.message_id)
        await self._push(project, room, message_id, stand_in_id)

    def _send_guard(self):
        from .agent_send_guard import AgentSendGuard

        guard = getattr(self._ctx, "hub_send_guard", None)
        if guard is None:
            guard = self._ctx.hub_send_guard = AgentSendGuard(self._ctx.channel_store)
        return guard

    # ── delivery state ──────────────────────────────────────────────────

    async def on_row_change(self, row, thread: "HubThread") -> None:
        """A bridge thread's outbox row changed: its relay's delivery line."""
        from clawmeets.server.channels.store import EXPIRED, FAILED as ROW_FAILED, SENT

        relay = self.hub.relay_for_hub_message(row.message_id) if row.message_id else None
        if relay is None or relay.state in (ANSWERED, CANCELLED, FAILED):
            return
        try:
            project = Project.get(relay.room_project_id, self._ctx.model_ctx)
        except ValueError:
            return
        if row.state == SENT and relay.state != DELIVERED:
            self.hub.set_relay(relay.room_message_id, relay.stand_in_id, state=DELIVERED, reason=None,
                               now=self.runtime._now())
            await self._push(project, relay.room, relay.room_message_id, relay.stand_in_id)
        elif row.state in (ROW_FAILED, EXPIRED):
            state = CANCELLED if row.reason == "cancelled_unretained" else FAILED
            await self._end(project, relay.room, relay.room_message_id, relay.stand_in_id, state,
                            row.reason or "failed", close_slot=state == FAILED)

    def deliveries(self, project_id: str, room: str, message_ids: Optional[set[str]] = None) -> list[BridgeDelivery]:
        return [
            BridgeDelivery(room_message_id=r.room_message_id, hub_agent_id=r.stand_in_id, state=r.state,
                           reason=r.reason)
            for r in self.hub.relays_for_room(project_id, room)
            if message_ids is None or r.room_message_id in message_ids
        ]

    async def _push(self, project: Project, room: str, message_id: str, stand_in_id: str) -> None:
        relay = self.hub.relay_row(message_id, stand_in_id)
        if relay is None or not project.created_by:
            return
        delivery = BridgeDelivery(room_message_id=message_id, hub_agent_id=stand_in_id, state=relay.state,
                                  reason=relay.reason)
        await self.runtime._push(project.created_by, ControlMessageType.HUB_BRIDGE_DELIVERY, {
            "project_id": project.id, "chatroom_name": room, "delivery": delivery.model_dump(mode="json")})

    async def _end(self, project: Project, room: str, message_id: str, stand_in_id: str, state: str,
                   reason: str, *, close_slot: bool) -> None:
        self.hub.set_relay(message_id, stand_in_id, state=state, reason=reason, now=self.runtime._now())
        await self._push(project, room, message_id, stand_in_id)
        if close_slot:
            stand_in = self.hub.remote_agent(stand_in_id)
            label = stand_in.display if stand_in is not None else stand_in_id
            await self.close_slot(project, room, stand_in_id,
                                  note=f"A message to {label} was not relayed ({reason}).", reason=reason)

    async def close_slot(self, project: Project, room: str, stand_in_id: str, *, note: Optional[str],
                         reason: Optional[str] = None) -> None:
        """Close the stand-in's slot in the room's open batch
        (``RequesterMirror.close_stand_in_slot``) and post a one-line system note."""
        await self.mirror.close_stand_in_slot(project, room, stand_in_id, reason=reason)
        if note:
            ingress = self._ingress()
            if ingress is not None:
                await ingress.post_note(project.id, room, note)

    # ── B -> room ───────────────────────────────────────────────────────

    async def on_reply(self, thread: "HubThread", envelope, *, entry_id: str, event_id: Optional[str],
                       files: Sequence[tuple[str, bytes]] = ()) -> str:
        """A verified reply into a bridge thread, with the files it carried
        (checked against their FileRefs). Returns the verdict."""
        from clawmeets.server.inspection import InspectionRequest, OutsidePath, file_refs

        stand_in = self.hub.remote_agent(thread.stand_in_id)
        name = stand_in.display if stand_in is not None else thread.agent_name
        text = envelope.body.text
        # Confined once; the room each copy lands in is set where it is stored.
        payloads = incoming_file_payloads(name, thread.stand_in_id, thread.bound_room or UC, files)
        replay = {"via": VIA_BRIDGE_REPLY, "thread_project_id": thread.project_id,
                  "stand_in_id": thread.stand_in_id, "name": name, "entry_id": entry_id, "text": text,
                  "in_reply_to": envelope.in_reply_to, "files": [p.model_dump(mode="json") for p in payloads]}
        try:
            project = Project.get(thread.bound_project_id or "", self._ctx.model_ctx)
        except ValueError:
            project = None
        live = project is not None and self.bridge_allowed(
            thread.user_id, thread.stand_in_id, project.id, thread.bound_room or "", check_flow=False)
        ingress = self._ingress()
        if not live:
            # Unretained, delisted or the room is gone: the hidden thread
            # only, never mirrored.
            thread_project = Project.get(thread.project_id, self._ctx.model_ctx)
            ticket = None
            if ingress is not None:
                admission = await ingress.admit(InspectionRequest(
                    path=OutsidePath.HUB_REPLY_BRIDGE, direction="inbound",
                    owner_user_id=thread.user_id, project_id=thread.project_id, chatroom=UC,
                    author_id=thread.stand_in_id, author_label=name, text=text, files=file_refs(payloads),
                    source_ref=event_id or entry_id,
                ), replay={**replay, "thread_only": True})
                if not admission.passed:
                    return admission.verdict.value
                ticket = admission.ticket
            await self.mirror._store_reply(thread_project, thread.stand_in_id, name, entry_id, text, ticket,
                                           files=payloads)
            return "pass"
        ticket = None
        if ingress is not None:
            admission = await ingress.admit(InspectionRequest(
                path=OutsidePath.HUB_REPLY_BRIDGE, direction="inbound", owner_user_id=project.created_by or "",
                project_id=project.id, chatroom=thread.bound_room or "", author_id=thread.stand_in_id,
                author_label=name, text=text, files=file_refs(payloads), source_ref=event_id or entry_id,
            ), replay=replay)
            if not admission.passed:
                if admission.verdict.value == "block":
                    await self.block_reply(replay)
                return admission.verdict.value
            ticket = admission.ticket
        await self.deliver_reply(replay, ticket)
        return "pass"

    async def block_reply(self, replay: Mapping[str, Any]) -> None:
        """A blocked reply (live, or held and blocked on release): the relay
        it answers fails (``blocked``) and the stand-in's slot closes. A
        thread-only reply has neither."""
        thread = self.hub.thread_for_project(replay["thread_project_id"])
        if thread is None or replay.get("thread_only"):
            return
        try:
            project = Project.get(thread.bound_project_id or "", self._ctx.model_ctx)
        except ValueError:
            return
        in_reply_to = replay.get("in_reply_to")
        relay = self.hub.relay_for_hub_message(in_reply_to) if in_reply_to else None
        if relay is not None:
            self.hub.set_relay(relay.room_message_id, relay.stand_in_id, state=FAILED,
                               reason="blocked", now=self.runtime._now())
            await self._push(project, relay.room, relay.room_message_id, relay.stand_in_id)
        await self.close_slot(project, thread.bound_room or "", thread.stand_in_id, note=None, reason="blocked")

    async def deliver_reply(self, replay: Mapping[str, Any], ticket: Any) -> None:
        """Append the admitted reply to the bridge thread, then mirror it into
        the workroom as the stand-in, on the same ticket. Also the deliverer
        of a reply held while the room was stopped."""
        thread = self.hub.thread_for_project(replay["thread_project_id"])
        if thread is None:
            return
        thread_project = Project.get(thread.project_id, self._ctx.model_ctx)
        ingress = self._ingress()
        files = [FilePayload.model_validate(f) for f in replay.get("files") or ()]
        if replay.get("thread_only"):
            await self.mirror._store_reply(thread_project, replay["stand_in_id"], replay["name"],
                                           replay["entry_id"], replay["text"], ticket, files=files)
            return
        both = ingress.extend(ticket, (thread.project_id, UC)) if (ingress is not None and ticket is not None) \
            else ticket
        await self.mirror._store_reply(thread_project, replay["stand_in_id"], replay["name"], replay["entry_id"],
                                       replay["text"], both, files=files)
        try:
            project = Project.get(thread.bound_project_id or "", self._ctx.model_ctx)
        except ValueError:
            return
        room = thread.bound_room or ""
        if Chatroom.get_in(project, room) is None:
            return
        thread_entry = next((e for e in reversed(self._entries(thread_project))
                             if e.entry_type == ChangelogEntryType.MESSAGE
                             and getattr(e.payload, "id", None) == replay["entry_id"]), None)
        room_entry_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"clawmeets-bridge-mirror:{replay['entry_id']}"))
        runloop = await self._ctx.runloop_manager.get_or_create(project.id, project.name, project.coordinator_id)
        if any(e.entry_type == ChangelogEntryType.MESSAGE and getattr(e.payload, "id", None) == room_entry_id
               for e in runloop.get_entries_since(0)):
            return                                           # mirrored already (idempotent)
        # The reply's files land in the workroom first, as outside content
        # (files/hub/<name>@<deployment>/), on the same ticket as its text.
        await self.mirror.store_incoming_files(runloop, project, [f.model_copy(update={"chatroom_name": room})
                                                                  for f in files], both)
        entry = await runloop.append(ChangelogEntryType.MESSAGE, MessagePayload(
            chatroom_name=room, id=room_entry_id, ts=datetime.now(UTC),
            from_participant_id=replay["stand_in_id"], from_participant_name=replay["name"],
            content=replay["text"], expects_response_from=[],
        ), ingress_ticket=both, mirrored_from=MirroredFromRef(
            project_id=thread.project_id, version=thread_entry.version if thread_entry is not None else 0))
        version = entry.version
        tracker = getattr(self._ctx, "work_tracker", None)
        work = await tracker.record_response(project.id, room, replay["stand_in_id"]) if tracker else None
        if work is not None and work.is_complete:
            await tracker.clear_pending_work(project.id, room)
            batch = await runloop.append(ChangelogEntryType.BATCH_COMPLETE, BatchCompletePayload(
                chatroom_name=room, message_id=work.message_id, coordinator_id=work.coordinator_id,
                responded_participants=list(work.responded_participants),
            ), source_version=work.message_version)
            version = batch.version
        relay = self.hub.relay_for_hub_message(replay.get("in_reply_to") or "") if replay.get("in_reply_to") else None
        if relay is not None:
            self.hub.set_relay(relay.room_message_id, relay.stand_in_id, state=ANSWERED, reason=None,
                               now=self.runtime._now())
            await self._push(project, room, relay.room_message_id, relay.stand_in_id)
        await self.mirror._broadcast(project, version)

    def _entries(self, project: Project) -> list[ChangelogEntry]:
        from clawmeets.sync.changelog import iter_entries

        path = self._ctx.model_ctx.changelog_dir(project.id, project.name) / "changelog.ndjson"
        return list(iter_entries(path)) if path.exists() else []

    # ── unretain, delisting, identity change ────────────────────────────

    async def deactivate(self, user_ids: Optional[list[str]], stand_in_id: str, reason: str) -> None:
        """Every bridged room of these users (all users when None) with this
        stand-in: its participant row goes inactive with ``reason``
        (PARTICIPANT_UPDATED), its waiting slot closes, a room note."""
        threads = [t for t in self.hub.threads_for_stand_in(stand_in_id)
                   if t.kind == "room_bridge" and (user_ids is None or t.user_id in user_ids)]
        stand_in = self.hub.remote_agent(stand_in_id)
        label = stand_in.display if stand_in is not None else stand_in_id
        rooms: set[tuple[str, str]] = {(t.bound_project_id or "", t.bound_room or "") for t in threads}
        # Rooms the stand-in was invited into but never relayed to have no thread yet.
        for project in Project.list_all(self._ctx.model_ctx):
            if user_ids is not None and project.created_by not in user_ids:
                continue
            if stand_in_id not in (project.participating_agents or []):
                continue
            for room_name in project.chatrooms:
                rooms.add((project.id, room_name))
        for project_id, room in sorted(rooms):
            try:
                project = Project.get(project_id, self._ctx.model_ctx)
            except ValueError:
                continue
            chatroom = Chatroom.get_in(project, room)
            member = chatroom.participant_rows().get(stand_in_id) if chatroom is not None else None
            if member is None or member.get("kind") != KIND_STAND_IN or member.get("bridge_state") == "inactive":
                continue
            runloop = await self._ctx.runloop_manager.get_or_create(project.id, project.name, project.coordinator_id)
            await runloop.append(ChangelogEntryType.PARTICIPANT_UPDATED, ParticipantUpdatedPayload(
                chatroom_name=room, participant_id=stand_in_id, bridge_state="inactive", inactive_reason=reason))
            await self.close_slot(project, room, stand_in_id,
                                  note=f"{label} can no longer take part in this room ({reason}).", reason=reason)


class RoomBridgeSubscriber(ChangelogSubscriber):
    """Relays addressed local room messages to retained agents' stand-ins.
    Registered on every server runloop beside the TunnelSubscriber. The relay
    runs off the source runloop (its lock is held while subscribers run);
    ``drain`` waits for the relays in flight."""

    def __init__(self) -> None:
        self._server_ctx: Optional["ServerContext"] = None
        self._tasks: set[asyncio.Task] = set()

    def bind_server_context(self, ctx: "ServerContext") -> None:
        self._server_ctx = ctx

    async def drain(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def on_entry(self, entry: ChangelogEntry, project_id: str, project_name: str) -> None:
        ctx = self._server_ctx
        if ctx is None or entry.entry_type != ChangelogEntryType.MESSAGE or entry.mirrored_from is not None:
            return
        runtime = getattr(ctx, "hub_runtime", None)
        bridge = getattr(runtime, "bridge", None) if runtime is not None else None
        payload = entry.payload
        if bridge is None or not isinstance(payload, MessagePayload):
            return
        if payload.from_participant_id in SYSTEM_AUTHORS or payload.is_ack:
            return
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            return
        if project.surface != "regular":
            return
        if payload.outside_isolated or outside_author(project, payload.from_participant_id,
                                                      ctx.model_ctx) is not None:
            return                                           # only local users and agents relay
        room = Chatroom.get_in(project, payload.chatroom_name)
        if room is None:
            return
        targets = bridge.addressed_stand_ins(room, payload)
        for stand_in_id in targets:
            task = asyncio.get_running_loop().create_task(self._relay(bridge, project, entry, stand_in_id))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _relay(self, bridge: RoomBridge, project: Project, entry: ChangelogEntry, stand_in_id: str) -> None:
        try:
            await bridge.relay(project, entry, stand_in_id)
        except Exception:  # noqa: BLE001 — one relay never stops the next
            logger.warning("Room bridge relay failed", exc_info=True)
