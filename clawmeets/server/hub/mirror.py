# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/mirror.py
``RequesterMirror``: the requester side (A). A user here talks to an agent on
another deployment; this is where that conversation lives on A.

**A conversation** is a Front Desk project coordinated by the user, whose
counterpart is the remote agent's stand-in (``RemoteAgent``, id
``{genesis fp}~{agent_name}``), never a chatroom member (the own-coordinator
rule, plan-owner-isolation section 4). ``start_conversation`` pins the target's key chain (asked of
the hub on first contact), records the stand-in and the thread
(``hub_threads``), and is deduped on the browser's ``client_thread_key``.
Starting a conversation with an agent of this same deployment is refused
(``local_agent``).

**Sending** (``send``): the browser's ``client_message_id`` is claimed once
(a retry is the same message); the envelope is signed ONCE by the identity
key and stored on its outbox row (kind ``hub_request``, on this server's
requester connection); the user's message (and its files) is appended to the
thread; a ``PendingWork`` waiting for the stand-in is opened paused
(``awaiting_delivery``). The relay, receipts and re-relays are the gateway's.

**A reply** (``on_reply``) is checked before anything is written:

- the route stamp verifies under a trusted hub key;
- the sender's key chain is pinned here and not revoked; the agent's
  certificate verifies under a key of that chain, names this hub, is in date
  and names the agent the envelope names; the envelope verifies under the
  certificate's agent key;
- aud is this hub, to_deployment is this deployment, sent_at is at most
  24 h + 10 min old and at most 10 min ahead;
- BINDING: the conversation key is ``{this genesis}/{requester_project_id}``,
  that project is a hub thread here, and its stand-in is exactly
  (signer's genesis root, cert's agent name) — so no other deployment, and no
  other agent of the same deployment, can write into it;
- a closed thread accepts a reply only inside its drain window.

Any failure is answered with a signed refusal and nothing is appended. The
reply's event id (``{sender genesis}/{message_id}``) is stored like every
dedupe key (7 days, over the 24 h + 10 min a reply may be relayed), and the
reply's MESSAGE id is derived from it (``_reply_entry_id``): a repeat whose
MESSAGE is in the thread is answered ``duplicate`` and appends nothing; one
whose MESSAGE is not (a cancel or crash after recording) appends it then.
**Files with a reply** are buffered as the frame is read (``reply_file_pool``:
only for a reply naming a hub thread here, from that thread's deployment) and
waited for off the inbound worker (``HubAdapter.collect_files``); each must
match its signed FileRef or nothing is stored. They are written beside the
reply under ``files/hub/<name>@<deployment>/`` (``room_bridge.incoming_file_payloads``:
confined, loader names renamed), authored by the stand-in and on the reply's
ingress ticket, so the prompt lists them as outside content.
The reply is appended as the stand-in, its batch completes (``BATCH_COMPLETE``), and a request that
had already failed ``expired_72h``, ``held_expired`` or ``key_revoked`` is
delivered after all (``delivered_late``, its expiry kept).

**Statements.** ``agent_delisted`` closes the stand-in's threads
(``agent_unlisted``) and fails its requests not yet accepted. The drain
window opens only for an owner's disable (reason ``owner_disabled``) whose
signed time (B's ``disabled_at``) is at most 5 minutes ahead of ours: until
10 minutes after that time, and only for replies to a request sent before
the thread closed and less than 24 hours old (the hub keeps its drain tuples
24 hours). The statement does not say "stop now"; the hub gives that no
drain, so nothing reaches A through it. Never for a moderation delist, a
suspension or a revoke. ``deployment_suspended`` closes every thread with
that root and fails its waiting requests ``rejected_by_hub``.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Mapping, Optional, Sequence

from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import Purpose, b64url_decode, sign_object, to_wire, verify_object
from clawmeets.hub_protocol.codes import DeliverResult, StatementKind
from clawmeets.hub_protocol.constants import (
    MAX_ENVELOPE_BYTES,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TEXT_BYTES,
    PROTOCOL_VERSION,
    REPLY_MAX_AGE_S,
)
from clawmeets.hub_protocol.envelope import AgentCert, Envelope, check_envelope_frame
from clawmeets.hub_protocol.constants import DISPATCH_TTL_S
from clawmeets.hub_protocol.ids import agent_ref, dispatched_message_id, parse_agent_ref
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project
from clawmeets.server.channels.hub_store import HubThread, RemoteAgent
from clawmeets.server.channels.store import HUB_CHANNEL, KIND_HUB_REQUEST, OutboxRow
from clawmeets.sync.changelog import (
    BatchCompletePayload,
    BatchTimeoutPayload,
    ChangelogEntryType,
    FilePayload,
    MessagePayload,
    ProjectCreatedPayload,
    RoomCreatedParticipant,
    RoomCreatedPayload,
)
from clawmeets.utils.file_io import FileUtil

from . import keys
from .adapter import INSPECTION_ACK_RESULT, AckFields, FilesNotTaken, file_name_ok
from .browser import HubError
from .trust import HubUntrusted, verify_deliver_route, verify_statement

if TYPE_CHECKING:
    from clawmeets.models.user import User

    from .runtime import HubRuntime

logger = logging.getLogger(__name__)

UC = "user-communication"
#: The hub connection row this server's requests travel on.
REQUESTER_AGENT_ID = "__requesters__"
REQUESTER_OWNER_ID = "__server__"
#: The drain after an owner disable, and the hub's drain-tuple lifetime.
DRAIN_S = 600
DRAIN_TUPLE_S = 24 * 3600
#: A statement's time may be at most this far ahead of ours to open a drain.
DISABLED_AT_AHEAD_S = 300
CLOSED_AGENT_UNLISTED = "agent_unlisted"
CLOSED_SUSPENDED = "deployment_suspended"
REASON_AGENT_UNLISTED = "agent_unlisted"
REASON_REJECTED_BY_HUB = "rejected_by_hub"
OWNER_DISABLED = "owner_disabled"
#: Reply outcomes stored with the reply's event id.
REPLY_APPENDED = "appended"
#: Reply wakes of an agent-started DM thread per day; past it the reply waits
#: for the user (plan-agent-access 4.1, loop protection).
THREAD_WAKES_PER_DAY = 20


@dataclass(frozen=True)
class SendResult:
    message_id: str
    row_id: str
    project_id: str


@dataclass(frozen=True)
class OutgoingFile:
    name: str
    mime: str
    data: bytes
    #: Already in the thread (the browser uploaded it there first): not written again.
    stored: bool = False


def _reply_entry_id(event_id: str) -> str:
    """The MESSAGE id of the reply with this event id: the same on every relay."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"clawmeets-hub-reply:{event_id}"))


class _Refused(Exception):
    def __init__(self, result: str, why: str) -> None:
        super().__init__(why)
        self.result = result


class RequesterMirror:
    def __init__(self, runtime: "HubRuntime") -> None:
        self.runtime = runtime

    @property
    def hub(self):
        return self.runtime.hub

    @property
    def store(self):
        return self.runtime.gateway.store

    @property
    def config(self):
        return self.runtime.config

    @property
    def _ctx(self):
        return self.runtime._ctx

    def _now(self) -> float:
        return self.runtime._now()

    def requests_connection(self) -> str:
        """The hub connection this server's requests travel on (made once)."""
        for connection in self.store.list_connections(REQUESTER_OWNER_ID):
            if connection.channel == HUB_CHANNEL and connection.agent_id == REQUESTER_AGENT_ID:
                return connection.id
        return self.store.create_connection(
            agent_id=REQUESTER_AGENT_ID, owner_id=REQUESTER_OWNER_ID, channel=HUB_CHANNEL,
            label="requests", secret="", fernet=self.config.fernet, now=self._now(),
        ).id

    # ── starting ─────────────────────────────────────────────────────────

    async def start_conversation(
        self, user: "User", hub_agent_id: str, client_thread_key: str, *,
        deployment_id: Optional[str] = None, deployment_name: Optional[str] = None,
        started_by=None,
    ) -> HubThread:
        """The user's thread with a remote agent (see the module docstring)."""
        await self.runtime.require_live(send=True)
        try:
            ref = parse_agent_ref(hub_agent_id)
        except ValueError:
            raise HubError("invalid_agent_id", "not a hub agent id") from None
        identity = self.runtime.identity()
        if identity is not None and ref.deployment_fingerprint == identity.genesis_fp:
            raise HubError("local_agent", "this agent is on this server")
        existing = self.hub.thread_for_key(user.id, client_thread_key)
        if existing is not None:
            return existing
        client = self.runtime.client
        try:
            pin = await keys.look_up_and_pin(
                client.request, self.hub, self.config, now=self._now(), deployment_id=deployment_id,
                fingerprint=ref.deployment_fingerprint, deployment_name=deployment_name,
            )
        except (keys.ChainUnverified, ConnectionError) as exc:
            logger.warning("Hub start: the target's key chain does not check out: %s", exc)
            raise HubError("hub_unreachable", "the agent's server could not be verified") from None
        if pin.genesis_fp != ref.deployment_fingerprint:
            raise HubError("invalid_agent_id", "the id is not the deployment's root")
        if pin.identity_changed_at is not None:
            raise HubError("identity_changed", "that server's identity changed")
        head = self.hub.chain(pin.genesis_fp)[-1]
        stand_in = self.hub.upsert_remote_agent(
            genesis_fp=pin.genesis_fp, agent_name=ref.agent_name,
            deployment_name=deployment_name or pin.deployment_name or pin.deployment_id or pin.genesis_fp,
            current_fp=head.fingerprint, deployment_id=pin.deployment_id, now=self._now(),
        )
        project_id = str(uuid.uuid4())
        thread = self.hub.open_thread(user_id=user.id, client_thread_key=client_thread_key,
                                      project_id=project_id, stand_in=stand_in, now=self._now(),
                                      started_by_agent_id=started_by.id if started_by is not None else None)
        await self._ensure_project(thread, stand_in, user, started_by=started_by)
        return thread

    async def _ensure_project(self, thread: HubThread, stand_in: RemoteAgent, user: "User",
                              started_by=None) -> Project:
        """The thread's Front Desk project; idempotent (a crash between the
        thread row and the project is finished by the next start)."""
        name = f"hub-{thread.project_id[:8]}"
        runloop = await self._ctx.runloop_manager.get_or_create(thread.project_id, name, user.id)
        if runloop.get_current_version() == 0:
            # The own-coordinator rule (plan-owner-isolation section 4): the
            # user coordinates their own thread, inertly (no runner, no wake);
            # the remote agent's stand-in is its counterpart.
            await runloop.append(ChangelogEntryType.PROJECT_CREATED, ProjectCreatedPayload(
                project_id=thread.project_id, project_name=name, coordinator_id=user.id,
                coordinator_name=user.username, counterpart_id=stand_in.id, counterpart_name=stand_in.display,
                request=f"Conversation with {stand_in.display}",
                created_by=user.id, agent_pool="self", surface="frontdesk", display_name=stand_in.display,
                # The thread holds a remote agent's words: it never feeds
                # memory. Its turns are full (the requester side runs at full
                # power; plan-owner-isolation section 3), fenced as outside content.
                memory_excluded=True,
            ))
        if Chatroom.get(thread.project_id, UC, self._ctx.model_ctx) is None:
            members = [RoomCreatedParticipant(id=user.id, name=user.username)]
            if started_by is not None:
                # The thread is the starting agent's inbox: it is a member, so
                # a reply can wake it here.
                members.append(RoomCreatedParticipant(id=started_by.id, name=started_by.name))
            await runloop.append(ChangelogEntryType.ROOM_CREATED, RoomCreatedPayload(
                chatroom_name=UC, participants=members,
            ))
        return Project.get(thread.project_id, self._ctx.model_ctx)

    # ── hub-ranked dispatch ──────────────────────────────────────────────

    def _principal(self, user: "User") -> dict[str, Any]:
        return {"kind": "user", "user_id": user.id, "username": user.username[:40],
                "display_name": (getattr(user, "display_name", None) or user.username)[:80]}

    def sign_ask(self, user: "User", *, ask_id: str, text: str, slots: Sequence[str],
                 exclude: Sequence[Mapping[str, str]] = ()) -> dict:
        """One DispatchAsk, signed by the identity key: the hub may route
        ``text`` to at most ``len(slots)`` agents, none in ``exclude``, for
        the next DISPATCH_TTL_S seconds. Each slot is the project id of the
        thread this server will open for whoever takes it."""
        identity = self.runtime.identity()
        if identity is None:
            raise HubError("hub_unreachable", "this server is not registered with the hub")
        now = self._now()
        return sign_object({
            "v": PROTOCOL_VERSION, "aud": self.config.hub_url, "ask_id": ask_id,
            "from_deployment": identity.deployment_id, "from_fingerprint": identity.fingerprint,
            "from_principal": self._principal(user), "text": text, "slots": list(slots),
            "exclude": [dict(e) for e in exclude], "sent_at": now, "expires_at": int(now) + DISPATCH_TTL_S,
        }, identity.key, purpose=Purpose.DISPATCH_ASK)

    def sign_outcome(self, *, ask_id: str, plan_id: str, events: Sequence[Mapping[str, Any]]) -> dict:
        """A DispatchOutcome (ids and kinds only), signed by the identity key."""
        identity = self.runtime.identity()
        if identity is None:
            raise HubError("hub_unreachable", "this server is not registered with the hub")
        return sign_object({
            "v": PROTOCOL_VERSION, "aud": self.config.hub_url, "ask_id": ask_id, "plan_id": plan_id,
            "from_deployment": identity.deployment_id, "from_fingerprint": identity.fingerprint,
            "events": [dict(e) for e in events], "ts": int(self._now()),
        }, identity.key, purpose=Purpose.DISPATCH_OUTCOME)

    async def open_dispatched_thread(self, user: "User", pick, *, ask_id: str, text: str) -> HubThread:
        """The thread for one pick of a live dispatch plan, under the slot the
        ask pre-committed (its project id). The hub delivers the request
        itself, so nothing is relayed from here: the request is appended as
        the user under ``dispatched_message_id(ask_id, slot)`` (the id the
        host acks and replies to) and recorded as a request row already
        forwarded, which the host's receipt completes like any other. From
        then on it is an ordinary hub thread: the reply checks and the
        binding to the pick's agent are unchanged. Idempotent."""
        identity = self.runtime.identity()
        if identity is None:
            raise HubError("hub_unreachable", "this server is not registered with the hub")
        genesis_fp, agent_name = pick.agent.deployment_fingerprint, pick.agent.agent_name
        if genesis_fp == identity.genesis_fp:
            raise HubError("local_agent", "this agent is on this server")
        slot = pick.slot
        thread = self.hub.thread_for_project(slot)
        if thread is None:
            try:
                pin = await keys.look_up_and_pin(
                    self.runtime.client.request, self.hub, self.config, now=self._now(),
                    deployment_id=pick.to_deployment, fingerprint=genesis_fp,
                    deployment_name=pick.deployment_name,
                )
            except (keys.ChainUnverified, ConnectionError, asyncio.TimeoutError) as exc:
                logger.warning("Hub dispatch: the pick's key chain does not check out: %s", exc)
                raise HubError("hub_unreachable", "the agent's server could not be verified") from None
            if pin.genesis_fp != genesis_fp:
                raise HubError("invalid_agent_id", "the id is not the deployment's root")
            if pin.identity_changed_at is not None:
                raise HubError("identity_changed", "that server's identity changed")
            head = self.hub.chain(pin.genesis_fp)[-1]
            stand_in = self.hub.upsert_remote_agent(
                genesis_fp=pin.genesis_fp, agent_name=agent_name,
                deployment_name=pick.deployment_name or pin.deployment_name or pin.genesis_fp,
                current_fp=head.fingerprint, deployment_id=pin.deployment_id, now=self._now(),
            )
            thread = self.hub.open_thread(user_id=user.id, client_thread_key=f"dispatch:{ask_id}:{slot}",
                                          project_id=slot, stand_in=stand_in, now=self._now())
        if thread.user_id != user.id or thread.project_id != slot \
                or thread.stand_in_id != agent_ref(genesis_fp, agent_name):
            raise HubError("project_not_found", "the slot belongs to another conversation")
        stand_in = self.hub.remote_agent(thread.stand_in_id)
        project = await self._ensure_project(thread, stand_in, user)
        now = self._now()
        message_id = dispatched_message_id(ask_id, slot)
        runloop = await self._ctx.runloop_manager.get_or_create(project.id, project.name, project.coordinator_id)
        existing = {getattr(e.payload, "id", None): e for e in runloop.get_entries_since(0)
                    if e.entry_type == ChangelogEntryType.MESSAGE}
        if message_id in existing:
            version = existing[message_id].version
        else:
            entry = await runloop.append(ChangelogEntryType.MESSAGE, MessagePayload(
                chatroom_name=UC, id=message_id, ts=datetime.fromtimestamp(now, UTC),
                from_participant_id=user.id, from_participant_name=user.username, content=text,
            ))
            version = entry.version
        self.hub.enqueue_dispatched_request(
            connection_id=self.requests_connection(), target_genesis_fp=thread.genesis_fp,
            project_id=slot, message_id=message_id, conversation_key=f"{identity.genesis_fp}/{slot}",
            text=text, now=now,
        )
        tracker = getattr(self._ctx, "work_tracker", None)
        if tracker is not None and await tracker.get_pending_work(slot, UC) is None:
            try:
                await tracker.create_pending_work(
                    message_id=message_id, message_version=version, project_id=slot,
                    project_name=project.name, chatroom_name=UC, coordinator_id=project.created_by,
                    expected_participants=[thread.stand_in_id], awaiting_delivery=True,
                )
            except ValueError:
                pass
        # The host's receipt may have beaten this row (the hub delivers right
        # after its plan, while the picks' keys were being pinned here).
        client = self.runtime.client
        if client is not None:
            await client.replay_early_receipt(message_id)
        await self._broadcast(project, runloop.get_current_version())
        return thread

    # ── sending ──────────────────────────────────────────────────────────

    async def send(
        self, user: "User", project_id: str, *, text: str, client_message_id: str,
        files: Sequence[OutgoingFile] = (), via_agent: Optional[str] = None, author=None,
    ) -> SendResult:
        """One message from the user to the thread's remote agent."""
        await self.runtime.require_live(send=True)
        thread = self.hub.thread_for_project(project_id)
        if thread is None or thread.user_id != user.id:
            raise HubError("project_not_found", "no such hub conversation")
        if thread.closed_at is not None:
            code = thread.closed_reason if thread.closed_reason in (
                "key_revoked", "identity_changed", "agent_unlisted") else "conversation_closed"
            raise HubError(code, "the conversation is closed", closed_reason=thread.closed_reason)
        self._check_caps(text, files)
        stand_in = self.hub.remote_agent(thread.stand_in_id)
        identity = self.runtime.identity()
        target = self.hub.chain(thread.genesis_fp)
        if stand_in is None or identity is None or not target or target[-1].deployment_id is None:
            raise HubError("hub_unreachable", "the agent's server is not known here")
        now = self._now()
        message_id = self.hub.claim_send(user.id, project_id, client_message_id, str(uuid.uuid4()), now=now)
        refs = [{"index": i, "name": f.name, "mime": f.mime, "size": len(f.data),
                 "sha256": hashlib.sha256(f.data).hexdigest()} for i, f in enumerate(files)]
        body: dict[str, Any] = {"text": text}
        if refs:
            body["files"] = refs
        envelope = sign_object({
            "v": PROTOCOL_VERSION, "type": "message", "aud": self.config.hub_url, "message_id": message_id,
            "from_deployment": identity.deployment_id, "from_fingerprint": identity.fingerprint,
            "from_principal": {"kind": "user", "user_id": user.id, "username": user.username[:40],
                               "display_name": (getattr(user, "display_name", None) or user.username)[:80],
                               # Signed: B sees "sent by their agent X"; absent for the user's own sends.
                               **({"via_agent": via_agent} if via_agent else {})},
            "to_deployment": target[-1].deployment_id, "to_agent": stand_in.agent_name,
            "requester_project_id": project_id, "conversation_key": f"{identity.genesis_fp}/{project_id}",
            "sent_at": now, "body": body,
        }, identity.key, purpose=Purpose.ENVELOPE)
        size = len(json.dumps(envelope, separators=(",", ":")).encode("utf-8")) + sum(len(f.data) for f in files)
        if size > MAX_ENVELOPE_BYTES:
            raise HubError("payload_too_large", "the message is too large", limit="envelope",
                           max=MAX_ENVELOPE_BYTES, actual=size)
        project = Project.get(project_id, self._ctx.model_ctx)
        runloop = await self._ctx.runloop_manager.get_or_create(project.id, project.name, project.coordinator_id)
        existing = {getattr(e.payload, "id", None): e for e in runloop.get_entries_since(0)
                    if e.entry_type == ChangelogEntryType.MESSAGE}
        if message_id not in existing:
            for f in files:
                if f.stored:
                    continue
                await runloop.append(ChangelogEntryType.FILE_CREATED, FilePayload(
                    chatroom_name=UC, filename=f.name, content_b64=FileUtil.to_base64(f.data),
                    sha256=hashlib.sha256(f.data).hexdigest(), from_participant_id=user.id,
                    from_participant_name=user.username,
                ))
            entry = await runloop.append(ChangelogEntryType.MESSAGE, MessagePayload(
                chatroom_name=UC, id=message_id, ts=datetime.fromtimestamp(now, UTC),
                from_participant_id=author.id if author is not None else user.id,
                from_participant_name=author.name if author is not None else user.username,
                content=text,
            ))
            version = entry.version
        else:
            version = existing[message_id].version
        row_id = self.hub.enqueue_hub_request(
            connection_id=self.requests_connection(), target_genesis_fp=thread.genesis_fp,
            project_id=project_id, message_id=message_id, envelope=envelope, now=now,
        )
        tracker = getattr(self._ctx, "work_tracker", None)
        if tracker is not None and await tracker.get_pending_work(project_id, UC) is None:
            try:
                await tracker.create_pending_work(
                    message_id=message_id, message_version=version, project_id=project_id,
                    project_name=project.name, chatroom_name=UC, coordinator_id=project.created_by,
                    expected_participants=[thread.stand_in_id], awaiting_delivery=True,
                )
            except ValueError:
                pass                                    # a racing send opened it
        await self._broadcast(project, runloop.get_current_version())
        return SendResult(message_id=message_id, row_id=row_id, project_id=project_id)

    @staticmethod
    def _check_caps(text: str, files: Sequence[OutgoingFile]) -> None:
        """The caps a browser is told about (``payload_too_large`` [413] with
        ``{limit, max, actual, file_id?}``); the envelope's is checked once signed."""
        text_bytes = len(text.encode("utf-8", "surrogatepass"))
        if text_bytes > MAX_TEXT_BYTES:
            raise HubError("payload_too_large", "the text is too long", limit="text",
                           max=MAX_TEXT_BYTES, actual=text_bytes)
        if len(files) > MAX_FILES:
            raise HubError("payload_too_large", "too many files", limit="files", max=MAX_FILES,
                           actual=len(files))
        for f in files:
            if not file_name_ok(f.name):
                raise HubError("file_not_found", "no such file in this conversation", file_id=f.name)
            if not 0 < len(f.data) <= MAX_FILE_BYTES:
                raise HubError("payload_too_large", "a file is too large", limit="file",
                               max=MAX_FILE_BYTES, actual=len(f.data), file_id=f.name)

    def files_for(self, row: OutboxRow) -> list[tuple[int, bytes]]:
        """The HubClient's ``files_for``: a request's files, read back from its
        project and checked against the signed FileRefs."""
        if row.kind != KIND_HUB_REQUEST or not row.envelope or not row.project_id:
            return []
        try:
            import json

            refs = (json.loads(row.envelope).get("body") or {}).get("files") or []
        except ValueError:
            return []
        if not refs:
            return []
        room = Chatroom.get(row.project_id, UC, self._ctx.model_ctx)
        out = []
        for ref in refs:
            ok = isinstance(ref.get("name"), str) and file_name_ok(ref["name"])
            data = room.get_file(ref["name"]) if room is not None and ok else None
            if data is None or hashlib.sha256(data).hexdigest() != ref["sha256"]:
                logger.warning("Hub request file %s is no longer in its project: not sent", ref["index"])
                continue
            out.append((ref["index"], data))
        return out

    async def _broadcast(self, project: Project, version: int) -> None:
        from clawmeets.server.routes.messages import _broadcast_changelog

        try:
            await _broadcast_changelog(self._ctx, project, version)
        except Exception as exc:  # noqa: BLE001 — a push never undoes the write
            logger.warning("Hub thread push failed: %s", type(exc).__name__)

    # ── replies ──────────────────────────────────────────────────────────

    async def on_reply(self, parsed) -> None:
        """A reply delivered to this server (see the module docstring)."""
        data = parsed.data
        raw = data.get("envelope")
        if not isinstance(raw, Mapping):
            return
        message_id, sender = raw.get("message_id"), raw.get("from_deployment")
        if not isinstance(message_id, str) or not isinstance(sender, str):
            return
        if not verify_deliver_route(data, hub=self.hub, config=self.config, now=self._now()):
            logger.warning("Hub reply with a route stamp that does not verify: dropped")
            return
        try:
            envelope, thread, genesis = await self._check_reply(raw)
        except _Refused as refused:
            logger.warning("Hub reply refused (%s): %s; nothing appended", refused.result, refused)
            self.runtime.adapter.drop_files(message_id)
            await self._ack(message_id, sender, AckFields(result=refused.result))
            return
        if envelope.body.files and not self._reply_appended(
                thread, _reply_entry_id(f"{genesis}/{envelope.message_id}")):
            # Its files follow the frame on the socket: waited for off the
            # inbound worker, so a slow sender holds up nothing else.
            self.runtime.adapter.track(self._take_reply_with_files(envelope, thread, genesis, sender))
            return
        self.runtime.adapter.drop_files(message_id)
        await self._take_reply(envelope, thread, genesis, sender)

    async def _take_reply_with_files(self, envelope: Envelope, thread: HubThread, genesis: str,
                                     sender: str) -> None:
        """Every file checked against its signed FileRef (``collect_files``)
        before anything is recorded: a reply whose files do not all arrive
        intact is answered and stores nothing; one interrupted by a socket
        drop is not answered, so B relays it again."""
        try:
            data = await self.runtime.adapter.collect_files(envelope)
        except FilesNotTaken as not_taken:
            if not_taken.ack is not None:
                await self._ack(envelope.message_id, sender, not_taken.ack)
            return
        files = [(ref.name, data[ref.index]) for ref in envelope.body.files or []]
        await self._take_reply(envelope, thread, genesis, sender, files=files)

    async def _take_reply(self, envelope: Envelope, thread: HubThread, genesis: str, sender: str, *,
                          files: Sequence[tuple[str, bytes]] = ()) -> None:
        event_id = f"{genesis}/{envelope.message_id}"
        entry_id = _reply_entry_id(event_id)
        connection_id = self.requests_connection()
        self.store.record_event(connection_id, event_id, outcome=REPLY_APPENDED,
                                current_state=DeliverResult.PICKED_UP.value, now=self._now())
        # The thread itself is the dedupe: the reply's MESSAGE carries an id
        # derived from the event, so a re-relay after a cancel or crash
        # between recording and appending appends it then, and once only.
        duplicate = self._reply_appended(thread, entry_id)
        verdict = "pass"
        if not duplicate:
            verdict = await self._append_reply(thread, envelope, entry_id=entry_id, event_id=event_id,
                                               files=files)
        if envelope.in_reply_to:                # idempotent: also finishes an interrupted first relay
            await self.runtime.gateway.note_late_reply(connection_id, envelope.in_reply_to,
                                                       project_id=thread.project_id)
        if duplicate:
            await self._ack(envelope.message_id, sender, AckFields(
                result=DeliverResult.DUPLICATE.value, original_result=DeliverResult.ACCEPTED.value,
                current_state=DeliverResult.PICKED_UP.value))
        elif verdict in INSPECTION_ACK_RESULT:  # held or blocked by the inspection hook
            await self._ack(envelope.message_id, sender, AckFields(result=INSPECTION_ACK_RESULT[verdict]))
        else:
            await self._ack(envelope.message_id, sender, AckFields(result=DeliverResult.ACCEPTED.value))

    def reply_file_pool(self, raw: Mapping[str, Any]) -> Optional[tuple[str, bool]]:
        """Where a reply's file chunks may go (``HubAdapter._file_pool``'s
        rule, for an agent-signed reply): only a reply naming a hub thread
        here whose agent is on the sending deployment. A sender pinned here,
        live, whose agent certificate verifies under that chain and whose
        envelope verifies under the certificate's key: the main pool, its
        share keyed by the genesis. A sender not pinned yet: the small
        unverified pool. Anything else: nowhere."""
        identity = self.runtime.identity()
        if identity is None or not self._solicited(raw, identity.genesis_fp, raw.get("from_deployment")):
            return None
        fp = raw.get("from_fingerprint")
        pin = self.hub.pin_for(fp) if isinstance(fp, str) else None
        if pin is None:
            return "", False
        if (pin.deployment_id != raw.get("from_deployment") or pin.revoked_at is not None
                or pin.identity_changed_at is not None):
            return None
        principal = raw.get("from_principal")
        cert = principal.get("cert") if isinstance(principal, Mapping) else None
        issuer = self.hub.pin_for(cert.get("issuer_fp", "")) if isinstance(cert, Mapping) else None
        if (issuer is None or issuer.genesis_fp != pin.genesis_fp or issuer.revoked_at is not None
                or not verify_object(cert, issuer.pubkey, purpose=Purpose.AGENT_CERT)):
            return None
        try:
            agent_pub = b64url_decode(str(cert.get("agent_pubkey", "")), length=32)
        except ValueError:
            return None
        return (pin.genesis_fp, True) if verify_object(raw, agent_pub, purpose=Purpose.ENVELOPE) else None

    async def _check_reply(self, raw: Mapping[str, Any]) -> tuple[Envelope, HubThread, str]:
        identity = self.runtime.identity()
        if identity is None:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "no registration here")
        fp, sender = raw.get("from_fingerprint"), raw.get("from_deployment")
        principal = raw.get("from_principal")
        if not isinstance(principal, Mapping) or principal.get("kind") != "agent":
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "not an agent's reply")
        try:
            pin = self.hub.pin_for(fp) if isinstance(fp, str) else None
            if pin is None and self.runtime.client is not None:
                if not self._solicited(raw, identity.genesis_fp, sender):
                    raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "no thread here awaits this sender")
                pin = await keys.look_up_and_pin(
                    self.runtime.client.request, self.hub, self.config, now=self._now(),
                    deployment_id=sender, fingerprint=fp if isinstance(fp, str) else None,
                )
        except (keys.ChainUnverified, ConnectionError, asyncio.TimeoutError) as exc:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, f"key lookup: {type(exc).__name__}") from None
        if pin is None or pin.deployment_id != sender:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the sender is not pinned")
        if pin.identity_changed_at is not None:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the sender's identity changed")
        cert = principal.get("cert")
        issuer = self.hub.pin_for(cert.get("issuer_fp", "")) if isinstance(cert, Mapping) else None
        if (issuer is None or issuer.genesis_fp != pin.genesis_fp or issuer.revoked_at is not None
                or not verify_object(cert, issuer.pubkey, purpose=Purpose.AGENT_CERT)):
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the agent certificate does not verify")
        try:
            parsed_cert = AgentCert.model_validate(cert)
        except ValidationError:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the certificate does not fit") from None
        if parsed_cert.hub_url != self.config.hub_url or parsed_cert.not_after < self._now():
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the certificate is for another hub or expired")
        try:
            agent_pub = b64url_decode(parsed_cert.agent_pubkey, length=32)
        except ValueError:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "bad agent key") from None
        if not verify_object(raw, agent_pub, purpose=Purpose.ENVELOPE):
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the reply's signature does not verify")
        try:
            envelope = Envelope.model_validate(raw)
        except ValidationError:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the reply does not fit") from None
        if envelope.type != "message" or envelope.to_agent is not None:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "not a host's message")
        code = check_envelope_frame(envelope, expected_aud=self.config.hub_url, me=identity.deployment_id,
                                    now=self._now(), max_age_s=REPLY_MAX_AGE_S)
        if code is not None:
            result = DeliverResult.STALE.value if code.value == "stale" else DeliverResult.SENDER_UNTRUSTED.value
            raise _Refused(result, f"reply check: {code.value}")
        # The binding: this project, this stand-in, this root, this agent.
        project_id = envelope.requester_project_id
        if envelope.conversation_key != f"{identity.genesis_fp}/{project_id}":
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the reply names another conversation")
        thread = self.hub.thread_for_project(project_id)
        if thread is None or thread.stand_in_id != agent_ref(pin.genesis_fp, parsed_cert.agent_name) \
                or thread.genesis_fp != pin.genesis_fp or thread.agent_name != parsed_cert.agent_name \
                or envelope.from_principal.agent_name != parsed_cert.agent_name:
            raise _Refused(DeliverResult.SENDER_UNTRUSTED.value, "the reply is not from this thread's agent")
        if thread.closed_at is not None and not self._drain_allows(thread, envelope):
            raise _Refused(DeliverResult.NOT_ACCEPTING.value, "the conversation is closed")
        return envelope, thread, pin.genesis_fp

    def _solicited(self, raw: Mapping[str, Any], own_genesis: str, sender: Any) -> bool:
        """Before an unknown key is looked up (and pinned): the reply names a
        stand-in thread here, under this deployment's root, whose agent is
        on the sending deployment. An unsolicited reply costs no lookup."""
        project_id = raw.get("requester_project_id")
        if not isinstance(project_id, str) or raw.get("conversation_key") != f"{own_genesis}/{project_id}":
            return False
        thread = self.hub.thread_for_project(project_id)
        stand_in = self.hub.remote_agent(thread.stand_in_id) if thread is not None else None
        return stand_in is not None and stand_in.deployment_id == sender

    def _drain_allows(self, thread: HubThread, envelope: Envelope) -> bool:
        """A closed thread's drain window (see the module docstring)."""
        now = self._now()
        if thread.closed_reason != CLOSED_AGENT_UNLISTED or thread.drain_until is None:
            return False
        if now >= thread.drain_until or not envelope.in_reply_to:
            return False
        row = self.hub.request_row(thread.project_id, envelope.in_reply_to)
        if row is None or thread.closed_at is None:
            return False
        return row.created_at <= thread.closed_at and now - row.created_at < DRAIN_TUPLE_S

    def _reply_appended(self, thread: HubThread, entry_id: str) -> bool:
        room = Chatroom.get(thread.project_id, UC, self._ctx.model_ctx)
        return room is not None and any(m.id == entry_id for m in room.get_messages())

    def _reply_wakes(self, thread: Optional[HubThread]) -> list[str]:
        agent_id = thread.started_by_agent_id if thread is not None else None
        if not agent_id:
            return []
        day = datetime.fromtimestamp(self._now(), UTC).strftime("%Y-%m-%d")
        return [agent_id] if self.hub.take_wake(thread.project_id, day=day, cap=THREAD_WAKES_PER_DAY) else []

    async def _append_reply(self, thread: HubThread, envelope: Envelope, *, entry_id: str,
                            event_id: Optional[str] = None, files: Sequence[tuple[str, bytes]] = ()) -> str:
        """Admit the reply through the inspection hook (path ``hub_reply_dm``),
        then append it with its files (``incoming_file_payloads``). Returns the
        verdict (``pass`` | ``hold`` | ``block``): a held or blocked reply is
        not appended (the hook notes the thread)."""
        from clawmeets.server.inspection import InspectionRequest, OutsidePath, file_refs

        from .room_bridge import incoming_file_payloads

        if thread.kind == "room_bridge":
            # A room-bridge thread: admitted against its workroom (path
            # hub_reply_bridge), then mirrored there (room_bridge.py).
            return await self.runtime.bridge.on_reply(thread, envelope, entry_id=entry_id, event_id=event_id,
                                                      files=files)
        project = Project.get(thread.project_id, self._ctx.model_ctx)
        stand_in = self.hub.remote_agent(thread.stand_in_id)
        name = stand_in.display if stand_in is not None else thread.agent_name
        payloads = incoming_file_payloads(name, thread.stand_in_id, UC, files)
        ticket = None
        ingress = getattr(self._ctx, "outside_ingress", None)
        if ingress is not None:
            admission = await ingress.admit(InspectionRequest(
                path=OutsidePath.HUB_REPLY_DM, direction="inbound", owner_user_id=project.created_by or "",
                project_id=project.id, chatroom=UC, author_id=thread.stand_in_id, author_label=name,
                text=envelope.body.text, files=file_refs(payloads), source_ref=event_id or entry_id,
            ), replay={"project_id": project.id, "stand_in_id": thread.stand_in_id, "name": name,
                       "entry_id": entry_id, "text": envelope.body.text,
                       "files": [p.model_dump(mode="json") for p in payloads]})
            if not admission.passed:
                if admission.verdict.value == "block":
                    # The hook noted the thread; the waiting slot closes now,
                    # with its reason, rather than on the batch clock.
                    await self.close_stand_in_slot(project, UC, thread.stand_in_id, reason="blocked")
                return admission.verdict.value
            ticket = admission.ticket
        await self._store_reply(project, thread.stand_in_id, name, entry_id, envelope.body.text, ticket,
                                files=payloads)
        return "pass"

    async def close_stand_in_slot(self, project: Project, room: str, stand_in_id: str, *,
                                  reason: Optional[str]) -> None:
        """Close the stand-in's slot in the room's open batch: recorded as
        answered while others are still due, else the batch ends with a
        BATCH_TIMEOUT naming the stand-in and ``reason``. No open batch
        waiting on it: nothing."""
        tracker = getattr(self._ctx, "work_tracker", None)
        work = await tracker.get_pending_work(project.id, room) if tracker is not None else None
        if work is None or stand_in_id not in work.expected_participants \
                or stand_in_id in work.responded_participants:
            return
        if any(p != stand_in_id and p not in work.responded_participants for p in work.expected_participants):
            await tracker.record_response(project.id, room, stand_in_id)
            return
        await tracker.clear_pending_work(project.id, room)
        runloop = await self._ctx.runloop_manager.get_or_create(project.id, project.name, project.coordinator_id)
        entry = await runloop.append(ChangelogEntryType.BATCH_TIMEOUT, BatchTimeoutPayload(
            chatroom_name=room, message_id=work.message_id, coordinator_id=work.coordinator_id,
            responded_participants=list(work.responded_participants),
            timed_out_participants=[stand_in_id], reason=reason,
        ), source_version=work.message_version)
        await self._broadcast(project, entry.version)

    async def block_held_reply(self, replay: Mapping[str, Any]) -> None:
        """A held reply blocked on release: the waiting slot closes with
        reason ``blocked``, as on a live block."""
        try:
            project = Project.get(replay["project_id"], self._ctx.model_ctx)
        except ValueError:
            return
        await self.close_stand_in_slot(project, UC, replay["stand_in_id"], reason="blocked")

    async def deliver_held_reply(self, replay: Mapping[str, Any], ticket: Any) -> None:
        """A held reply released on reopen: appended as it would have been."""
        try:
            project = Project.get(replay["project_id"], self._ctx.model_ctx)
        except ValueError:
            return
        await self._store_reply(project, replay["stand_in_id"], replay["name"], replay["entry_id"],
                                replay["text"], ticket,
                                files=[FilePayload.model_validate(f) for f in replay.get("files") or ()])

    async def store_incoming_files(self, runloop, project: Project, files: Sequence[FilePayload],
                                   ticket: Any) -> None:
        """Append a reply's files (already confined) before its MESSAGE, on the
        reply's ticket. A file already in the room as it is is not appended
        again (a re-delivery after a crash between the two)."""
        for payload in files:
            room = Chatroom.get(project.id, payload.chatroom_name, self._ctx.model_ctx)
            have = room.get_file(payload.filename) if room is not None else None
            if have is not None and hashlib.sha256(have).hexdigest() == payload.sha256:
                continue
            await runloop.append(ChangelogEntryType.FILE_CREATED, payload, ingress_ticket=ticket)

    async def _store_reply(self, project: Project, stand_in_id: str, name: str, entry_id: str,
                           text: str, ticket: Any, *, files: Sequence[FilePayload] = ()) -> None:
        runloop = await self._ctx.runloop_manager.get_or_create(project.id, project.name, project.coordinator_id)
        await self.store_incoming_files(runloop, project, [f.model_copy(update={"chatroom_name": UC})
                                                           for f in files], ticket)
        entry = await runloop.append(ChangelogEntryType.MESSAGE, MessagePayload(
            chatroom_name=UC, id=entry_id, ts=datetime.fromtimestamp(self._now(), UTC),
            from_participant_id=stand_in_id, from_participant_name=name,
            content=text,
            # An agent-started thread: the reply wakes that agent, here, in a
            # full turn, its text fenced as outside content — at most 20 a day,
            # then it waits for the user. Mentions in remote text are never
            # parsed for dispatch.
            expects_response_from=self._reply_wakes(self.hub.thread_for_project(project.id)),
        ), ingress_ticket=ticket)
        version = entry.version
        tracker = getattr(self._ctx, "work_tracker", None)
        work = await tracker.record_response(project.id, UC, stand_in_id) if tracker else None
        if work is not None and work.is_complete:
            await tracker.clear_pending_work(project.id, UC)
            batch = await runloop.append(ChangelogEntryType.BATCH_COMPLETE, BatchCompletePayload(
                chatroom_name=UC, message_id=work.message_id, coordinator_id=work.coordinator_id,
                responded_participants=list(work.responded_participants),
            ), source_version=work.message_version)
            version = batch.version
        await self._broadcast(project, version)

    def _sign_ack(self, message_id: str, to_deployment: str, fields: AckFields) -> Optional[dict]:
        from clawmeets.hub_protocol.frames import DeliverAck

        identity = self.runtime.identity()
        if identity is None:
            return None
        try:
            ack = DeliverAck(
                aud=self.config.hub_url, message_id=message_id, to_deployment=to_deployment,
                result=fields.result, detail=fields.detail, original_result=fields.original_result,
                current_state=fields.current_state, at=int(self._now()), from_fingerprint=identity.fingerprint,
            )
        except ValidationError:
            return None
        return sign_object(to_wire(ack), identity.key, purpose=Purpose.DELIVER_ACK)

    async def _ack(self, message_id: str, to_deployment: str, fields: AckFields) -> None:
        signed = self._sign_ack(message_id, to_deployment, fields)
        if signed is None or self.runtime.client is None:
            return
        try:
            await self.runtime.client.send("deliver_ack", signed)
        except Exception as exc:  # noqa: BLE001 — B re-relays
            logger.info("Hub reply ack not sent: %s", type(exc).__name__)

    # ── statements ───────────────────────────────────────────────────────

    async def on_statement(self, raw: Mapping[str, Any]) -> None:
        kind = raw.get("kind") if isinstance(raw, Mapping) else None
        if kind not in (StatementKind.AGENT_DELISTED.value, StatementKind.DEPLOYMENT_SUSPENDED.value):
            logger.info("Hub statement %s noted", kind)
            return
        subject_fp = raw.get("subject_fingerprint")
        try:
            statement = verify_statement(
                raw, hub=self.hub, config=self.config, now=self._now(), kind=kind,
                fingerprint=subject_fp if isinstance(subject_fp, str) else "",
                deployment_id=raw.get("subject_deployment_id"),
            )
        except HubUntrusted as exc:
            logger.warning("Hub %s statement not trusted: %s", kind, exc.reason)
            return
        genesis = self.hub.genesis_of(statement.subject_fingerprint or "")
        if genesis is None:
            return                                       # a deployment never met here
        now = self._now()
        if kind == StatementKind.AGENT_DELISTED.value:
            if not statement.subject_agent:
                return
            await self._agent_delisted(agent_ref(genesis, statement.subject_agent), statement, now=now)
        else:
            projects = self.hub.close_threads_for_root(genesis, reason=CLOSED_SUSPENDED, now=now)
            await self._fail_waiting(projects, REASON_REJECTED_BY_HUB, now=now)

    async def _agent_delisted(self, stand_in_id: str, statement, *, now: float) -> None:
        at = float(statement.at)
        drain = statement.reason == OWNER_DISABLED and at - now <= DISABLED_AT_AHEAD_S
        projects = []
        for thread in self.hub.threads_for_stand_in(stand_in_id):
            if thread.closed_at is not None:
                continue
            if self.hub.close_thread(thread.project_id, reason=CLOSED_AGENT_UNLISTED, now=now,
                                     drain_until=at + DRAIN_S if drain else None):
                projects.append(thread.project_id)
        await self._fail_waiting(projects, REASON_AGENT_UNLISTED, now=now)
        await self.runtime.retained.agent_delisted(stand_in_id)

    async def _fail_waiting(self, project_ids: list[str], reason: str, *, now: float) -> None:
        """Requests of these threads not yet with the target fail ``reason``."""
        if not project_ids:
            return
        connection_id = self.requests_connection()
        for row_id in self.hub.fail_open_rows(connection_id, reason=reason, now=now, project_ids=project_ids):
            await self.runtime.gateway._hub_row_changed(row_id)
