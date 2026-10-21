# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/telegram.py
The Telegram adapter: a bot's webhook in, ``sendMessage`` out.

**Credentials.** The connection stores the bot token (encrypted, like every
channel credential). The webhook secret Telegram echoes back in
``X-Telegram-Bot-Api-Secret-Token`` is NOT stored: it is
``HMAC-SHA256(key, "telegram-webhook-secret:" + connection_id)`` in hex, under
a server secret key (``CLAWMEETS_CHANNEL_SECRET_KEY``). ``setWebhook`` always
uses the first (current) key; a webhook call is accepted under any configured
key, so the documented rotation (put a new key first) does not cut Telegram
off. A call accepted only under an older key tells the gateway to show
"reconnect to finish key rotation". The label keeps the key from being used
raw for a second purpose. The token cannot be the webhook secret: Telegram
allows only ``A-Z a-z 0-9 _ -`` there, and the token holds ``:``.

**Inbound mapping** (``parse``), from the Bot API ``Update`` object:

    event_id          str(update_id)       — never message_id (repeats across chats)
    conversation_key  str(message.chat.id)
    user_key          str(message.from.id) — never the username, never chat.id
    handle            message.from.username (no "@"; None when absent)
    display_name      first_name + " " + last_name (raw; the gateway cleans it)
    text              message.text, or a placeholder line (below)
    auth_verdict      AUTH_PROVIDER        — Telegram authenticates the sender

Only private chats with a human sender are read. Ignored (no event, 200):
edited messages, channel posts, groups and supergroups, bots, a message with no
sender, empty text, membership changes, callback and inline queries, and any
update or message type not listed here. Non-text messages become one
placeholder line so the agent and the owner see something arrived:

    sticker → "[sticker 👍]"   voice → "[voice message]"   video note → "[video message]"
    location / venue → "[location]"   contact → "[contact]"   poll → "[poll]"
    dice → "[dice 🎲]"
    photo, document, video, audio, animation (GIF) → "[photo]" … plus the caption

A placeholder from an unknown sender opens a Request exactly as text would.

**Outbound** (``send``). One part per call — the gateway splits the reply into
parts (``format_parts``, HTML parse mode) and each part is its own outbox row.
``POST /bot<token>/sendMessage`` with ``{"chat_id", "text", "parse_mode":
"HTML", "link_preview_options": {"is_disabled": true}}``. Telegram has no
idempotency key, so a restart between Telegram's 200 and the row being marked
sent can send a part twice (the accepted cost of at-least-once delivery).

    200 ok:true                      sent
    200 ok:false / unreadable body   retryable (not treated as sent)
    400 "can't parse entities"       retried ONCE as plain text (tags stripped,
                                     entities decoded, no parse_mode); if that
                                     fails too → permanent format_error
    400 "chat not found"             permanent chat_not_found
    400 anything else                permanent bad_request
    401                              permanent token_rejected (+ connection status)
    403 (blocked, deactivated)       permanent blocked_by_user — never retried
    429                              retryable, no sooner than retry_after
    5xx, timeout, network error      retryable

Telegram's ``description`` is read only to tell those 400s apart; it is never
logged or stored, because it can echo user input.

**Secrets never in logs.** The token is in every request URL, and ``httpx``
logs request URLs at INFO. ``install_secret_scrubbing`` attaches the scrubbing
filter to the ``httpx``/``httpcore`` loggers and this module's logger, and no
``httpx`` exception escapes this module: each becomes an :class:`AdapterError`
raised ``from None``, so the URL is neither in its text nor in its traceback.

**The bot is not an allowlist entry** (``refuse_entry``). The connection's
``account_name`` is ``@<bot username>`` from ``getMe`` and its
``external_id`` the bot's numeric id; an entry equal to either (username
compared case-insensitively, with or without ``@``) is refused with a sentence
saying so — the bot never writes to itself, so such an entry admits no one and
the owner's own messages would go to Requests.

**No network at boot.** ``setWebhook`` / ``deleteWebhook`` run only from an
owner's action (connect, enable, reconnect, disable, remove).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
from typing import Any, Mapping, Optional, Sequence

import httpx
from pydantic import SecretStr

from . import access
from .adapter import AccountInfo, AdapterError, HealthReport, InboundEvent
from .log_redaction import install_secret_scrubbing
from .store import ChannelConnection
from .telegram_format import format_parts, strip_tags

logger = logging.getLogger(__name__)
install_secret_scrubbing(__name__)

API_BASE = "https://api.telegram.org"
SECRET_HEADER = "x-telegram-bot-api-secret-token"
WEBHOOK_SECRET_LABEL = b"telegram-webhook-secret:"
TOKEN_RE = re.compile(r"^\d+:[A-Za-z0-9_-]{30,}$")
BOT_USERNAME_ENTRY_ERROR = (
    "That's your bot's username. Enter the Telegram @username or numeric id of "
    "the person you want to allow."
)
BOT_ID_ENTRY_ERROR = (
    "That's your bot's id. Enter the Telegram @username or numeric id of "
    "the person you want to allow."
)
#: The update types section "Inbound mapping" reads; Telegram sends nothing else.
ALLOWED_UPDATES = ["message"]
#: A webhook error Telegram reports counts for this long (``getWebhookInfo``
#: keeps ``last_error_date`` after deliveries recover).
WEBHOOK_ERROR_WINDOW_SECONDS = 3600

# Fixed codes (stored on rows, logged; never Telegram's own text).
CODE_TOKEN_REJECTED = "token_rejected"
CODE_BLOCKED = "blocked_by_user"
CODE_CHAT_NOT_FOUND = "chat_not_found"
CODE_BAD_REQUEST = "bad_request"
CODE_FORMAT_ERROR = "format_error"
CODE_RATE_LIMITED = "rate_limited"
CODE_PROVIDER_5XX = "provider_5xx"
CODE_NOT_OK = "provider_not_ok"
CODE_BAD_RESPONSE = "bad_response"
CODE_TIMEOUT = "timeout"
CODE_NETWORK = "network_error"
CODE_PROVIDER_ERROR = "provider_error"

_PLACEHOLDERS = (
    ("sticker", lambda m: f"[sticker {m['sticker'].get('emoji')}]" if isinstance(m["sticker"], dict) and m["sticker"].get("emoji") else "[sticker]"),
    ("voice", lambda m: "[voice message]"),
    ("video_note", lambda m: "[video message]"),
    ("venue", lambda m: "[location]"),
    ("location", lambda m: "[location]"),
    ("contact", lambda m: "[contact]"),
    ("poll", lambda m: "[poll]"),
    ("dice", lambda m: f"[dice {m['dice'].get('emoji')}]" if isinstance(m["dice"], dict) and m["dice"].get("emoji") else "[dice]"),
)
#: Media that may carry a caption. ``animation`` first: a GIF message also has
#: a ``document`` field.
_CAPTIONED = (
    ("animation", "[GIF]"),
    ("photo", "[photo]"),
    ("video", "[video]"),
    ("audio", "[audio]"),
    ("document", "[document]"),
)


def webhook_secret(key: str, connection_id: str) -> str:
    """The secret Telegram is given for this connection, under ``key``."""
    return hmac.new(
        key.encode("utf-8"), WEBHOOK_SECRET_LABEL + connection_id.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def bot_id(token: str) -> str:
    """The bot's id: the token's part before ``:``. A re-issued token for the
    same bot keeps it."""
    return token.split(":", 1)[0]


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    value = headers.get(name)
    if value is not None:
        return value
    for key, item in headers.items():  # a plain dict with other casing
        if key.lower() == name:
            return item
    return None


def _message_text(message: dict) -> Optional[str]:
    text = message.get("text")
    if isinstance(text, str):
        return text if text.strip() else None
    for field, render in _PLACEHOLDERS:
        if field in message:
            return render(message)
    for field, label in _CAPTIONED:
        if field in message:
            caption = message.get("caption")
            if isinstance(caption, str) and caption.strip():
                return f"{label} {caption}"
            return label
    return None


class TelegramAdapter:
    channel = "telegram"
    allowlist_kinds = (access.USER_ID, access.USERNAME)
    provider_authenticates_sender = True

    def __init__(
        self, *, transport: Optional[httpx.AsyncBaseTransport] = None,
        api_base: str = API_BASE, timeout: float = 30.0, connect_timeout: float = 10.0,
        clock=None,
    ) -> None:
        self._transport = transport
        self._api_base = api_base.rstrip("/")
        self._timeout = httpx.Timeout(timeout, connect=connect_timeout)
        # An overall deadline too: a transport that ignores httpx's timeouts
        # must not hold the outbox worker forever.
        self._deadline = timeout + connect_timeout
        self._clock = clock or time.time

    # ── inbound ──────────────────────────────────────────────────────────

    def verify(
        self, connection: ChannelConnection, secret: SecretStr,
        headers: Mapping[str, str], body: bytes, *, webhook_keys: Sequence[str],
    ) -> Optional[int]:
        presented = _header(headers, SECRET_HEADER)
        if not presented:
            return None
        given = presented.encode("utf-8")
        matched: Optional[int] = None
        # Every key, without stopping at a match.
        for index, key in enumerate(webhook_keys):
            expected = webhook_secret(key, connection.id).encode("utf-8")
            if hmac.compare_digest(expected, given) and matched is None:
                matched = index
        return matched

    def parse(self, body: bytes) -> list[InboundEvent]:
        update = json.loads(body)
        if not isinstance(update, dict) or not isinstance(update.get("update_id"), int):
            raise ValueError("not a Telegram update")
        message = update.get("message")
        if not isinstance(message, dict):
            return []  # edited_message, channel_post, my_chat_member, callback_query, …
        chat = message.get("chat")
        sender = message.get("from")
        if not isinstance(chat, dict) or chat.get("type") != "private" or "id" not in chat:
            return []
        if not isinstance(sender, dict) or "id" not in sender or sender.get("is_bot"):
            return []
        text = _message_text(message)
        if text is None:
            return []
        name = " ".join(
            str(part) for part in (sender.get("first_name"), sender.get("last_name")) if part
        )
        username = sender.get("username")
        return [InboundEvent(
            event_id=str(update["update_id"]),
            conversation_key=str(chat["id"]),
            user_key=str(sender["id"]),
            display_name=name,
            text=text,
            handle=username if isinstance(username, str) and username else None,
            auth_verdict=access.AUTH_PROVIDER,
        )]

    # ── outbound ─────────────────────────────────────────────────────────

    def format_parts(self, text: str) -> list[str]:
        return format_parts(text)

    async def send(
        self, connection: ChannelConnection, secret: SecretStr, *,
        conversation_key: str, text: str, retry_key: str,
    ) -> None:
        body = {
            "chat_id": conversation_key,
            "text": text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
        }
        status, payload = await self._call(secret, "sendMessage", body)
        if status == 400 and "can't parse entities" in _description(payload).lower():
            logger.warning(
                "Telegram send for connection %s: telegram_format_fallback (sent as plain text)",
                connection.id[:8],
            )
            plain = {"chat_id": conversation_key, "text": strip_tags(text),
                     "link_preview_options": {"is_disabled": True}}
            status, payload = await self._call(secret, "sendMessage", plain)
            if not _ok(status, payload):
                raise AdapterError(CODE_FORMAT_ERROR, permanent=True)
            return
        _raise_for(status, payload)

    # ── connection management (owner actions only) ───────────────────────

    def refuse_entry(self, connection: ChannelConnection, raw: str) -> Optional[str]:
        """Why ``raw`` can't be an allowlist entry on this connection, or None.
        Only the bot's own username or id is refused here; the shape is
        checked by ``access.parse_entry``."""
        text = (raw or "").strip()
        bot_username = connection.account_name.removeprefix("@")
        if bot_username and text.removeprefix("@").casefold() == bot_username.casefold():
            return BOT_USERNAME_ENTRY_ERROR
        if connection.external_id and text == connection.external_id:
            return BOT_ID_ENTRY_ERROR
        return None

    def check_credential(self, secret: SecretStr) -> Optional[str]:
        if not TOKEN_RE.match(secret.get_secret_value()):
            return "That doesn't look like a bot token (it should look like 123456:ABC…)"
        return None

    def account_id(self, secret: SecretStr) -> str:
        return bot_id(secret.get_secret_value())

    async def account(self, secret: SecretStr) -> AccountInfo:
        status, payload = await self._call(secret, "getMe", None)
        _raise_for(status, payload)
        result = payload.get("result") if isinstance(payload, dict) else None
        username = result.get("username") if isinstance(result, dict) else None
        return AccountInfo(
            external_id=bot_id(secret.get_secret_value()),
            account_name=f"@{username}" if isinstance(username, str) and username else "",
        )

    async def register_webhook(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str, webhook_key: str,
    ) -> None:
        if not url.startswith("https://"):
            raise AdapterError("webhook_not_https", permanent=True)
        status, payload = await self._call(secret, "setWebhook", {
            "url": url,
            "secret_token": webhook_secret(webhook_key, connection.id),
            "allowed_updates": ALLOWED_UPDATES,
            "drop_pending_updates": True,
        })
        _raise_for(status, payload)

    async def unregister_webhook(self, connection: ChannelConnection, secret: SecretStr) -> None:
        status, payload = await self._call(secret, "deleteWebhook", {"drop_pending_updates": False})
        _raise_for(status, payload)

    async def health(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str,
    ) -> HealthReport:
        status, payload = await self._call(secret, "getMe", None)
        if status == 401:
            return HealthReport("token_rejected")
        _raise_for(status, payload)
        status, payload = await self._call(secret, "getWebhookInfo", None)
        if status == 401:
            return HealthReport("token_rejected")
        _raise_for(status, payload)
        info = payload.get("result") if isinstance(payload, dict) else None
        if not isinstance(info, dict) or info.get("url") != url:
            return HealthReport("webhook_missing")
        error_date = info.get("last_error_date")
        if isinstance(error_date, (int, float)) and error_date >= self._clock() - WEBHOOK_ERROR_WINDOW_SECONDS:
            message = info.get("last_error_message")
            return HealthReport(
                "webhook_error", detail=message if isinstance(message, str) else None,
                count=int(error_date),
            )
        pending = info.get("pending_update_count")
        if isinstance(pending, int) and pending > 0:
            return HealthReport("pending_updates", count=pending)
        return HealthReport("working")

    # ── HTTP ─────────────────────────────────────────────────────────────

    async def _call(
        self, secret: SecretStr, method: str, body: Optional[dict],
    ) -> tuple[int, Any]:
        """One Bot API call → (HTTP status, decoded JSON or None). Every httpx
        failure becomes an AdapterError raised ``from None``."""
        url = f"{self._api_base}/bot{secret.get_secret_value()}/{method}"
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
                request = client.post(url, json=body) if body is not None else client.post(url)
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


def _ok(status: int, payload: Any) -> bool:
    return status == 200 and isinstance(payload, dict) and payload.get("ok") is True


def _description(payload: Any) -> str:
    if isinstance(payload, dict) and isinstance(payload.get("description"), str):
        return payload["description"]
    return ""


def _raise_for(status: int, payload: Any) -> None:
    """Map a Bot API answer to success or an AdapterError (see the table in
    the module docstring)."""
    if _ok(status, payload):
        return
    if status == 200:
        raise AdapterError(CODE_NOT_OK if isinstance(payload, dict) else CODE_BAD_RESPONSE)
    if status == 401:
        raise AdapterError(CODE_TOKEN_REJECTED, permanent=True, connection_status="token_rejected")
    if status == 403:
        raise AdapterError(CODE_BLOCKED, permanent=True)
    if status == 429:
        retry_after = None
        params = payload.get("parameters") if isinstance(payload, dict) else None
        if isinstance(params, dict) and isinstance(params.get("retry_after"), (int, float)):
            retry_after = float(params["retry_after"])
        raise AdapterError(CODE_RATE_LIMITED, retry_after=retry_after)
    if status == 400:
        if "chat not found" in _description(payload).lower():
            raise AdapterError(CODE_CHAT_NOT_FOUND, permanent=True)
        raise AdapterError(CODE_BAD_REQUEST, permanent=True)
    if status >= 500:
        raise AdapterError(CODE_PROVIDER_5XX)
    raise AdapterError(CODE_PROVIDER_ERROR, permanent=status in (404, 409))
