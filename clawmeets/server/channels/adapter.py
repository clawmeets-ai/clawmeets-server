# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/adapter.py
What a channel (Telegram, email, LINE, WhatsApp, the web chat widget) must
provide to the gateway.

The gateway owns everything that is the same for every channel — dedupe, the
burst buffer, the conversation → thread mapping, pause, the outbox and its
retry/expiry rules. An adapter owns only the provider's wire format: proving a
webhook call is genuine, turning its body into events, and sending one text.

Adapters must never put the credential into an exception message they raise
themselves; the gateway also never logs ``str(exc)`` of anything an adapter
raises (a provider client can quote the request URL, and Telegram's URL
contains the bot token) — only the exception type and a reason code.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Protocol, Sequence, Union

from pydantic import SecretStr

from .store import AcceptGate, ChannelConnection, Outcome, OutboxRow, RequestGate


@dataclass(frozen=True)
class InboundEvent:
    """One message from an outside contact, as the provider described it."""

    event_id: str           # provider's id for this delivery; unique per connection
    conversation_key: str   # provider's id for the conversation (chat id, thread, number)
    #: The sender's STABLE provider id (Telegram's numeric ``from.id``, the
    #: WhatsApp ``wa_id``, the email address). Contacts, Requests, blocks and
    #: username pins are keyed on it; it stays inside the store.
    user_key: str
    display_name: str       # raw — the gateway cleans it; never used for matching
    text: str
    #: A mutable handle the sender chose (Telegram @username), if any. Only an
    #: unpinned ``@username`` allowlist entry ever looks at it.
    handle: Optional[str] = None
    #: Whether the sender is who they say: ``access.AUTH_PASS`` /
    #: ``AUTH_FAIL`` / ``AUTH_PROVIDER``. Missing counts as failed. The hook
    #: the email adapter's SPF/DKIM gate reports through.
    auth_verdict: Optional[str] = None
    #: A short-lived, single-use token for answering this event (LINE's
    #: ``replyToken``). Used once for the acknowledgement and never stored: it
    #: is a capability to message the sender and is useless a minute later.
    reply_token: Optional[str] = None
    #: When the contact sent it, by the provider's clock (epoch s), if the
    #: provider says. Starts a customer-service window (WhatsApp), and a
    #: message older than the dedupe retention allows is never accepted.
    sent_at: Optional[float] = None


@dataclass(frozen=True)
class VerifiedHubEvent:
    """An envelope from another deployment, as the hub client hands it to the
    gateway (``ChannelGateway.handle_hub_events``). Built ONLY after the
    envelope's signature and its binding to the sender's pinned key checked
    out, so nothing unverified reaches the store.

    ``event.conversation_key`` is the envelope's ``<genesis fp>/<requester
    project id>``; ``root_fp`` is the sender deployment's GENESIS fingerprint,
    what deployment blocks and conversations are keyed on."""

    event: InboundEvent
    root_fp: str
    #: A refusal decided before the store (``(outcome, detail)``): the agent's
    #: Hub channel is off, the server is browse-only, the daily run cap is
    #: reached. Stored with the dedupe key, like the gateway's own refusals.
    refuse: Optional[tuple["Outcome", Optional[str]]] = None
    #: The pending-Requests fill rule (``store.RequestGate``).
    request_gate: Optional["RequestGate"] = None
    #: Claimed in the accept transaction before the agent gets the message
    #: (``store.AcceptGate``): the channel is still on, and a run of today's cap.
    accept_gate: Optional["AcceptGate"] = None


class AdapterError(Exception):
    """A provider call failed. ``code`` is a short fixed reason, safe to store
    and log — never the provider's own error text, which can echo user input.

    ``detail``, when an adapter sets it, is the provider's own explanation,
    already bounded and redacted by that adapter (email: SendGrid's error
    messages, addresses and keys removed, at most 300 characters). The gateway
    stores it for the owner beside ``code`` — on the outbox row and, with
    ``connection_status``, on the connection — and never logs it.

    ``permanent`` errors (blocked by the user, invalid recipient, revoked
    credential) end the row in ``failed``; anything else is retried, no sooner
    than ``retry_after`` seconds when the provider said so (Telegram's 429).
    ``connection_status``, when set, is stored as the connection's health
    (a revoked bot token: ``token_rejected``).

    ``window_closed``: the provider refused because the contact's
    customer-service window has closed (WhatsApp's 131047). Neither a failure
    nor retried: the row ends ``held_window`` with the later parts of its
    reply, and the conversation counts as closed until the contact writes.
    """

    def __init__(
        self, code: str, *, permanent: bool = False, retry_after: Optional[float] = None,
        connection_status: Optional[str] = None, window_closed: bool = False,
        detail: Optional[str] = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail
        self.permanent = permanent
        self.retry_after = retry_after
        self.connection_status = connection_status
        self.window_closed = window_closed


@dataclass(frozen=True)
class AccountInfo:
    """What a provider says about the account a credential belongs to."""

    external_id: str        # stable id (Telegram's bot id); one connection per id
    account_name: str = ""  # shown to the owner (the bot's @username)


@dataclass(frozen=True)
class HealthReport:
    """A connection health check's result: a fixed ``code`` plus, for some
    codes, the provider's text (rendered as text, never markup) and a number —
    the pending update count for ``pending_updates``, the epoch time of the
    provider's last delivery error for ``webhook_error``."""

    code: str
    detail: Optional[str] = None
    count: Optional[int] = None


class ChannelAdapter(Protocol):
    channel: str
    #: The allowlist entry kinds this channel takes (``access.USER_ID`` ...).
    allowlist_kinds: tuple[str, ...]
    #: True when the provider itself authenticates the sender (Telegram, LINE,
    #: WhatsApp), so ``AUTH_PROVIDER`` counts as verified. False for email,
    #: where only an explicit ``AUTH_PASS`` does.
    provider_authenticates_sender: bool

    def verify(
        self, connection: ChannelConnection, secret: SecretStr,
        headers: Mapping[str, str], body: bytes, *, webhook_keys: Sequence[str],
    ) -> Optional[int]:
        """Whether the call really comes from the provider for this connection.

        ``None``: it does not (401). Otherwise the index, in ``webhook_keys``
        (the server's secret keys, current first), of the key the call was
        verified under: ``0`` for the current key or for a channel that derives
        nothing from the keys; above ``0`` means the provider still holds a
        secret derived under an older key, and the webhook must be registered
        again (the gateway shows "reconnect to finish key rotation").
        """

    def parse(self, body: bytes) -> list[InboundEvent]:
        """The contact messages in a verified body (empty for anything else)."""

    def format_parts(self, text: str) -> list[str]:
        """The agent's (markdown) text as the channel's message parts, each
        within the provider's length limit. Empty text → no parts. Each part
        becomes its own outbox row, so ordering and retry are per part."""

    async def send(
        self, connection: ChannelConnection, secret: SecretStr, *,
        conversation_key: str, text: str, retry_key: str,
    ) -> None:
        """Send ``text`` exactly as given, under the channel's own identity.

        ``retry_key`` is identical on every attempt for the same outbound unit;
        providers that accept one (LINE's ``X-Line-Retry-Key``) use it to drop
        the duplicate. Raise :class:`AdapterError` on failure.
        """


class AcknowledgingAdapter(ChannelAdapter, Protocol):
    """A channel that answers an incoming message at once, on the event's own
    reply token (LINE). Optional; the gateway looks for these members.

    ``acknowledge`` is called only for an event whose outcome is ``BUFFERED``,
    after that decision has committed, off the webhook's critical path, once
    per burst, never while the thread is paused, and never retried.
    ``parse_for_connection`` replaces ``parse`` when present, for a body that
    must be checked against the connection (LINE's ``destination``)."""

    async def acknowledge(
        self, connection: ChannelConnection, secret: SecretStr, *,
        reply_token: str, text: str,
    ) -> None: ...

    def parse_for_connection(
        self, connection: ChannelConnection, body: bytes,
    ) -> list[InboundEvent]: ...


class SubscribingAdapter(ChannelAdapter, Protocol):
    """A channel whose provider checks the callback URL with a GET before it
    sends anything there (Meta's ``hub.challenge``). Optional; the GET route
    answers 404 for a channel without it.

    ``customer_service_window_seconds``, when an adapter has it, makes the
    gateway hold (``held_window``) any row whose conversation's last contact
    message (``InboundEvent.sent_at``) is that old or older — checked on every
    claim, not only when the row is queued."""

    customer_service_window_seconds: float

    def answer_subscription(
        self, connection: ChannelConnection, secret: SecretStr,
        query: Mapping[str, Sequence[str]],
    ) -> Optional[str]:
        """The challenge to echo (200, ``text/plain``), or None (403) when the
        request is not the provider confirming THIS connection. ``query`` maps
        each parameter name to every value it was given. Raises ``ValueError``
        for a challenge that is not the provider's shape (400)."""


class ManagedChannelAdapter(ChannelAdapter, Protocol):
    """A channel whose connection the server sets up with the provider (a
    Telegram bot's webhook), rather than one the owner configures elsewhere.

    These run only from an owner's action (connect, test, disable, enable,
    reconnect, remove) — never at boot. Each raises :class:`AdapterError`.
    """

    def check_credential(self, secret: SecretStr) -> Optional[str]:
        """A reason the credential is malformed, before any provider call."""

    async def account(self, secret: SecretStr) -> AccountInfo:
        """Validate the credential with the provider (before anything is stored)."""

    async def register_webhook(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str, webhook_key: str,
    ) -> None:
        """Point the provider at ``url``, with the secret derived under ``webhook_key``."""

    async def unregister_webhook(self, connection: ChannelConnection, secret: SecretStr) -> None:
        """Stop the provider calling us."""

    async def health(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str,
    ) -> HealthReport:
        """The provider's view of the connection."""


@dataclass(frozen=True)
class Forwarded:
    """The hub took the relay (``relay_ack`` accepted): wait for the receipt."""


@dataclass(frozen=True)
class Parked:
    """Not relayed now, and not an attempt: the target is not connected, the
    hub is unreachable, or it asked us to slow down until ``until``."""

    reason: str
    until: Optional[float] = None


@dataclass(frozen=True)
class Refused:
    """The hub refused the relay for good (``relay_rejected``)."""

    reason: str
    detail: Optional[str] = None
    retry_at: Optional[float] = None


RelayOutcome = Union[Forwarded, Parked, Refused]


class RelayingAdapter(Protocol):
    """The hub channel's send side, implemented by the hub client. Rows of a
    ``hub`` connection are relayed through it instead of ``send``; until one
    is registered (the hub mode is off) they park.

    ``relay`` writes the row's stored envelope, byte for byte, and calls
    ``on_written`` the moment the frame is written to the hub's socket,
    BEFORE waiting for any ``relay_ack``: a lost ack still leaves the row
    counted as forwarded (the hub client returns :class:`Forwarded` once the
    frame left, whatever follows; it parks the row when nothing could be
    written). An adapter may raise :class:`AdapterError` instead, and the row
    is retried like any send. ``probe`` sends a delivery probe for a held
    row; True if the frame was written."""

    channel: str

    async def relay(
        self, connection: ChannelConnection, row: OutboxRow, *, on_written: Callable[[], None],
    ) -> RelayOutcome: ...

    async def probe(self, connection: ChannelConnection, row: OutboxRow) -> bool: ...
