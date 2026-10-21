# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/email_adapter.py
The email adapter: SendGrid Inbound Parse in, SendGrid's mail send API out.

**One URL for the whole server.** Inbound Parse is set up once, by hand
(go-live runbook step 6), to post every mail for ``CLAWMEETS_INBOUND_EMAIL_DOMAIN``
to ``/api/channels/webhooks/email``. The connection is chosen by recipient
(``gateway.handle_email``); this adapter never registers anything with SendGrid
and never touches DNS.

**Webhook authenticity: HTTP basic auth** with the server's
``SENDGRID_INBOUND_SECRET`` — the URL SendGrid is given is
``https://sendgrid:<secret>@<host>/api/channels/webhooks/email``, and SendGrid
sends the userinfo as an ``Authorization: Basic`` header (``check_basic_auth``).
The secret is in a header, which nothing logs, not in the path. It is checked
before a byte of the body is read. Inbound Parse has no signature of its own
in the mode we use; SendGrid's ECDSA-signed variant is a follow-up.

**Addresses.** An agent's address is ``<owner username>.<agent short name>``
at the inbound domain, lowercased (``address_for``). Usernames and agent names
are filesystem names (letters, digits, ``-``, ``_``; usernames have no ``-``)
and neither holds a ``.``, so the dot is unambiguous; the address is stored as
the connection's ``external_id`` (unique across all accounts) and routing is an
exact lookup of it, never a split.

**Credentials.** None per connection: every email connection sends with the
server's ``SENDGRID_API_KEY`` (``shared_credential``), so the connection
stores no ciphertext and a ``CLAWMEETS_CHANNEL_SECRET_KEY`` rotation cannot
affect it; a 401 from SendGrid marks EVERY email connection ``token_rejected``.

**Outbound** (``send``): ``POST https://api.sendgrid.com/v3/mail/send`` with
the server key; one request per reply, built from the conversation's stored
state (``ChannelStore.email_state``):

- ``from``: the agent's address and short name; ``personalizations[0].to``:
  exactly the contact's ``From:`` address — never Reply-To, never CC/Bcc;
- ``subject``: ``Re: <latest inbound subject>`` (``reply_subject``);
- ``content``: text/plain then text/html (``email_format.render``);
- ``headers``: ``In-Reply-To`` (the latest inbound Message-ID), ``References``
  (the stored chain, at most 20 ids, the root first), ``Message-ID`` (derived
  from the row's retry key, so every attempt carries the same id) and
  ``Auto-Submitted`` (``auto-replied`` on the fixed reply, ``auto-generated`` on
  agent replies — both stop well-behaved auto-responders; none on the owner's
  own takeover messages, which a person wrote);
- click, open and subscription tracking off: links are not rewritten and no
  pixel or footer is added to a reply to a stranger.

    202                        sent (SendGrid ACCEPTED it; delivery is not known)
    400                        permanent rejected_by_provider
    401                        permanent token_rejected (+ every email connection)
    403                        permanent sender_not_authorized (+ connection status)
    413                        permanent format_error
    429                        retried, no sooner than Retry-After / X-RateLimit-Reset
    5xx, timeout, network      retried (the gateway's backoff and 24 h expiry)

**SendGrid's own words** (``provider_detail``): on any non-2xx answer the
``errors[].message`` fields are joined, every address and anything shaped like
an API key replaced, control characters folded and the result cut to 300
characters, and carried as ``AdapterError.detail`` — so the owner sees "The
from address does not match a verified Sender Identity", not just
``sender_not_authorized``. Only ``message`` is read (``field`` and ``help``
are not), and the text is stored for the owner, never logged. Every ``httpx``
exception becomes an :class:`AdapterError` raised ``from None``.

**Loop guard.** ``max_agent_replies_per_hour`` (10): an auto-responder that sets
none of the RFC 3834 headers still can't hold the agent in a mail loop.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
import logging
import re
import time
import unicodedata
from typing import Any, Mapping, Optional, Sequence

import httpx
from pydantic import SecretStr

from . import access
from .adapter import AdapterError, HealthReport, InboundEvent
from .email_address import normalize_local, outbound_message_id, split_address
from .email_format import check_size, render
from .log_redaction import REDACTED, install_secret_scrubbing, scrub
from .store import KIND_FIXED_REPLY, ChannelConnection

logger = logging.getLogger(__name__)
install_secret_scrubbing(__name__)

API_BASE = "https://api.sendgrid.com"
BASIC_AUTH_USER = b"sendgrid"
MAX_SUBJECT_CHARS = 250
MAX_AGENT_REPLIES_PER_HOUR = 10
NO_SUBJECT = "(no subject)"
MAX_DETAIL_CHARS = 300
ADDRESS_REDACTED = "<address>"

CODE_REJECTED = "rejected_by_provider"
CODE_TOKEN_REJECTED = "token_rejected"
CODE_SENDER_NOT_AUTHORIZED = "sender_not_authorized"
CODE_FORMAT_ERROR = "format_error"
CODE_RATE_LIMITED = "rate_limited"
CODE_PROVIDER_5XX = "provider_5xx"
CODE_PROVIDER_ERROR = "provider_error"
CODE_TIMEOUT = "timeout"
CODE_NETWORK = "network_error"
CODE_NO_STATE = "no_thread_state"

_RE_PREFIX = re.compile(r"^\s*re\s*(\[\d+\])?\s*:\s*", re.IGNORECASE)
#: Anything with an ``@`` between two non-space runs: an address, however mangled.
_ADDRESS_RE = re.compile(r"[^\s<>()\[\],;:\"']*@[^\s<>()\[\],;:\"']+")


def check_basic_auth(header: Optional[str], secret: str) -> bool:
    """``Authorization: Basic base64("sendgrid:" + secret)``, compared as
    bytes in constant time. Anything malformed is simply False."""
    if not header or not secret:
        return False
    scheme, _, value = header.partition(" ")
    if scheme != "Basic" or not value.strip():
        return False
    try:
        decoded = base64.b64decode(value.strip().encode("ascii"), validate=True)
    except (UnicodeError, binascii.Error, ValueError):
        return False
    return hmac.compare_digest(decoded, BASIC_AUTH_USER + b":" + secret.encode("utf-8"))


def clean_header(text: str, *, fold: bool = True) -> str:
    """CR, LF, NUL and every other control (C0, C1) or line/paragraph
    separator removed — folded into a space when ``fold``."""
    out = []
    for ch in text:
        category = unicodedata.category(ch)
        if category in ("Cc", "Zl", "Zp") or ch in "  ":
            if fold:
                out.append(" ")
            continue
        out.append(ch)
    return " ".join("".join(out).split())


def reply_subject(subject: str) -> str:
    """One ``Re: `` prefix (an existing ``RE:``, ``re:``, ``Re :``, ``Re[2]:``
    counts, however many); localised prefixes (``AW:``, ``SV:``, ``回复:``)
    are kept with ``Re: `` in front; empty → ``Re: (no subject)``; cut to 250
    characters."""
    text = clean_header(subject)
    while True:
        stripped = _RE_PREFIX.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped
    text = text.strip() or NO_SUBJECT
    return ("Re: " + text)[:MAX_SUBJECT_CHARS].rstrip()


def provider_detail(content: bytes, api_key: str = "") -> Optional[str]:
    """SendGrid's ``errors[].message`` texts from an error answer, safe to show
    the owner: joined with "; ", addresses → ``<address>``, the key and
    key-shaped strings → ``<redacted>``, control characters folded, at most
    ``MAX_DETAIL_CHARS``. None when the body holds no message."""
    try:
        errors = json.loads(content).get("errors")
    except (ValueError, AttributeError):
        return None
    if not isinstance(errors, list):
        return None
    messages = [
        e["message"] for e in errors
        if isinstance(e, dict) and isinstance(e.get("message"), str) and e["message"].strip()
    ]
    if not messages:
        return None
    text = "; ".join(messages)
    if api_key:
        text = text.replace(api_key, REDACTED)
    text = clean_header(_ADDRESS_RE.sub(ADDRESS_REDACTED, scrub(text)))
    if len(text) > MAX_DETAIL_CHARS:
        text = text[:MAX_DETAIL_CHARS - 1].rstrip() + "…"
    return text or None


def address_for(owner_username: str, agent_short_name: str, domain: str) -> Optional[str]:
    """The agent's inbound address, or None when its name can't be a local part."""
    local = normalize_local(f"{owner_username}.{agent_short_name}")
    if local is None or not re.fullmatch(r"[a-z0-9_.-]+", local):
        return None
    return f"{local}@{domain}"


class EmailAdapter:
    channel = "email"
    allowlist_kinds = (access.EMAIL, access.DOMAIN)
    #: Only an aligned SPF/DKIM pass verifies an email sender.
    provider_authenticates_sender = False
    #: One URL for the server (``/webhooks/email``), not one per connection.
    server_webhook = True
    #: Sends with the server's own key: health applies to every connection.
    shared_credential = True
    max_agent_replies_per_hour = MAX_AGENT_REPLIES_PER_HOUR

    def __init__(
        self, *, transport: Optional[httpx.AsyncBaseTransport] = None,
        api_base: str = API_BASE, timeout: float = 30.0, connect_timeout: float = 10.0,
        clock=None,
    ) -> None:
        self._transport = transport
        self._api_base = api_base.rstrip("/")
        self._timeout = httpx.Timeout(timeout, connect=connect_timeout)
        self._deadline = timeout + connect_timeout
        self._clock = clock or time.time
        self._store = None
        self._api_key = SecretStr("")
        self.domain = ""

    def bind(self, *, store, config) -> None:
        """Called by the gateway: the store (thread state) and the server's
        SendGrid key and inbound domain."""
        self._store = store
        self._api_key = SecretStr(config.sendgrid_api_key)
        self.domain = config.inbound_email_domain

    def address_for(self, owner_username: str, agent_short_name: str, domain: str) -> Optional[str]:
        return address_for(owner_username, agent_short_name, domain)

    # ── the generic webhook route never serves email ─────────────────────

    def verify(self, connection, secret, headers: Mapping[str, str], body: bytes, *,
               webhook_keys: Sequence[str] = ()) -> Optional[int]:
        return None

    def parse(self, body: bytes) -> list[InboundEvent]:
        return []

    # ── outbound ─────────────────────────────────────────────────────────

    def format_parts(self, text: str) -> list[str]:
        """The whole reply as one part (email has no practical length limit);
        over 1 MB of markdown raises, which the gateway records as
        ``format_error``."""
        if not text.strip():
            return []
        check_size(text)
        return [text]

    def message_body(
        self, connection: ChannelConnection, *, conversation_key: str, text: str,
        retry_key: str,
    ) -> dict[str, Any]:
        state = self._store.email_state(connection.id, conversation_key) if self._store else None
        if state is None:
            raise AdapterError(CODE_NO_STATE, permanent=True)
        row = self._store.outbox_row_by_retry_key(retry_key)
        fixed_reply = row is not None and row.kind == KIND_FIXED_REPLY
        # The owner's own message (a takeover) is written by a person: unmarked.
        automatic = fixed_reply or row is None or bool(row.from_agent)
        plain, html = render(text)
        local, domain = split_address(state.agent_address)
        name = clean_header(local.split(".", 1)[-1].replace("_", " ").replace("-", " "))
        headers = {"Message-ID": outbound_message_id(retry_key, domain)}
        if state.last_message_id:
            headers["In-Reply-To"] = state.last_message_id
            headers["References"] = " ".join(state.references or [state.last_message_id])
        if automatic:
            headers["Auto-Submitted"] = "auto-replied" if fixed_reply else "auto-generated"
        return {
            "personalizations": [{"to": [{"email": state.user_key}]}],
            "from": {"email": state.agent_address, "name": name},
            "subject": reply_subject(state.subject),
            "content": [
                {"type": "text/plain", "value": plain},
                {"type": "text/html", "value": html},
            ],
            "headers": headers,
            "tracking_settings": {
                "click_tracking": {"enable": False, "enable_text": False},
                "open_tracking": {"enable": False},
                "subscription_tracking": {"enable": False},
            },
        }

    async def send(
        self, connection: ChannelConnection, secret: SecretStr, *,
        conversation_key: str, text: str, retry_key: str,
    ) -> None:
        body = self.message_body(
            connection, conversation_key=conversation_key, text=text, retry_key=retry_key,
        )
        response = await self._call("POST", "/v3/mail/send", body)
        status = response.status_code
        if status in (200, 202):
            return
        detail = provider_detail(response.content, self._api_key.get_secret_value())
        if status == 400:
            raise AdapterError(CODE_REJECTED, permanent=True, detail=detail)
        if status == 401:
            raise AdapterError(CODE_TOKEN_REJECTED, permanent=True,
                               connection_status=CODE_TOKEN_REJECTED, detail=detail)
        if status == 403:
            raise AdapterError(CODE_SENDER_NOT_AUTHORIZED, permanent=True,
                               connection_status=CODE_SENDER_NOT_AUTHORIZED, detail=detail)
        if status == 413:
            raise AdapterError(CODE_FORMAT_ERROR, permanent=True, detail=detail)
        if status == 429:
            raise AdapterError(CODE_RATE_LIMITED, retry_after=self._retry_after(response),
                               detail=detail)
        if status >= 500:
            raise AdapterError(CODE_PROVIDER_5XX, detail=detail)
        raise AdapterError(CODE_PROVIDER_ERROR, permanent=status in (404, 405), detail=detail)

    def _retry_after(self, response: httpx.Response) -> Optional[float]:
        raw = response.headers.get("retry-after")
        if raw and raw.strip().isdigit():
            return float(raw.strip())
        reset = response.headers.get("x-ratelimit-reset")
        if reset and reset.strip().isdigit():
            return max(0.0, float(reset.strip()) - self._clock())
        return None

    # ── health (the owner's Test) ────────────────────────────────────────

    async def health(
        self, connection: ChannelConnection, secret: SecretStr, *, url: str,
    ) -> HealthReport:
        """``GET /v3/scopes`` with the server key: never sends a mail."""
        response = await self._call("GET", "/v3/scopes", None)
        if response.status_code == 401:
            return HealthReport(CODE_TOKEN_REJECTED)
        if response.status_code == 403:
            return HealthReport(CODE_SENDER_NOT_AUTHORIZED)
        if response.status_code != 200:
            raise AdapterError(
                CODE_PROVIDER_5XX if response.status_code >= 500 else CODE_PROVIDER_ERROR,
            )
        try:
            scopes = json.loads(response.content).get("scopes")
        except (ValueError, AttributeError):
            raise AdapterError(CODE_PROVIDER_ERROR) from None
        if not isinstance(scopes, list) or "mail.send" not in scopes:
            return HealthReport(CODE_SENDER_NOT_AUTHORIZED)
        return HealthReport("working")

    # ── HTTP ─────────────────────────────────────────────────────────────

    async def _call(self, method: str, path: str, body: Optional[dict]) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self._api_key.get_secret_value()}"}
        try:
            async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
                request = client.request(
                    method, f"{self._api_base}{path}", headers=headers,
                    **({"json": body} if body is not None else {}),
                )
                response = await asyncio.wait_for(request, timeout=self._deadline)
                await response.aread()
        except (httpx.TimeoutException, asyncio.TimeoutError):
            raise AdapterError(CODE_TIMEOUT) from None
        except httpx.HTTPError:
            raise AdapterError(CODE_NETWORK) from None
        return response
