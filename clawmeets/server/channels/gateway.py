# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/gateway.py
The channel gateway: outside contacts in, the agent's and owner's replies out.

Inbound, per provider call (``handle_webhook``):
    verify → parse → for each event: dedupe key + the access decision in ONE
    commit → 200.
The decision (``access.py`` has the rules) is one of: buffered for the agent;
held in the sender's Request (an unknown sender never reaches the agent — the
owner gets one Requests entry, and the sender the connection's fixed reply,
once); or dropped (blocked, over the rate limit, over a cap). The webhook never
touches a project. A per-conversation flush task, after the burst window, finds
or creates the conversation's Front Desk thread and appends the buffered
messages there as the contact (``contact:<uuid>``), addressing the agent once
per burst — or nobody, when the thread is paused.

Allow (``allow_request``, also begun by an allowlist entry the owner adds, or
by a waiting sender writing while the mode is "anyone") moves a Request's held
messages into the thread as ONE combined message. Block deletes them.

Outbound (``run_outbox_once``, looped by the worker task):
    scan each live thread's changelog from a durable cursor → the message as
    the channel's parts (``adapter.format_parts``) → one outbox row per part +
    cursor in one commit → claim → send through the adapter → mark sent.
Only messages the two ordinary write paths marked ``channel_outbound`` are
sent (see ``is_outbound``). No channel sends a file: a file the agent shares
there goes out as a signed download link, listed under its reply
(``outbound_units``, ``file_links``). Delivery is at least once: a row left ``sending``
by a crash is sent again with the same retry key once it is stale. A row older
than 24 h (measured from the message's own timestamp) is never sent; it ends
``expired`` with a reason that says whether an earlier attempt may have
reached the contact. Parts go out in order per conversation (the claim's
head-of-line rule, ``store.claimable``); a part that fails for good fails the
rest of its reply with it.

**Customer-service windows** (WhatsApp; any adapter with
``customer_service_window_seconds``). Every accepted message moves its
conversation's window clock forward in the same commit as its dedupe key,
whatever the access decision (the provider opens the window when the contact
writes, whatever we do with the message). Every claim of a row in such a
conversation checks the window first — before the 24 h age rule — and a row
whose window has closed (less a safety margin) ends ``held_window`` with the
later parts of its reply, unsent and never released. The provider's own
refusal (``AdapterError.window_closed``) does the same and marks the
conversation closed until the contact writes again. The provider's
subscription check (Meta's GET with ``hub.challenge``) is answered by
``handle_subscription``.

**Hub rows** (a connection whose channel is ``hub``) go through the same
outbox but are relayed, not sent: through the hub client's
``RelayingAdapter`` when one is registered, and parked (never failed) while
none is. A relayed row waits for a verified receipt (``complete_on_receipt``)
and is re-relayed, byte for byte, on a back-off; the rules are in
``hub_delivery``. Each worker pass first wakes the rows whose wait is over;
``sweep_hub_rows`` expires them, ends held rows at 7 days and sends the
probes, whatever the hub mode. Envelopes from other deployments come in
through ``handle_hub_events``, the same per-event path as a webhook.

Email (``handle_email``) has ONE webhook for the whole server rather than one
per connection: the route checks the server's basic-auth secret and reads the
body under its own limits (``email_form``), then each recipient in the SMTP
envelope is looked up as a connection's address, and every matched connection
gets the mail independently — its own dedupe key, contact, access decision and
thread — through the same ``accept_inbound`` as every other channel.

Connections (``connect``, ``check``, ``disable``, ``enable``, ``reconnect``,
``remove``) are owner actions; a channel whose adapter manages its own webhook
(``ManagedChannelAdapter``, Telegram) is set up with the provider here, and
never at boot. A webhook call is checked in a fixed order: kill switch (the
route), the connection row (a removed one is 404 even with a correctly derived
secret), the secret (401), then disabled (200, dropped).

Crash safety is by construction, not by a shutdown hook — every step either
commits atomically or can be redone and recognised:

- dedupe key and the decision commit together (store.accept_inbound), and so
  do a fixed reply and its "sent once" mark;
- the flushed message's id is minted at accept time and stored on its buffer
  row, and the tip version is recorded before the append, so an interrupted
  flush finds what it already wrote instead of writing it twice;
- Allow is built the same way: the intent (``allowing``, the combined
  messages' ids, the thread intents) commits first; the combined message is
  adopted by id on retry; the held messages, the ``allowed`` state and the
  allow entry go in one final commit;
- the thread mapping is written as an intent naming the project id BEFORE the
  project is created, and finished on the next flush;
- the outbox is fed by a cursor scan, not a runloop subscriber, so a reply
  persisted just before a crash is still found after it;
- ``start()`` finishes every interrupted Allow, reloads every channel
  thread's runloop (replaying entries whose subscribers never ran) and
  reschedules every unflushed buffer row; the outbox worker also reschedules
  any overdue conversation whose flush failed, with a backoff.

**Single process.** The per-conversation and per-Request ``asyncio.Lock``s
below, like the rest of the server's in-memory coordination, assume ONE uvicorn
worker (``cli_server.py`` runs without ``workers=``). Running several workers
would need a cross-process lock; the mapping's primary key and the unique index
on open Requests would still stop a second row, but not a doubled flush or a
doubled combined message. The Requests decisions themselves (one Request and
one fixed reply per sender, the held cap, the rate-limit counts, Block) are
single SQLite transactions with no ``await`` inside, so they hold either way.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import AsyncExitStack
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Awaitable, Callable, Mapping, Optional

from cryptography.fernet import InvalidToken
from pydantic import SecretStr

from clawmeets.models.agent import Agent
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import NEW_CHAT_PLACEHOLDER, Project
from clawmeets.models.user import User
from clawmeets.sync.changelog import (
    ChangelogEntry,
    ChangelogEntryType,
    FilePayload,
    MessagePayload,
    ProjectCreatedPayload,
    RoomCreatedParticipant,
    RoomCreatedPayload,
    is_contact_id,
)
from clawmeets.sync.runloop import BatchEntrySpec

from . import access, file_links, webchat
from clawmeets.hub_protocol.canonical import Purpose
from clawmeets.hub_protocol.codes import DeliverResult
from clawmeets.hub_protocol.constants import MAX_ENVELOPE_AGE_S
from clawmeets.hub_protocol.frames import DeliverAck

from . import hub_delivery
from .adapter import (
    AdapterError,
    ChannelAdapter,
    Forwarded,
    HealthReport,
    Parked,
    Refused,
    RelayingAdapter,
    VerifiedHubEvent,
)
from .config import ChannelConfig, HubConfig, hub_config_for_boot, hub_only_server_url, load_channel_config
from .contacts import FALLBACK_DISPLAY_NAME, clean_display_name
from .email_address import normalize_domain, split_address, without_plus_tag
from .email_form import InboundForm
from .email_text import cap_text
from .hub_store import HubStore
from .store import (
    EXPIRED,
    FAILED,
    HELD_WINDOW,
    HUB_CHANNEL,
    AWAITING_RECEIPT,
    KIND_HUB_REQUEST,
    PARKED,
    REASON_EXPIRED_72H,
    REASON_HELD_EXPIRED,
    REASON_KEY_REVOKED,
    REASON_WINDOW_CLOSED,
    REASON_WINDOW_CLOSED_MAYBE_SENT,
    ChannelConnection,
    DuplicateConnection,
    KIND_FIXED_REPLY,
    REASON_MAYBE_SENT,
    REASON_FORMAT_ERROR,
    REASON_NEVER_SENT,
    REASON_REPLY_LIMIT,
    REASON_RETRIES_EXHAUSTED,
    REASON_THREAD_GONE,
    REQUEST_ALLOWING,
    REQUEST_BLOCKED,
    SCHEMA_VERSION,
    PENDING,
    SENDING,
    SENT,
    THREAD_LIVE,
    WAIT_HUB_UNREACHABLE,
    AcceptGate,
    ChannelRequest,
    ChannelStore,
    ChannelThread,
    HeldMessage,
    InboundDecision,
    InboundLimits,
    OutboundUnit,
    OutboxRow,
    Outcome,
    RequestGate,
    SchemaMismatch,
    new_thread_slug,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

UC = "user-communication"
MAX_OUTBOUND_AGE_SECONDS = 24 * 3600
DEDUPE_RETENTION_SECONDS = 7 * 24 * 3600
MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
SYSTEM_SENDER_ID = "system"
SYSTEM_SENDER_NAME = "ClawMeets"
THREAD_REPLACED_NOTE = (
    "The earlier thread with this contact was deleted, so their new message "
    "started this one."
)

# Requests. The first messages an unknown sender sends are kept (the Requests
# entry shows the first one); later ones are dropped and counted.
MAX_HELD_PER_REQUEST = 20
MAX_HELD_TEXT_BYTES = 8 * 1024
MAX_PENDING_REQUESTS = 100
# "anyone" mode, for senders no allowlist entry admits.
RATE_WINDOW_SECONDS = 10 * 60
RATE_PER_SENDER = 20
RATE_PER_CONNECTION = 200
# A flush that raised is retried by the outbox worker after 2 s, doubling, at
# most every 5 minutes.
FLUSH_RETRY_FIRST_SECONDS = 2.0
FLUSH_RETRY_MAX_SECONDS = 300.0
#: A row ``sending`` for longer than this was left by a crash (a send is
#: bounded by the adapter's timeout, well under it) and is claimed again.
STALE_SENDING_SECONDS = 300.0
#: A message the provider says was sent longer ago than this is dropped on
#: arrival: its dedupe key may already be pruned (``DEDUPE_RETENTION_SECONDS``),
#: and Meta retries a webhook for up to 7 days, so a late copy would otherwise
#: reach the agent twice. Only applies to events carrying ``sent_at``.
STALE_EVENT_SECONDS = 6 * 24 * 3600
#: An acknowledgement (LINE's "got it" on the reply token) gets this long in
#: total; it runs after the webhook's answer, so it never delays the 200.
ACK_TIMEOUT_SECONDS = 5.0
#: A contact-name lookup (LINE's profile call, for a webhook that carries no
#: name) gets this long; it runs after the webhook's answer, never delays it.
PROFILE_TIMEOUT_SECONDS = 5.0
#: After a lookup found no name (404, error, timeout), the same contact is not
#: asked about again for this long; their messages keep the stand-in name.
PROFILE_RETRY_SECONDS = 3600.0
#: Provider quota figures older than this are fetched again when the owner's
#: page loads (never on the webhook path or per send).
QUOTA_REFRESH_SECONDS = 15 * 60
#: The page-load quota fetch (both calls together) gives up after this; the
#: page shows the last figures with their time.
QUOTA_PAGE_TIMEOUT_SECONDS = 3.0
# A hub envelope expires before its sender stops treating a redelivery as
# new, and that before its dedupe key is pruned: otherwise a late re-relay
# could be accepted twice.
assert MAX_ENVELOPE_AGE_S < STALE_EVENT_SECONDS < DEDUPE_RETENTION_SECONDS

# Connection health, as stored and shown on the Channels page. ``disabled`` and
# ``key_rotation_pending`` are derived from the connection's flags
# (``connection_status``); the rest come from the last check or send.
STATUS_WORKING = "working"
STATUS_TOKEN_REJECTED = "token_rejected"
STATUS_WEBHOOK_MISSING = "webhook_missing"
STATUS_WEBHOOK_ERROR = "webhook_error"
STATUS_PENDING_UPDATES = "pending_updates"
STATUS_DISABLED = "disabled"
STATUS_KEY_ROTATION_PENDING = "key_rotation_pending"
#: A monthly push quota is used up (LINE's monthly-limit 429); cleared by the
#: next successful push, or by a fetch once the quota month has turned. Kept as
#: its own flag too (``quota_exhausted_at``), so a Test that finds something
#: else wrong first does not lose it.
STATUS_QUOTA_EXHAUSTED = "quota_exhausted"

#: An email posted to more of our addresses than this reaches the first ten.
MAX_EMAIL_RECIPIENTS = 10
EMAIL_CHANNEL = "email"
AUTOMATIC_MAIL_PREFIX = "[automatic reply] "



def channel_requester_key(connection_id: str, contact_id: str) -> str:
    """``requester_key`` of a channel conversation: one per (connection, contact)."""
    return f"channel:{connection_id}/{contact_id}"


def requester_scope(store, thread) -> dict:
    """See ``ChannelGateway._requester_scope``; also used by the one-time
    requester_key migration. A hub contact's provider key is
    ``{root_fp}~{user_id}``."""
    connection = store.get_connection(thread.connection_id) if store is not None else None
    if connection is not None and connection.channel == HUB_CHANNEL:
        contact = store.get_contact(thread.contact_id)
        if contact is not None and "~" in contact.provider_user_key:
            root_fp, _, user_id = contact.provider_user_key.partition("~")
            return {"requester_key": f"hub:{root_fp}/{user_id}", "memory_excluded": True}
        return {"requester_key": f"project:{thread.project_id}", "memory_excluded": True}
    return {"requester_key": channel_requester_key(thread.connection_id, thread.contact_id)}

def invite_pool(store, thread, agent) -> dict:
    """Who the agent may bring into a channel conversation's project.

    Solo (``agent_pool="self"``) unless this is a hub conversation and the
    owner picked agents or teams on the Hub tab; then exactly those, the same
    allowlist a same-server Front Desk thread gets. An empty pick stays solo,
    never "every owned agent", so the contact cannot steer the agent into
    bringing in agents the owner did not choose. Read once, at creation: a
    later change applies to new conversations only."""
    connection = store.get_connection(thread.connection_id) if store is not None else None
    names = list(agent.default_invitable_agents)
    teams = list(agent.default_invitable_teams)
    if connection is None or connection.channel != HUB_CHANNEL or not (names or teams):
        return {"agent_pool": "self"}
    return {"agent_pool": "owned", "agent_names": names, "agent_teams": teams}


class GatewayHooks:
    """Named points the tests use to crash or hold the gateway mid-step.

    A no-op in production. A test subclass raises at a point to simulate the
    process dying there, or awaits a barrier to force two requests to overlap.
    """

    async def point(self, name: str) -> None:
        return None


@dataclass
class GatewayOptions:
    clock: Callable[[], float] = time.time
    burst_seconds: float = 2.0
    outbox_poll_seconds: float = 1.0
    max_outbound_age_seconds: float = MAX_OUTBOUND_AGE_SECONDS
    retention_seconds: float = DEDUPE_RETENTION_SECONDS
    max_send_attempts: int = 8
    start_worker: bool = True
    hooks: GatewayHooks = field(default_factory=GatewayHooks)
    held_per_request: int = MAX_HELD_PER_REQUEST
    held_text_bytes: int = MAX_HELD_TEXT_BYTES
    pending_requests: int = MAX_PENDING_REQUESTS
    rate_window_seconds: float = RATE_WINDOW_SECONDS
    rate_per_sender: int = RATE_PER_SENDER
    rate_per_connection: int = RATE_PER_CONNECTION
    stale_sending_seconds: float = STALE_SENDING_SECONDS
    stale_event_seconds: float = STALE_EVENT_SECONDS
    ack_timeout_seconds: float = ACK_TIMEOUT_SECONDS
    profile_timeout_seconds: float = PROFILE_TIMEOUT_SECONDS
    profile_retry_seconds: float = PROFILE_RETRY_SECONDS
    quota_refresh_seconds: float = QUOTA_REFRESH_SECONDS
    quota_page_timeout_seconds: float = QUOTA_PAGE_TIMEOUT_SECONDS
    hub_sweep_seconds: float = hub_delivery.HUB_SWEEP_SECONDS
    relays_per_minute: int = hub_delivery.RELAYS_PER_MINUTE
    first_send_reserve_per_minute: int = hub_delivery.FIRST_SEND_RESERVE_PER_MINUTE

    def limits(self) -> InboundLimits:
        return InboundLimits(
            held_per_request=self.held_per_request,
            held_text_bytes=self.held_text_bytes,
            pending_requests=self.pending_requests,
            rate_window_seconds=self.rate_window_seconds,
            rate_per_sender=self.rate_per_sender,
            rate_per_connection=self.rate_per_connection,
        )


#: Signs an envelope again with this deployment's new identity key, under the
#: purpose given (the hub client's key module supplies it).
Resigner = Callable[[Mapping, Purpose], dict]


class CannotResign(Exception):
    """Raised by a ``Resigner`` for an envelope that cannot be carried over to
    the new key at all (a host's reply after an unchained re-key): the row
    ends ``failed`` / ``key_revoked``, like a forwarded one."""

#: The reason on a row whose stored envelope could not be re-signed.
REASON_BAD_ENVELOPE = "bad_envelope"


@dataclass(frozen=True)
class SweepReport:
    expired: list[str] = field(default_factory=list)        # row ids ended past their max age
    held_expired: list[str] = field(default_factory=list)   # held rows ended at the 7-day ceiling
    probed: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ResignReport:
    resigned: list[str] = field(default_factory=list)
    revoked: list[str] = field(default_factory=list)        # ended key_revoked: may have been delivered
    refused: list[str] = field(default_factory=list)        # the stored envelope could not be re-signed


class ConnectionSetupError(Exception):
    """An owner's connection action failed; ``status`` is the HTTP answer and
    ``reason`` a message safe to show (never a provider's own text)."""

    def __init__(self, status: int, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def connection_status(connection: ChannelConnection) -> Optional[str]:
    """The health code the owner sees: disabled > token rejected > key rotation
    pending > the last check's result."""
    if connection.disabled:
        return STATUS_DISABLED
    if connection.status == STATUS_TOKEN_REJECTED:
        return STATUS_TOKEN_REJECTED
    if connection.key_rotation_pending:
        return STATUS_KEY_ROTATION_PENDING
    return connection.status


def _render_for(adapter: Optional[ChannelAdapter]) -> Callable[[str], list[str]]:
    """The adapter's ``format_parts``, or the text as one part."""
    render = getattr(adapter, "format_parts", None)
    if render is None:
        return lambda text: [text] if text.strip() else []
    return render


def _unit(
    message_id: str, text: str, created_at: float, render: Callable[[str], list[str]],
    *, from_agent: bool,
) -> OutboundUnit:
    """One outbound message as an ``OutboundUnit``. A message the adapter
    cannot format becomes one ``failed`` / ``format_error`` row instead of
    raising: one bad message must never stop the scan for every thread."""
    try:
        parts, failed = render(text), None
    except Exception as exc:  # noqa: BLE001 — agent text is untrusted input
        logger.error("channel_format_failed: %s", type(exc).__name__)
        parts, failed = [], REASON_FORMAT_ERROR
    return OutboundUnit(
        message_id=message_id,
        parts=parts,
        created_at=created_at,
        from_agent=from_agent,
        failed_reason=failed,
    )


def outbound_units(
    entries: list[ChangelogEntry], project: Project, render: Callable[[str], list[str]],
    link_for: Callable[[FilePayload], str],
) -> list[OutboundUnit]:
    """The messages of one outbox scan that go out to the contact, as units.

    Files the agent shared (``is_outbound_file``) go out as links
    (``file_links``): appended to the agent's reply they were shared with —
    the reply in this scan with the same ``source_version`` — else, when the
    reply went out in an earlier scan or there is none, as a message of their
    own, placed where the first of them was shared. A file shared twice in one
    turn is listed once, at its last version.
    """
    groups: dict[object, list[ChangelogEntry]] = {}
    for e in entries:
        if is_outbound_file(e, project):
            key = e.source_version if e.source_version is not None else ("v", e.version)
            groups.setdefault(key, []).append(e)

    def section(group: list[ChangelogEntry]) -> str:
        latest: dict[str, FilePayload] = {}
        for e in group:
            latest.pop(e.payload.filename, None)
            latest[e.payload.filename] = e.payload
        return file_links.attachments_markdown(
            [(name, link_for(payload)) for name, payload in latest.items()]
        )

    placed: list[tuple[int, OutboundUnit]] = []
    for e in entries:
        if not is_outbound(e, project):
            continue
        from_agent = e.payload.from_participant_id == project.coordinator_id
        text = e.payload.content
        if from_agent and e.source_version is not None and e.source_version in groups:
            text = f"{text.rstrip()}\n\n{section(groups.pop(e.source_version))}"
        placed.append((e.version, _unit(
            e.payload.id, text, e.payload.ts.timestamp(), render, from_agent=from_agent,
        )))
    for group in groups.values():
        first = group[0]
        placed.append((first.version, _unit(
            f"files@{first.version}", section(group), first.timestamp.timestamp(), render,
            from_agent=True,
        )))
    return [unit for _, unit in sorted(placed, key=lambda item: item[0])]


class AllowInProgress(Exception):
    """A flush found its sender's Allow still unfinished; retried later, so the
    combined message always lands before the messages sent after it."""


def channel_thread_for(ctx: "ServerContext", project_id: str) -> Optional[ChannelThread]:
    """The channel mapping whose current project is ``project_id``, or None.

    Works with the kill switch off (the store needs no key), so outbound
    marking and pause hold even while nothing is being sent.
    """
    store: Optional[ChannelStore] = getattr(ctx, "channel_store", None)
    if store is None:
        return None
    return store.thread_for_project(project_id)


def is_outbound(entry: ChangelogEntry, project: Project) -> bool:
    """Whether a changelog entry of a channel thread goes out to the contact.

    Positive marker first (``channel_outbound``, set only by the agent's own
    post and the owner's own post); the remaining checks are defence in depth.
    """
    if entry.entry_type != ChangelogEntryType.MESSAGE or entry.mirrored_from is not None:
        return False
    payload = entry.payload
    if not isinstance(payload, MessagePayload):
        return False
    return (
        payload.channel_outbound
        and payload.chatroom_name == UC
        and not payload.is_ack
        and not is_contact_id(payload.from_participant_id)
        and payload.from_participant_id in (project.coordinator_id, project.created_by)
    )


def is_outbound_file(entry: ChangelogEntry, project: Project) -> bool:
    """Whether a changelog entry is a file the agent shared with the contact:
    written by the agent itself into a channel thread's user-communication
    room. Sent as a link (``file_links``), never as the file."""
    if (entry.entry_type not in (ChangelogEntryType.FILE_CREATED, ChangelogEntryType.FILE_UPDATED)
            or entry.mirrored_from is not None):
        return False
    payload = entry.payload
    return (
        isinstance(payload, FilePayload)
        and payload.chatroom_name == UC
        and payload.from_participant_id == project.coordinator_id
    )


async def _no_hub_push(_row: OutboxRow) -> None:
    return None


async def _no_hub_allowed(_connection_id: str, _event_ids: list[str]) -> None:
    return None


async def _no_hub_inspected(_connection_id: str, _event_id: str, _verdict: str) -> None:
    return None


#: The one reply a channel contact gets when the inspection hook blocks
#: their message. Never says why.
BLOCKED_REPLY = "This message could not be delivered."


def _no_hub_files(_project, _rows) -> tuple[list, dict]:
    return [], {}


class _HubInbound:
    """What ``_accept_events`` needs of a hub "adapter" until the hub client
    registers its own: the envelope's signature already authenticated the
    sender, and a fixed reply goes out as one part."""

    channel = HUB_CHANNEL
    provider_authenticates_sender = True


_HUB_INBOUND = _HubInbound()


def _project_or_none(project_id: str, ctx: "ServerContext") -> Optional[Project]:
    try:
        return Project.get(project_id, ctx.model_ctx)
    except ValueError:
        return None


class ChannelGateway:
    def __init__(
        self,
        ctx: "ServerContext",
        store: ChannelStore,
        config: ChannelConfig,
        adapters: Mapping[str, ChannelAdapter],
        options: Optional[GatewayOptions] = None,
    ) -> None:
        self._ctx = ctx
        self.store = store
        self.config = config
        self.adapters = dict(adapters)
        for adapter in self.adapters.values():
            bind = getattr(adapter, "bind", None)
            if bind is not None:
                bind(store=store, config=config)
        self.options = options or GatewayOptions()
        self._hooks = self.options.hooks
        #: The hub tables, on the same file and transactions as ``store``.
        self.hub = HubStore(store)
        #: Seam for the hub client: called after every change to a hub row
        #: (the requester's browser is pushed its delivery state from here).
        self.on_hub_row_change: Callable[[OutboxRow], Awaitable[None]] = _no_hub_push
        #: Seam for the hub adapter: a hub connection's Request was allowed;
        #: called with its held messages' event ids (they reached the agent).
        self.on_hub_allowed: Callable[[str, list[str]], Awaitable[None]] = _no_hub_allowed
        #: Seam for the hub adapter: the inspection hook held or blocked a
        #: hub message at flush (connection id, event id, verdict); the
        #: requester gets the signed ack with the existing result code.
        self.on_hub_inspected: Callable[[str, str, str], Awaitable[None]] = _no_hub_inspected
        #: Seam for the hub adapter: before a hub connection's buffered
        #: messages are appended, the files that came with them (entries to
        #: write first, and the text to add to each message, by message id).
        self.hub_files_for: Callable[
            [Project, list], tuple[list[BatchEntrySpec], dict[str, str]]
        ] = _no_hub_files
        #: ... and once they are appended (the staged files can go).
        self.hub_files_flushed: Callable[[list], None] = lambda _rows: None
        self._relay_bucket = hub_delivery.RelayBucket(
            self.options.relays_per_minute, self.options.first_send_reserve_per_minute,
        )
        # Keyed on (connection, conversation), never on a project id: two racing
        # first messages would each mint their own project id. See the module
        # docstring for the single-process assumption.
        self._conversation_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._allow_locks: dict[str, asyncio.Lock] = {}
        self._outbox_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()
        # Live flush tasks per conversation, so the retry sweep never stacks a
        # second one; and the backoff of conversations whose flush failed
        # (attempts, not before). In memory: the boot flush covers a restart.
        self._live_flushes: dict[tuple[str, str], int] = {}
        self._flush_backoff: dict[tuple[str, str], tuple[int, float]] = {}
        # (connection, sender, window start) already logged as rate-limited.
        self._rate_logged: set[tuple[str, str]] = set()
        # Contact-name lookups (``_look_up_name``) in flight, and the ones that
        # found nothing (connection, user key) → not before. In memory: a
        # restart only means one more lookup.
        self._name_lookups: set[tuple[str, str]] = set()
        self._name_retry_at: dict[tuple[str, str], float] = {}
        self._worker_task: Optional[asyncio.Task] = None
        #: This process's id on the outbox rows it claims: a row another
        #: process left ``sending`` is a crashed attempt, reclaimed at once.
        self._claimer = uuid.uuid4().hex
        #: Exceptions that ended a background flush (type names only).
        self.flush_errors: list[str] = []

    def _now(self) -> float:
        return self.options.clock()

    def _serves(self, connection_id: str) -> bool:
        """Whether this gateway runs a connection's flushes and outbox. A
        hub-only gateway (``providers_enabled`` false) runs hub connections
        only: another channel's buffered messages and replies wait, untouched,
        for the gateway that has its adapter, as they do with channels off."""
        if self.config.providers_enabled:
            return True
        connection = self.store.get_connection(connection_id)
        return connection is not None and connection.channel == HUB_CHANNEL

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Boot recovery, then the outbox worker."""
        # First: an Allow interrupted by the crash. The owner's click may have
        # returned an error they never saw, so nobody else would finish it.
        # A hub-only gateway leaves another channel's Allow for the gateway
        # that serves it, as with channels off.
        for request in self.store.allowing_requests():
            if not self._serves(request.connection_id):
                continue
            try:
                await self.finish_allow(request.id)
            except Exception as exc:  # noqa: BLE001 — retried by the next flush or click
                logger.error(
                    "Channel Allow recovery failed for connection %s: %s",
                    request.connection_id[:8], type(exc).__name__,
                )
        for thread in self.store.all_threads():
            if thread.state != THREAD_LIVE or not self._serves(thread.connection_id):
                continue
            project = _project_or_none(thread.project_id, self._ctx)
            if project is None:
                continue
            # Loading the runloop queues any entry whose subscribers never ran
            # (a crash between the changelog write and CHATS.ndjson); syncing
            # to its own tip processes that queue without fetching anything.
            # The push then tells connected runners there is something new.
            runloop = await self._ctx.runloop_manager.get_or_create(
                project.id, project.name, project.coordinator_id,
            )
            tip = runloop.get_current_version()
            await runloop.sync(tip, _nothing_to_fetch)
            await self._broadcast(project, tip)
        for connection_id, conversation_key in self.store.conversations_with_unflushed():
            if self._serves(connection_id):
                self._schedule_flush(connection_id, conversation_key)
        if self.options.start_worker:
            self._worker_task = asyncio.create_task(self._worker())

    async def stop(self) -> None:
        if self._worker_task is not None:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except (asyncio.CancelledError, Exception):
                pass
            self._worker_task = None
        # Await the cancelled flushes: a restart that boots a new gateway while
        # the old one's flushes still run delivers the same rows twice.
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()

    async def drain(self) -> None:
        """Wait until every scheduled flush has finished (tests)."""
        while True:
            pending = [t for t in self._tasks if not t.done()]
            if not pending:
                return
            await asyncio.wait(pending)

    # ── inbound ──────────────────────────────────────────────────────────

    async def handle_webhook(
        self, channel: str, connection_id: str, headers: Mapping[str, str], body: bytes,
    ) -> int:
        """Process one provider call; returns the HTTP status to answer with.

        200 means every event in it is durably decided (or already was):
        buffered, held, or deliberately dropped. Dropping is answered with 200
        too — providers retry anything else, and the retries would only make a
        flood bigger.
        """
        # The row first: a removed connection's secret can still be derived by
        # whoever holds the server key, so no secret is ever checked against an
        # id that has no row.
        connection = self.store.get_connection(connection_id)
        adapter = self.adapters.get(channel)
        if connection is None or adapter is None or connection.channel != channel:
            return 404
        if getattr(adapter, "server_webhook", False):
            return 404  # email has one URL for the server (handle_email), none per connection
        try:
            secret = self.store.load_secret(connection.id, self.config.fernet)
        except InvalidToken:
            # The key that encrypted it is no longer configured. 503 so the
            # provider keeps retrying while the operator restores the key.
            logger.error(
                "Channel connection %s: credential cannot be decrypted with the "
                "configured keys", connection.id[:8],
            )
            return 503
        key_index = adapter.verify(
            connection, secret, headers, body, webhook_keys=self.config.secret_keys,
        )
        tracked = getattr(adapter, "track_unverified_calls", False)
        if key_index is None:
            if tracked:
                self.store.note_webhook_verified(connection.id, False)
            return 401
        if tracked and self.store.extras(connection.id).unverified_calls:
            self.store.note_webhook_verified(connection.id, True)
        if tracked and not connection.disabled:
            # Proof the provider reaches us with the right secret (the card's
            # "last webhook received"; WhatsApp's Test reads it).
            self.store.note_delivery(connection.id, self._now())
        # Verified only under an older key: the provider still holds the old
        # secret until the webhook is registered again.
        rotation_pending = key_index > 0
        if rotation_pending != connection.key_rotation_pending:
            self.store.set_key_rotation_pending(connection.id, rotation_pending)
        if connection.disabled:
            return 200  # a late call after Disable: dropped, reaching no one
        parse_for = getattr(adapter, "parse_for_connection", None)
        try:
            events = parse_for(connection, body) if parse_for else adapter.parse(body)
        except Exception as exc:  # noqa: BLE001 — a body we cannot read will not parse on retry either
            # Type only: the body is the contact's text.
            logger.error(
                "Channel connection %s: webhook body could not be parsed: %s",
                connection.id[:8], type(exc).__name__,
            )
            return 200
        await self._hooks.point("inbound.after_verify")
        acks: list[tuple[str, str]] = []
        lookups: list[tuple[str, str]] = []  # (user key, stand-in name)
        await self._accept_events(connection, adapter, events, acks=acks, lookups=lookups)
        await self._hooks.point("inbound.before_200")
        for reply_token, text in acks:
            self._track(self._acknowledge(connection, adapter, reply_token, text))
        for user_key, stand_in in lookups:
            key = (connection.id, user_key)
            if key in self._name_lookups or self._name_retry_at.get(key, 0.0) > self._now():
                continue
            self._name_lookups.add(key)
            self._track(self._look_up_name(connection, adapter, user_key, stand_in))
        return 200

    async def _accept_events(
        self, connection: ChannelConnection, adapter: ChannelAdapter, events: list, *,
        acks: Optional[list[tuple[str, str]]] = None,
        lookups: Optional[list[tuple[str, str]]] = None,
        stale_event_seconds: Optional[float] = None,
        request_gate: Optional[RequestGate] = None,
        accept_gate: Optional[AcceptGate] = None,
    ) -> list[Optional[InboundDecision]]:
        """The per-event half of an inbound call, shared by every provider's
        webhook and by the hub (``handle_hub_events``): the stale check, the
        window clock, the name stand-in, the dedupe key with its decision
        (``accept_inbound``) and the flush. ``stale_event_seconds`` overrides
        the option (the hub's envelopes are refused past their own 72 h).

        Returns one decision per event, in order: None for an event dropped as
        a stale redelivery (nothing stored). The acknowledgements and name
        lookups the events call for are appended to ``acks`` and ``lookups``;
        the caller starts them, after its last hook point.
        """
        limits = self.options.limits()
        look_up = getattr(adapter, "profile_name", None)
        windowed = getattr(adapter, "customer_service_window_seconds", None) is not None
        stale_after = (
            self.options.stale_event_seconds if stale_event_seconds is None else stale_event_seconds
        )
        decisions: list[Optional[InboundDecision]] = []
        for event in events:
            await self._hooks.point("inbound.before_dedupe")
            now = self._now()
            if event.sent_at is not None and now - event.sent_at > stale_after:
                logger.warning(
                    "Channel connection %s: dropped a message sent over %d days ago "
                    "(stale_redelivery)", connection.id[:8], int(stale_after // 86400),
                )
                decisions.append(None)
                continue
            on_accept = None
            if windowed:
                on_accept = self._window_clock(connection.id, event, now)
            display_name = clean_display_name(event.display_name)
            stand_in = None
            if look_up is not None:
                # The event's name is a stand-in (LINE sends no name): keep a
                # looked-up one already stored, else look it up once accepted.
                stored = self.store.contact_name(connection.id, event.user_key)
                if stored is not None and stored != display_name:
                    display_name = stored
                else:
                    stand_in = display_name
            decision = self.store.accept_inbound(
                connection_id=connection.id,
                event_id=event.event_id,
                conversation_key=event.conversation_key,
                user_key=event.user_key,
                handle=event.handle,
                display_name=display_name,
                text=event.text,
                verdict=event.auth_verdict,
                verified=access.sender_verified(
                    event.auth_verdict, adapter.provider_authenticates_sender,
                ),
                limits=limits,
                now=now,
                flush_after=now + self.options.burst_seconds,
                render=_render_for(adapter),
                on_accept=on_accept,
                request_gate=request_gate,
                accept_gate=accept_gate,
            )
            decisions.append(decision)
            if lookups is not None and stand_in is not None and decision.outcome in (
                Outcome.BUFFERED, Outcome.HELD,
            ):
                lookups.append((event.user_key, stand_in))
            if decision.outcome == Outcome.BUFFERED:
                self._schedule_flush(connection.id, event.conversation_key)
                ack = self._ack_for(connection, adapter, event)
                if ack is not None and acks is not None:
                    acks.append(ack)
            elif decision.outcome == Outcome.DROPPED_RATE_LIMITED and decision.first_over_limit:
                logger.warning(
                    "Channel connection %s: a sender is over the rate limit; their "
                    "messages are dropped for up to %d s",
                    connection.id[:8], int(self.options.rate_window_seconds),
                )
            elif decision.outcome == Outcome.DROPPED_UNVERIFIED:
                logger.warning(
                    "Channel connection %s: dropped a message that failed the sender "
                    "check while its sender's Request was being allowed",
                    connection.id[:8],
                )
        return decisions

    async def handle_hub_events(
        self, connection_id: str, events: list[VerifiedHubEvent],
    ) -> list[Optional[InboundDecision]]:
        """Envelopes another deployment sent to this hub connection's agent,
        already verified by the hub client. One decision per event, in order;
        None when nothing was stored (stale past the envelope's 72 h, or a
        conversation key that does not start with the sender's own genesis
        fingerprint, which would land in another deployment's thread).

        Before any access rule, each event's dedupe key is stored with a
        refusal when this connection's hub channel is off (``not_accepting`` /
        ``channel_off``) or the sender's deployment is blocked here or
        server-wide (``blocked``): so a re-relay is answered ``duplicate`` with
        that same outcome, and a deployment block wins over the per-person
        block and the allowlist. Everything else goes through the same path
        as every provider's webhook (``_accept_events``): an unknown person
        becomes a Request. No acknowledgement and no name lookup. The hub
        adapter's own refusal (``verified.refuse``) comes after both, and its
        fill rule (``verified.request_gate``) runs where a Request would open.
        """
        connection = self.store.get_connection(connection_id)
        if connection is None or connection.channel != HUB_CHANNEL:
            raise KeyError(connection_id)
        adapter = self.adapters.get(HUB_CHANNEL) or _HUB_INBOUND
        decisions: list[Optional[InboundDecision]] = []
        for verified in events:
            event = verified.event
            if not event.conversation_key.startswith(f"{verified.root_fp}/"):
                logger.warning(
                    "Hub connection %s: dropped an envelope whose conversation is not its "
                    "sender's own (conversation_mismatch)", connection.id[:8],
                )
                decisions.append(None)
                continue
            refuse: Optional[tuple[Outcome, Optional[str]]] = None
            if connection.disabled:
                refuse = (Outcome.NOT_ACCEPTING, "channel_off")
            elif self.hub.is_deployment_blocked(connection.id, verified.root_fp):
                refuse = (Outcome.DROPPED_BLOCKED, None)
            else:
                refuse = verified.refuse
            if refuse is None:
                decisions += await self._accept_events(
                    connection, adapter, [event], stale_event_seconds=MAX_ENVELOPE_AGE_S,
                    request_gate=verified.request_gate, accept_gate=verified.accept_gate,
                )
                continue
            now = self._now()
            decisions.append(self.store.accept_inbound(
                connection_id=connection.id, event_id=event.event_id,
                conversation_key=event.conversation_key, user_key=event.user_key,
                handle=None, display_name=clean_display_name(event.display_name),
                text=event.text, verdict=event.auth_verdict, verified=True,
                limits=self.options.limits(), now=now, flush_after=now, refuse=refuse,
            ))
        return decisions

    def _window_clock(self, connection_id: str, event, now: float):
        """The ``on_accept`` that moves the conversation's window clock: to the
        provider's send time, never later than our own clock (a provider clock
        ahead of ours must not stretch the window). Without a send time, our
        own clock."""
        at = min(event.sent_at, now) if event.sent_at is not None else now

        def on_accept(db) -> None:
            self.store.note_user_message(
                db, connection_id=connection_id, conversation_key=event.conversation_key,
                at=at, now=now,
            )

        return on_accept

    async def handle_subscription(
        self, channel: str, connection_id: str, query: Mapping[str, list[str]],
    ) -> tuple[int, Optional[str]]:
        """The provider's GET check of a callback URL (Meta's ``hub.challenge``).
        Returns ``(status, challenge)``; the challenge only with 200.

        404 for an unknown connection, another channel's id, or a channel with
        no such check; 503 when the credential can't be decrypted; 403 while
        disabled, and whenever the adapter does not recognise the request (a
        wrong verify token, a wrong mode); 400 for a challenge that is not the
        provider's shape. Writes nothing but the time of a successful check."""
        connection = self.store.get_connection(connection_id)
        adapter = self.adapters.get(channel)
        if connection is None or adapter is None or connection.channel != channel:
            return 404, None
        if not hasattr(adapter, "answer_subscription"):
            return 404, None
        try:
            secret = self.store.load_secret(connection.id, self.config.fernet)
        except InvalidToken:
            logger.error(
                "Channel connection %s: credential cannot be decrypted with the "
                "configured keys", connection.id[:8],
            )
            return 503, None
        if connection.disabled:
            return 403, None
        try:
            challenge = adapter.answer_subscription(connection, secret, query)
        except ValueError:
            return 400, None
        if challenge is None:
            return 403, None
        self.store.note_handshake(connection.id, self._now())
        return 200, challenge

    def window_state(self, connection_id: str, conversation_key: str) -> Optional[tuple[float, list]]:
        """For the thread view: ``(closed_at, held)`` when replies were held in
        this conversation since the contact last wrote, else None. ``held`` is
        ``[(OutboxRow, held_at), ...]``; ``closed_at`` is when the first was held."""
        window = self.store.window(connection_id, conversation_key)
        since = window.last_received_at if window is not None else 0.0
        held = self.store.held_for_window(connection_id, conversation_key, since=since)
        if not held:
            return None
        return min(at for _, at in held), held

    def _window_closed(self, adapter, row: OutboxRow, now: float) -> bool:
        """Whether ``row``'s conversation is outside the adapter's
        customer-service window (treated as closed ``margin`` early, so a send
        in flight doesn't race the provider's clock)."""
        length = getattr(adapter, "customer_service_window_seconds", None)
        if length is None:
            return False
        window = self.store.window(row.connection_id, row.conversation_key)
        if window is None:
            return True  # the contact never wrote: nothing to answer within
        if window.provider_closed_at is not None and (
            window.provider_closed_at > window.last_received_at
        ):
            return True  # the provider refused after the contact last wrote
        margin = getattr(adapter, "customer_service_window_margin_seconds", 0.0)
        return now >= window.last_user_message_at + length - margin

    def _ack_for(
        self, connection: ChannelConnection, adapter: ChannelAdapter, event,
    ) -> Optional[tuple[str, str]]:
        """The acknowledgement a just-buffered event gets, or None.

        Decided from the store right after the event's commit, with no await
        in between: once per burst (no earlier unflushed message in this
        conversation — so a restart mid-burst doesn't acknowledge the same
        burst twice), never in a paused thread (the owner answers by hand),
        and never with an empty text (the owner turned it off)."""
        if event.reply_token is None or not hasattr(adapter, "acknowledge"):
            return None
        text = self.store.extras(connection.id).ack_text
        if not text.strip():
            return None
        thread = self.store.get_thread(connection.id, event.conversation_key)
        if thread is not None and thread.paused:
            return None
        if self.store.has_earlier_unflushed(connection.id, event.conversation_key):
            return None
        return event.reply_token, text

    def _track(self, coro) -> None:
        """Run ``coro`` as a background task that ``drain`` waits for and
        ``stop`` cancels."""
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _acknowledge(
        self, connection: ChannelConnection, adapter, reply_token: str, text: str,
    ) -> None:
        """Best effort, never retried and never an outbox row: the token is
        single-use and dies within a minute. A failure is one log line with a
        fixed code; only a rejected access token changes the connection's
        status (it is dead for pushes too). The message itself is unaffected."""
        try:
            secret = self.store.load_secret(connection.id, self.config.fernet)
            await asyncio.wait_for(
                adapter.acknowledge(connection, secret, reply_token=reply_token, text=text),
                timeout=self.options.ack_timeout_seconds,
            )
        except AdapterError as exc:
            if exc.connection_status is not None:
                self._set_status(connection, adapter, exc.connection_status)
            logger.warning(
                "Channel connection %s: acknowledgement not sent: %s", connection.id[:8], exc.code,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "Channel connection %s: acknowledgement not sent: ack_timeout", connection.id[:8],
            )
        except Exception as exc:  # noqa: BLE001 — type only; best effort
            logger.warning(
                "Channel connection %s: acknowledgement not sent: %s",
                connection.id[:8], type(exc).__name__,
            )

    async def _look_up_name(
        self, connection: ChannelConnection, adapter, user_key: str, stand_in: str,
    ) -> None:
        """Best effort, like the acknowledgement: the contact's name from the
        provider (``adapter.profile_name``), replacing the stand-in on the
        contact, its Request and its unflushed messages. Never a reason to
        drop or delay a message; a failure is one log line with a fixed code
        (never the name or the user key) and no retry for
        ``profile_retry_seconds``. Not a message, so no quota is counted."""
        key = (connection.id, user_key)
        name: Optional[str] = None
        try:
            secret = self.store.load_secret(connection.id, self.config.fernet)
            raw = await asyncio.wait_for(
                adapter.profile_name(connection, secret, user_key=user_key),
                timeout=self.options.profile_timeout_seconds,
            )
            cleaned = clean_display_name(raw) if raw else None
            name = cleaned if cleaned not in (None, FALLBACK_DISPLAY_NAME) else None
            if name is None:
                logger.info("Channel connection %s: contact name not found", connection.id[:8])
        except AdapterError as exc:
            logger.warning(
                "Channel connection %s: contact name not fetched: %s", connection.id[:8], exc.code,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "Channel connection %s: contact name not fetched: profile_timeout",
                connection.id[:8],
            )
        except Exception as exc:  # noqa: BLE001 — type only; best effort
            logger.warning(
                "Channel connection %s: contact name not fetched: %s",
                connection.id[:8], type(exc).__name__,
            )
        finally:
            self._name_lookups.discard(key)
        if name is None:
            self._name_retry_at[key] = self._now() + self.options.profile_retry_seconds
            return
        self._name_retry_at.pop(key, None)
        try:
            self.store.rename_contact(
                connection_id=connection.id, provider_user_key=user_key,
                display_name=name, replacing=stand_in,
            )
        except Exception as exc:  # noqa: BLE001 — the stand-in stays
            logger.warning(
                "Channel connection %s: contact name not stored: %s",
                connection.id[:8], type(exc).__name__,
            )

    async def handle_email(self, form: InboundForm) -> int:
        """One authenticated Inbound Parse POST, already read under the email
        limits. Always 200 unless a store write failed (SendGrid retries any
        other answer for three days, and a retry cannot fix what was dropped).

        Dropped with 200, reaching no agent and no owner: an unreadable POST
        (no ``envelope``, no ``From:``); mail from one of our own addresses or
        carrying one of our own Message-IDs (agent-to-agent mail would loop);
        a recipient that is not a connection's address on the inbound domain;
        a disabled connection. Automatic mail (out-of-office, bounces, lists)
        goes into an existing conversation for the owner to see, never to the
        agent, and is dropped from anyone else — never answered, but counted
        on the connection with its sender domain and signal
        (``ChannelStore.note_automatic_dropped``). A dropped mail of any kind
        moves "last mail received" and writes no threading state.
        """
        from .email_mail import MailUnreadable, event_id, read_mail, thread_key

        adapter = self.adapters.get(EMAIL_CHANNEL)
        if adapter is None:
            return 404
        try:
            mail = read_mail(form)
        except MailUnreadable:
            logger.error("Channel email: dropped an Inbound Parse POST: MailUnreadable")
            return 200
        except Exception as exc:  # noqa: BLE001 — the body is the contact's text
            logger.error("Channel email: dropped an Inbound Parse POST: %s", type(exc).__name__)
            return 200
        domain = self.config.inbound_email_domain
        if mail.from_address is not None and _at_domain(mail.from_address, domain):
            logger.info("Channel email: dropped mail from one of our own addresses")
            return 200
        if mail.message_id is not None and mail.message_id.endswith(f"@{domain}>"):
            logger.info("Channel email: dropped mail carrying one of our own Message-IDs")
            return 200

        connections: list[ChannelConnection] = []
        unknown = 0
        for recipient in mail.recipients:
            if not _at_domain(recipient, domain, exact=True):
                continue
            connection = self.store.connection_for_account(
                EMAIL_CHANNEL, without_plus_tag(recipient),
            )
            if connection is None:
                unknown += 1
            elif connection.id not in {c.id for c in connections}:
                connections.append(connection)
        if unknown:
            logger.info("Channel email: %d recipient(s) matched no connection; dropped", unknown)
        if len(connections) > MAX_EMAIL_RECIPIENTS:
            logger.warning(
                "Channel email: mail to %d agent addresses; only the first %d get it",
                len(connections), MAX_EMAIL_RECIPIENTS,
            )
            connections = connections[:MAX_EMAIL_RECIPIENTS]
        if mail.from_address is None:
            if connections:
                logger.warning("Channel email: dropped mail with no readable From: address")
            return 200

        user_key = mail.from_address
        verified = access.sender_verified(mail.auth_verdict, adapter.provider_authenticates_sender)
        limits = self.options.limits()
        await self._hooks.point("inbound.after_verify")
        for connection in connections:
            if connection.disabled:
                continue
            await self._hooks.point("inbound.before_dedupe")
            lookup = mail.in_reply_to + list(reversed(mail.references[-20:]))
            # No await from here to the commit: the lookup and the write that
            # depends on it cannot interleave with another mail.
            conversation_key = self.store.email_conversation_for(connection.id, user_key, lookup)
            new_thread = conversation_key is None
            event = event_id(mail, user_key)
            if conversation_key is None:
                conversation_key = thread_key(user_key, mail.message_id or event)
            text = mail.text
            if new_thread and mail.subject:
                text = f"Subject: {mail.subject}\n\n{text}"
            if mail.automatic:
                text = AUTOMATIC_MAIL_PREFIX + text
            text = cap_text(text)
            now = self._now()

            def on_accept(db, connection=connection, now=now):
                self.store.note_email_received(db, connection.id, now)

            def on_kept(db, connection=connection, conversation_key=conversation_key, now=now):
                self.store.record_email_inbound(
                    db, connection_id=connection.id, conversation_key=conversation_key,
                    user_key=user_key, agent_address=connection.external_id or "",
                    subject=mail.subject, message_id=mail.message_id,
                    references=mail.references, trusted=verified, now=now,
                )

            decision = self.store.accept_inbound(
                connection_id=connection.id,
                event_id=event,
                conversation_key=conversation_key,
                user_key=user_key,
                handle=None,
                display_name=clean_display_name(mail.display_name or user_key.partition("@")[0]),
                text=text,
                verdict=mail.auth_verdict,
                verified=verified,
                limits=limits,
                now=now,
                flush_after=now + self.options.burst_seconds,
                render=_render_for(adapter),
                dispatch=not mail.automatic,
                on_accept=on_accept,
                on_kept=on_kept,
            )
            if decision.outcome == Outcome.BUFFERED:
                self._schedule_flush(connection.id, conversation_key)
            elif decision.outcome == Outcome.DROPPED_AUTOMATIC:
                # Never answered, but never invisible: counted on the
                # connection with its sender domain and signal (a provider's
                # "verify your sender" mail lands here). No address, subject
                # or text, in the log or the store.
                sender_domain = split_address(user_key)[1]
                self.store.note_automatic_dropped(
                    connection.id, domain=sender_domain,
                    reason=mail.automatic_reason or "", now=now,
                )
                logger.info(
                    "Channel connection %s: dropped automatic mail (%s) from a sender at %s "
                    "with no conversation", connection.id[:8], mail.automatic_reason,
                    sender_domain,
                )
            elif decision.outcome == Outcome.DROPPED_RATE_LIMITED and decision.first_over_limit:
                logger.warning(
                    "Channel connection %s: a sender is over the rate limit; their "
                    "messages are dropped for up to %d s",
                    connection.id[:8], int(self.options.rate_window_seconds),
                )
        await self._hooks.point("inbound.before_200")
        return 200

    def _schedule_flush(self, connection_id: str, conversation_key: str) -> None:
        key = (connection_id, conversation_key)
        self._live_flushes[key] = self._live_flushes.get(key, 0) + 1
        task = asyncio.create_task(self._flush_when_due(connection_id, conversation_key))
        self._tasks.add(task)

        def _done(t: asyncio.Task) -> None:
            self._tasks.discard(t)
            left = self._live_flushes.get(key, 1) - 1
            if left:
                self._live_flushes[key] = left
            else:
                self._live_flushes.pop(key, None)

        task.add_done_callback(_done)

    async def _flush_when_due(self, connection_id: str, conversation_key: str) -> None:
        key = (connection_id, conversation_key)
        try:
            while True:
                rows = self.store.unflushed(connection_id, conversation_key)
                if not rows:
                    return
                wait = max(r.flush_after for r in rows) - self._now()
                if wait <= 0:
                    break
                await asyncio.sleep(wait)
            await self.flush(connection_id, conversation_key)
            self._flush_backoff.pop(key, None)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — rows stay buffered; the retry sweep picks them up
            attempts = self._flush_backoff.get(key, (0, 0.0))[0] + 1
            delay = min(
                FLUSH_RETRY_MAX_SECONDS, FLUSH_RETRY_FIRST_SECONDS * (2 ** (attempts - 1)),
            )
            self._flush_backoff[key] = (attempts, self._now() + delay)
            self.flush_errors.append(type(exc).__name__)
            logger.error(
                "Channel flush failed for connection %s: %s (attempt %d, retry in %d s)",
                connection_id[:8], type(exc).__name__, attempts, int(delay),
            )

    def sweep_flushes(self) -> int:
        """Reschedule every conversation whose burst window has closed, that
        still has unflushed rows, no live flush task and no backoff pending —
        a flush that raised is retried here, not only at the next boot or the
        next message. Returns how many were scheduled."""
        now = self._now()
        scheduled = 0
        for key in self.store.overdue_unflushed(now):
            if self._live_flushes.get(key) or not self._serves(key[0]):
                continue
            backoff = self._flush_backoff.get(key)
            if backoff is not None and backoff[1] > now:
                continue
            self._schedule_flush(*key)
            scheduled += 1
        return scheduled

    def _conversation_lock(self, connection_id: str, conversation_key: str) -> asyncio.Lock:
        key = (connection_id, conversation_key)
        lock = self._conversation_locks.get(key)
        if lock is None:
            lock = self._conversation_locks[key] = asyncio.Lock()
        return lock

    async def flush(self, connection_id: str, conversation_key: str) -> None:
        """Append every buffered message of one conversation to its thread.

        Pause is judged HERE, when the messages are written into the thread,
        not when the webhook arrived: a burst that spans a pause is addressed
        by the state at flush time.

        A sender whose Allow is still in progress gets it finished first, so
        the combined message of what they sent while waiting always lands
        before what they sent after.
        """
        rows = self.store.unflushed(connection_id, conversation_key)
        senders = sorted({r.contact_id for r in rows})
        request = self.store.allowing_request_for(connection_id, senders)
        if request is not None:
            await self.finish_allow(request.id, follow_up=conversation_key)
        # The find-or-create race window: two first messages of one conversation
        # meet here before either holds the lock.
        await self._hooks.point("thread.find_or_create")
        async with self._conversation_lock(connection_id, conversation_key):
            rows = self.store.unflushed(connection_id, conversation_key)
            if not rows:
                return
            if self.store.allowing_request_for(
                connection_id, sorted({r.contact_id for r in rows}),
            ) is not None:
                raise AllowInProgress()
            connection = self.store.get_connection(connection_id)
            if connection is None:
                return
            agent = Agent.get(connection.agent_id, self._ctx.model_ctx)
            owner = User.get(connection.owner_id, self._ctx.model_ctx)
            if agent is None or owner is None:
                logger.error("Channel connection %s has no agent or owner", connection_id[:8])
                return
            thread, project = await self._find_or_create_locked(
                connection_id, conversation_key, rows[-1].contact_id, agent, owner,
            )
            runloop = await self._ctx.runloop_manager.get_or_create(
                project.id, project.name, project.coordinator_id,
            )

            # Adopt what an interrupted flush already appended (found by id).
            bases = [r.flush_base_version for r in rows if r.flush_base_version is not None]
            if bases:
                written = _message_ids_since(runloop, min(bases))
                adopted = [r.message_id for r in rows if r.message_id in written]
                if adopted:
                    self.store.mark_flushed(
                        adopted, connection_id=connection_id,
                        conversation_key=conversation_key,
                        clear_replaced=thread.replaced_project_id is not None,
                    )
                    thread = self.store.get_thread(connection_id, conversation_key) or thread
                rows = [r for r in rows if r.message_id not in written]
            if not rows:
                return

            await self._hooks.point("flush.before_append")
            self.store.set_flush_base(
                [r.message_id for r in rows], runloop.get_current_version(),
            )
            await self._append_contact_messages(thread, project, agent, owner, rows)
            await self._hooks.point("flush.after_append")
            self.store.mark_flushed(
                [r.message_id for r in rows], connection_id=connection_id,
                conversation_key=conversation_key,
                clear_replaced=thread.replaced_project_id is not None,
            )

    # ── Requests: Allow ──────────────────────────────────────────────────

    async def allow_request(self, request_id: str) -> Optional[ChannelRequest]:
        """The owner's Allow. Begins it (the intent commit) if the Request is
        pending, then finishes it — also when it was already ``allowing``
        (a second click, or the first click's answer was lost). Returns the
        Request as it ends up; the caller answers 409 for a blocked one."""
        request = self.store.begin_allow(request_id, now=self._now())
        if request is None or request.state != REQUEST_ALLOWING:
            return request
        await self._hooks.point("allow.after_intent")
        await self.finish_allow(request_id)
        return self.store.get_request(request_id)

    def block_request(self, request_id: str) -> Optional[ChannelRequest]:
        """The owner's Block (``ChannelStore.block_request``); a hub Request's
        staged files go with its held messages. Returns the Request as it
        ends up; the caller answers 409 for one being or already allowed."""
        held = self.store.held_for_request(request_id)
        request = self.store.block_request(request_id, now=self._now())
        if request is not None and request.state == REQUEST_BLOCKED and held:
            self.hub_files_flushed(held)
        return request

    def _allow_lock(self, request_id: str) -> asyncio.Lock:
        lock = self._allow_locks.get(request_id)
        if lock is None:
            lock = self._allow_locks[request_id] = asyncio.Lock()
        return lock

    async def finish_allow(self, request_id: str, *, follow_up: Optional[str] = None) -> None:
        """Steps two to four of Allow, idempotent: create each planned thread
        (through the same find-or-create the flush uses), append the combined
        message under its planned id unless a previous attempt already did, and
        commit the end state.

        Takes the conversation locks of every planned conversation, in sorted
        key order (one email sender can be waiting in two conversations; a
        fixed order means two Allows can never hold them crosswise).

        ``follow_up``: the conversation a flush is about to append newer
        messages to. Its combined message does not address the agent — the
        flushed message after it will, so the agent is woken once.
        """
        async with self._allow_lock(request_id):
            request = self.store.get_request(request_id)
            if request is None or request.state != REQUEST_ALLOWING:
                return
            connection = self.store.get_connection(request.connection_id)
            if connection is None:
                return
            agent = Agent.get(connection.agent_id, self._ctx.model_ctx)
            owner = User.get(connection.owner_id, self._ctx.model_ctx)
            if agent is None or owner is None:
                logger.error(
                    "Channel connection %s has no agent or owner", connection.id[:8],
                )
                return
            # The plan's conversations are fixed when Allow begins, so the
            # lock set is known before the request is read again under it.
            keys = sorted(p.conversation_key for p in request.allow_plan)
            async with AsyncExitStack() as stack:
                for key in keys:
                    await stack.enter_async_context(self._conversation_lock(connection.id, key))
                # Re-read under the locks: what an earlier attempt recorded
                # (the base versions) decides what is adopted. A connection
                # removed meanwhile took the Request with it: nothing to finish.
                request = self.store.get_request(request_id)
                if request is None or request.state != REQUEST_ALLOWING:
                    return
                if self.store.get_connection(connection.id) is None:
                    return
                held = self.store.held_for_request(request_id)
                plan = sorted(request.allow_plan, key=lambda p: p.conversation_key)
                for item in plan:
                    messages = [h for h in held if h.conversation_key == item.conversation_key]
                    await self._hooks.point("allow.before_thread")
                    thread, project = await self._find_or_create_locked(
                        connection.id, item.conversation_key, request.contact_id, agent, owner,
                    )
                    runloop = await self._ctx.runloop_manager.get_or_create(
                        project.id, project.name, project.coordinator_id,
                    )
                    if item.base_version is not None and item.message_id in _message_ids_since(
                        runloop, item.base_version,
                    ):
                        continue  # written by an earlier attempt
                    if not messages:
                        continue
                    await self._hooks.point("allow.before_combined")
                    self.store.set_allow_base(
                        request_id, item.conversation_key, runloop.get_current_version(),
                    )
                    await self._append_combined_message(
                        thread, project, agent, owner, request, messages, item.message_id,
                        address_agent=item.conversation_key != follow_up,
                    )
                    await self._hooks.point("allow.after_combined")
                self.store.complete_allow(request_id, now=self._now())
            if connection.channel == HUB_CHANNEL:
                try:
                    await self.on_hub_allowed(connection.id, [h.event_id for h in held])
                except Exception as exc:  # noqa: BLE001 — the Allow itself is done
                    logger.warning("Hub Allow notice failed: %s", type(exc).__name__)

    async def _append_combined_message(
        self, thread: ChannelThread, project: Project, agent: Agent, owner: User,
        request: ChannelRequest, held: list[HeldMessage], message_id: str, *,
        address_agent: bool,
    ) -> None:
        from clawmeets.server.routes.messages import (
            AddressedMessage,
            send_addressed_messages_as_user,
        )

        # A hub Request's held messages may have come with files: written
        # first, as the contact, and linked under the combined message.
        prelude: list[BatchEntrySpec] = []
        extra: dict[str, str] = {}
        hub = self._channel_is_hub(request.connection_id)
        staged = [
            HeldFiles(connection_id=h.connection_id, event_id=h.event_id, message_id=message_id,
                      contact_id=request.contact_id, display_name=request.display_name)
            for h in held
        ] if hub else []
        if staged:
            prelude, extra = self.hub_files_for(project, staged)
        content = combined_message_text(request, held) + extra.get(message_id, "")
        admitted, ticket = await self._admit_contact_message(
            thread, project, agent, owner, hub=hub, message_id=message_id,
            author_id=request.contact_id, author_name=request.display_name,
            content=content, files=prelude,
            hub_events=[(h.connection_id, h.event_id) for h in held] if hub else [],
            source_ref=message_id,
        )
        if admitted:
            message = AddressedMessage(
                chatroom_name=UC,
                content=content,
                expects=[agent.id] if address_agent else [],
                message_id=message_id,
                author_id=request.contact_id,
                author_name=request.display_name,
            )
            await send_addressed_messages_as_user(
                self._ctx, owner.id, owner.username, project.id, [message],
                prelude_specs=prelude, ingress_tickets=[ticket] if ticket else [],
            )
        if staged:
            self.hub_files_flushed(staged)

    async def _append_contact_messages(self, thread, project, agent, owner, rows) -> None:
        # Imported here: routes.messages imports this module (channel_thread_for).
        from clawmeets.server.routes.messages import (
            AddressedMessage,
            send_addressed_messages_as_user,
        )

        # Each message passes the inspection hook first (server/inspection.py):
        # a held or blocked one is not appended and wakes nobody.
        hub = bool(thread.connection_id and self._channel_is_hub(thread.connection_id))
        admitted: list[tuple] = []
        for row in rows:
            files, extra = self.hub_files_for(project, [row]) if hub else ([], {})
            content = row.text + extra.get(row.message_id, "")
            ok, ticket = await self._admit_contact_message(
                thread, project, agent, owner, hub=hub, message_id=row.message_id,
                author_id=row.contact_id, author_name=row.display_name,
                content=content, files=files,
                hub_events=[(row.connection_id, row.event_id)] if hub else [],
                source_ref=row.event_id or row.message_id,
            )
            if ok:
                admitted.append((row, files, content, ticket))

        # One dispatch per burst: only the last message addresses the agent;
        # the earlier ones are in the room when it reads. Contact text is never
        # mention-resolved. Pause is applied by the door itself (a paused
        # thread addresses nobody), so it holds for every caller alike.
        # Automatic mail (dispatch False) is never the one that wakes the agent.
        wake = max((i for i, (row, *_rest) in enumerate(admitted) if row.dispatch), default=None)
        prelude: list[BatchEntrySpec] = [spec for _row, files, _c, _t in admitted for spec in files]
        messages = [
            AddressedMessage(
                chatroom_name=UC,
                content=content,
                expects=[agent.id] if i == wake else [],
                message_id=row.message_id,
                author_id=row.contact_id,
                author_name=row.display_name,
            )
            for i, (row, _files, content, _ticket) in enumerate(admitted)
        ]
        if thread.replaced_project_id is not None:
            # Written as "system", unmarked: the outbox never sends it.
            prelude.append(
                BatchEntrySpec(
                    entry_type=ChangelogEntryType.MESSAGE,
                    payload=MessagePayload(
                        chatroom_name=UC,
                        id=str(uuid.uuid4()),
                        ts=_utc(self._now()),
                        from_participant_id=SYSTEM_SENDER_ID,
                        from_participant_name=SYSTEM_SENDER_NAME,
                        content=THREAD_REPLACED_NOTE,
                    ),
                )
            )
        if messages:
            await send_addressed_messages_as_user(
                self._ctx, owner.id, owner.username, project.id, messages,
                prelude_specs=prelude,
                ingress_tickets=[t for *_rest, t in admitted if t is not None],
            )
        if hub:
            self.hub_files_flushed(rows)

    async def _admit_contact_message(
        self, thread: ChannelThread, project: Project, agent: Agent, owner: User, *,
        hub: bool, message_id: str, author_id: str, author_name: str, content: str,
        files: list[BatchEntrySpec], hub_events: list[tuple[str, str]], source_ref: str,
    ) -> tuple[bool, Optional[object]]:
        """The inspection hook for one contact message (path ``hub_inbound`` or
        ``channel_inbound``): ``(admitted, ticket)``. A hold stores the message
        with what ``deliver_held`` needs to append it on release; a hub
        sender gets the signed ack, a blocked channel contact one generic
        reply."""
        from clawmeets.models.provenance import outside_author
        from clawmeets.server.inspection import InspectionRequest, OutsidePath, Verdict, file_refs

        ingress = getattr(self._ctx, "outside_ingress", None)
        if ingress is None or outside_author(project, author_id, self._ctx.model_ctx) is None:
            return True, None
        path = OutsidePath.HUB_INBOUND if hub else OutsidePath.CHANNEL_INBOUND
        req = InspectionRequest(
            path=path, direction="inbound", owner_user_id=owner.id, project_id=project.id,
            chatroom=UC, author_id=author_id, author_label=author_name, text=content,
            files=file_refs(spec.payload for spec in files), source_ref=source_ref,
        )
        admission = await ingress.admit(req, replay={
            "project_id": project.id, "owner_id": owner.id, "agent_id": agent.id,
            "message_id": message_id, "author_id": author_id, "author_name": author_name,
            "content": content, "hub_events": [list(e) for e in hub_events],
            "files": [
                {"entry_type": spec.entry_type.value, "payload": spec.payload.model_dump(mode="json")}
                for spec in files
            ],
        })
        if admission.passed:
            return True, admission.ticket
        for connection_id, event_id in hub_events:
            await self.on_hub_inspected(connection_id, event_id, admission.verdict.value)
        if not hub and admission.verdict == Verdict.BLOCK:
            self._send_blocked_reply(thread, message_id)
        return False, None

    def _send_blocked_reply(self, thread: ChannelThread, message_id: str) -> None:
        fresh = self.store.get_thread(thread.connection_id, thread.conversation_key) or thread
        now = self._now()
        self.store.enqueue(
            fresh, [OutboundUnit(message_id=f"blocked:{message_id}", parts=[BLOCKED_REPLY], created_at=now)],
            cursor=fresh.outbox_cursor, now=now,
        )

    async def block_held(self, replay: Mapping) -> None:
        """A held contact message blocked on release: as on a live block, a
        hub requester gets the signed ``blocked`` ack and a channel contact
        the one generic reply."""
        events = replay.get("hub_events") or []
        for connection_id, event_id in events:
            await self.on_hub_inspected(connection_id, event_id, "block")
        thread = self.store.thread_for_project(replay["project_id"])
        if thread is not None and not self._channel_is_hub(thread.connection_id):
            self._send_blocked_reply(thread, replay["message_id"])

    async def deliver_held(self, replay: Mapping, ticket) -> None:
        """Append a released contact message (``hub_inbound`` /
        ``channel_inbound``) exactly as the flush would have, with its ticket.
        A hub requester's message reached the agent: ``on_hub_allowed``."""
        from clawmeets.server.routes.messages import (
            AddressedMessage,
            send_addressed_messages_as_user,
        )

        owner = User.get(replay["owner_id"], self._ctx.model_ctx)
        if owner is None:
            return
        prelude = [
            BatchEntrySpec(entry_type=ChangelogEntryType(f["entry_type"]),
                           payload=FilePayload.model_validate(f["payload"]))
            for f in replay.get("files") or []
        ]
        await send_addressed_messages_as_user(
            self._ctx, owner.id, owner.username, replay["project_id"],
            [AddressedMessage(
                chatroom_name=UC, content=replay["content"], expects=[replay["agent_id"]],
                message_id=replay["message_id"], author_id=replay["author_id"],
                author_name=replay["author_name"],
            )],
            prelude_specs=prelude, ingress_tickets=[ticket],
        )
        events = replay.get("hub_events") or []
        if events:
            await self.on_hub_allowed(events[0][0], [e[1] for e in events])

    def _channel_is_hub(self, connection_id: str) -> bool:
        connection = self.store.get_connection(connection_id)
        return connection is not None and connection.channel == HUB_CHANNEL

    async def _find_or_create_locked(
        self, connection_id: str, conversation_key: str, contact_id: str,
        agent: Agent, owner: User,
    ) -> tuple[ChannelThread, Project]:
        """The conversation's thread, creating (or re-creating) its project.

        The mapping lookup does not look at project status: a completed thread
        is the same thread, and the contact's message reopens it.
        """
        now = self._now()
        thread = self.store.get_thread(connection_id, conversation_key)
        if thread is None:
            thread = self.store.claim_thread(
                connection_id=connection_id, conversation_key=conversation_key,
                contact_id=contact_id, project_id=str(uuid.uuid4()),
                project_name=new_thread_slug(connection_id), now=now,
            )
        # Inside the lock: a second flush of this conversation must not get here
        # until this one has finished (tests suspend here to prove it).
        await self._hooks.point("thread.claimed")
        if thread.state == THREAD_LIVE:
            project = _project_or_none(thread.project_id, self._ctx)
            if project is not None:
                return thread, project
            logger.info(
                "Channel thread for connection %s lost its project; starting a new one",
                connection_id[:8],
            )
            thread = self.store.repoint_thread(
                thread, project_id=str(uuid.uuid4()),
                project_name=new_thread_slug(connection_id), now=now,
            )
        project = await self._ensure_project(thread, agent, owner)
        self.store.mark_thread_live(connection_id, conversation_key)
        fresh = self.store.get_thread(connection_id, conversation_key)
        assert fresh is not None
        return fresh, project

    def _requester_scope(self, thread: ChannelThread) -> dict:
        """``requester_key`` (and ``memory_excluded``) for a conversation's
        project: ``hub:{root_fp}/{user_id}`` and memory-excluded for a hub
        conversation (the person at the remote deployment), otherwise
        ``channel:{connection}/{contact}``."""
        return requester_scope(getattr(self, "store", None), thread)

    async def _ensure_project(self, thread: ChannelThread, agent: Agent, owner: User) -> Project:
        """Create the mapped project, or finish creating it. Idempotent."""
        runloop = await self._ctx.runloop_manager.get_or_create(
            thread.project_id, thread.project_name, agent.id,
        )
        if runloop.get_current_version() == 0:
            await runloop.append(
                ChangelogEntryType.PROJECT_CREATED,
                ProjectCreatedPayload(
                    project_id=thread.project_id,
                    project_name=thread.project_name,
                    coordinator_id=agent.id,
                    coordinator_name=agent.name,
                    request="Channel conversation",
                    created_by=owner.id,
                    **invite_pool(getattr(self, "store", None), thread, agent),
                    surface="frontdesk",
                    display_name=NEW_CHAT_PLACEHOLDER,
                    # Every channel conversation serves its contact, never
                    # the owner: its turns are requester-scoped. A hub
                    # conversation is also kept out of memory.
                    **self._requester_scope(thread),
                ),
            )
            await self._hooks.point("thread.after_project_created")
        if Chatroom.get(thread.project_id, UC, self._ctx.model_ctx) is None:
            await runloop.append(
                ChangelogEntryType.ROOM_CREATED,
                RoomCreatedPayload(
                    chatroom_name=UC,
                    participants=[RoomCreatedParticipant(id=agent.id, name=agent.name)],
                ),
            )
        project = Project.get(thread.project_id, self._ctx.model_ctx)
        await self._broadcast(project, runloop.get_current_version())
        return project

    async def _broadcast(self, project: Project, version: int) -> None:
        from clawmeets.server.routes.messages import _broadcast_changelog

        await _broadcast_changelog(self._ctx, project, version)

    # ── outbound ─────────────────────────────────────────────────────────

    async def run_outbox_once(self) -> None:
        """One pass of the worker: reschedule overdue flushes, then the outbox."""
        self.sweep_flushes()
        async with self._outbox_lock:
            # Hub rows whose wait is over (a re-relay due, a retry_after
            # passed) are claimable on this pass, not at the next sweep; only
            # as many re-relays as the relay bucket can send now.
            now = self._now()
            self.hub.wake_due(
                now=now,
                re_relay_limit=(
                    self._relay_bucket.re_relays_available(now)
                    if self._relaying_adapter() is not None else None
                ),
            )
            await self._enqueue_all()
            await self._hooks.point("outbox.after_enqueue")
            await self._send_due()

    async def _worker(self) -> None:
        last_sweep = float("-inf")
        while True:
            try:
                await self.run_outbox_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — the worker must outlive one bad pass
                logger.error("Channel outbox pass failed: %s", type(exc).__name__)
            try:
                if self._now() - last_sweep >= self.options.hub_sweep_seconds:
                    # Whatever the hub mode, whether or not a hub socket is
                    # up, and in its own try so a failed outbox pass cannot
                    # stop it: a hub row must still expire.
                    last_sweep = self._now()
                    await self.sweep_hub_rows()
                now = self._now()
                self.store.prune(
                    older_than=now - self.options.retention_seconds,
                    rate_older_than=now - self.options.rate_window_seconds,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.error("Channel sweep or prune failed: %s", type(exc).__name__)
            await asyncio.sleep(self.options.outbox_poll_seconds)

    async def _enqueue_all(self) -> None:
        for thread in self.store.all_threads():
            if thread.state != THREAD_LIVE or not self._serves(thread.connection_id):
                continue
            project = _project_or_none(thread.project_id, self._ctx)
            if project is None:
                continue
            runloop = await self._ctx.runloop_manager.get_or_create(
                project.id, project.name, project.coordinator_id,
            )
            if runloop.get_current_version() <= thread.outbox_cursor:
                continue
            entries = runloop.get_entries_since(thread.outbox_cursor)
            if not entries:
                continue
            connection = self.store.get_connection(thread.connection_id)
            render = _render_for(self.adapters.get(connection.channel) if connection else None)
            units = outbound_units(entries, project, render, self._file_link_maker(project.id))
            await self._hooks.point("outbox.before_enqueue")
            self.store.enqueue(thread, units, cursor=entries[-1].version, now=self._now())

    def _file_link_maker(self, project_id: str) -> Callable[[FilePayload], str]:
        """Signed download links (``file_links``) for files in ``project_id``'s
        user-communication room, made now and valid for the link lifetime.
        "" (the file is listed by name) on a hub-only gateway with no
        server URL: a relative link would be useless to the contact."""
        now = self._now()

        def link_for(payload: FilePayload) -> str:
            if not self.config.secret_keys or not self.config.server_url:
                return ""
            token = file_links.make_token(
                self.config.secret_keys[0], project_id=project_id, chatroom_name=UC,
                filename=payload.filename, sha256=payload.sha256, now=now,
            )
            return file_links.file_url(self.config.server_url, token)
        return link_for

    def read_file_link(self, token: str) -> Optional[file_links.FileLink]:
        """The file a download link grants, or None: a bad or expired token,
        or a project that is no longer a channel thread this gateway serves."""
        link = file_links.read_token(self.config.secret_keys, token, now=self._now())
        if link is None:
            return None
        thread = self.store.thread_for_project(link.project_id)
        if thread is None or not self._serves(thread.connection_id):
            return None
        return link

    async def _send_due(self) -> None:
        """Send everything claimable, re-reading after each round: the next
        part of a reply becomes claimable only once the part before it ends."""
        tried: set[str] = set()
        channels: dict[str, Optional[str]] = {}     # connection id -> channel, this pass
        while True:
            now = self._now()
            rows = [
                r for r in self.store.claimable(
                    now, stale_sending_before=now - self.options.stale_sending_seconds,
                    claimer=self._claimer,
                )
                if r.id not in tried
            ]
            if not rows:
                return
            for row in rows:
                tried.add(row.id)
                if not self.config.providers_enabled and self._channel_of(row, channels) != HUB_CHANNEL:
                    continue                    # a hub-only gateway leaves other channels' rows alone
                if self._hub_row_waits_for_a_token(row, now, channels):
                    continue
                await self._send_one(row)

    async def _send_one(self, row: OutboxRow) -> None:
        now = self._now()
        # Judged on the row as claimed: an earlier attempt (or a send that
        # crashed mid-flight, left ``sending``) may have reached the provider,
        # so its Message-ID must stay indexed whatever ends the row now.
        never_attempted = row.state == PENDING and row.attempts == 0
        # A fixed reply has no thread: it answers a Request, so "the thread is
        # gone" cannot apply to it (the 24 h rule below still does).
        if row.kind != KIND_FIXED_REPLY and _project_or_none(row.project_id, self._ctx) is None:
            self.store.finish(row.id, EXPIRED, reason=REASON_THREAD_GONE, now=now)
            return
        connection = self.store.get_connection(row.connection_id)
        if connection is not None and connection.channel == HUB_CHANNEL:
            await self._relay_one(row, connection)
            return
        adapter = self.adapters.get(connection.channel) if connection else None
        # The window first, on every claim: a reply produced while it was open
        # but claimed after it closed (a backoff, a disabled connection, an
        # outage) is held too, and a closed window says so rather than "expired".
        if adapter is not None and self._window_closed(adapter, row, now):
            reason = (
                REASON_WINDOW_CLOSED_MAYBE_SENT if row.state == SENDING or row.attempts > 0
                else REASON_WINDOW_CLOSED
            )
            self.store.finish(row.id, HELD_WINDOW, reason=reason, now=now)
            return
        # Checked on EVERY claim, not only when the switch comes back on: a
        # server that was down for two days must not send day-old replies.
        # A channel may allow less (LINE: its retry key is remembered 24 h).
        max_age = min(
            self.options.max_outbound_age_seconds,
            getattr(adapter, "max_outbound_age_seconds", None) or self.options.max_outbound_age_seconds,
        )
        if now - row.created_at > max_age:
            reason = (
                REASON_MAYBE_SENT if row.state == SENDING or row.attempts > 0
                else REASON_NEVER_SENT
            )
            await self._hooks.point("outbox.expiry_decided")
            self.store.finish(
                row.id, EXPIRED, reason=reason, now=now, never_sent=reason == REASON_NEVER_SENT,
            )
            return
        if connection is None or adapter is None:
            self.store.finish(
                row.id, FAILED, reason="no_adapter", now=now, never_sent=never_attempted,
            )
            return

        cap = getattr(adapter, "max_agent_replies_per_hour", None)
        if cap and row.from_agent and row.kind != KIND_FIXED_REPLY and row.state != SENDING and (
            self.store.agent_replies_sent_since(
                connection.id, row.conversation_key, now - 3600,
            ) >= cap
        ):
            logger.warning(
                "Channel connection %s: reply_limit_reached (%d agent replies in an hour "
                "to one contact); not sent", connection.id[:8], cap,
            )
            self.store.finish(
                row.id, FAILED, reason=REASON_REPLY_LIMIT, now=now, never_sent=never_attempted,
            )
            return
        if not self.store.mark_sending(row.id, now, claimer=self._claimer):
            return  # ended meanwhile (the connection was removed)
        attempt = row.attempts + 1
        await self._hooks.point("outbox.before_send")
        try:
            secret = self.store.load_secret(connection.id, self.config.fernet)
            await adapter.send(
                connection, secret,
                conversation_key=row.conversation_key,
                text=row.text,
                retry_key=row.retry_key,
            )
        except AdapterError as exc:
            if exc.window_closed:
                # The provider's clock says the window closed: one contact's
                # state, not the connection's health. Dated by the claim, not
                # the answer: Meta refused a send that started at ``now``, so a
                # message the contact wrote while it was in flight reopens it.
                logger.info(
                    "Channel connection %s: reply held: %s", connection.id[:8], exc.code,
                )
                self.store.note_provider_closed(connection.id, row.conversation_key, now)
                self.store.finish(row.id, HELD_WINDOW, reason=REASON_WINDOW_CLOSED, now=self._now())
                return
            if exc.connection_status is not None:
                self._set_status(connection, adapter, exc.connection_status, detail=exc.detail)
            if exc.connection_status == STATUS_QUOTA_EXHAUSTED:
                self.store.set_quota_exhausted(connection.id, self._now())
            elif exc.connection_status is not None and (
                exc.connection_status == getattr(adapter, "push_refused_status", None)
            ):
                self.store.set_push_refused(connection.id, self._now())
            self._send_failed(
                row, attempt, exc.code, exc.permanent, type(exc).__name__,
                retry_after=exc.retry_after, detail=exc.detail, never_sent=never_attempted,
            )
            return
        except Exception as exc:  # noqa: BLE001 — type only; str(exc) may quote a token-bearing URL
            self._send_failed(row, attempt, "send_error", False, type(exc).__name__)
            return
        await self._hooks.point("outbox.after_send")
        self.store.finish(row.id, SENT, reason=None, now=self._now())
        if connection.status in getattr(adapter, "statuses_cleared_by_send", ()):
            self.store.set_status(connection.id, STATUS_WORKING, now=self._now())
        if hasattr(adapter, "quota") and self.store.extras(connection.id).quota_exhausted_at:
            self.store.set_quota_exhausted(connection.id, None)
        if (hasattr(adapter, "push_refused_status")
                and self.store.extras(connection.id).push_refused_at):
            self.store.set_push_refused(connection.id, None)

    # ── outbound: hub rows ───────────────────────────────────────────────

    def _relaying_adapter(self) -> Optional[RelayingAdapter]:
        adapter = self.adapters.get(HUB_CHANNEL)
        return adapter if hasattr(adapter, "relay") else None

    def _channel_of(self, row: OutboxRow, channels: dict[str, Optional[str]]) -> Optional[str]:
        """The channel of a row's connection, cached per pass in ``channels``."""
        if row.connection_id not in channels:
            connection = self.store.get_connection(row.connection_id)
            channels[row.connection_id] = connection.channel if connection else None
        return channels[row.connection_id]

    def _hub_row_waits_for_a_token(
        self, row: OutboxRow, now: float, channels: dict[str, Optional[str]],
    ) -> bool:
        """A hub row the relay bucket has no room for stays ``pending`` for a
        later pass, without a claim (and without reading its project)."""
        if self._relaying_adapter() is None:
            return False                       # it parks in _relay_one
        if self._channel_of(row, channels) != HUB_CHANNEL:
            return False
        return not self._relay_bucket.can_take(first_send=row.forwarded_at is None, now=now)

    async def _relay_one(self, row: OutboxRow, connection: ChannelConnection) -> None:
        """One claim of a hub row (see ``hub_delivery``): expire it past its
        age; park it while no relaying adapter is registered (never
        ``no_adapter``: a hub row waits for its hub, and the sweep expires
        it); otherwise relay the stored envelope, within the relay bucket.

        A relay is not an attempt: only a frame that could not be written
        counts as one (the row is retried like any send). ``on_written`` marks
        the row forwarded at the write, so an ack lost after it still leaves
        the row counted as forwarded."""
        now = self._now()
        if now - row.created_at > hub_delivery.max_age(row):
            if row.kind == KIND_HUB_REQUEST:
                reason = REASON_EXPIRED_72H
            else:
                reason = REASON_MAYBE_SENT if row.forwarded_at is not None else REASON_NEVER_SENT
            self.store.finish(row.id, EXPIRED, reason=reason, now=now)
            await self._hub_row_changed(row.id)
            return
        adapter = self._relaying_adapter()
        if adapter is None:
            self.hub.park(row.id, reason=WAIT_HUB_UNREACHABLE, until=None, now=now)
            await self._hub_row_changed(row.id)
            return
        if not self._relay_bucket.take(first_send=row.forwarded_at is None, now=now):
            return
        if not self.store.mark_sending(row.id, now, claimer=self._claimer, count_attempt=False):
            return
        attempt = row.attempts + 1
        await self._hooks.point("outbox.before_relay")
        try:
            outcome = await adapter.relay(
                connection, row, on_written=lambda: self.hub.mark_forwarded(row.id, now=self._now()),
            )
        except AdapterError as exc:
            self._send_failed(
                row, attempt, exc.code, exc.permanent, type(exc).__name__,
                retry_after=exc.retry_after, detail=exc.detail, count_attempt=True,
            )
        except Exception as exc:  # noqa: BLE001 — type only
            self._send_failed(row, attempt, "send_error", False, type(exc).__name__, count_attempt=True)
        else:
            if isinstance(outcome, Forwarded):
                self.hub.await_receipt(row.id, now=self._now())
            elif isinstance(outcome, Parked):
                self.hub.park(row.id, reason=outcome.reason, until=outcome.until, now=self._now())
            elif isinstance(outcome, Refused):
                self.store.finish(
                    row.id, FAILED, reason=outcome.reason, now=self._now(),
                    delivery_detail=outcome.detail, retry_at=outcome.retry_at,
                )
        await self._hub_row_changed(row.id)

    async def _hub_row_changed(self, row_id: str) -> None:
        """After every change to a hub row: the hub client's push, and for a
        requester's message, its paused batch (the timer starts when the
        target has the message; the batch closes when the message cannot
        get there)."""
        row = self.store.get_outbox_row(row_id)
        if row is None:
            return
        try:
            await self.on_hub_row_change(row)
        except Exception as exc:  # noqa: BLE001 — a push must never stop the outbox
            logger.warning("Hub row push failed: %s", type(exc).__name__)
        if row.kind != KIND_HUB_REQUEST or row.project_id is None:
            return
        tracker = getattr(self._ctx, "work_tracker", None)
        if tracker is None:
            return
        work = await tracker.get_pending_work(row.project_id, UC)
        if work is None or work.awaiting_since is None:
            return
        if row.state == SENT and not hub_delivery.is_held(row) and not row.delivered_late:
            await tracker.start_timer(row.project_id, UC)
        elif row.state in (FAILED, EXPIRED):
            from clawmeets.server.batch_timeout import NEVER_PICKED_UP_NOTE
            from clawmeets.server.timeout_checker import close_undelivered_work

            await close_undelivered_work(tracker, self._ctx.runloop_manager, work, NEVER_PICKED_UP_NOTE)

    async def complete_on_receipt(self, connection_id: str, ack: DeliverAck) -> Optional[OutboxRow]:
        """A receipt for one of this connection's hub rows. The CALLER has
        verified ``ack``'s signature against the receiver's pinned key. A
        receipt for a row that already ended changes nothing, except a kept
        one (accepted or picked up) for a row that ended ``expired_72h``,
        ``held_expired`` or ``key_revoked``: it was delivered late."""
        now = self._now()
        transition = hub_delivery.receipt_transition(ack, now=now)
        row = self.hub.apply_receipt(connection_id, ack.message_id, transition, now=now)
        if row is None and transition.kind == "sent":
            row = self.hub.mark_delivered_late(
                connection_id, ack.message_id, last_receipt=transition.last_receipt, now=now,
            )
        if row is not None:
            await self._hub_row_changed(row.id)
        return row

    async def sweep_hub_rows(self) -> SweepReport:
        """The hub rows' clock, every ``hub_sweep_seconds`` from the worker.
        Never reads the hub mode and needs no socket:

        1. a waiting row past its kind's max age (from ``created_at``) ends
           ``expired`` (``expired_72h`` for a request);
        2. a held row 7 days after it was forwarded ends ``failed`` /
           ``held_expired`` (``last_receipt`` kept);
        3. a held row whose probe is due is probed, if a relaying adapter is
           registered and the relay bucket has room; otherwise it stays due.

        A request ended here closes its paused batch with a note."""
        expired: list[str] = []
        held_expired: list[str] = []
        probed: list[str] = []
        adapter = self._relaying_adapter()
        async with self._outbox_lock:
            now = self._now()
            for row in self.hub.hub_rows_open():
                if row.state in (PENDING, PARKED, AWAITING_RECEIPT) and (
                    now - row.created_at > hub_delivery.max_age(row)
                ):
                    if row.kind == KIND_HUB_REQUEST:
                        reason = REASON_EXPIRED_72H
                    else:
                        reason = REASON_MAYBE_SENT if row.forwarded_at is not None else REASON_NEVER_SENT
                    if self.store.finish(row.id, EXPIRED, reason=reason, now=now):
                        expired.append(row.id)
                elif hub_delivery.is_held(row):
                    since = row.forwarded_at if row.forwarded_at is not None else row.created_at
                    if now - since > hub_delivery.HELD_CEILING_SECONDS:
                        if self.hub.end_held(row.id, reason=REASON_HELD_EXPIRED, now=now):
                            held_expired.append(row.id)
                    elif row.probe_due_at is not None and row.probe_due_at <= now and adapter is not None:
                        connection = self.store.get_connection(row.connection_id)
                        if connection is None or not self._relay_bucket.take(first_send=False, now=now):
                            continue
                        try:
                            written = await adapter.probe(connection, row)
                        except Exception as exc:  # noqa: BLE001 — a failed probe just stays due
                            logger.warning("Hub probe failed: %s", type(exc).__name__)
                            written = False
                        if written:
                            self.hub.set_probe_due(row.id, self._now() + hub_delivery.PROBE_SECONDS)
                            probed.append(row.id)
        for row_id in expired + held_expired:
            await self._hub_row_changed(row_id)
        return SweepReport(expired=expired, held_expired=held_expired, probed=probed)

    async def resign_after_rekey(self, *, chained: bool, resign: Resigner,
                                 current_fp: Optional[str] = None) -> ResignReport:
        """This deployment's identity key was replaced. Under the outbox lock
        (no row is mid-send), every hub row still carrying an envelope signed
        by the old key, held rows included:

        - ``chained`` (the new key is a rotation the old one signed): every
          open row is re-signed; held rows need nothing (the receiver has them);
        - not chained (the old root is closed on the other side): a row that
          was never forwarded is re-signed and goes out once under the new key;
          a forwarded one (held included) ends ``failed`` / ``key_revoked`` —
          it may have been delivered, and nothing signed by the old key can
          follow it. So does a row whose resigner raises :class:`CannotResign`.

        A row whose envelope is already signed by ``current_fp`` (the key now
        in use) is left alone: it was re-signed by an earlier run, or signed
        after the re-key. So a repeat, or a retry after a crash partway
        through, ends nothing that already follows the new key.

        The purpose is read back from the row and must be ``ENVELOPE``; the new
        envelope must keep ``message_id`` and ``sent_at``. A row that fails
        either check ends ``failed`` (``bad_envelope``) and is logged."""
        resigned: list[str] = []
        revoked: list[str] = []
        refused: list[str] = []
        async with self._outbox_lock:
            now = self._now()
            for row in self.hub.hub_rows_open():
                if row.envelope is None:
                    continue                      # signed at its first send, with the new key
                if current_fp is not None and _signed_by(row.envelope) == current_fp:
                    continue                      # already under the key now in use
                held = hub_delivery.is_held(row)
                if not chained and (row.forwarded_at is not None or held):
                    ended = (self.hub.end_held(row.id, reason=REASON_KEY_REVOKED, now=now) if held
                             else self.store.finish(row.id, FAILED, reason=REASON_KEY_REVOKED, now=now))
                    if ended:
                        revoked.append(row.id)
                    continue
                if held:
                    continue
                try:
                    purpose = Purpose(row.envelope_purpose)
                    if purpose is not Purpose.ENVELOPE:
                        raise ValueError(purpose)
                    old = json.loads(row.envelope)
                    new = resign(old, purpose)
                    if (new.get("message_id"), new.get("sent_at")) != (old["message_id"], old["sent_at"]):
                        raise ValueError("re-signing changed the message id or sent_at")
                except CannotResign:
                    if self.store.finish(row.id, FAILED, reason=REASON_KEY_REVOKED, now=now):
                        revoked.append(row.id)
                    continue
                except Exception as exc:  # noqa: BLE001 — one bad row must not stop the re-key
                    logger.error(
                        "Hub row %s: envelope not re-signed after the re-key: %s",
                        row.id[:8], type(exc).__name__,
                    )
                    if self.store.finish(row.id, FAILED, reason=REASON_BAD_ENVELOPE, now=now):
                        refused.append(row.id)
                    continue
                if self.hub.replace_envelope(row.id, new, purpose):
                    resigned.append(row.id)
        for row_id in revoked + refused:
            await self._hub_row_changed(row_id)
        return ResignReport(resigned=resigned, revoked=revoked, refused=refused)

    async def note_late_reply(
        self, connection_id: str, in_reply_to: str, *, project_id: str,
    ) -> Optional[OutboxRow]:
        """A reply arrived in thread ``project_id`` for a request of THAT
        thread that ended ``expired_72h``, ``held_expired`` or
        ``key_revoked``: it was delivered after all (``delivered_late``; its
        reason and ``created_at``, so its expiry, are kept). A request of any
        other thread is never touched."""
        row = self.hub.mark_delivered_late(
            connection_id, in_reply_to, last_receipt=DeliverResult.PICKED_UP.value, now=self._now(),
            project_id=project_id,
        )
        if row is not None:
            await self._hub_row_changed(row.id)
        return row

    def wake_parked(self, *, connection_id: str, conversation_prefix: Optional[str] = None) -> int:
        """The target deployment (``conversation_prefix`` = ``<its genesis fp>/``)
        or the hub itself came back: parked rows are claimable again."""
        return self.hub.wake(
            connection_id=connection_id, conversation_prefix=conversation_prefix, now=self._now(),
        )

    def _send_failed(
        self, row: OutboxRow, attempt: int, code: str, permanent: bool, error_type: str,
        *, retry_after: Optional[float] = None, detail: Optional[str] = None,
        never_sent: bool = False, count_attempt: bool = False,
    ) -> None:
        """``detail`` (the provider's own words, see ``AdapterError.detail``)
        is stored on the row for the owner and never logged. ``never_sent``
        (this was the row's first attempt) lets a permanent refusal drop the
        email Message-ID; ``retries_exhausted`` always keeps it."""
        now = self._now()
        logger.warning(
            "Channel send failed: connection=%s reason=%s error=%s attempt=%d",
            row.connection_id[:8], code, error_type, attempt,
        )
        if permanent:
            self.store.finish(
                row.id, FAILED, reason=code, now=now, detail=detail, never_sent=never_sent,
            )
        elif attempt >= self.options.max_send_attempts:
            self.store.finish(
                row.id, FAILED, reason=REASON_RETRIES_EXHAUSTED, now=now, detail=detail,
            )
        else:
            backoff = min(300.0, 5.0 * (2 ** (attempt - 1)))
            if retry_after is not None:
                backoff = retry_after  # the provider said when (Telegram's 429)
            self.store.retry_later(
                row.id, at=now + backoff, reason=code, now=now, detail=detail,
                count_attempt=count_attempt,
            )

    # ── connections (owner actions) ──────────────────────────────────────

    def _set_status(self, connection: ChannelConnection, adapter, status: str, **kw) -> None:
        """A health status on this connection — or on every connection of the
        channel when they all send with the server's one credential (email)."""
        if getattr(adapter, "shared_credential", False):
            self.store.set_status_for_channel(
                connection.channel, status, now=self._now(), detail=kw.get("detail"),
            )
        else:
            self.store.set_status(connection.id, status, now=self._now(), **kw)

    def _managed(self, connection: ChannelConnection):
        """The adapter, if it manages its own webhook with the provider."""
        adapter = self.adapters.get(connection.channel)
        return adapter if hasattr(adapter, "register_webhook") else None

    def webhook_url(self, connection: ChannelConnection) -> str:
        if getattr(self.adapters.get(connection.channel), "server_webhook", False):
            return self.config.webhook_url(connection.channel)
        return self.config.webhook_url(f"{connection.channel}/{connection.id}")

    async def connect(
        self, *, agent_id: str, owner_id: str, channel: str, label: str, secret: SecretStr,
        owner_username: str = "", agent_short_name: str = "",
        credentials: Optional[Mapping[str, SecretStr]] = None,
    ) -> ChannelConnection:
        """Connect an agent to a channel. For a managed channel: the credential
        is checked (format, then the provider) before anything is stored; only
        then one connection per provider account across all owners (409); then the
        webhook is registered, and the connection removed again if that fails.

        A channel with several values (LINE: the channel secret that checks
        signatures; WhatsApp: the app secret, the verify token and the phone
        number id) gets them in ``credentials`` by name, next to the access
        token in ``secret``, and stores them all as one encrypted credential
        (``adapter.pack_credential``). Only the access token's last four are
        shown — and, for an adapter that names one
        (``shown_credential_field``), the last four of that one too (WhatsApp's
        verify token). A push quota is fetched once connected (a failure leaves
        the figures unknown; it never fails the connect).
        Raises :class:`ConnectionSetupError`."""
        adapter = self.adapters.get(channel)
        if adapter is None:
            raise ConnectionSetupError(400, f"Unknown channel {channel!r}")
        now = self._now()
        if getattr(adapter, "shared_credential", False):
            return self._connect_shared(
                adapter, agent_id=agent_id, owner_id=owner_id, label=label,
                owner_username=owner_username, agent_short_name=agent_short_name, now=now,
            )
        if getattr(adapter, "server_generated_secret", False):
            return self._connect_generated(adapter, agent_id=agent_id, owner_id=owner_id,
                                           label=label, now=now)
        if not hasattr(adapter, "register_webhook"):
            if len(secret.get_secret_value().strip()) < 8:
                raise ConnectionSetupError(400, "secret is too short")
            return self.store.create_connection(
                agent_id=agent_id, owner_id=owner_id, channel=channel, label=label,
                secret=secret.get_secret_value().strip(), fernet=self.config.fernet, now=now,
            )
        token = SecretStr(secret.get_secret_value().strip())
        last4: Optional[str] = None
        second_last4: Optional[str] = None
        pack = getattr(adapter, "pack_credential", None)
        if pack is not None:
            access_token = token.get_secret_value()
            last4 = access_token[-4:] if len(access_token) >= 8 else ""
            fields = {
                name: value.get_secret_value().strip()
                for name, value in (credentials or {}).items()
            }
            fields["access_token"] = access_token
            shown = getattr(adapter, "shown_credential_field", None)
            if shown is not None:
                value = fields.get(shown, "")
                second_last4 = value[-4:] if len(value) >= 8 else ""
            token = SecretStr(pack(fields))
        problem = adapter.check_credential(token)
        if problem:
            raise ConnectionSetupError(400, problem)
        if not self.config.server_url.startswith("https://"):
            raise ConnectionSetupError(
                400, "This server's public URL is not https, so the provider cannot call it",
            )
        # The provider vouches for the token before we say whether its
        # account is connected here, so a made-up token learns nothing.
        try:
            info = await adapter.account(token)
        except AdapterError as exc:
            self._log_setup_failure("connect", None, exc)
            if exc.permanent:
                reasons = getattr(adapter, "account_error_reasons", {})
                raise ConnectionSetupError(
                    400, reasons.get(exc.code, "The provider rejected this token"),
                ) from None
            raise ConnectionSetupError(502, _UNREACHABLE) from None
        if self.store.connection_for_account(channel, info.external_id) is not None:
            raise ConnectionSetupError(409, _ALREADY_CONNECTED)
        try:
            connection = self.store.create_connection(
                agent_id=agent_id, owner_id=owner_id, channel=channel, label=label,
                secret=token.get_secret_value(), fernet=self.config.fernet, now=now,
                external_id=info.external_id, account_name=info.account_name,
                secret_last4=last4, ack_text=getattr(adapter, "default_ack_text", None),
            )
        except DuplicateConnection:
            raise ConnectionSetupError(409, _ALREADY_CONNECTED) from None
        if second_last4 is not None:
            self.store.set_verify_token_last4(connection.id, second_last4)
        try:
            await self._register(connection, adapter, token)
        except AdapterError as exc:
            self._log_setup_failure("set_webhook", connection, exc)
            self.store.remove_connection(connection.id, now=self._now())
            raise ConnectionSetupError(502, _UNREACHABLE) from None
        self.store.set_status(connection.id, STATUS_WORKING, now=self._now())
        await self.refresh_quota(self.store.get_connection(connection.id))
        return self.store.get_connection(connection.id)

    def _connect_shared(
        self, adapter, *, agent_id: str, owner_id: str, label: str, owner_username: str,
        agent_short_name: str, now: float,
    ) -> ChannelConnection:
        """Email: no credential is asked for (the server's SendGrid key sends,
        its Inbound Parse secret receives) and nothing is set up with the
        provider. One connection per agent; the address, derived from the
        names, is unique across all accounts."""
        address = adapter.address_for(owner_username, agent_short_name, self.config.inbound_email_domain) \
            if hasattr(adapter, "address_for") else None
        if address is None:
            raise ConnectionSetupError(400, "This agent's name can't be used as an email address")
        if self.store.connection_for_agent(adapter.channel, agent_id) is not None:
            raise ConnectionSetupError(409, "This agent already has an email address")
        try:
            return self.store.create_connection(
                agent_id=agent_id, owner_id=owner_id, channel=adapter.channel, label=label,
                secret="", fernet=self.config.fernet, now=now,
                external_id=address, account_name=address,
            )
        except DuplicateConnection:
            raise ConnectionSetupError(409, "That email address is already in use") from None

    def _connect_generated(
        self, adapter, *, agent_id: str, owner_id: str, label: str, now: float,
    ) -> ChannelConnection:
        """The web chat widget: no provider and no credential to ask for. The
        server mints the connection's signing key, starts it in the adapter's
        default mode ("anyone": a visitor has no identity to allowlist) and
        gives it one default key whose only allowed site is this server, so the
        hosted chat page works at once. One connection per agent."""
        if self.store.connection_for_agent(adapter.channel, agent_id) is not None:
            raise ConnectionSetupError(409, "This agent already has a web chat widget")
        connection = self.store.create_connection(
            agent_id=agent_id, owner_id=owner_id, channel=adapter.channel, label=label,
            secret=webchat.new_signing_key(), fernet=self.config.fernet, now=now,
            secret_last4="",
        )
        self.store.set_mode(connection.id, getattr(adapter, "default_mode", access.MODE_ALLOWLIST))
        self.store.set_status(connection.id, STATUS_WORKING, now=now)
        self.create_grant(connection, label="Default", origins=[self.server_origin()])
        return self.store.get_connection(connection.id)

    # ── web chat widget grants (owner actions) ───────────────────────────

    def create_grant(
        self, connection: ChannelConnection, *, label: str, origins: list[str],
    ) -> webchat.WebchatGrant:
        key = webchat.new_grant_key()
        return self.store.create_grant(
            connection_id=connection.id, kind=webchat.GRANT_SITE, label=label, origins=origins,
            key=key, key_hash=webchat.key_hash(key), fernet=self.config.fernet, now=self._now(),
        )

    def grant_key(self, grant: webchat.WebchatGrant) -> str:
        try:
            return self.store.grant_key(grant.id, self.config.fernet).get_secret_value()
        except InvalidToken:
            raise ConnectionSetupError(
                503, "The stored key cannot be decrypted with this server's keys",
            ) from None

    def server_origin(self) -> str:
        return webchat.normalize_origin(self.config.server_url)

    def hosted_grant(self, connection: ChannelConnection) -> Optional[webchat.WebchatGrant]:
        """The key this server's own pages (the hosted chat, the account page)
        use: the oldest live key that lists this server among its sites. None
        when the owner has taken the server off every key — the agent is then
        not public."""
        origin = self.server_origin()
        for grant in self.store.list_grants(connection.id):
            if origin in grant.origins:
                return grant
        return None

    def webchat_signing_key(self, connection: ChannelConnection) -> str:
        return self._token(connection).get_secret_value()

    async def _register(self, connection: ChannelConnection, adapter, token: SecretStr) -> None:
        await adapter.register_webhook(
            connection, token, url=self.webhook_url(connection),
            webhook_key=self.config.secret_keys[0],
        )

    def _token(self, connection: ChannelConnection) -> SecretStr:
        try:
            return self.store.load_secret(connection.id, self.config.fernet)
        except InvalidToken:
            raise ConnectionSetupError(
                503, "The stored credential cannot be decrypted with this server's keys",
            ) from None

    async def check(self, connection: ChannelConnection) -> ChannelConnection:
        """The owner's Test: ask the provider, store the result with its time."""
        adapter = self.adapters.get(connection.channel)
        if adapter is None or not hasattr(adapter, "health") or connection.disabled:
            return connection
        try:
            report = await adapter.health(
                connection, self._token(connection), url=self.webhook_url(connection),
            )
        except AdapterError as exc:
            self._log_setup_failure("check", connection, exc)
            raise ConnectionSetupError(502, _UNREACHABLE) from None
        # A provider's own answer to a send (LINE's monthly limit, a 403 on
        # push) is not undone by a health check that never sends — nor lost
        # when an earlier Test stored another fault in its place.
        sticky = getattr(adapter, "statuses_cleared_by_send", ())
        refusal = self.send_refusal(connection)
        if report.code != STATUS_WORKING:
            self._store_report(connection, report)
        elif connection.status in sticky:
            pass
        elif refusal is not None:
            self._set_status(connection, adapter, refusal)
        else:
            self._store_report(connection, report)
        if report.code != STATUS_TOKEN_REJECTED:
            await self.refresh_quota(self.store.get_connection(connection.id))
        return self.store.get_connection(connection.id)

    # ── push quota (LINE) ────────────────────────────────────────────────

    async def refresh_quota(self, connection: Optional[ChannelConnection]) -> None:
        """Fetch a push-metered channel's quota and usage from the provider and
        store them with the time. Never raises: a failure keeps the last
        figures (the page shows "as of" their time); a rejected token sets the
        connection's status. ``quota_exhausted`` (LINE's own monthly-limit
        answer) outranks the fetched figures, which are approximate: a fetch
        clears it only once the quota month has turned since it was set —
        otherwise the next successful push does (``_send_one``)."""
        adapter = self.adapters.get(connection.channel) if connection else None
        if connection is None or not hasattr(adapter, "quota") or connection.disabled:
            return
        try:
            secret = self.store.load_secret(connection.id, self.config.fernet)
            quota_type, limit, usage = await adapter.quota(secret)
        except AdapterError as exc:
            if exc.connection_status is not None:
                self._set_status(connection, adapter, exc.connection_status)
            self._log_setup_failure("quota", connection, exc)
            return
        except Exception as exc:  # noqa: BLE001 — the page must not break on it
            self._log_setup_failure("quota", connection, exc)
            return
        now = self._now()
        self.store.set_quota(connection.id, quota_type=quota_type, limit=limit, usage=usage, now=now)
        month_start = adapter.quota_month_start(now)
        exhausted_at = self.store.extras(connection.id).quota_exhausted_at
        if exhausted_at is not None and exhausted_at < month_start:
            self.store.set_quota_exhausted(connection.id, None)
        if connection.status == STATUS_QUOTA_EXHAUSTED and (
            connection.status_at is None or connection.status_at < month_start
        ):
            self.store.set_status(connection.id, STATUS_WORKING, now=now)

    def quota_exhausted(self, connection: ChannelConnection) -> bool:
        """LINE answered a push with its monthly limit this quota month."""
        month_start = getattr(self.adapters.get(connection.channel), "quota_month_start", None)
        at = self.store.extras(connection.id).quota_exhausted_at
        return month_start is not None and at is not None and at >= month_start(self._now())

    def send_refusal(self, connection: ChannelConnection) -> Optional[str]:
        """The status of the provider's latest refusal of a push still in force
        — LINE's monthly limit this quota month, or its 403 on push since the
        last successful push — else None."""
        adapter = self.adapters.get(connection.channel)
        refused_status = getattr(adapter, "push_refused_status", None)
        extras = self.store.extras(connection.id)
        found = []
        if self.quota_exhausted(connection):
            found.append((extras.quota_exhausted_at, STATUS_QUOTA_EXHAUSTED))
        if refused_status is not None and extras.push_refused_at is not None:
            found.append((extras.push_refused_at, refused_status))
        return max(found)[1] if found else None

    async def refresh_quota_if_stale(self, connection: ChannelConnection) -> None:
        """The page-load refresh: only when the last attempt, successful or
        not, is older than ``quota_refresh_seconds`` — so an outage at LINE
        costs one wait per 15 minutes, not one per page load — and bounded by
        ``quota_page_timeout_seconds`` for both calls together."""
        if not hasattr(self.adapters.get(connection.channel), "quota") or connection.disabled:
            return
        extras = self.store.extras(connection.id)
        tried = [t for t in (extras.quota_fetched_at, extras.quota_attempted_at) if t is not None]
        now = self._now()
        if tried and now - max(tried) <= self.options.quota_refresh_seconds:
            return
        self.store.note_quota_attempt(connection.id, now)
        try:
            await asyncio.wait_for(
                self.refresh_quota(connection), timeout=self.options.quota_page_timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            self._log_setup_failure("quota", connection, exc)

    def push_usage(
        self, connection: ChannelConnection,
    ) -> Optional[tuple[int, Optional[int], Optional[float]]]:
        """``(used, limit, as_of)`` for a push-metered channel, else None.

        The provider's figure leads (it also counts what the owner broadcast
        from LINE's own console); pushes we sent since that fetch are added
        from the outbox. Once the quota month has turned since the fetch, only
        this month's pushes are counted. ``limit`` is None when the provider
        set none (or was never asked); ``as_of`` is None until the first fetch."""
        adapter = self.adapters.get(connection.channel)
        month_start = getattr(adapter, "quota_month_start", None)
        if month_start is None:
            return None
        now = self._now()
        extras = self.store.extras(connection.id)
        start = month_start(now)
        limit = extras.quota_limit if extras.quota_type == "limited" else None
        fetched = extras.quota_fetched_at
        if fetched is not None and fetched >= start:
            used = (extras.quota_usage or 0) + self.store.pushes_sent_between(
                connection.id, fetched, now,
            )
        else:
            used = self.store.pushes_sent_between(connection.id, start, now)
        return used, limit, fetched

    def _store_report(self, connection: ChannelConnection, report: HealthReport) -> None:
        self._set_status(
            connection, self.adapters.get(connection.channel), report.code,
            detail=report.detail, count=report.count,
        )

    async def disable(self, connection: ChannelConnection) -> ChannelConnection:
        """Stop the provider calling us (``deleteWebhook``). Replies already
        queued wait, unclaimed, until Enable (the 24 h expiry still applies);
        a late webhook call is answered 200 and dropped. A failed
        ``deleteWebhook`` is logged and the connection is disabled anyway."""
        self.store.set_disabled(connection.id, True)
        adapter = self._managed(connection)
        if adapter is not None:
            try:
                await adapter.unregister_webhook(connection, self._token(connection))
            except (AdapterError, ConnectionSetupError) as exc:
                self._log_setup_failure("delete_webhook", connection, exc)
        return self.store.get_connection(connection.id)

    async def enable(self, connection: ChannelConnection) -> ChannelConnection:
        """Register the webhook again (with ``drop_pending_updates``: whatever
        was sent to the bot while it was disabled is lost), then enable."""
        adapter = self._managed(connection)
        if adapter is not None:
            try:
                await self._register(connection, adapter, self._token(connection))
            except AdapterError as exc:
                self._log_setup_failure("set_webhook", connection, exc)
                raise ConnectionSetupError(502, _UNREACHABLE) from None
            self.store.set_key_rotation_pending(connection.id, False)
            self._mark_working_unless_sticky(connection, adapter)
        self.store.set_disabled(connection.id, False)
        return self.store.get_connection(connection.id)

    async def reconnect(self, connection: ChannelConnection) -> ChannelConnection:
        """Register the webhook again under the current key — what finishes a
        key rotation, or repairs a webhook someone else changed."""
        if connection.disabled:
            return await self.enable(connection)
        adapter = self._managed(connection)
        if adapter is None:
            return connection
        try:
            await self._register(connection, adapter, self._token(connection))
        except AdapterError as exc:
            self._log_setup_failure("set_webhook", connection, exc)
            if exc.connection_status is not None:
                self.store.set_status(connection.id, exc.connection_status, now=self._now())
            raise ConnectionSetupError(502, _UNREACHABLE) from None
        self.store.set_key_rotation_pending(connection.id, False)
        self._mark_working_unless_sticky(connection, adapter)
        return self.store.get_connection(connection.id)

    def _mark_working_unless_sticky(self, connection: ChannelConnection, adapter) -> None:
        """A webhook registered again proves the webhook, not a provider's
        answer to a send: a status only a successful send clears
        (``statuses_cleared_by_send``) is kept."""
        if connection.status in getattr(adapter, "statuses_cleared_by_send", ()):
            return
        self.store.set_status(connection.id, STATUS_WORKING, now=self._now())

    async def remove(self, connection: ChannelConnection) -> None:
        """``deleteWebhook`` (its failure — a token revoked in BotFather, the
        network down — is logged and does not block removal), then remove the
        connection and everything keyed on it in one commit
        (``store.remove_connection``). Threads stay as history."""
        adapter = self._managed(connection)
        if adapter is not None:
            try:
                await adapter.unregister_webhook(connection, self._token(connection))
            except (AdapterError, ConnectionSetupError) as exc:
                self._log_setup_failure("delete_webhook", connection, exc)
        self.store.remove_connection(connection.id, now=self._now())

    def _log_setup_failure(
        self, step: str, connection: Optional[ChannelConnection], exc: Exception,
    ) -> None:
        code = getattr(exc, "code", None) or type(exc).__name__
        logger.warning(
            "Channel connection %s: %s failed: channel_setup_failed reason=%s",
            connection.id[:8] if connection else "-", step, code,
        )


async def _nothing_to_fetch(_from: int, _to: int) -> list[ChangelogEntry]:
    return []


def _message_ids_since(runloop, version: int) -> set[str]:
    return {
        e.payload.id
        for e in runloop.get_entries_since(version)
        if e.entry_type == ChangelogEntryType.MESSAGE and isinstance(e.payload, MessagePayload)
    }


@dataclass(frozen=True)
class HeldFiles:
    """One held hub message whose staged files go with its Request's
    combined message (what ``hub_files_for`` reads, like a buffer row)."""

    connection_id: str
    event_id: str
    message_id: str             # the combined message's id
    contact_id: str
    display_name: str


def combined_message_text(request: ChannelRequest, held: list[HeldMessage]) -> str:
    """What a sender wrote while waiting, as ONE message to the agent.

    Each original message gets a header line with its time, and its text is
    quoted line by line with ``> ``. Every line of contact text therefore starts
    with ``> ``, so nothing the contact wrote can pass for a header or for the
    framing around it.
    """
    count = len(held)
    lines = [
        f"{request.display_name} sent {count} message{'s' if count != 1 else ''} "
        "while waiting for approval:",
    ]
    for i, message in enumerate(held, start=1):
        lines.append("")
        lines.append(f"Message {i} of {count}, {_utc(message.received_at):%Y-%m-%d %H:%M} UTC:")
        # splitlines, not split("\n"): a lone \r, \r\n, U+2028 or U+2029 is a
        # line break to markdown and to the agent, so each must start a quoted line.
        lines.extend(f"> {line}" for line in message.text.splitlines() or [""])
        if message.truncated:
            lines.append("(cut: the rest of this message was not kept)")
    if request.dropped_count:
        lines.append("")
        lines.append(
            f"({request.dropped_count} later message{'s were' if request.dropped_count != 1 else ' was'}"
            " not kept.)"
        )
    return "\n".join(lines)


_ALREADY_CONNECTED = (
    "This bot is already connected to an agent. Remove that connection first."
)
_UNREACHABLE = "The provider could not be reached. Try again in a minute."


def _at_domain(address: str, domain: str, *, exact: bool = False) -> bool:
    """Whether ``address`` is at ``domain`` (or, unless ``exact``, a subdomain of it)."""
    at = split_address(address)[1]
    target = normalize_domain(domain) or domain
    return at == target or (not exact and at.endswith("." + target))


def _utc(epoch: float):
    from datetime import UTC, datetime

    return datetime.fromtimestamp(epoch, UTC)


def default_adapters() -> dict[str, ChannelAdapter]:
    """The channels that ship. Registered whenever the gateway is on; tests
    pass their own map instead (it replaces this one, it is not merged)."""
    from .email_adapter import EmailAdapter
    from .line import LineAdapter
    from .telegram import TelegramAdapter
    from .whatsapp import WhatsAppAdapter

    return {
        "telegram": TelegramAdapter(), "email": EmailAdapter(), "line": LineAdapter(),
        "whatsapp": WhatsAppAdapter(), webchat.CHANNEL: webchat.WebChatAdapter(),
    }


def build_channel_gateway(
    ctx: "ServerContext",
    store: ChannelStore,
    *,
    env: Optional[Mapping[str, str]] = None,
    adapters: Optional[Mapping[str, ChannelAdapter]] = None,
    options: Optional[GatewayOptions] = None,
) -> Optional[ChannelGateway]:
    """The kill switch, widened for the hub. Which gateway boots:

    1. the channel configuration is valid -> the full gateway, as before,
       carrying the hub settings;
    2. else the hub mode is not ``off`` -> a hub-only gateway: no provider
       adapter (a hub adapter passed in is kept), every provider, connection
       and webchat route 404 (``providers_enabled`` false), and only hub
       connections' outbox and flushes run;
    3. else ``channels.db`` already exists, holds open hub rows, and the
       secret key parses -> the same hub-only gateway with the hub off: its
       worker only parks, expires and closes those rows (``sweep_hub_rows``),
       with no network, so a rolled-back hub still ends its rows;
    4. else None: every channel route 404s, nothing is sent.

    A hub-only or sweep-only gateway still runs the retention prune
    (``ChannelStore.prune``) for every channel, not only the hub's.

    Raises :class:`HubConfigError` — deliberately, and nothing else — when the
    hub mode is not ``off`` and the hub settings are invalid: the server must
    refuse to start (``hub_config_for_boot``). Otherwise never raises: a
    broken channel gateway must not stop the server from booting."""
    hub = hub_config_for_boot(env, data_dir=store.directory.parent)
    if hub.lazy and hub.fernet is None:
        # auto with no usable key (the key file could not be made): the hub
        # stays off rather than booting a gateway that could store nothing.
        hub = replace(hub, mode="off")
    config = load_channel_config(env)
    if config is not None:
        config = replace(config, hub=hub)
    elif hub.enabled:
        config = ChannelConfig.hub_only(hub, hub_only_server_url(env))
        logger.info("Channel gateway ON for the hub only (no provider channels)")
    else:
        config = _sweep_only_config(store, hub, env)
        if config is None:
            return None
    try:
        store.check_schema()
    except SchemaMismatch as exc:
        logger.error(
            "Channel gateway OFF: channels.db has schema version %d, this server "
            "needs %d. Move the file aside (it was written by an earlier build of the "
            "channel gateway, which never ran in production) and restart.",
            exc.found, SCHEMA_VERSION,
        )
        return None
    try:
        if not config.providers_enabled:
            adapters = {k: v for k, v in (adapters or {}).items() if k == HUB_CHANNEL}
        elif adapters is None:
            adapters = default_adapters()
        return ChannelGateway(ctx, store, config, adapters, options)
    except Exception as exc:  # noqa: BLE001 — the never-crash rule
        logger.error("Channel gateway OFF: unexpected %s while starting", type(exc).__name__)
        return None


def _sweep_only_config(
    store: ChannelStore, hub: HubConfig, env: Optional[Mapping[str, str]],
) -> Optional[ChannelConfig]:
    """The hub-only config with the hub off, when ``channels.db`` already
    holds open hub rows (never creating the file) and the key parses."""
    try:
        if not store.exists():
            return None
        open_rows = len(HubStore(store).hub_rows_open())
    except Exception as exc:  # noqa: BLE001 — SchemaMismatch included: the check below logs it
        logger.info("Channel gateway off (hub rows not readable: %s)", type(exc).__name__)
        return None
    if not open_rows:
        return None
    if hub.fernet is None:
        logger.warning(
            "Channel gateway OFF: %d open hub row(s), but CLAWMEETS_CHANNEL_SECRET_KEY is "
            "missing or invalid, so they are not swept until it is set", open_rows,
        )
        return None
    logger.info(
        "Channel gateway ON with the hub off, to sweep %d open hub row(s) (no network)", open_rows,
    )
    return ChannelConfig.hub_only(hub, hub_only_server_url(env))


def provider_gateway(ctx: "ServerContext") -> Optional[ChannelGateway]:
    """The gateway, when it serves provider channels: what every webhook,
    connection, webchat and public-profile route uses. None with channels off
    and on a hub-only gateway, so those routes 404 exactly as before."""
    gateway = ctx.channel_gateway
    return gateway if gateway is not None and gateway.config.providers_enabled else None


def _signed_by(envelope: str) -> Optional[str]:
    """The ``from_fingerprint`` of a stored envelope, or None if unreadable."""
    try:
        fp = json.loads(envelope).get("from_fingerprint")
    except (ValueError, AttributeError):
        return None
    return fp if isinstance(fp, str) else None
