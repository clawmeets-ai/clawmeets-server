# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/line.py
The LINE adapter: a Messaging API channel's webhook in, an acknowledgement on
the reply token, the agent's answer as a push message with a retry key.

LINE facts this module relies on (Messaging API reference and "Retry a failed
API request", read 2026-10-07):

- ``X-Line-Signature`` = base64(HMAC-SHA256(channel secret, raw body)).
- A reply token can be used once, within a minute of the webhook. Reply
  messages are free; push messages count toward the monthly quota.
- ``X-Line-Retry-Key`` is "a hexadecimal UUID", valid for 24 hours after the
  first request, accepted on push (not on reply). ``409`` means a request with
  the same key was already accepted.
- ``429`` is either the monthly limit (``message`` ``You have reached your
  monthly limit.``) or the rate limit; only the body's ``message`` tells them
  apart.
- A text message is at most 5000 UTF-16 code units; ``type: "text"`` renders
  no markup (``textV2`` would read ``{name}`` as a placeholder, so it is never
  used).

**Credentials.** A connection holds TWO secrets, stored together as one
encrypted JSON blob (``pack_credential``): the channel secret, which only
``verify`` reads, and the long-lived channel access token, which every outbound
call sends as ``Authorization: Bearer``. Only the token's last four characters
are ever shown; the channel secret is never shown, not even partly. Nothing is
derived from the server's secret keys, so ``verify`` returns ``0`` or ``None``
and a key rotation never asks for a reconnect (``rotate_secrets`` re-encrypts
the blob like any credential). Short-lived and v2.1 tokens, which need
refreshing, are not supported in this phase.

**Inbound mapping** (``parse_for_connection``), from the webhook body
``{"destination": <bot user id>, "events": [...]}``:

    event_id          webhookEventId — never message.id (non-message events
                      have none) and never the reply token (a redelivery
                      carries a new one)
    conversation_key  source.userId (1:1 chats only)
    user_key          source.userId
    display_name      "LINE user ···<last 4 of the id>" — a stand-in; the
                      real name comes from ``profile_name`` (below)
    text              message.text, or a placeholder line (below)
    reply_token       replyToken — used once for the acknowledgement, never stored
    auth_verdict      AUTH_PROVIDER — LINE authenticates the sender

A body whose ``destination`` is not this connection's bot (two channels sharing
one mis-pasted secret) is dropped whole. Each event is then read on its own, in
array order, and one unreadable event never drops the others. Dropped events
(no event, 200): an event without ``webhookEventId`` (never deduped by a
made-up id); ``mode: "standby"`` (another module owns the chat, and LINE says
the bot must not send); a ``group`` or ``room`` source, even from an
allowlisted user (group content must never be answered in a private chat —
the plan serves 1:1 chats only); ``follow``, ``unfollow``, ``unsend``,
``join``, ``leave``, ``memberJoined``, ``memberLeft``, ``postback``,
``beacon``, ``accountLink``, ``videoPlayComplete``, ``things`` and any unknown
type; whitespace-only text. ``deliveryContext.isRedelivery`` is NOT a reason to
drop: a redelivery may be the first copy we see. Redelivered events are taken
in arrival order (as Telegram's), never re-sorted by ``timestamp``.

Non-text messages become one placeholder line; media content is never
downloaded (no call to ``api-data.line.me``):

    sticker → "[sticker]" or "[sticker: happy, smile]" (LINE's keywords, ≤ 5)
    image / video / audio → "[image]" / "[video]" / "[audio]"
    file → "[file: <name>, <size>]"     location → "[location: <title>, <address>]"

**The contact's name** (``profile_name``). A webhook carries only the userId,
so the gateway asks ``GET /v2/bot/profile/{userId}`` for ``displayName`` the
first time it sees a contact (and again, at most hourly, while the stand-in is
all it has). Off the webhook's critical path, bounded by ``profile_timeout``
(5 s), never retried: ``404`` (the user blocked the bot or is not a friend)
answers None, any other failure an :class:`AdapterError` with a fixed code, and
either way the message keeps the stand-in. A profile call is not a message, so
it never counts toward the push quota. The name is never logged; the userId in
the URL is scrubbed from ``httpx``'s request log (``log_redaction``).

**The acknowledgement** (``acknowledge``) is one ``POST /v2/bot/message/reply``
with the connection's text, made by the gateway after the decision committed,
only for a message that reached the agent, off the webhook's critical path and
never retried (see ``ChannelGateway._acknowledge``). No retry key: reply does
not take one.

**The answer** (``send``) is one push per outbox row, ``POST
/v2/bot/message/push`` with ``X-Line-Retry-Key`` = ``uuid5(RETRY_KEY_NAMESPACE,
row.retry_key)``: the stored key, the same on every attempt and in every
process, as a canonical UUID. **The 24-hour windows line up:** a row is never
sent more than ``max_outbound_age_seconds`` (24 h) after its message, and its
first push is never earlier than the message, so every retry falls inside the
key's 24-hour validity — the gateway clamps its own setting to this adapter's.

    200, 409 (key already accepted)  sent
    400                              permanent rejected_by_provider
    401                              permanent token_rejected (+ connection status)
    403                              permanent push_not_allowed (+ connection status)
    404                              permanent not_found
    429 monthly limit                permanent push_quota_exhausted
                                     (+ connection status quota_exhausted)
    429 anything else / unreadable   retried (rate_limited), same key
    other 4xx                        permanent provider_error
    5xx, timeout, network error      retried, same key

LINE's ``message`` is read only to tell the two 429s apart; neither it nor
``details`` (which can echo our request) is ever stored or logged.

**Push quota** (``quota``): ``GET /v2/bot/message/quota`` (the limit) and
``GET /v2/bot/message/quota/consumption`` (usage, which includes broadcasts the
owner sends from LINE Official Account Manager). Called on connect, on Test and
when the page loads with figures older than 15 minutes — never on the webhook
path or per send. The quota month is computed in Asia/Tokyo
(``quota_month_start``); the next fetch corrects any drift.

**Connection management.** ``account`` is ``GET /v2/bot/info`` (the bot's
``userId`` is the webhook's ``destination``). ``register_webhook`` sets the
endpoint URL. LINE has no call that deletes a webhook, so ``unregister_webhook``
does nothing: Disable and Remove leave the URL registered at LINE, and later
calls are answered 200-and-dropped (disabled) or 404 (removed). ``health`` asks
whether the token works, whether LINE points at our URL with "Use webhook" on,
and runs LINE's webhook test, which reveals a mistyped channel secret: our
endpoint answers it 401 (``signature_mismatch``).

**Secrets never in logs.** The token travels in a header, never a URL. No
``httpx`` exception escapes this module: each becomes an :class:`AdapterError`
raised ``from None``. Log lines carry the connection id prefix and fixed codes
only — never a user id, a reply token, a signature or message text.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import unicodedata
import uuid
from datetime import datetime
from typing import Any, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo

import httpx
from pydantic import SecretStr

from . import access
from .adapter import AccountInfo, AdapterError, HealthReport, InboundEvent
from .line_format import format_parts
from .log_redaction import install_secret_scrubbing
from .store import ChannelConnection

logger = logging.getLogger(__name__)
install_secret_scrubbing(__name__)

API_BASE = "https://api.line.me"
SIGNATURE_HEADER = "x-line-signature"
#: A fixed namespace, never a setting: the retry key of a row must come out the
#: same in every process that will ever send it.
RETRY_KEY_NAMESPACE = uuid.UUID("6f1c3d2e-8b4a-5c7e-9d10-4a2b3c4d5e6f")
#: How long LINE remembers a retry key; the gateway never sends a row older.
RETRY_KEY_VALIDITY_SECONDS = 24 * 3600
QUOTA_TIMEZONE = ZoneInfo("Asia/Tokyo")
DEFAULT_ACK_TEXT = "Got it — I'll reply shortly."
MONTHLY_LIMIT_MESSAGE = "You have reached your monthly limit."
USER_ID_RE = re.compile(r"^U[0-9a-f]{32}$")
USER_ID_ERROR = "a LINE user id is U followed by 32 lowercase hex characters"
CHANNEL_SECRET_RE = re.compile(r"^[0-9a-f]{32}$")
ACCESS_TOKEN_RE = re.compile(r"^[A-Za-z0-9+/=._-]{40,}$")
MAX_STICKER_KEYWORDS = 5
MAX_PLACEHOLDER_FIELD = 100

# Fixed codes (stored on rows, logged; never LINE's own text).
CODE_TOKEN_REJECTED = "token_rejected"
CODE_PUSH_NOT_ALLOWED = "push_not_allowed"
CODE_REJECTED = "rejected_by_provider"
CODE_NOT_FOUND = "not_found"
CODE_QUOTA = "push_quota_exhausted"
CODE_RATE_LIMITED = "rate_limited"
CODE_PROVIDER_5XX = "provider_5xx"
CODE_PROVIDER_ERROR = "provider_error"
CODE_TIMEOUT = "timeout"
CODE_NETWORK = "network_error"
CODE_BAD_CREDENTIAL = "bad_credential"
CODE_ACK_TOKEN_INVALID = "ack_token_invalid"
CODE_ACK_REJECTED = "ack_rejected"

# Connection statuses this adapter reports (shown as fixed sentences).
STATUS_TOKEN_REJECTED = "token_rejected"
STATUS_PUSH_NOT_ALLOWED = "push_not_allowed"
STATUS_QUOTA_EXHAUSTED = "quota_exhausted"
STATUS_SIGNATURE_MISMATCH = "signature_mismatch"

_DROPPED_CATEGORIES = {"Cc", "Cf", "Zl", "Zp"}
_IGNORED_EVENTS = frozenset({
    "follow", "unfollow", "unsend", "join", "leave", "memberJoined", "memberLeft",
    "postback", "beacon", "accountLink", "videoPlayComplete", "things",
})


def pack_credential(access_token: str, channel_secret: str) -> str:
    """The one stored credential: both secrets, as JSON."""
    return json.dumps({"channel_secret": channel_secret, "access_token": access_token})


def unpack_credential(secret: SecretStr) -> tuple[str, str]:
    """``(channel_secret, access_token)``. Raises ``AdapterError`` (never with
    the value) when the stored blob is not a LINE credential."""
    try:
        data = json.loads(secret.get_secret_value())
        channel_secret, token = data["channel_secret"], data["access_token"]
    except (ValueError, KeyError, TypeError):
        raise AdapterError(CODE_BAD_CREDENTIAL, permanent=True) from None
    if not isinstance(channel_secret, str) or not isinstance(token, str):
        raise AdapterError(CODE_BAD_CREDENTIAL, permanent=True)
    return channel_secret, token


def retry_key_uuid(retry_key: str) -> str:
    """The ``X-Line-Retry-Key`` for an outbox row's stored key: a canonical
    ``8-4-4-4-12`` UUID, identical for the same row in every process."""
    return str(uuid.uuid5(RETRY_KEY_NAMESPACE, retry_key))


def signature(channel_secret: str, body: bytes) -> str:
    return base64.b64encode(
        hmac.new(channel_secret.encode("utf-8"), body, hashlib.sha256).digest(),
    ).decode("ascii")


def quota_month_start(epoch: float) -> float:
    """The start of the quota month (Asia/Tokyo) that ``epoch`` falls in."""
    local = datetime.fromtimestamp(epoch, QUOTA_TIMEZONE)
    return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()


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
    characters removed, whitespace collapsed, capped in code points (empty
    when nothing is left)."""
    if not isinstance(value, str):
        return ""
    text = unicodedata.normalize("NFC", value)
    spaced = "".join(" " if ch.isspace() else ch for ch in text)
    kept = "".join(ch for ch in spaced if unicodedata.category(ch) not in _DROPPED_CATEGORIES)
    return " ".join(kept.split())[:limit].strip()


def _size(value: Any) -> str:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        return ""
    if value < 1024:
        return f"{value} B"
    if value < 1024 * 1024:
        return f"{value / 1024:.0f} KB"
    return f"{value / (1024 * 1024):.1f} MB"


def _message_text(message: dict) -> Optional[str]:
    kind = message.get("type")
    if kind == "text":
        text = message.get("text")
        return text if isinstance(text, str) and text.strip() else None
    if kind == "sticker":
        keywords = message.get("keywords")
        words = [w for w in (_clean(k, 30) for k in keywords[:MAX_STICKER_KEYWORDS])
                 if w] if isinstance(keywords, list) else []
        return f"[sticker: {', '.join(words)}]" if words else "[sticker]"
    if kind in ("image", "video", "audio"):
        return f"[{kind}]"
    if kind == "file":
        fields = [f for f in (_clean(message.get("fileName")), _size(message.get("fileSize"))) if f]
        return f"[file: {', '.join(fields)}]" if fields else "[file]"
    if kind == "location":
        fields = [f for f in (_clean(message.get("title")), _clean(message.get("address"))) if f]
        return f"[location: {', '.join(fields)}]" if fields else "[location]"
    return None


class LineAdapter:
    channel = "line"
    allowlist_kinds = (access.USER_ID,)
    provider_authenticates_sender = True
    #: A typed allowlist entry must look like a LINE user id.
    user_id_pattern = USER_ID_RE
    user_id_error = USER_ID_ERROR
    #: The gateway never sends a row older than this (the retry key's validity).
    max_outbound_age_seconds = RETRY_KEY_VALIDITY_SECONDS
    default_ack_text = DEFAULT_ACK_TEXT
    #: Webhook calls that fail ``verify`` are counted and shown on the card.
    track_unverified_calls = True
    #: Statuses only a later successful push proves stale: a health check,
    #: which never pushes, does not clear them.
    statuses_cleared_by_send = (STATUS_QUOTA_EXHAUSTED, STATUS_PUSH_NOT_ALLOWED)
    #: LINE's refusal of push itself (a 403): kept as its own flag too
    #: (``push_refused_at``), so a Test that finds something else wrong first
    #: does not lose it.
    push_refused_status = STATUS_PUSH_NOT_ALLOWED

    def __init__(
        self, *, transport: Optional[httpx.AsyncBaseTransport] = None,
        api_base: str = API_BASE, timeout: float = 30.0, connect_timeout: float = 10.0,
        ack_timeout: float = 5.0, profile_timeout: float = 5.0,
    ) -> None:
        self._transport = transport
        self._api_base = api_base.rstrip("/")
        self._timeout = httpx.Timeout(timeout, connect=connect_timeout)
        # An overall deadline too: a transport that ignores httpx's timeouts
        # must not hold the outbox worker forever.
        self._deadline = timeout + connect_timeout
        self._ack_timeout = ack_timeout
        self._profile_timeout = profile_timeout

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
            # bytes LINE sent; a value that can't be latin-1 can't be ours.
            given = presented.encode("latin-1")
            channel_secret, _ = unpack_credential(secret)
        except (UnicodeEncodeError, AdapterError):
            return None
        expected = signature(channel_secret, body).encode("ascii")
        return 0 if hmac.compare_digest(expected, given) else None

    def parse(self, body: bytes) -> list[InboundEvent]:
        """The events of a verified body (no destination check; the gateway
        calls ``parse_for_connection``)."""
        return self._events(_document(body))

    def parse_for_connection(
        self, connection: ChannelConnection, body: bytes,
    ) -> list[InboundEvent]:
        document = _document(body)
        destination = document.get("destination")
        if connection.external_id and destination != connection.external_id:
            logger.warning(
                "LINE webhook for connection %s: destination_mismatch (body dropped)",
                connection.id[:8],
            )
            return []
        return self._events(document)

    def _events(self, document: dict) -> list[InboundEvent]:
        events: list[InboundEvent] = []
        for raw in document["events"]:
            event, skipped = _event(raw)
            if event is not None:
                events.append(event)
            elif skipped:
                logger.info("LINE event dropped: %s", skipped)
        return events

    # ── outbound ─────────────────────────────────────────────────────────

    def format_parts(self, text: str) -> list[str]:
        return format_parts(text)

    async def send(
        self, connection: ChannelConnection, secret: SecretStr, *,
        conversation_key: str, text: str, retry_key: str,
    ) -> None:
        _, token = unpack_credential(secret)
        status, payload = await self._call(
            "POST", "/v2/bot/message/push", token,
            body={"to": conversation_key, "messages": [{"type": "text", "text": text}]},
            headers={"X-Line-Retry-Key": retry_key_uuid(retry_key)},
        )
        if status == 409:
            # The same key was already accepted: an earlier attempt reached
            # LINE (we crashed before recording it). Sent, not an error.
            logger.info("LINE push for connection %s: already_accepted", connection.id[:8])
            return
        _raise_for_push(status, payload)

    async def acknowledge(
        self, connection: ChannelConnection, secret: SecretStr, *,
        reply_token: str, text: str,
    ) -> None:
        """The "got it" on the reply token. Bounded by ``ack_timeout``; raises
        :class:`AdapterError` with a fixed code on any failure."""
        _, token = unpack_credential(secret)
        status, payload = await self._call(
            "POST", "/v2/bot/message/reply", token,
            body={"replyToken": reply_token, "messages": [{"type": "text", "text": text}]},
            deadline=self._ack_timeout,
        )
        if 200 <= status < 300:
            return
        if status == 401:
            raise AdapterError(
                CODE_TOKEN_REJECTED, permanent=True, connection_status=STATUS_TOKEN_REJECTED,
            )
        if status == 400:
            invalid = _message(payload).lower() == "invalid reply token"
            raise AdapterError(CODE_ACK_TOKEN_INVALID if invalid else CODE_ACK_REJECTED)
        if status >= 500:
            raise AdapterError(CODE_PROVIDER_5XX)
        raise AdapterError(CODE_ACK_REJECTED)

    async def profile_name(
        self, connection: ChannelConnection, secret: SecretStr, *, user_key: str,
    ) -> Optional[str]:
        """The contact's LINE ``displayName`` (raw; the gateway cleans it), or
        None when LINE has no profile for them (404: blocked, not a friend).
        Bounded by ``profile_timeout``; raises :class:`AdapterError` with a
        fixed code on any other failure."""
        if not USER_ID_RE.match(user_key):
            return None  # never put anything else into the URL
        _, token = unpack_credential(secret)
        status, payload = await self._call(
            "GET", f"/v2/bot/profile/{user_key}", token, deadline=self._profile_timeout,
        )
        if status == 404:
            return None
        _raise_for_api(status)
        name = payload.get("displayName") if isinstance(payload, dict) else None
        return name if isinstance(name, str) and name.strip() else None

    # ── connection management (owner actions only) ───────────────────────

    def pack_credential(self, fields: Mapping[str, str]) -> str:
        return pack_credential(fields.get("access_token", ""), fields.get("channel_secret", ""))

    def check_credential(self, secret: SecretStr) -> Optional[str]:
        try:
            channel_secret, token = unpack_credential(secret)
        except AdapterError:
            return "Enter both the channel secret and the channel access token"
        if not CHANNEL_SECRET_RE.match(channel_secret):
            return "That doesn't look like a channel secret (it is 32 characters, 0-9 and a-f)"
        if not ACCESS_TOKEN_RE.match(token):
            return "That doesn't look like a long-lived channel access token"
        return None

    async def account(self, secret: SecretStr) -> AccountInfo:
        _, token = unpack_credential(secret)
        status, payload = await self._call("GET", "/v2/bot/info", token)
        _raise_for_api(status)
        info = payload if isinstance(payload, dict) else {}
        user_id = info.get("userId")
        if not isinstance(user_id, str) or not USER_ID_RE.match(user_id):
            raise AdapterError(CODE_PROVIDER_ERROR)
        name = info.get("displayName") or info.get("basicId") or ""
        return AccountInfo(external_id=user_id, account_name=_clean(name) if name else "")

    async def register_webhook(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str, webhook_key: str,
    ) -> None:
        if not url.startswith("https://"):
            raise AdapterError("webhook_not_https", permanent=True)
        _, token = unpack_credential(secret)
        status, _ = await self._call(
            "PUT", "/v2/bot/channel/webhook/endpoint", token, body={"endpoint": url},
        )
        _raise_for_api(status)

    async def unregister_webhook(self, connection: ChannelConnection, secret: SecretStr) -> None:
        """LINE has no call that deletes a webhook; nothing is sent."""
        return None

    async def health(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str,
    ) -> HealthReport:
        _, token = unpack_credential(secret)
        status, _ = await self._call("GET", "/v2/bot/info", token)
        if status == 401:
            return HealthReport(STATUS_TOKEN_REJECTED)
        _raise_for_api(status)
        status, payload = await self._call("GET", "/v2/bot/channel/webhook/endpoint", token)
        _raise_for_api(status)
        info = payload if isinstance(payload, dict) else {}
        if info.get("endpoint") != url or info.get("active") is not True:
            return HealthReport("webhook_missing")
        status, payload = await self._call(
            "POST", "/v2/bot/channel/webhook/test", token, body={"endpoint": url},
        )
        _raise_for_api(status)
        result = payload if isinstance(payload, dict) else {}
        answered = result.get("statusCode")
        if answered == 401:
            return HealthReport(STATUS_SIGNATURE_MISMATCH)
        if result.get("success") is not True:
            return HealthReport(
                "webhook_error", count=answered if isinstance(answered, int) else None,
            )
        return HealthReport("working")

    async def quota(self, secret: SecretStr) -> tuple[str, Optional[int], Optional[int]]:
        """``(type, limit, usage)``: ``("limited", N, used)`` or ``("none",
        None, used)``. Raises :class:`AdapterError`."""
        _, token = unpack_credential(secret)
        status, payload = await self._call("GET", "/v2/bot/message/quota", token)
        _raise_for_api(status)
        limit_doc = payload if isinstance(payload, dict) else {}
        status, payload = await self._call("GET", "/v2/bot/message/quota/consumption", token)
        _raise_for_api(status)
        usage = payload.get("totalUsage") if isinstance(payload, dict) else None
        usage = usage if isinstance(usage, int) and not isinstance(usage, bool) else None
        value = limit_doc.get("value")
        if limit_doc.get("type") == "limited" and isinstance(value, int) and not isinstance(value, bool):
            return "limited", value, usage
        if limit_doc.get("type") == "none":
            return "none", None, usage
        raise AdapterError(CODE_PROVIDER_ERROR)

    def quota_month_start(self, epoch: float) -> float:
        return quota_month_start(epoch)

    # ── HTTP ─────────────────────────────────────────────────────────────

    async def _call(
        self, method: str, path: str, token: str, *, body: Optional[dict] = None,
        headers: Optional[dict] = None, deadline: Optional[float] = None,
    ) -> tuple[int, Any]:
        """One Messaging API call → (HTTP status, decoded JSON or None). Every
        httpx failure becomes an AdapterError raised ``from None``."""
        sent = {"Authorization": f"Bearer {token}", **(headers or {})}
        limit = deadline if deadline is not None else self._deadline
        timeout = self._timeout if deadline is None else httpx.Timeout(deadline)
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as client:
                request = client.request(
                    method, f"{self._api_base}{path}", headers=sent,
                    **({"json": body} if body is not None else {}),
                )
                response = await asyncio.wait_for(request, timeout=limit)
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


def _document(body: bytes) -> dict:
    document = json.loads(body)
    if not isinstance(document, dict) or not isinstance(document.get("events"), list):
        raise ValueError("not a LINE webhook body")
    return document


def _event(raw: Any) -> tuple[Optional[InboundEvent], Optional[str]]:
    """One webhook event → (the event, None) or (None, why it was dropped —
    a fixed word, logged; None for the types that are ignored silently)."""
    if not isinstance(raw, dict):
        return None, "not_an_object"
    kind = raw.get("type")
    event_id = raw.get("webhookEventId")
    if not isinstance(event_id, str) or not event_id:
        return None, f"no_event_id type={kind if isinstance(kind, str) else '?'}"[:60]
    if raw.get("mode") == "standby":
        return None, "standby"
    source = raw.get("source")
    if not isinstance(source, dict):
        return None, "no_source"
    if source.get("type") != "user":
        return None, "group_or_room_source"
    if kind != "message":
        return None, None if kind in _IGNORED_EVENTS else "unknown_type"
    user_id = source.get("userId")
    if not isinstance(user_id, str) or not USER_ID_RE.match(user_id):
        return None, "no_user_id"
    message = raw.get("message")
    if not isinstance(message, dict):
        return None, "no_message"
    text = _message_text(message)
    if text is None:
        return None, None
    reply_token = raw.get("replyToken")
    return InboundEvent(
        event_id=event_id,
        conversation_key=user_id,
        user_key=user_id,
        display_name=f"LINE user ···{user_id[-4:]}",
        text=text,
        auth_verdict=access.AUTH_PROVIDER,
        reply_token=reply_token if isinstance(reply_token, str) and reply_token else None,
    ), None


def _message(payload: Any) -> str:
    if isinstance(payload, dict) and isinstance(payload.get("message"), str):
        return payload["message"]
    return ""


def _raise_for_push(status: int, payload: Any) -> None:
    """Map a push answer to success or an AdapterError (the table in the
    module docstring; 409 is handled by the caller)."""
    if 200 <= status < 300:
        return
    if status == 401:
        raise AdapterError(
            CODE_TOKEN_REJECTED, permanent=True, connection_status=STATUS_TOKEN_REJECTED,
        )
    if status == 403:
        raise AdapterError(
            CODE_PUSH_NOT_ALLOWED, permanent=True, connection_status=STATUS_PUSH_NOT_ALLOWED,
        )
    if status == 429:
        if _message(payload) == MONTHLY_LIMIT_MESSAGE:
            raise AdapterError(
                CODE_QUOTA, permanent=True, connection_status=STATUS_QUOTA_EXHAUSTED,
            )
        raise AdapterError(CODE_RATE_LIMITED)
    if status == 400:
        raise AdapterError(CODE_REJECTED, permanent=True)
    if status == 404:
        raise AdapterError(CODE_NOT_FOUND, permanent=True)
    if status >= 500:
        raise AdapterError(CODE_PROVIDER_5XX)
    raise AdapterError(CODE_PROVIDER_ERROR, permanent=True)


def _raise_for_api(status: int) -> None:
    """Map an owner-action call (info, webhook, quota) to success or an error."""
    if 200 <= status < 300:
        return
    if status == 401:
        raise AdapterError(
            CODE_TOKEN_REJECTED, permanent=True, connection_status=STATUS_TOKEN_REJECTED,
        )
    if status >= 500 or status == 429:
        raise AdapterError(CODE_PROVIDER_5XX if status >= 500 else CODE_RATE_LIMITED)
    raise AdapterError(CODE_PROVIDER_ERROR, permanent=True)
