# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/whatsapp.py
The WhatsApp adapter: a Cloud API phone number's webhook in, the agent's answer
as a text message from that number, within WhatsApp's 24-hour window.

WhatsApp facts this module relies on (Cloud API reference — Webhooks, Messages,
Error codes — and Graph API ``GRAPH_API_VERSION``; to be re-read against
Meta's current pages in the provider rehearsal):

- ``X-Hub-Signature-256: sha256=<hex HMAC-SHA256(app secret, raw body)>``,
  lower-case hex. The older ``X-Hub-Signature`` (SHA-1) is never accepted.
- The subscription check is ``GET <callback>?hub.mode=subscribe&
  hub.verify_token=<token>&hub.challenge=<int>``, answered 200 with the
  challenge as the raw body.
- A body is ``{"object": "whatsapp_business_account", "entry": [{"id",
  "changes": [{"field", "value"}]}]}``; ``value`` holds ``metadata``
  (``display_phone_number``, ``phone_number_id``), ``contacts[]`` (``wa_id``,
  ``profile.name``), ``messages[]``, ``statuses[]`` and ``errors[]``. One body
  can carry several entries, changes and messages.
- Meta retries an unanswered webhook for up to 7 days; duplicates are possible
  even after a 200.
- A text message holds at most 4096 characters. A free-form message is only
  accepted within 24 hours of the customer's last message (the customer-service
  window); outside it Meta answers error ``131047``.
- Errors are ``{"error": {"message", "type", "code", "error_subcode",
  "error_data", "fbtrace_id"}}``, mostly with HTTP 400: the ``code`` decides,
  not the status.

**Credentials.** One encrypted JSON blob (``pack_credential``) holds the
access token (every Graph call sends it as ``Authorization: Bearer``, never in
a URL), the app secret (only ``verify`` reads it), the verify token (only the
GET check reads it) and the phone number id (also the connection's
``external_id``: one connection per number across all owners). The token's
and the verify token's last four are shown; the app secret never is, not even
partly. Nothing is derived from the server's keys, so ``verify`` returns ``0``
or ``None`` and a key rotation never asks for a reconnect. Use a System User
access token: the App Dashboard's temporary token expires in 24 hours.

**Webhook registration.** None: the callback URL is set on the owner's own
Meta app (App Dashboard → WhatsApp → Configuration), which we don't control.
The card shows the URL; the owner pastes it with their verify token and
subscribes the ``messages`` field. ``register_webhook`` / ``unregister_webhook``
make no call, so Disable and Remove leave the callback configured at Meta and
later calls get 200-and-dropped (disabled; the GET check gets 403) or 404
(removed).

**Inbound mapping** (``parse_for_connection``):

    event_id          messages[].id (the ``wamid``) — never from:timestamp
    conversation_key  messages[].from (1:1 chats only)
    user_key          messages[].from (the wa_id)
    display_name      contacts[].profile.name of the contact whose wa_id is
                      ``from``; "WhatsApp user ···<last 4>" without one
    text              text.body, or a placeholder line (below)
    sent_at           messages[].timestamp — opens the 24-hour window
    auth_verdict      AUTH_PROVIDER — Meta authenticates the sender

Read per change, in array order; one unreadable message never drops the
others. Dropped (no event, 200):

- a change whose ``metadata.phone_number_id`` isn't this connection's number:
  one app secret signs for every number on the app, so another number's
  message can arrive here correctly signed;
- every field but ``messages`` (``message_template_status_update``,
  ``account_update``, ``smb_message_echoes``, ``history`` …), and the
  ``statuses[]`` of a ``messages`` change — a ``failed`` status logs its error
  code only;
- a message without ``id`` (never deduped by a made-up id), without a phone
  number in ``from`` (a username-only sender can't be allowlisted), from our
  own number, or carrying a ``group_id`` (groups are not served; group content
  is never answered privately, even from an allowlisted number);
- ``reaction``, ``system`` (one log line; the contact is not migrated),
  ``request_welcome`` and unknown types; whitespace-only text.

Non-text messages become one placeholder line; media is never downloaded:

    image / video   "[image]" / "[video]", then the caption if any
    document        "[document: <filename>]", then the caption if any
    audio           "[voice message]" (voice: true) or "[audio]"
    sticker         "[sticker]"
    location        "[location: <name>, <address>]" — never the coordinates
    contacts        "[contact card: <formatted_name>]" — never the numbers
    interactive     the button_reply / list_reply title
    button          its text
    order           "[order]"
    unsupported     "[unsupported message]"

``context`` (a reply or forward) and ``referral`` (a click-to-WhatsApp ad) are
not passed on.

**Sending** (``send``): one ``POST /<version>/<phone_number_id>/messages`` per
outbox row, ``{"messaging_product": "whatsapp", "recipient_type":
"individual", "to": <wa_id>, "type": "text", "text": {"preview_url": false,
"body": <part>}}``. Success needs ``messages[0].id`` in a 2xx answer;
without it the row is retried. WhatsApp takes no retry key, so a restart
between Meta accepting a message and our recording it sends it again (the
accepted at-least-once cost). By ``error.code``:

    131047 re-engagement (outside the window)   held (window_closed)
    131026 undeliverable                        permanent undeliverable
    130429, 131056, 4, 80007 rate limits        retried (131056: no sooner
                                                than PAIR_RATE_LIMIT_SECONDS)
    190 token invalid or expired                permanent + token_rejected
    10, 200-299 permission                      permanent + permission_denied
    100 invalid parameter, 33 no such object    permanent rejected_by_provider
    131030 recipient not in the allowed list    permanent recipient_not_allowed
    133010 number not registered                permanent + number_not_registered
    131042 payment problem                      permanent + payment_issue
    368, 131031, 131048 restriction or spam     permanent + account_restricted
    131000, 131016, 1, 2, any 5xx, 429,
    timeout, network error                      retried
    any other 4xx, or one with no readable code permanent rejected_by_provider

Meta's ``message``, ``error_data`` and ``fbtrace_id`` are never stored or
logged: they can echo the token or the recipient.

**Connection management.** ``account`` and ``health`` are ``GET
/<version>/<phone_number_id>?fields=display_phone_number,verified_name,
quality_rating``. ``health`` never sends a message: it adds what only we can
see — calls refused by the signature check (``signature_mismatch``: the app
secret doesn't match), and whether Meta has checked or called the URL at all
(``no_webhook_yet``).

**Logs** carry the connection id prefix and fixed codes only — never a token,
a signature, a challenge, a number, a name or message text. No ``httpx``
exception escapes: each becomes an :class:`AdapterError` raised ``from None``.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import unicodedata
from typing import Any, Mapping, Optional, Sequence

import httpx
from pydantic import SecretStr

from . import access
from .adapter import AccountInfo, AdapterError, HealthReport, InboundEvent
from .log_redaction import install_secret_scrubbing
from .store import ChannelConnection
from .whatsapp_format import format_parts

logger = logging.getLogger(__name__)
install_secret_scrubbing(__name__)

GRAPH_BASE = "https://graph.facebook.com"
#: The Graph API version every call is pinned to.
GRAPH_API_VERSION = "v24.0"
SIGNATURE_HEADER = "x-hub-signature-256"
WINDOW_SECONDS = 24 * 3600
#: The window is treated as closed this long before Meta closes it, so a send
#: in flight doesn't race Meta's clock (131047 is the backstop).
WINDOW_MARGIN_SECONDS = 120.0
#: Agent replies (rows) to one contact per hour; a loop guard against another
#: bot on the other end. A conversation stays well under it.
MAX_AGENT_REPLIES_PER_HOUR = 60
#: 131056 (too many messages to one number): the soonest retry.
PAIR_RATE_LIMIT_SECONDS = 60.0
MAX_PLACEHOLDER_FIELD = 100

_SIGNATURE_RE = re.compile(rb"^sha256=[0-9a-f]{64}\Z")
_CHALLENGE_RE = re.compile(r"^[0-9A-Za-z_-]{1,64}\Z")
PHONE_NUMBER_ID_RE = re.compile(r"^[0-9]{5,20}\Z")
APP_SECRET_RE = re.compile(r"^[0-9a-f]{32}\Z")
ACCESS_TOKEN_RE = re.compile(r"^[A-Za-z0-9_|.-]{40,}\Z")
_VERIFY_TOKEN_RE = re.compile(r"^[\x21-\x7e]{16,256}\Z")
_DIGITS_RE = re.compile(r"^[0-9]{6,15}\Z")

# Fixed codes (stored on rows, logged; never Meta's own text).
CODE_WINDOW_CLOSED = "window_closed"
CODE_UNDELIVERABLE = "undeliverable"
CODE_RATE_LIMITED = "rate_limited"
CODE_TOKEN_REJECTED = "token_rejected"
CODE_PERMISSION_DENIED = "permission_denied"
CODE_REJECTED = "rejected_by_provider"
CODE_RECIPIENT_NOT_ALLOWED = "recipient_not_allowed"
CODE_NUMBER_NOT_REGISTERED = "number_not_registered"
CODE_PAYMENT_ISSUE = "payment_issue"
CODE_ACCOUNT_RESTRICTED = "account_restricted"
CODE_PROVIDER_UNAVAILABLE = "provider_unavailable"
CODE_PROVIDER_5XX = "provider_5xx"
CODE_NO_MESSAGE_ID = "no_message_id"
CODE_TIMEOUT = "timeout"
CODE_NETWORK = "network_error"
CODE_BAD_CREDENTIAL = "bad_credential"
CODE_NUMBER_UNREACHABLE = "number_unreachable"

# Connection statuses this adapter reports (shown as fixed sentences).
STATUS_TOKEN_REJECTED = "token_rejected"
STATUS_PERMISSION_DENIED = "permission_denied"
STATUS_NUMBER_NOT_REGISTERED = "number_not_registered"
STATUS_PAYMENT_ISSUE = "payment_issue"
STATUS_ACCOUNT_RESTRICTED = "account_restricted"
STATUS_SIGNATURE_MISMATCH = "signature_mismatch"
STATUS_NO_WEBHOOK_YET = "no_webhook_yet"
STATUS_NUMBER_UNREACHABLE = "number_unreachable"

_RATE_LIMIT_CODES = frozenset({130429, 131056, 4, 80007})
_TRANSIENT_CODES = frozenset({131000, 131016, 1, 2})
_RESTRICTED_CODES = frozenset({368, 131031, 131048})
_DROPPED_CATEGORIES = {"Cc", "Cf", "Zl", "Zp"}
_SILENT_TYPES = frozenset({"reaction", "request_welcome"})


def pack_credential(
    access_token: str, app_secret: str, verify_token: str, phone_number_id: str,
) -> str:
    """The one stored credential, as JSON."""
    return json.dumps({
        "access_token": access_token, "app_secret": app_secret,
        "verify_token": verify_token, "phone_number_id": phone_number_id,
    })


def unpack_credential(secret: SecretStr) -> dict[str, str]:
    """The blob's four values. Raises ``AdapterError`` (never with a value)
    when the stored blob is not a WhatsApp credential."""
    try:
        data = json.loads(secret.get_secret_value())
        fields = {k: data[k] for k in ("access_token", "app_secret", "verify_token",
                                       "phone_number_id")}
    except (ValueError, KeyError, TypeError):
        raise AdapterError(CODE_BAD_CREDENTIAL, permanent=True) from None
    if not all(isinstance(v, str) for v in fields.values()):
        raise AdapterError(CODE_BAD_CREDENTIAL, permanent=True)
    return fields


def signature(app_secret: str, body: bytes) -> str:
    """The ``X-Hub-Signature-256`` value Meta sends for ``body``."""
    return "sha256=" + hmac.new(app_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    value = headers.get(name)
    if value is not None:
        return value
    for key, item in headers.items():  # a plain dict with other casing
        if key.lower() == name:
            return item
    return None


def _clean(value: Any, limit: int = MAX_PLACEHOLDER_FIELD) -> str:
    """A provider-supplied label for a placeholder line: control and format
    characters removed, whitespace collapsed, capped in code points."""
    if not isinstance(value, str):
        return ""
    text = unicodedata.normalize("NFC", value)
    spaced = "".join(" " if ch.isspace() else ch for ch in text)
    kept = "".join(ch for ch in spaced if unicodedata.category(ch) not in _DROPPED_CATEGORIES)
    return " ".join(kept.split())[:limit].strip()


def _digits(value: Any) -> str:
    return re.sub(r"[^0-9]", "", value) if isinstance(value, str) else ""


def _with_caption(label: str, media: Any) -> str:
    caption = media.get("caption") if isinstance(media, dict) else None
    if isinstance(caption, str) and caption.strip():
        return f"{label}\n{caption}"
    return label


def _message_text(message: dict) -> tuple[Optional[str], Optional[str]]:
    """``(text, None)`` for a message the agent gets, or ``(None, why)`` — a
    fixed word to log, or None for the types ignored silently."""
    kind = message.get("type")
    if kind == "text":
        text = message.get("text")
        body = text.get("body") if isinstance(text, dict) else None
        return (body, None) if isinstance(body, str) and body.strip() else (None, None)
    if kind in ("image", "video"):
        return _with_caption(f"[{kind}]", message.get(kind)), None
    if kind == "document":
        doc = message.get(kind)
        name = _clean(doc.get("filename")) if isinstance(doc, dict) else ""
        return _with_caption(f"[document: {name}]" if name else "[document]", doc), None
    if kind == "audio":
        audio = message.get(kind)
        voice = isinstance(audio, dict) and audio.get("voice") is True
        return ("[voice message]" if voice else "[audio]"), None
    if kind == "sticker":
        return "[sticker]", None
    if kind == "location":
        loc = message.get(kind)
        fields = [f for f in (_clean(loc.get("name")), _clean(loc.get("address")))
                  if f] if isinstance(loc, dict) else []
        return (f"[location: {', '.join(fields)}]" if fields else "[location]"), None
    if kind == "contacts":
        cards = message.get(kind)
        names = []
        for card in cards if isinstance(cards, list) else []:
            name = card.get("name") if isinstance(card, dict) else None
            formatted = _clean(name.get("formatted_name")) if isinstance(name, dict) else ""
            if formatted:
                names.append(f"[contact card: {formatted}]")
        return ("\n".join(names) if names else "[contact card]"), None
    if kind == "interactive":
        interactive = message.get(kind)
        if isinstance(interactive, dict):
            for key in ("button_reply", "list_reply"):
                reply = interactive.get(key)
                title = reply.get("title") if isinstance(reply, dict) else None
                if isinstance(title, str) and title.strip():
                    return title, None
        return None, "interactive_without_title"
    if kind == "button":
        button = message.get(kind)
        text = button.get("text") if isinstance(button, dict) else None
        return (text, None) if isinstance(text, str) and text.strip() else (None, None)
    if kind == "order":
        return "[order]", None
    if kind in ("unsupported", "unknown"):
        return "[unsupported message]", None
    if kind == "system":
        return None, "system_message"
    if kind in _SILENT_TYPES:
        return None, None
    return None, "unknown_type"


def _timestamp(value: Any) -> Optional[float]:
    if isinstance(value, str) and value.isdigit():
        return float(value)
    if isinstance(value, int) and not isinstance(value, bool):
        return float(value)
    return None


class WhatsAppAdapter:
    channel = "whatsapp"
    allowlist_kinds = (access.PHONE,)
    provider_authenticates_sender = True
    #: A typed number must start with ``+`` or ``00`` (see access.parse_entry).
    phone_prefix_required = True
    #: Webhook calls that fail ``verify`` are counted and shown on the card.
    track_unverified_calls = True
    customer_service_window_seconds = WINDOW_SECONDS
    customer_service_window_margin_seconds = WINDOW_MARGIN_SECONDS
    max_agent_replies_per_hour = MAX_AGENT_REPLIES_PER_HOUR
    #: Its last four are shown next to the access token's.
    shown_credential_field = "verify_token"
    #: Statuses only a later successful send proves stale: a health check,
    #: which never sends, does not clear them.
    statuses_cleared_by_send = (
        STATUS_PERMISSION_DENIED, STATUS_PAYMENT_ISSUE, STATUS_ACCOUNT_RESTRICTED,
        STATUS_NUMBER_NOT_REGISTERED,
    )
    #: Why connect was refused, by ``account``'s error code.
    account_error_reasons = {
        CODE_TOKEN_REJECTED: "Meta rejected this token",
        CODE_NUMBER_UNREACHABLE: "This phone number id isn't reachable with this token",
        CODE_PERMISSION_DENIED: "This token isn't allowed to use this phone number",
    }

    def __init__(
        self, *, transport: Optional[httpx.AsyncBaseTransport] = None,
        api_base: str = GRAPH_BASE, timeout: float = 30.0, connect_timeout: float = 10.0,
    ) -> None:
        self._transport = transport
        self._api_base = api_base.rstrip("/")
        self._timeout = httpx.Timeout(timeout, connect=connect_timeout)
        # An overall deadline too: a transport that ignores httpx's timeouts
        # must not hold the outbox worker forever.
        self._deadline = timeout + connect_timeout
        self._store = None

    def bind(self, *, store, config) -> None:
        """Called by the gateway: the store, for what ``health`` reports from
        our own records (the last check, the last delivery, refused calls)."""
        self._store = store

    # ── inbound ──────────────────────────────────────────────────────────

    def verify(
        self, connection: ChannelConnection, secret: SecretStr,
        headers: Mapping[str, str], body: bytes, *, webhook_keys: Sequence[str],
    ) -> Optional[int]:
        presented = _header(headers, SIGNATURE_HEADER)
        if not presented:
            return None
        try:
            # Starlette decodes header bytes as latin-1, so this gives back the
            # bytes Meta sent; a value that can't be latin-1 can't be ours.
            given = presented.encode("latin-1")
            app_secret = unpack_credential(secret)["app_secret"]
        except (UnicodeEncodeError, AdapterError):
            return None
        if not _SIGNATURE_RE.match(given) or not app_secret:
            return None
        expected = signature(app_secret, body).encode("ascii")
        return 0 if hmac.compare_digest(expected, given) else None

    def answer_subscription(
        self, connection: ChannelConnection, secret: SecretStr,
        query: Mapping[str, Sequence[str]],
    ) -> Optional[str]:
        """Meta's check of the callback URL. Every parameter must appear exactly
        once; the token is compared in constant time, before the challenge is
        looked at, so a wrong token learns nothing about the challenge rule."""
        modes, tokens = query.get("hub.mode", ()), query.get("hub.verify_token", ())
        challenges = query.get("hub.challenge", ())
        if len(modes) != 1 or modes[0] != "subscribe" or len(tokens) != 1:
            return None
        try:
            stored = unpack_credential(secret)["verify_token"]
        except AdapterError:
            return None
        if not stored or not hmac.compare_digest(
            tokens[0].encode("utf-8"), stored.encode("utf-8"),
        ):
            return None
        if len(challenges) != 1:
            return None
        if not _CHALLENGE_RE.match(challenges[0]):
            raise ValueError("challenge")
        return challenges[0]

    def parse(self, body: bytes) -> list[InboundEvent]:
        raise ValueError("WhatsApp bodies are read with parse_for_connection")

    def parse_for_connection(
        self, connection: ChannelConnection, body: bytes,
    ) -> list[InboundEvent]:
        document = json.loads(body)
        if (
            not isinstance(document, dict)
            or document.get("object") != "whatsapp_business_account"
            or not isinstance(document.get("entry"), list)
        ):
            raise ValueError("not a WhatsApp webhook body")
        events: list[InboundEvent] = []
        for entry in document["entry"]:
            changes = entry.get("changes") if isinstance(entry, dict) else None
            for change in changes if isinstance(changes, list) else []:
                events.extend(self._change(connection, change))
        return events

    def _change(self, connection: ChannelConnection, change: Any) -> list[InboundEvent]:
        if not isinstance(change, dict) or change.get("field") != "messages":
            return []
        value = change.get("value")
        if not isinstance(value, dict):
            return []
        metadata = value.get("metadata")
        number_id = metadata.get("phone_number_id") if isinstance(metadata, dict) else None
        if number_id != connection.external_id:
            logger.warning(
                "WhatsApp webhook for connection %s: phone_number_mismatch (change dropped)",
                connection.id[:8],
            )
            return []
        own = _digits(metadata.get("display_phone_number"))
        for status in value.get("statuses") or []:
            if isinstance(status, dict) and status.get("status") == "failed":
                codes = [e.get("code") for e in status.get("errors") or [] if isinstance(e, dict)]
                logger.warning(
                    "WhatsApp connection %s: a sent message failed: codes=%s",
                    connection.id[:8], [c for c in codes if isinstance(c, int)],
                )
        for error in value.get("errors") or []:
            if isinstance(error, dict) and isinstance(error.get("code"), int):
                logger.warning(
                    "WhatsApp connection %s: webhook error code=%d", connection.id[:8],
                    error["code"],
                )
        names = {}
        for contact in value.get("contacts") or []:
            if isinstance(contact, dict) and isinstance(contact.get("wa_id"), str):
                profile = contact.get("profile")
                name = profile.get("name") if isinstance(profile, dict) else None
                if isinstance(name, str):
                    names[contact["wa_id"]] = name
        events = []
        for message in value.get("messages") or []:
            event, skipped = _event(message, own, names)
            if event is not None:
                events.append(event)
            elif skipped:
                logger.info("WhatsApp message dropped for connection %s: %s",
                            connection.id[:8], skipped)
        return events

    # ── outbound ─────────────────────────────────────────────────────────

    def format_parts(self, text: str) -> list[str]:
        return format_parts(text)

    async def send(
        self, connection: ChannelConnection, secret: SecretStr, *,
        conversation_key: str, text: str, retry_key: str,
    ) -> None:
        token = unpack_credential(secret)["access_token"]
        status, payload = await self._call(
            "POST", f"/{connection.external_id}/messages", token,
            body={
                "messaging_product": "whatsapp", "recipient_type": "individual",
                "to": conversation_key, "type": "text",
                "text": {"preview_url": False, "body": text},
            },
        )
        if 200 <= status < 300:
            messages = payload.get("messages") if isinstance(payload, dict) else None
            first = messages[0] if isinstance(messages, list) and messages else None
            if isinstance(first, dict) and isinstance(first.get("id"), str) and first["id"]:
                return
            raise AdapterError(CODE_NO_MESSAGE_ID)
        raise send_error(status, payload)

    # ── connection management (owner actions only) ───────────────────────

    def pack_credential(self, fields: Mapping[str, str]) -> str:
        return pack_credential(
            fields.get("access_token", ""), fields.get("app_secret", ""),
            fields.get("verify_token", ""), fields.get("phone_number_id", ""),
        )

    def check_credential(self, secret: SecretStr) -> Optional[str]:
        try:
            fields = unpack_credential(secret)
        except AdapterError:
            return "Enter the phone number id, access token, app secret and verify token"
        if not PHONE_NUMBER_ID_RE.match(fields["phone_number_id"]):
            return "That doesn't look like a phone number id (it is digits only)"
        if not APP_SECRET_RE.match(fields["app_secret"]):
            return "That doesn't look like an app secret (it is 32 characters, 0-9 and a-f)"
        if not ACCESS_TOKEN_RE.match(fields["access_token"]):
            return "That doesn't look like a WhatsApp access token"
        if not _VERIFY_TOKEN_RE.match(fields["verify_token"]):
            return "The verify token must be at least 16 printable characters, without spaces"
        return None

    async def account(self, secret: SecretStr) -> AccountInfo:
        fields = unpack_credential(secret)
        info = await self._number(fields["phone_number_id"], fields["access_token"])
        number_id = info.get("id")
        if number_id is not None and number_id != fields["phone_number_id"]:
            raise AdapterError(CODE_REJECTED, permanent=True)
        name = _clean(info.get("verified_name"))
        display = _clean(info.get("display_phone_number"), 30)
        label = f"{name} ({display})" if name and display else (name or display)
        return AccountInfo(external_id=fields["phone_number_id"], account_name=label)

    async def register_webhook(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str, webhook_key: str,
    ) -> None:
        """The callback lives on the owner's Meta app; nothing is sent."""
        return None

    async def unregister_webhook(self, connection: ChannelConnection, secret: SecretStr) -> None:
        """The callback lives on the owner's Meta app; nothing is sent."""
        return None

    async def health(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str,
    ) -> HealthReport:
        """Token alive and number reachable (one GET, never a message), then
        the webhook side from our own records."""
        token = unpack_credential(secret)["access_token"]
        try:
            await self._number(connection.external_id or "", token)
        except AdapterError as exc:
            if exc.code in (CODE_TOKEN_REJECTED, CODE_PERMISSION_DENIED, CODE_NUMBER_UNREACHABLE):
                return HealthReport(exc.code)
            raise
        if self._store is not None:
            extras = self._store.extras(connection.id)
            if extras.unverified_calls:
                return HealthReport(STATUS_SIGNATURE_MISMATCH, count=extras.unverified_calls)
            if extras.handshake_ok_at is None and connection.last_inbound_at is None:
                return HealthReport(STATUS_NO_WEBHOOK_YET)
        return HealthReport("working")

    async def _number(self, phone_number_id: str, token: str) -> dict:
        status, payload = await self._call(
            "GET", f"/{phone_number_id}", token,
            params={"fields": "display_phone_number,verified_name,quality_rating"},
        )
        if 200 <= status < 300:
            return payload if isinstance(payload, dict) else {}
        code = _error_code(payload)
        if code == 190 or (code is None and status == 401):
            raise AdapterError(CODE_TOKEN_REJECTED, permanent=True,
                               connection_status=STATUS_TOKEN_REJECTED)
        if code == 10 or (code is not None and 200 <= code <= 299):
            raise AdapterError(CODE_PERMISSION_DENIED, permanent=True)
        if code in (100, 33):
            raise AdapterError(CODE_NUMBER_UNREACHABLE, permanent=True)
        if status >= 500 or status == 429 or code in _RATE_LIMIT_CODES or code in _TRANSIENT_CODES:
            raise AdapterError(CODE_PROVIDER_UNAVAILABLE)
        raise AdapterError(CODE_REJECTED, permanent=True)

    # ── HTTP ─────────────────────────────────────────────────────────────

    async def _call(
        self, method: str, path: str, token: str, *, body: Optional[dict] = None,
        params: Optional[dict] = None,
    ) -> tuple[int, Any]:
        """One Graph call → (HTTP status, decoded JSON or None). Every httpx
        failure becomes an AdapterError raised ``from None``."""
        url = f"{self._api_base}/{GRAPH_API_VERSION}{path}"
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
                request = client.request(
                    method, url, headers={"Authorization": f"Bearer {token}"},
                    **({"json": body} if body is not None else {}),
                    **({"params": params} if params is not None else {}),
                )
                response = await asyncio.wait_for(request, timeout=self._deadline)
                content = response.content
        except (httpx.TimeoutException, asyncio.TimeoutError):
            raise AdapterError(CODE_TIMEOUT) from None
        except httpx.HTTPError:
            raise AdapterError(CODE_NETWORK) from None
        try:
            payload = json.loads(content) if content else None
        except ValueError:
            payload = None
        return response.status_code, payload


def _event(
    message: Any, own_number: str, names: Mapping[str, str],
) -> tuple[Optional[InboundEvent], Optional[str]]:
    """One ``messages[]`` item → (the event, None) or (None, why it was
    dropped — a fixed word, or None for types ignored silently)."""
    if not isinstance(message, dict):
        return None, "not_an_object"
    kind = message.get("type")
    kind_label = kind if isinstance(kind, str) and kind.isidentifier() else "?"
    message_id = message.get("id")
    if not isinstance(message_id, str) or not message_id:
        return None, f"no_message_id type={kind_label}"[:60]
    sender = message.get("from")
    if not isinstance(sender, str) or not _DIGITS_RE.match(sender):
        return None, "no_phone_number"
    if message.get("group_id") is not None:
        return None, "group_message"
    if own_number and sender == own_number:
        return None, "own_number"
    text, skipped = _message_text(message)
    if text is None:
        return None, skipped
    name = names.get(sender) or f"WhatsApp user ···{sender[-4:]}"
    return InboundEvent(
        event_id=message_id,
        conversation_key=sender,
        user_key=sender,
        display_name=name,
        text=text,
        auth_verdict=access.AUTH_PROVIDER,
        sent_at=_timestamp(message.get("timestamp")),
    ), None


def _error_code(payload: Any) -> Optional[int]:
    error = payload.get("error") if isinstance(payload, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    return code if isinstance(code, int) and not isinstance(code, bool) else None


def send_error(status: int, payload: Any) -> AdapterError:
    """A failed send's answer as the AdapterError the gateway acts on (the
    table in the module docstring)."""
    code = _error_code(payload)
    if code == 131047:
        return AdapterError(CODE_WINDOW_CLOSED, window_closed=True)
    if code == 131026:
        return AdapterError(CODE_UNDELIVERABLE, permanent=True)
    if code == 131056:
        return AdapterError(CODE_RATE_LIMITED, retry_after=PAIR_RATE_LIMIT_SECONDS)
    if code in _RATE_LIMIT_CODES:
        return AdapterError(CODE_RATE_LIMITED)
    if code == 190:
        return AdapterError(CODE_TOKEN_REJECTED, permanent=True,
                            connection_status=STATUS_TOKEN_REJECTED)
    if code == 10 or (code is not None and 200 <= code <= 299):
        return AdapterError(CODE_PERMISSION_DENIED, permanent=True,
                            connection_status=STATUS_PERMISSION_DENIED)
    if code in (100, 33):
        return AdapterError(CODE_REJECTED, permanent=True)
    if code == 131030:
        return AdapterError(CODE_RECIPIENT_NOT_ALLOWED, permanent=True)
    if code == 133010:
        return AdapterError(CODE_NUMBER_NOT_REGISTERED, permanent=True,
                            connection_status=STATUS_NUMBER_NOT_REGISTERED)
    if code == 131042:
        return AdapterError(CODE_PAYMENT_ISSUE, permanent=True,
                            connection_status=STATUS_PAYMENT_ISSUE)
    if code in _RESTRICTED_CODES:
        return AdapterError(CODE_ACCOUNT_RESTRICTED, permanent=True,
                            connection_status=STATUS_ACCOUNT_RESTRICTED)
    if code in _TRANSIENT_CODES:
        return AdapterError(CODE_PROVIDER_UNAVAILABLE)
    if status >= 500:
        return AdapterError(CODE_PROVIDER_5XX)
    if status == 429:
        return AdapterError(CODE_RATE_LIMITED)
    return AdapterError(CODE_REJECTED, permanent=True)
