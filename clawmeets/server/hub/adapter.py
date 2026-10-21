# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/adapter.py
``HubAdapter``: the host side (B). Another deployment's requester messages
one of this server's public agents; this is where that message is checked,
decided, answered and replied to.

**Inbound** (``on_deliver``), in order:

1. The hub's route stamp must verify under a trusted hub key, else the frame
   is dropped (the hub is not who it says).
2. The envelope is checked against the SENDER's key as pinned here (a
   ``key_lookup`` pins the chain on first contact): signature, schema, aud,
   addressed to this deployment, age (72 h + skew), a user principal, an agent
   of this server with a Hub channel, and a conversation key whose prefix is
   the sender's genesis root. Any failure is answered with a signed
   ``sender_untrusted`` (``stale`` for age) and NOTHING is stored, so a
   hostile hub cannot pre-store a refusal against a real message id.
3. The conversation key is DERIVED, ``{genesis}/{requester_project_id}``,
   and the event id is ``{genesis}/{message_id}``. The sender is the USER
   (``{genesis}~{user_id}``) even when one of their agents sent it: the
   signed ``via_agent`` is kept, cleaned, only as a label for the owner
   ("sent by their agent X"), never in a key, so contacts, Requests, blocks
   and rate limits treat the user and all their agents as one person.
4. The gateway decides (``handle_hub_events``: channel off, deployment
   blocks, then the adapter's own refusals — browse-only, the daily run cap —
   then the same path as every webhook: allowlist, Requests, the fill rule,
   rate limits). The outcome is stored with the event id; a repeat is
   answered ``duplicate`` with the original outcome and where the message is
   now. The receiver is the only dedupe authority: the agent never runs twice.
5. The answer is a ``deliver_ack`` signed by the identity key over the whole
   ack minus sig.

**Where a kept message is** (``current_state``): ``accepted`` (buffered for an
agent whose runner is connected; ``picked_up`` once in its thread),
``held_agent_offline`` (its runner is not connected: in the thread, not yet
with the agent), ``held_for_approval`` (a Request). A signed ``picked_up``
goes to the requester when the runner comes back (``agent_connected``) or
the owner allows the Request (``on_allowed``). ``deliver_probe`` is answered
from the stored outcome, or ``unknown_message`` once it was pruned.

**The pending-Requests fill rule.** At most 5 pending Requests per remote
root; and once the connection's queue is 80% full, a new Request from a root
first pinned less than 7 days ago is refused ``not_accepting`` /
``requests_full``. Nothing is ever evicted.

**Agents' Hub channels.** ``enable`` makes the agent's own key (a ``hub``
connection row, its secret the key, encrypted like any credential), issues a
30-day certificate from the identity key and lists the agent
(``agent_register``, the listing signed by the agent key); every (re)connect
renews certificates near expiry and lists every enabled channel again.
``disable`` is local and immediate in every mode (inbound is refused
``channel_off``); the signed ``agent_unregister`` (``disabled_at`` = now, never
later) goes now or on the next connect. Reply rows already queued drain for
10 minutes after ``disabled_at`` and then fail ``channel_disabled``; with
``stop_now`` they fail at once.

**Replies** (``prepare_relay``) are signed once, at their first relay, by the
agent's key, carrying its full certificate, and answer (``in_reply_to``) the
newest message of the conversation.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import shutil
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Mapping, Optional, Union

from cryptography.fernet import InvalidToken
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import (
    Purpose,
    b64url,
    b64url_decode,
    sign_object,
    to_wire,
    verify_object,
)
from clawmeets.hub_protocol.codes import DeliverResult, ErrorCode, NotAcceptingDetail, UnregisterReason
from clawmeets.hub_protocol.constants import (
    FILE_HEADER_BYTES,
    MAX_ENVELOPE_AGE_S,
    MAX_ENVELOPE_BYTES,
    MAX_FILE_BYTES,
    MAX_FILES,
    PROTOCOL_VERSION,
)
from clawmeets.hub_protocol.envelope import Envelope, check_envelope_frame, parse_file_stream_header
from clawmeets.hub_protocol.text import TextField, clean_remote_text
from clawmeets.hub_protocol.frames import (
    AgentUnregister,
    DeliverAck,
    Listing,
    ParsedFrame,
    sign_listing,
)
from clawmeets.models.agent import Agent
from clawmeets.server.channels import access
from clawmeets.server.channels.adapter import InboundEvent, Parked, Refused, RelayOutcome, VerifiedHubEvent
from clawmeets.server.channels.email_text import clean_filename
from clawmeets.server.channels.hub_delivery import HELD_CEILING_SECONDS
from clawmeets.server.isolation_notice import HUB_DETAIL as HUB_ISOLATION_DETAIL
from clawmeets.server.channels.hub_store import HubChannelState, HubStore, Pin
from clawmeets.server.channels.store import (
    EVENT_HELD_AGENT_OFFLINE,
    EVENT_HELD_ISOLATION,
    EVENT_PICKED_UP,
    HUB_CHANNEL,
    KIND_HUB_REQUEST,
    REQUEST_PENDING,
    WAIT_HUB_UNREACHABLE,
    ChannelConnection,
    InboundDecision,
    OutboxRow,
    Outcome,
)
from clawmeets.sync.changelog import ChangelogEntryType, FilePayload
from clawmeets.sync.runloop import BatchEntrySpec
from clawmeets.utils.file_io import FileUtil

from . import keys
from .browser import DAILY_RUN_CAP, HubError
from .trust import verify_deliver_route

if TYPE_CHECKING:
    from .runtime import HubRuntime

logger = logging.getLogger(__name__)

#: The fill rule (design: abuse row).
MAX_PENDING_PER_ROOT = 5
FILL_FRACTION = 0.8
PROBATION_S = 7 * 86400
#: Replies queued when the owner turns the channel off keep sending this long.
DRAIN_S = 600
#: How long the files of one delivery may take to arrive after its frame.
FILES_TIMEOUT_S = 60.0
#: A file buffer no verified message took over goes after this long.
#: Two pools. The MAIN pool is for a sender already pinned here whose envelope
#: signature checks out as its frame is read: at most this many buffers,
#: declaring at most this many bytes, in all, and one sender (keyed by its
#: VERIFIED genesis, never the deployment id it claims) holds at most its own
#: share, so one sender declaring files it never sends cannot starve the
#: others. Every sender not pinned yet shares the small UNVERIFIED pool, so
#: any number of forged or new deployments can never fill the main one. (A
#: first contact whose files find no room is pinned by the check of its
#: envelope all the same, so the requester's next relay uses the main pool.)
FILE_BUFFER_MAX_AGE_S = FILES_TIMEOUT_S + 30.0
MAX_FILE_BUFFERS = 32
FILE_BUFFER_BUDGET = 128 * 2**20
MAX_FILE_BUFFERS_PER_SENDER = 4
FILE_BUFFER_BUDGET_PER_SENDER = MAX_ENVELOPE_BYTES
MAX_UNVERIFIED_FILE_BUFFERS = 4
UNVERIFIED_FILE_BUFFER_BUDGET = MAX_ENVELOPE_BYTES
#: Beside a staged message's files: its connection and event id.
STAGED_META = "meta.json"
#: A staged folder this young is never pruned (its message may be being decided).
STAGED_GRACE_S = 600.0
REASON_CHANNEL_DISABLED = "channel_disabled"
UC = "user-communication"

_OUTCOME_RESULT = {
    Outcome.BUFFERED: DeliverResult.ACCEPTED.value,
    Outcome.HELD: DeliverResult.HELD_FOR_APPROVAL.value,
    Outcome.DROPPED_BLOCKED: DeliverResult.BLOCKED.value,
    Outcome.DROPPED_RATE_LIMITED: DeliverResult.NOT_ACCEPTING.value,
    Outcome.DROPPED_CAP: DeliverResult.NOT_ACCEPTING.value,
    Outcome.DROPPED_REQUESTS_FULL: DeliverResult.NOT_ACCEPTING.value,
    Outcome.NOT_ACCEPTING: DeliverResult.NOT_ACCEPTING.value,
    Outcome.DROPPED_UNVERIFIED: DeliverResult.SENDER_UNTRUSTED.value,
    Outcome.DROPPED_AUTOMATIC: DeliverResult.SENDER_UNTRUSTED.value,
}
#: The inspection hook's verdicts (server/inspection.py), as the signed ack
#: the requester gets: the result codes that already exist, no wire value added.
INSPECTION_ACK_RESULT = {
    "hold": DeliverResult.HELD_FOR_APPROVAL.value,
    "block": DeliverResult.BLOCKED.value,
}
#: Refusals the store records with no detail of their own.
_OUTCOME_DETAIL = {
    Outcome.DROPPED_CAP: NotAcceptingDetail.REQUESTS_FULL.value,
    Outcome.DROPPED_REQUESTS_FULL: NotAcceptingDetail.REQUESTS_FULL.value,
}


@dataclass(frozen=True)
class AckFields:
    result: str
    detail: Optional[str] = None
    retry_after: Optional[int] = None
    original_result: Optional[str] = None
    current_state: Optional[str] = None


@dataclass(frozen=True)
class _Inbound:
    """An envelope that checked out: what the decision needs."""

    envelope: Envelope
    raw: Mapping[str, Any]
    pin: Pin
    channel: HubChannelState
    agent: Agent

    @property
    def event_id(self) -> str:
        return f"{self.pin.genesis_fp}/{self.envelope.message_id}"

    @property
    def conversation_key(self) -> str:
        return f"{self.pin.genesis_fp}/{self.envelope.requester_project_id}"


class FilesNotTaken(Exception):
    """A delivery's files could not be taken (``HubAdapter.collect_files``).
    ``ack``: the answer to send, or None (no answer: the sender relays again)."""

    def __init__(self, ack: Optional[AckFields]) -> None:
        super().__init__(ack.result if ack is not None else "no answer")
        self.ack = ack


class _Untrusted(Exception):
    def __init__(self, result: str, why: str) -> None:
        super().__init__(why)
        self.result = result


def _agent_key_secret(key: Ed25519PrivateKey) -> str:
    return b64url(key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()))


class HubAdapter:
    def __init__(self, runtime: "HubRuntime") -> None:
        self.runtime = runtime
        #: Whether an agent's runner is connected (tests replace it).
        self.agent_online: Callable[[str], bool] = self._runner_connected
        #: Whether the isolation gate would hand the agent a hub thread now
        #: (tests that fake a connected runner replace it with it).
        self.can_isolate: Callable[[str], bool] = self._gate_can_serve
        #: File chunks of deliveries still arriving, by message hash (see _FileBuffer).
        self._buffers: dict[bytes, _FileBuffer] = {}
        self._tasks: set[asyncio.Task] = set()

    # ── plumbing ─────────────────────────────────────────────────────────

    @property
    def hub(self):
        return self.runtime.hub

    @property
    def store(self):
        return self.runtime.gateway.store

    @property
    def config(self):
        return self.runtime.config

    def _now(self) -> float:
        return self.runtime._now()

    def _runner_connected(self, agent_id: str) -> bool:
        ws_hub = getattr(self.runtime._ctx, "ws_hub", None)
        return bool(ws_hub is not None and ws_hub.is_connected(agent_id))

    def _gate_can_serve(self, agent_id: str) -> bool:
        """Whether the isolation gate would hand this agent a hub thread now.
        A server without a gate (a bare test context) never holds for it."""
        gate = getattr(self.runtime._ctx, "isolation_gate", None)
        return gate is None or gate.can_serve(agent_id)

    def _notice(self):
        gate = getattr(self.runtime._ctx, "isolation_gate", None)
        return getattr(gate, "notice", None) if gate is not None else None

    def _check_failed(self, agent_id: str) -> bool:
        """The agent's runners say their isolation check failed, as opposed
        to still running it (``IsolationNotice.failing``)."""
        notice = self._notice()
        return notice is not None and notice.failing(agent_id)

    def _notice_held(self, agent_id: str) -> None:
        notice = self._notice()
        if notice is not None:
            notice.on_held(agent_id)

    def _held_state(self, agent_id: str) -> Optional[str]:
        """Where a message to this agent waits, or None when its runner can
        take it now. A runner that is connected but still running its
        isolation check (minutes, after every start and provider change)
        reads as offline-held: nothing has failed, so nobody is told it has,
        and its reconnect when the check ends moves the message on
        (``agent_connected``). Only a failed check holds it for isolation."""
        if not self.agent_online(agent_id):
            return EVENT_HELD_AGENT_OFFLINE
        if self.can_isolate(agent_id):
            return None
        return EVENT_HELD_ISOLATION if self._check_failed(agent_id) else EVENT_HELD_AGENT_OFFLINE

    def track(self, coro) -> None:
        """Run ``coro`` in the background, cancelled when the runtime stops."""
        self._track(coro)

    def _track(self, coro) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def stop(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()

    def _sign_ack(self, message_id: str, to_deployment: str, fields: AckFields) -> Optional[dict]:
        identity = self.runtime.identity()
        if identity is None:
            return None
        try:
            ack = DeliverAck(
                aud=self.config.hub_url, message_id=message_id, to_deployment=to_deployment,
                result=fields.result, detail=fields.detail, retry_after=fields.retry_after,
                original_result=fields.original_result, current_state=fields.current_state,
                at=int(self._now()), from_fingerprint=identity.fingerprint,
            )
        except ValidationError:
            logger.error("Hub deliver_ack for %s does not fit its schema: not sent", fields.result)
            return None
        return sign_object(to_wire(ack), identity.key, purpose=Purpose.DELIVER_ACK)

    async def _ack(self, message_id: str, to_deployment: str, fields: AckFields) -> None:
        signed = self._sign_ack(message_id, to_deployment, fields)
        client = self.runtime.client
        if signed is None or client is None:
            return
        try:
            await client.send("deliver_ack", signed)
        except Exception as exc:  # noqa: BLE001 — the sender re-relays; the outcome is stored
            logger.info("Hub deliver_ack not sent: %s", type(exc).__name__)

    # ── channels ─────────────────────────────────────────────────────────

    def channel_for_agent_name(self, agent_name: str) -> Optional[tuple[HubChannelState, Agent]]:
        model_ctx = self.runtime._ctx.model_ctx
        for state in self.hub.channel_states():
            if state.connection_id is None:
                continue
            agent = Agent.get(state.agent_id, model_ctx)
            if agent is not None and agent.name == agent_name:
                return state, agent
        return None

    def _agent_key(self, state: HubChannelState) -> Ed25519PrivateKey:
        secret = self.store.load_secret(state.connection_id or "", self.config.fernet).get_secret_value()
        return Ed25519PrivateKey.from_private_bytes(b64url_decode(secret, length=32))

    def _ensure_cert(self, state: HubChannelState, agent: Agent) -> HubChannelState:
        """A certificate with more than 7 days left (renewed otherwise)."""
        identity = self.runtime.identity()
        if identity is None or not keys.cert_needs_renewal(state.cert, now=self._now()):
            return state
        cert = keys.issue_agent_cert(identity.key, self._agent_key(state), agent_name=agent.name,
                                     hub_url=self.config.hub_url, now=self._now())
        state = replace(state, cert=cert, rotate_by=float(cert["not_after"] - keys.AGENT_CERT_RENEW_S),
                        updated_at=self._now())
        self.hub.set_channel_state(state)
        return state

    def _listing(self, state: HubChannelState, agent: Agent) -> dict:
        connection = self.store.get_connection(state.connection_id or "")
        mode = connection.mode if connection is not None else access.MODE_ALLOWLIST
        capabilities = [c for c in (getattr(agent, "capabilities", None) or []) if isinstance(c, str)]
        listing = Listing(
            description=(agent.description or "")[:500],
            capabilities=[c[:32] for c in capabilities][:12],
            needs_approval=mode != access.MODE_ANYONE,
            accepting_messages=self.runtime.mode == "full",
        )
        return to_wire(listing)

    def ensure_connection(self, agent: Agent) -> HubChannelState:
        """The agent's Hub connection (its own key, encrypted like any
        credential) and channel row, made once; the channel stays as it is
        (off, until enabled). What enable and the deployment blocks hang on."""
        now = self._now()
        state = self.hub.channel_state(agent.id)
        connection_id = state.connection_id if state is not None else None
        if connection_id is None or self.store.get_connection(connection_id) is None:
            key = Ed25519PrivateKey.generate()
            connection_id = self.store.create_connection(
                agent_id=agent.id, owner_id=agent.registered_by or "", channel=HUB_CHANNEL,
                label=agent.name, secret=_agent_key_secret(key), fernet=self.config.fernet, now=now,
                account_name=agent.name,
            ).id
        if state is None:
            state = HubChannelState(agent_id=agent.id, owner_id=agent.registered_by or "",
                                    created_at=now, updated_at=now, daily_run_cap=DAILY_RUN_CAP)
        if state.connection_id != connection_id:
            state = replace(state, connection_id=connection_id, updated_at=now)
            self.hub.set_channel_state(state)
        return state

    async def check_can_enable(self, agent: Agent) -> None:
        """Everything about the hub and the owner an enable needs, checked
        before anything is written (the switch makes the agent public only
        after this passes): in mode auto a verified owner, and the hub up
        (the socket is connected on demand)."""
        if self.config.lazy and agent.registered_by and not self.runtime.enrollment.owner_verified(
                agent.registered_by):
            raise HubError("hub_owner_unverified", "verify your email with the hub before listing an agent")
        await self.runtime.require_live(send=True)

    async def enable(self, agent: Agent, *, client_request_id: Optional[str] = None,
                     register: bool = True) -> HubChannelState:
        """Turn the agent's Hub channel on (or "Reconnect" an enabled one):
        its key and certificate, then ``agent_register`` if the hub is up.
        ``register=False``: the caller registers later (the browser route
        answers ``enabling`` at once; the result is pushed). In mode auto the
        owner must have verified their email with the hub first
        (``hub_owner_unverified``; enroll.py), and the socket is connected on
        demand."""
        await self.check_can_enable(agent)
        if not agent.is_discoverable:
            raise HubError("agent_not_public", "only a public agent can be listed on the hub")
        state = self.ensure_connection(agent)
        state = replace(state, enabled=True, status="enabling",
                        status_detail=None, reject_reason=None, enable_request_id=client_request_id,
                        disabled_at=None, stop_now=False, unregister_pending=False, updated_at=self._now())
        self.hub.set_channel_state(state)
        state = self._ensure_cert(state, agent)
        if not register:
            return state
        await self.register(agent.id)
        return self.hub.channel_state(agent.id) or state

    async def register(self, agent_id: str) -> None:
        """``agent_register`` for one enabled channel; the answer sets its status."""
        state = self.hub.channel_state(agent_id)
        agent = Agent.get(agent_id, self.runtime._ctx.model_ctx)
        client = self.runtime.client
        if state is None or agent is None or not state.enabled or state.connection_id is None:
            return
        state = self._ensure_cert(state, agent)
        if client is None or state.cert is None:
            self.hub.set_channel_state(replace(state, status="hub_unreachable", updated_at=self._now()))
            await self.runtime.push_channel(agent_id)
            return
        if (self.config.lazy and agent.registered_by
                and not self.runtime.enrollment.owner_verified(agent.registered_by)):
            # The hub would refuse it (owner_unverified): say so without asking.
            self.hub.set_channel_state(replace(state, status="rejected", reject_reason="owner_unverified",
                                               updated_at=self._now()))
            await self.runtime.push_channel(agent_id)
            return
        listing = self._listing(state, agent)
        body = {
            "aud": self.config.hub_url, "agent_name": agent.name, "cert": state.cert, "listing": listing,
            "listing_sig": sign_listing(self._agent_key(state), aud=self.config.hub_url,
                                        agent_name=agent.name, issuer_fp=state.cert["issuer_fp"],
                                        listing=listing),
        }
        owner_ref = self._owner_ref(agent)
        if owner_ref is not None:
            body["owner_ref"] = owner_ref
        try:
            reply = await client.request("agent_register", body)
        except (ConnectionError, asyncio.TimeoutError):
            self.hub.set_channel_state(replace(state, status="hub_unreachable", updated_at=self._now()))
            await self.runtime.push_channel(agent_id)
            return
        now = self._now()
        if reply.frame.type == "agent_registered":
            state = replace(state, status="connected", status_detail=None, reject_reason=None,
                            last_success_at=now, next_retry_at=None, updated_at=now)
        elif reply.frame.type == "agent_rejected":
            state = replace(state, status="rejected", reject_reason=str(reply.data.get("reason") or ""),
                            updated_at=now)
        else:
            state = replace(state, status="hub_unreachable",
                            status_detail=str(reply.data.get("code") or reply.frame.type), updated_at=now)
        self.hub.set_channel_state(state)
        await self.runtime.push_channel(agent_id)

    def _owner_ref(self, agent: Agent) -> Optional[str]:
        """The agent's owner as the hub knows them (HubStore.owner_ref), or None."""
        if not agent.registered_by or self.config.fernet is None:
            return None
        try:
            return self.hub.owner_ref(self.config.hub_url, self.config.fernet, agent.registered_by)
        except (KeyError, InvalidToken):
            return None

    async def disable(self, agent: Agent, *, stop_now: bool = False) -> HubChannelState:
        """Turn the agent's Hub channel off: local and immediate in every mode."""
        state, failed = disable_locally(self.hub, agent, stop_now=stop_now, now=self._now())
        for row_id in failed:
            await self.runtime.gateway._hub_row_changed(row_id)
        await self.unregister(agent.id)
        await self.runtime.push_channel(agent.id)
        return self.hub.channel_state(agent.id) or state

    async def disable_private(self) -> list[str]:
        """An enabled channel whose agent was made private (or removed) since
        is turned off as the owner's disable would: unlisted, and its drain
        starts. Run every poll; until then ``_refusal`` already refuses its
        messages. One channel failing never stops the rest. Returns the agent
        ids turned off."""
        model_ctx = self.runtime._ctx.model_ctx
        turned_off = []
        for state in self.hub.channel_states():
            if not state.enabled:
                continue
            try:
                agent = Agent.get(state.agent_id, model_ctx)
                if agent is not None and agent.is_discoverable:
                    continue
                if agent is None:
                    logger.info("Hub channel of agent %s turned off: the agent was removed", state.agent_id)
                    now = self._now()
                    self.hub.set_channel_state(replace(
                        state, enabled=False, status="off", disabled_at=now,
                        unregister_pending=state.connection_id is not None, updated_at=now))
                    await self.unregister(state.agent_id)
                else:
                    logger.info("Hub channel of %s turned off: the agent is no longer public", agent.name)
                    await self.disable(agent)
                turned_off.append(state.agent_id)
            except Exception as exc:  # noqa: BLE001 — one channel never stops the rest
                logger.warning("Hub channel of agent %s not turned off: %s", state.agent_id, type(exc).__name__)
        return turned_off

    async def unregister(self, agent_id: str) -> None:
        """The pending ``agent_unregister`` of one channel, if the hub is up.
        A removed agent is unregistered under the name its certificate lists."""
        state = self.hub.channel_state(agent_id)
        agent = Agent.get(agent_id, self.runtime._ctx.model_ctx)
        name = agent.name if agent is not None else (state.cert or {}).get("agent_name") if state else None
        identity = self.runtime.identity()
        client = self.runtime.client
        if (state is None or not isinstance(name, str) or not state.unregister_pending or identity is None
                or client is None or state.disabled_at is None):
            return
        body = to_wire(AgentUnregister(
            aud=self.config.hub_url, deployment_id=identity.deployment_id, agent_name=name,
            reason=UnregisterReason.OWNER_DISABLED.value, disabled_at=int(state.disabled_at),
            stop_now=state.stop_now or None, ts=int(self._now()),
        ))
        signed = sign_object(body, identity.key, purpose=Purpose.AGENT_UNREGISTER)
        try:
            reply = await client.request("agent_unregister", signed)
        except (ConnectionError, asyncio.TimeoutError):
            return                                   # sent again on the next connect
        code = reply.data.get("code") if reply.frame.type == "error" else None
        if reply.frame.type == "agent_unregistered" or code in (
            ErrorCode.NOT_LISTED.value, ErrorCode.INVALID_DISABLED_AT.value,
        ):
            self.hub.set_channel_state(replace(state, unregister_pending=False, updated_at=self._now()))

    async def on_connected(self) -> None:
        """Every (re)connect: list every enabled channel (renewing its
        certificate), and send every pending ``agent_unregister``."""
        await self.disable_private()
        for state in self.hub.channel_states():
            try:
                if state.enabled:
                    await self.register(state.agent_id)
                elif state.unregister_pending:
                    await self.unregister(state.agent_id)
            except Exception as exc:  # noqa: BLE001 — one channel never stops the rest
                logger.warning("Hub channel step failed on connect: %s", type(exc).__name__)

    def agents_online(self) -> list[str]:
        """The listed agents whose runner is connected and can run a hub
        conversation isolated (heartbeat). One that failed its isolation check
        reads offline in search, so new senders do not pick it."""
        model_ctx = self.runtime._ctx.model_ctx
        names = []
        for state in self.hub.channel_states():
            agent = Agent.get(state.agent_id, model_ctx) if state.enabled else None
            if (agent is not None and agent.is_discoverable and self.agent_online(agent.id)
                    and self.can_isolate(agent.id)):
                names.append(agent.name)
        return names

    async def expire_drains(self) -> list[str]:
        """Reply rows of a channel turned off more than 10 minutes ago fail
        ``channel_disabled`` (the drain is over). Returns their ids."""
        now = self._now()
        ended: list[str] = []
        for state in self.hub.channel_states():
            if state.enabled or state.connection_id is None or state.disabled_at is None:
                continue
            if state.stop_now or now >= state.disabled_at + DRAIN_S:
                ended += self.hub.fail_open_rows(state.connection_id, reason=REASON_CHANNEL_DISABLED, now=now)
        for row_id in ended:
            await self.runtime.gateway._hub_row_changed(row_id)
        return ended

    # ── replies ──────────────────────────────────────────────────────────

    def prepare_relay(self, connection: ChannelConnection, row: OutboxRow) -> Union[RelayOutcome, str, None]:
        """Before a reply row is relayed: refused ``channel_disabled`` once the
        channel's drain is over; signed (once, stored) when it has no envelope
        yet. Returns the envelope text to send, a refusal, or None (send the
        row's own envelope). A requester's row is never touched."""
        if row.kind == KIND_HUB_REQUEST:
            return self._bridge_drain_check(row)
        state = self.hub.channel_for_connection(connection.id)
        if state is None:
            return Refused("no_adapter")
        now = self._now()
        if not state.enabled and (state.stop_now or state.disabled_at is None
                                  or now >= state.disabled_at + DRAIN_S):
            return Refused(REASON_CHANNEL_DISABLED)
        if row.envelope:
            return None
        envelope = self._sign_reply(state, connection, row)
        if isinstance(envelope, Refused):
            return envelope
        if envelope is None:
            return Parked(WAIT_HUB_UNREACHABLE)
        self.hub.set_reply_envelope(row.id, envelope)
        stored = self.store.get_outbox_row(row.id)
        return stored.envelope if stored is not None else None

    def _bridge_drain_check(self, row: OutboxRow) -> Union[RelayOutcome, None]:
        """A room-bridge envelope is sent only while ``bridge_allowed`` holds
        (plan-agent-access 4.2): an unretain that raced it cancels it, a
        stopped room, an inactive stand-in or the hub mode parks it (it waits
        under the 72 h ceiling and is re-checked)."""
        thread = self.hub.thread_for_project(row.project_id) if row.project_id else None
        if thread is None or thread.kind != "room_bridge":
            return None
        bridge = self.runtime.bridge
        if bridge.bridge_allowed(thread.user_id, thread.stand_in_id, thread.bound_project_id or "",
                                 thread.bound_room or ""):
            return None
        reason = bridge.why_not(thread.user_id, thread.stand_in_id)
        if reason == "unretained":
            return Refused("cancelled_unretained")
        if reason == "inactive":
            reason = "flow_stopped" if not self.runtime._ctx.room_flow.is_open(
                thread.bound_project_id or "", thread.bound_room or "") else "bridge_inactive"
        return Parked(reason, until=self._now() + 60)

    def _sign_reply(self, state: HubChannelState, connection: ChannelConnection,
                    row: OutboxRow) -> Union[dict, Refused, None]:
        identity = self.runtime.identity()
        agent = Agent.get(state.agent_id, self.runtime._ctx.model_ctx)
        if identity is None or agent is None:
            return None
        genesis, _, project_id = row.conversation_key.partition("/")
        to_deployment = next(iter(self.hub.deployment_ids_for([genesis])), None)
        latest = self.store.latest_event_id(connection.id, row.conversation_key)
        if to_deployment is None or latest is None or not project_id:
            return Refused("unknown_requester")
        state = self._ensure_cert(state, agent)
        if state.cert is None:
            return None
        envelope = {
            "v": PROTOCOL_VERSION, "type": "message", "aud": self.config.hub_url,
            "message_id": row.message_id, "from_deployment": identity.deployment_id,
            "from_fingerprint": identity.fingerprint,
            "from_principal": {"kind": "agent", "agent_name": agent.name, "cert": state.cert},
            "to_deployment": to_deployment, "requester_project_id": project_id,
            "conversation_key": row.conversation_key, "in_reply_to": latest.partition("/")[2],
            "sent_at": row.created_at, "body": {"text": row.text},
        }
        try:
            Envelope.model_validate(envelope)
        except ValidationError:
            return Refused(DeliverResult.TOO_LARGE.value)
        return sign_object(envelope, self._agent_key(state), purpose=Purpose.ENVELOPE)

    # ── inbound ──────────────────────────────────────────────────────────

    def _route_verifies(self, data: Mapping[str, Any]) -> bool:
        return verify_deliver_route(data, hub=self.hub, config=self.config, now=self._now())

    async def on_deliver(self, parsed: ParsedFrame, *, browse_only: bool = False) -> None:
        """One ``deliver`` frame (see the module docstring)."""
        data = parsed.data
        raw = data.get("envelope")
        if not isinstance(raw, Mapping):
            return
        message_id, sender = raw.get("message_id"), raw.get("from_deployment")
        if not isinstance(message_id, str) or not isinstance(sender, str):
            return
        if not self._route_verifies(data):
            logger.warning("Hub deliver with a route stamp that does not verify: dropped")
            return
        try:
            inbound = await self._verify(raw)
        except _Untrusted as refused:
            # Its file buffer (if any) is left alone: an unverified envelope
            # reusing a real message's id must not drop that message's bytes.
            # An abandoned buffer expires by age.
            logger.warning("Hub envelope refused (%s): %s; nothing stored", refused.result, refused)
            await self._ack(message_id, sender, AckFields(result=refused.result))
            return
        files = inbound.envelope.body.files or []
        if files and not browse_only and not self._refused_before_files(inbound):
            self._track(self._accept_with_files(inbound))
            return
        if files:
            # Decided without its files (refused, blocked): none is kept or staged.
            self.drop_files(message_id)
        await self._accept(inbound, browse_only=browse_only)

    def _refused_before_files(self, inbound: _Inbound) -> bool:
        """Whether this message is refused whatever its files hold: its
        deployment is blocked, the channel is off, or a refusal of the
        adapter's own applies (browse-only, today's cap). Checked before
        waiting for the files, so a refused message writes nothing to disk."""
        state = self.hub.channel_state(inbound.channel.agent_id) or inbound.channel
        if self.hub.is_deployment_blocked(state.connection_id or "", inbound.pin.genesis_fp):
            return True
        return self._refusal(replace(inbound, channel=state), browse_only=False) is not None

    async def refuse_browse_only(self, parsed: ParsedFrame) -> None:
        """A reply delivered to a browse-only server: refused, signed. (No
        dedupe key: nothing here can ever accept it.)"""
        raw = parsed.data.get("envelope")
        if not isinstance(raw, Mapping) or not self._route_verifies(parsed.data):
            return
        message_id, sender = raw.get("message_id"), raw.get("from_deployment")
        if isinstance(message_id, str) and isinstance(sender, str):
            await self._ack(message_id, sender, AckFields(
                result=DeliverResult.NOT_ACCEPTING.value, detail=NotAcceptingDetail.BROWSE_ONLY.value))

    def expect_files(self, parsed: ParsedFrame) -> None:
        """Called as the deliver frame is read, before anything awaits: its
        file chunks follow it on the socket and must find a place. Only in
        mode ``full``, for a message to one of this server's agents or a reply
        into one of its hub threads, whose route stamp verifies. Which pool (``_file_pool``) is decided here,
        synchronously. Each declared file is capped at its declared size (and
        the protocol's); undeclared chunks are dropped."""
        raw = parsed.data.get("envelope")
        body = raw.get("body") if isinstance(raw, Mapping) else None
        if not isinstance(body, Mapping) or not body.get("files") or not isinstance(raw.get("message_id"), str):
            return
        if self.runtime.mode != "full":
            return
        if not self._route_verifies(parsed.data):
            return
        # A reply to one of this server's requesters (no to_agent): its pool
        # is the mirror's to decide, against the hub thread it names.
        pool = self._file_pool(raw) if raw.get("to_agent") else self.runtime.mirror.reply_file_pool(raw)
        if pool is not None:
            self._expect_files(raw["message_id"], body["files"], *pool)

    def _file_pool(self, raw: Mapping[str, Any]) -> Optional[tuple[str, bool]]:
        """Where a delivery's file chunks may go: ``(share, verified)``. A
        sender pinned here, live, for the deployment the envelope names, whose
        signature verifies now: the main pool, its share keyed by its genesis.
        A pinned key whose check fails: nowhere (the envelope will be refused
        anyway). A sender not pinned yet: the small unverified pool, whoever
        it claims to be."""
        fp = raw.get("from_fingerprint")
        pin = self.hub.pin_for(fp) if isinstance(fp, str) else None
        if pin is None:
            return "", False
        if (pin.deployment_id == raw.get("from_deployment") and pin.revoked_at is None
                and pin.identity_changed_at is None
                and verify_object(raw, pin.pubkey, purpose=Purpose.ENVELOPE)):
            return pin.genesis_fp, True
        return None

    async def _verify(self, raw: Mapping[str, Any]) -> _Inbound:
        identity = self.runtime.identity()
        client = self.runtime.client
        if identity is None:
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "no registration here")
        fp, sender = raw.get("from_fingerprint"), raw.get("from_deployment")
        try:
            pin = self.hub.pin_for(fp) if isinstance(fp, str) else None
            if pin is None and client is not None:
                pin = await keys.look_up_and_pin(
                    client.request, self.hub, self.config, now=self._now(),
                    deployment_id=sender, fingerprint=fp if isinstance(fp, str) else None,
                )
        except (keys.ChainUnverified, ConnectionError, asyncio.TimeoutError) as exc:
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, f"key lookup: {exc}") from None
        if pin is None or pin.deployment_id != sender:
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "the signer is not pinned for the sender")
        if pin.revoked_at is not None or pin.identity_changed_at is not None:
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "the signer's identity is revoked")
        if not verify_object(raw, pin.pubkey, purpose=Purpose.ENVELOPE):
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "the signature does not verify")
        try:
            envelope = Envelope.model_validate(raw)
        except ValidationError:
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "the envelope does not fit") from None
        if envelope.type != "message" or envelope.from_principal.kind != "user" or envelope.to_agent is None:
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "not a requester's message")
        if not all(file_name_ok(ref.name) for ref in envelope.body.files or []):
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "a file name is not plain text")
        code = check_envelope_frame(envelope, expected_aud=self.config.hub_url,
                                    me=identity.deployment_id, now=self._now(),
                                    max_age_s=MAX_ENVELOPE_AGE_S)
        if code is not None:
            result = DeliverResult.STALE.value if code == ErrorCode.STALE else DeliverResult.SENDER_UNTRUSTED.value
            raise _Untrusted(result, f"envelope check: {code.value}")
        if envelope.conversation_key.split("/", 1)[0] != pin.genesis_fp:
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "the conversation is not the sender's own")
        found = self.channel_for_agent_name(envelope.to_agent)
        if found is None:
            raise _Untrusted(DeliverResult.SENDER_UNTRUSTED.value, "no such agent here")
        return _Inbound(envelope=envelope, raw=raw, pin=pin, channel=found[0], agent=found[1])

    def _refusal(self, inbound: _Inbound, *, browse_only: bool) -> Optional[tuple[Outcome, Optional[str]]]:
        """The adapter's own refusals, before any access rule."""
        state = inbound.channel
        if not state.enabled or not inbound.agent.is_discoverable:
            return (Outcome.NOT_ACCEPTING, NotAcceptingDetail.CHANNEL_OFF.value)
        if browse_only or self.runtime.mode != "full":
            return (Outcome.NOT_ACCEPTING, NotAcceptingDetail.BROWSE_ONLY.value)
        if self._cap_reached(state):
            return (Outcome.NOT_ACCEPTING, NotAcceptingDetail.DAILY_CAP.value)
        return None

    def _cap_reached(self, state: HubChannelState) -> bool:
        fresh = state.runs_reset_at is None or self._now() >= state.runs_reset_at
        return not fresh and state.runs_today >= state.daily_run_cap

    def _retry_after(self, state: HubChannelState, detail: Optional[str]) -> Optional[int]:
        if detail != NotAcceptingDetail.DAILY_CAP.value:
            return None
        current = self.hub.channel_state(state.agent_id) or state
        if current.runs_reset_at is None:
            return None
        return max(1, int(current.runs_reset_at - self._now()))

    def _run_gate(self, agent_id: str):
        """In the accept transaction, before the agent gets the message: the
        channel is still on, and one run of today's cap is claimed (the claim
        and the acceptance are one commit, so concurrent messages cannot run
        the agent past the cap)."""
        now = self._now()
        reset_at = next_local_midnight(now)

        def gate(db) -> Optional[str]:
            row = db.execute("SELECT enabled FROM hub_channels WHERE agent_id = ?", (agent_id,)).fetchone()
            if row is None or not row[0]:
                return NotAcceptingDetail.CHANNEL_OFF.value
            if HubStore.claim_run(db, agent_id, now=now, next_reset_at=reset_at) is None:
                return NotAcceptingDetail.DAILY_CAP.value
            return None

        return gate

    def _request_gate(self, inbound: _Inbound):
        """The fill rule for this sender's root (see the module docstring)."""
        connection_id = inbound.channel.connection_id
        root = inbound.pin.genesis_fp
        first_seen = self.hub.first_seen(root)
        probation = first_seen is None or self._now() - first_seen < PROBATION_S
        limit = self.runtime.gateway.options.limits().pending_requests

        def gate(db, pending: int) -> Optional[str]:
            per_root = db.execute(
                "SELECT COUNT(*) FROM requests WHERE connection_id = ? AND state = ?"
                " AND substr(user_key, 1, ?) = ?",
                (connection_id, REQUEST_PENDING, len(root) + 1, f"{root}~"),
            ).fetchone()[0]
            if per_root >= MAX_PENDING_PER_ROOT:
                return NotAcceptingDetail.REQUESTS_FULL.value
            if probation and pending >= FILL_FRACTION * limit:
                return NotAcceptingDetail.REQUESTS_FULL.value
            return None

        return gate

    async def _accept(self, inbound: _Inbound, *, browse_only: bool = False) -> None:
        env = inbound.envelope
        principal = env.from_principal
        state = inbound.channel
        connection_id = state.connection_id or ""
        event = InboundEvent(
            event_id=inbound.event_id, conversation_key=inbound.conversation_key,
            user_key=f"{inbound.pin.genesis_fp}~{principal.user_id}",
            # The browser shows the sender as remote_username @ deployment:
            # the username is what the contact and its Request store.
            display_name=remote_username(principal.username),
            text=env.body.text, auth_verdict=access.AUTH_PROVIDER, sent_at=env.sent_at,
        )
        # The channel as it is NOW, not as it was when the envelope verified
        # (a message with files waits up to a minute for them).
        inbound = replace(inbound, channel=self.hub.channel_state(state.agent_id) or state)
        refuse = self._refusal(inbound, browse_only=browse_only)
        try:
            [decision] = await self.runtime.gateway.handle_hub_events(connection_id, [VerifiedHubEvent(
                event=event, root_fp=inbound.pin.genesis_fp, refuse=refuse,
                request_gate=self._request_gate(inbound), accept_gate=self._run_gate(state.agent_id),
            )])
        except KeyError:
            await self._ack(env.message_id, env.from_deployment,
                            AckFields(result=DeliverResult.SENDER_UNTRUSTED.value))
            return
        if decision is not None and decision.outcome in (Outcome.BUFFERED, Outcome.HELD):
            # A label only: the contact, its Request, blocks and rate limits
            # stay keyed on the user (event.user_key), so their agents share
            # their budget and blocking the user blocks their agents.
            self.hub.note_via_agent(connection_id, event.user_key, remote_agent_label(principal.via_agent),
                                    sent_at=env.sent_at)
        fields = self._decided(inbound, decision)
        await self._ack(env.message_id, env.from_deployment, fields)

    def _decided(self, inbound: _Inbound, decision: Optional[InboundDecision]) -> AckFields:
        """The ack for a decision; for a first acceptance, also where the
        message is now (its runner may be offline) and the day's run count."""
        state = inbound.channel
        connection_id = state.connection_id or ""
        if decision is None:
            return AckFields(result=DeliverResult.STALE.value)
        if decision.outcome == Outcome.DUPLICATE:
            stored = decision.original
            if stored is None:
                return AckFields(result=DeliverResult.DUPLICATE.value)
            original = self._stored_result(stored.outcome, stored.current_state)
            current, detail = self._wire_state(stored)
            return AckFields(
                result=DeliverResult.DUPLICATE.value, original_result=original, detail=detail,
                # A refusal has no "where it is now": its own result stands in.
                current_state=current or original,
                retry_after=self._retry_after(state, stored.detail),
            )
        if decision.outcome == Outcome.BUFFERED:                 # its run was claimed with it
            held = self._held_state(state.agent_id)
            if held == EVENT_HELD_AGENT_OFFLINE:
                self.store.set_event_state(connection_id, [inbound.event_id], EVENT_HELD_AGENT_OFFLINE)
                return AckFields(result=DeliverResult.HELD_AGENT_OFFLINE.value)
            if held == EVENT_HELD_ISOLATION:
                # Connected, but its check failed and the gate will hold the
                # thread: say so now instead of "accepted" followed by silence.
                self.store.set_event_state(connection_id, [inbound.event_id], EVENT_HELD_ISOLATION)
                self._notice_held(state.agent_id)
                return AckFields(result=DeliverResult.HELD_AGENT_OFFLINE.value, detail=HUB_ISOLATION_DETAIL)
            return AckFields(result=DeliverResult.ACCEPTED.value)
        stored = self.store.stored_outcome(connection_id, inbound.event_id)
        detail = stored.detail if stored is not None else None
        detail = detail or _OUTCOME_DETAIL.get(decision.outcome)
        return AckFields(result=_OUTCOME_RESULT.get(decision.outcome, DeliverResult.NOT_ACCEPTING.value),
                         detail=detail, retry_after=self._retry_after(state, detail))

    @staticmethod
    def _wire_state(stored) -> tuple[Optional[str], Optional[str]]:
        """A stored event's ``(current_state, detail)`` as the wire says them:
        a message held for isolation is ``held_agent_offline`` with detail
        ``isolation_unavailable`` (the event state is this server's own word)."""
        if stored.current_state == EVENT_HELD_ISOLATION:
            return EVENT_HELD_AGENT_OFFLINE, HUB_ISOLATION_DETAIL
        return stored.current_state, stored.detail

    @staticmethod
    def _stored_result(outcome: str, current_state: Optional[str]) -> str:
        try:
            known = Outcome(outcome)
        except ValueError:
            return DeliverResult.NOT_ACCEPTING.value
        if known == Outcome.BUFFERED and current_state in (EVENT_HELD_AGENT_OFFLINE, EVENT_HELD_ISOLATION):
            return DeliverResult.HELD_AGENT_OFFLINE.value
        return _OUTCOME_RESULT.get(known, DeliverResult.NOT_ACCEPTING.value)

    # ── where kept messages go next ──────────────────────────────────────

    async def _send_picked_up(self, connection_id: str, event_ids: list[str]) -> None:
        if not event_ids:
            return
        self.store.set_event_state(connection_id, event_ids, EVENT_PICKED_UP)
        for event_id in event_ids:
            genesis, _, message_id = event_id.partition("/")
            to_deployment = next(iter(self.hub.deployment_ids_for([genesis])), None)
            if to_deployment is not None:
                await self._ack(message_id, to_deployment, AckFields(result=DeliverResult.PICKED_UP.value))

    async def agent_connected(self, agent_id: str) -> None:
        """The agent's runner is back: its held_agent_offline messages are
        with it now, and each requester gets a signed picked_up. Messages held
        because it could not isolate go too, once it can."""
        state = self.hub.channel_state(agent_id)
        if state is None or state.connection_id is None:
            return
        if not self.can_isolate(agent_id):
            if not self._check_failed(agent_id):
                return                       # still checking: its end reconnects again
            # Back, but its check failed: the gate holds the thread.
            offline = self.store.events_in_state(state.connection_id, EVENT_HELD_AGENT_OFFLINE)
            if not offline:
                return
            self.store.set_event_state(state.connection_id, offline, EVENT_HELD_ISOLATION)
            self._notice_held(agent_id)
            for event_id in offline:                 # each sender learns the new reason
                genesis, _, message_id = event_id.partition("/")
                to_deployment = next(iter(self.hub.deployment_ids_for([genesis])), None)
                if to_deployment is not None:
                    await self._ack(message_id, to_deployment, AckFields(
                        result=DeliverResult.HELD_AGENT_OFFLINE.value, detail=HUB_ISOLATION_DETAIL))
            return
        await self._send_picked_up(state.connection_id, [
            *self.store.events_in_state(state.connection_id, EVENT_HELD_AGENT_OFFLINE),
            *self.store.events_in_state(state.connection_id, EVENT_HELD_ISOLATION),
        ])

    async def on_inspected(self, connection_id: str, event_id: str, verdict: str) -> None:
        """The inspection hook held or blocked a buffered hub message at
        flush (the gateway's ``on_hub_inspected``): the requester gets a
        signed ack with ``held_for_approval`` or ``blocked``."""
        result = INSPECTION_ACK_RESULT.get(verdict)
        if result is None:
            return
        genesis, _, message_id = event_id.partition("/")
        to_deployment = next(iter(self.hub.deployment_ids_for([genesis])), None)
        if to_deployment is not None:
            await self._ack(message_id, to_deployment, AckFields(result=result))

    async def on_allowed(self, connection_id: str, event_ids: list[str]) -> None:
        """The owner allowed a Request: its messages reached the thread. A
        connected runner has them (picked_up); otherwise they wait for it."""
        state = self.hub.channel_for_connection(connection_id)
        if state is None or not event_ids:
            return
        held = self._held_state(state.agent_id)
        if held is None:
            await self._send_picked_up(connection_id, event_ids)
            return
        self.store.set_event_state(connection_id, event_ids, held)
        if held == EVENT_HELD_ISOLATION:
            self._notice_held(state.agent_id)

    async def on_deliver_probe(self, parsed: ParsedFrame) -> None:
        """A requester asks where a held message is: answered from the stored
        outcome (never the body), or unknown_message once it was pruned."""
        probe = parsed.data.get("probe")
        if not isinstance(probe, Mapping):
            return
        sender, message_id = probe.get("from_deployment"), probe.get("message_id")
        if not isinstance(sender, str) or not isinstance(message_id, str):
            return
        genesis = self.hub.genesis_for_deployment(sender)
        chain = self.hub.chain(genesis) if genesis is not None else []
        if not any(p.revoked_at is None and p.identity_changed_at is None
                   and verify_object(probe, p.pubkey, purpose=Purpose.DELIVERY_PROBE) for p in chain):
            logger.warning("Hub delivery probe not signed by a pinned key: dropped")
            return
        found = self.channel_for_agent_name(str(probe.get("to_agent") or ""))
        stored = (self.store.stored_outcome(found[0].connection_id or "", f"{genesis}/{message_id}")
                  if found is not None else None)
        if stored is None:
            await self._ack(message_id, sender, AckFields(result=DeliverResult.UNKNOWN_MESSAGE.value))
            return
        original = self._stored_result(stored.outcome, stored.current_state)
        current, detail = self._wire_state(stored)
        await self._ack(message_id, sender, AckFields(
            result=DeliverResult.DUPLICATE.value, original_result=original,
            detail=detail, current_state=current or original,
        ))

    # ── files ────────────────────────────────────────────────────────────

    def _expect_files(self, message_id: str, refs: Any, sender: str, verified: bool) -> Optional["_FileBuffer"]:
        """The buffer for this message's chunks on the current socket: made
        once (a second deliver with the same id shares it). Buffers older than
        ``FILE_BUFFER_MAX_AGE_S`` go first. ``verified``: the main pool, with
        ``sender`` (a verified genesis) its share; else the unverified pool.
        None when the pool, or the sender's share of it, is full: its chunks
        are dropped and its message gets no answer, so the requester relays it
        again later."""
        self.expire_file_buffers()
        tag = _file_tag(message_id)
        buffer = self._buffers.get(tag)
        if buffer is not None:
            return buffer
        sizes = _declared_sizes(refs)
        if sum(sizes.values()) > MAX_ENVELOPE_BYTES:
            logger.warning("Hub delivery declares more file bytes than an envelope may carry: not kept")
            return None
        declared = sum(sizes.values())
        pool = [b for b in self._buffers.values() if b.verified == verified]
        if not verified:
            if (len(pool) >= MAX_UNVERIFIED_FILE_BUFFERS
                    or sum(b.declared for b in pool) + declared > UNVERIFIED_FILE_BUFFER_BUDGET):
                logger.warning("Hub file buffers for senders not pinned yet full: a delivery's files are not kept")
                return None
        else:
            own = [b for b in pool if b.sender == sender]
            if (len(own) >= MAX_FILE_BUFFERS_PER_SENDER
                    or sum(b.declared for b in own) + declared > FILE_BUFFER_BUDGET_PER_SENDER):
                logger.warning("Hub file buffers of one sender full: a delivery's files are not kept")
                return None
            if len(pool) >= MAX_FILE_BUFFERS or sum(b.declared for b in pool) + declared > FILE_BUFFER_BUDGET:
                logger.warning("Hub file buffers full: a delivery's files are not kept")
                return None
        buffer = _FileBuffer(sizes=sizes, created_at=time.monotonic(), sender=sender, verified=verified)
        self._buffers[tag] = buffer
        return buffer

    def _forget_files(self, tag: bytes, buffer: "_FileBuffer") -> None:
        if self._buffers.get(tag) is buffer:
            del self._buffers[tag]

    def drop_files(self, message_id: str) -> None:
        """A delivery decided without its files: its buffer (if any) goes."""
        tag = _file_tag(message_id)
        buffer = self._buffers.get(tag)
        if buffer is not None:
            self._forget_files(tag, buffer)
            buffer.abandon()

    def expire_file_buffers(self) -> int:
        """Buffers no verified message is using any more (refused, abandoned)
        go after ``FILE_BUFFER_MAX_AGE_S``. Returns how many went."""
        cutoff = time.monotonic() - FILE_BUFFER_MAX_AGE_S
        old = [tag for tag, b in self._buffers.items() if b.created_at < cutoff]
        for tag in old:
            self._buffers.pop(tag).abandon()
        return len(old)

    def socket_closed(self) -> None:
        """The hub socket dropped: every buffer was for a stream on it. A
        delivery waiting for its files stops quietly (no ack); the hub
        re-delivers on the next socket, into a fresh buffer."""
        buffers, self._buffers = self._buffers, {}
        for buffer in buffers.values():
            buffer.abandon()

    def on_binary(self, frame: bytes) -> None:
        """One file chunk from the socket: the 16-byte header, then bytes."""
        if len(frame) < FILE_HEADER_BYTES:
            return
        try:
            tag, index = parse_file_stream_header(frame[:FILE_HEADER_BYTES])
        except ValueError:
            return
        buffer = self._buffers.get(tag)
        if buffer is not None:                      # not expected: dropped
            buffer.add(index, frame[FILE_HEADER_BYTES:])

    async def _accept_with_files(self, inbound: _Inbound) -> None:
        """Wait for every file of the envelope (``collect_files``), stage them
        beside channels.db for the flush, then decide as any message."""
        env = inbound.envelope
        try:
            data = await self.collect_files(env)
        except FilesNotTaken as not_taken:
            if not_taken.ack is not None:
                await self._ack(env.message_id, env.from_deployment, not_taken.ack)
            return
        self._stage_files(inbound, data)
        await self._accept(inbound)

    async def collect_files(self, env: Envelope) -> dict[int, bytes]:
        """Every file of a verified envelope, by index, each checked against
        its signed FileRef (size and sha256). Used for messages to agents here
        and for replies into hub threads (``RequesterMirror``).

        Raises ``FilesNotTaken``: a file that never arrives (``FILES_TIMEOUT_S``)
        or does not match is answered too_large / sender_untrusted; a socket
        drop meanwhile, or a message whose chunks found no buffer as its frame
        was read (the pool was full), gets no answer, so the sender relays it
        again, into a free one."""
        refs = env.body.files or []
        tag = _file_tag(env.message_id)
        buffer = self._buffers.get(tag)
        if buffer is None:
            if sum(r.size for r in refs) > MAX_ENVELOPE_BYTES:
                raise FilesNotTaken(AckFields(result=DeliverResult.TOO_LARGE.value, detail="files_incomplete"))
            logger.info("Hub message with files not kept (buffers full): left for the sender to relay again")
            raise FilesNotTaken(None)
        deadline = asyncio.get_running_loop().time() + FILES_TIMEOUT_S
        try:
            while not all(len(buffer.files.get(r.index, b"")) >= r.size for r in refs):
                if buffer.abandoned:
                    raise FilesNotTaken(None)
                buffer.event.clear()
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                await asyncio.wait_for(buffer.event.wait(), timeout=remaining)
            for ref in refs:
                data = bytes(buffer.files.get(ref.index, b""))
                if len(data) != ref.size or hashlib.sha256(data).hexdigest() != ref.sha256:
                    raise FilesNotTaken(AckFields(result=DeliverResult.SENDER_UNTRUSTED.value))
            return {ref.index: bytes(buffer.files[ref.index]) for ref in refs}
        except asyncio.TimeoutError:
            raise FilesNotTaken(AckFields(result=DeliverResult.TOO_LARGE.value, detail="files_incomplete")) from None
        finally:
            self._forget_files(tag, buffer)

    def _staging(self, connection_id: str, event_id: str) -> Path:
        key = hashlib.sha256(f"{connection_id}/{event_id}".encode("utf-8")).hexdigest()[:32]
        return self.store.directory / "hub-inbound" / key

    def _stage_files(self, inbound: _Inbound, data: dict[int, bytes]) -> None:
        folder = self._staging(inbound.channel.connection_id or "", inbound.event_id)
        if folder.exists():
            return                                     # a re-relay: staged already
        tmp = folder.with_name(folder.name + ".part")
        tmp.mkdir(parents=True, exist_ok=True)
        for ref in inbound.envelope.body.files or []:
            (tmp / f"{ref.index}").write_bytes(data[ref.index])
            (tmp / f"{ref.index}.name").write_text(ref.name, encoding="utf-8")
        # Whose files these are, so the prune can tell when nothing waits for them.
        (tmp / STAGED_META).write_text(json.dumps({
            "connection_id": inbound.channel.connection_id or "", "event_id": inbound.event_id,
        }), encoding="utf-8")
        tmp.rename(folder)

    def files_for(self, project, rows: list) -> tuple[list[BatchEntrySpec], dict[str, str]]:
        """The gateway's ``hub_files_for``: each buffered message's staged files
        become FILE entries of the thread (written first, as the contact) and
        a line of signed download links on this deployment's own file route."""
        specs: list[BatchEntrySpec] = []
        extra: dict[str, str] = {}
        gateway = self.runtime.gateway
        link_for = gateway._file_link_maker(project.id)
        for row in rows:
            folder = self._staging(row.connection_id, row.event_id)
            if not folder.is_dir():
                continue
            lines = []
            for path in sorted(p for p in folder.iterdir() if p.name.isdigit()):
                name = (folder / f"{path.name}.name").read_text(encoding="utf-8")
                content = path.read_bytes()
                payload = FilePayload(
                    chatroom_name=UC, filename=_safe_name(name, path.name),
                    content_b64=FileUtil.to_base64(content), sha256=hashlib.sha256(content).hexdigest(),
                    from_participant_id=row.contact_id, from_participant_name=row.display_name,
                )
                specs.append(BatchEntrySpec(entry_type=ChangelogEntryType.FILE_CREATED, payload=payload))
                link = link_for(payload)
                lines.append(f"- {payload.filename}" + (f": {link}" if link else ""))
            if lines:
                # Several held messages share one combined message: one list.
                head = extra.get(row.message_id) or "\n\nFiles:"
                extra[row.message_id] = head + "\n" + "\n".join(lines)
        return specs, extra

    def files_flushed(self, rows: list) -> None:
        for row in rows:
            shutil.rmtree(self._staging(row.connection_id, row.event_id), ignore_errors=True)

    def prune_staged(self) -> int:
        """Staged files nothing waits for any more go: their message was
        refused, its Request was blocked or expired, or its connection was
        removed. A folder younger than ``STAGED_GRACE_S`` is kept (its message
        may be being decided right now). Returns how many folders went."""
        root = self.store.directory / "hub-inbound"
        if not root.is_dir():
            return 0
        cutoff = time.time() - STAGED_GRACE_S
        pruned = 0
        for folder in root.iterdir():
            try:
                if folder.stat().st_mtime > cutoff:
                    continue
                meta = json.loads((folder / STAGED_META).read_text(encoding="utf-8"))
                waiting = self.hub.inbound_event_waiting(meta["connection_id"], meta["event_id"])
            except (OSError, ValueError, KeyError, TypeError):
                waiting = False                     # a half-written or foreign folder
            if not waiting:
                shutil.rmtree(folder, ignore_errors=True)
                pruned += 1
        return pruned

    def expire_held(self) -> int:
        """Held messages of pending Requests on a Hub channel are dropped 7
        days after they were held (the requester gave up then: held_expired),
        with their files; a Request left with nothing held goes too, so an
        approval on day 8 starts no run. Returns how many messages went."""
        dropped = self.hub.expire_held_requests(held_before=self._now() - HELD_CEILING_SECONDS)
        for connection_id, event_id in dropped:
            shutil.rmtree(self._staging(connection_id, event_id), ignore_errors=True)
        return len(dropped)


def next_local_midnight(now: float) -> float:
    """The server's next local midnight after ``now``: when the daily run
    count starts again (``runs_reset_at``)."""
    local = datetime.fromtimestamp(now).astimezone()
    tomorrow = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return tomorrow.timestamp()


def disable_locally(
    hub: "HubStore", agent: Agent, *, stop_now: bool, now: float,
) -> tuple[HubChannelState, list[str]]:
    """The part of turning a Hub channel off that needs no hub and no
    runtime (so it works with the hub off): the channel is off at once with
    ``disabled_at = now`` (never later), its ``agent_unregister`` is pending
    for the next connect, and with ``stop_now`` its reply rows fail
    ``channel_disabled`` at once. Returns the state and the failed row ids."""
    state = hub.channel_state(agent.id)
    if state is None:
        state = HubChannelState(agent_id=agent.id, owner_id=agent.registered_by or "",
                                created_at=now, updated_at=now)
    state = replace(state, enabled=False, status="off", disabled_at=now, stop_now=stop_now,
                    unregister_pending=state.connection_id is not None, updated_at=now)
    hub.set_channel_state(state)
    failed: list[str] = []
    if stop_now and state.connection_id is not None:
        failed = hub.fail_open_rows(state.connection_id, reason=REASON_CHANNEL_DISABLED, now=now)
    return state, failed


def file_name_ok(name: str) -> bool:
    """Whether a file may travel over the hub under this name, on either side:
    1-100 characters, relative, no ``..`` or hidden part, no backslash, and no
    control or format character (a NUL breaks the write, a newline forges
    lines in what the agent reads)."""
    import unicodedata

    if not isinstance(name, str) or not 0 < len(name) <= 100 or "\\" in name or name.startswith("/"):
        return False
    if any(unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") for ch in name):
        return False
    return all(part and not part.startswith(".") for part in name.split("/"))


def remote_username(name: str) -> str:
    """A requester's username as B stores and shows it: no ``@`` (so it can
    never read as another ``user @ deployment``), no bidi or invisible
    characters, at most 40 code points."""
    return clean_remote_text(str(name or "").replace("@", ""), TextField.USERNAME) or "user"


def remote_agent_label(name: Optional[str]) -> Optional[str]:
    """The signed ``via_agent`` as B stores and shows it ("sent by their agent
    X"): cleaned like ``remote_username`` (no ``@``, nothing invisible, at most
    40 code points), plain text; None when absent or nothing is left."""
    if name is None:
        return None
    return clean_remote_text(str(name).replace("@", ""), TextField.USERNAME) or None


def _safe_name(name: str, fallback: str) -> str:
    """A received file's name as stored: plain text, no path parts, nothing hidden."""
    base = clean_filename(name.replace("\\", "/").rsplit("/", 1)[-1]).strip().lstrip(".")
    return base[:100] or f"file-{fallback}"


def _file_tag(message_id: str) -> bytes:
    """The 14-byte message hash file chunks are addressed by."""
    return hashlib.sha256(message_id.encode("utf-8")).digest()[:14]


def _declared_sizes(refs: Any) -> dict[int, int]:
    """index -> size of each well-formed FileRef (read before verification)."""
    sizes: dict[int, int] = {}
    for ref in refs if isinstance(refs, list) else ():
        index, size = (ref.get("index"), ref.get("size")) if isinstance(ref, Mapping) else (None, None)
        if (type(index) is int and 0 <= index < MAX_FILES and type(size) is int
                and 0 < size <= MAX_FILE_BYTES and len(sizes) < MAX_FILES):
            sizes[index] = size
    return sizes


@dataclass
class _FileBuffer:
    """One delivery's file chunks, on one socket. Each declared file grows to
    at most its declared size; chunks for any other index are dropped.
    ``verified``: in the main pool, where ``sender`` (the sender's verified
    genesis) names the share it counts in; else in the unverified pool."""

    sizes: dict[int, int]
    created_at: float
    sender: str = ""
    verified: bool = False
    files: dict[int, bytearray] = field(default_factory=dict)
    event: asyncio.Event = field(default_factory=asyncio.Event)
    abandoned: bool = False

    @property
    def declared(self) -> int:
        return sum(self.sizes.values())

    def add(self, index: int, data: bytes) -> None:
        limit = self.sizes.get(index)
        if limit is None or self.abandoned:
            return
        got = self.files.setdefault(index, bytearray())
        got.extend(data[: max(0, limit - len(got))])
        self.event.set()

    def abandon(self) -> None:
        self.abandoned = True
        self.event.set()
