# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/log_redaction.py
Keep channel secrets out of the server log.

Two filters live here.

**Bot tokens, SendGrid keys and webhook secrets** (``SecretScrubFilter``). Telegram puts the
bot token in the request URL (``https://api.telegram.org/bot<id>:<secret>/…``)
and ``httpx`` logs every request URL at INFO; ``httpcore`` traces at DEBUG.
A logging filter only runs for records logged on the logger it is attached to
— not for records that propagate up to it from a child — so the filter is
attached by name to ``httpx``, ``httpcore`` and each ``httpcore.*`` logger, and
to the adapter's own logger (``install_secret_scrubbing``), never only to the
root or ``uvicorn.access``. LINE user ids (``U`` + 32 hex) are scrubbed by the
same filter: not a secret, but personal, and LINE's profile call carries one in
its URL (``/v2/bot/profile/<userId>``). It rewrites the formatted message and the formatted
traceback. The adapter also never lets an ``httpx`` exception (whose text holds
the URL) escape: it raises its own, ``from None``.

**Webhook query strings** (``WebhookQueryRedactionFilter``). uvicorn logs
every request as ``"<METHOD> <path>?<query> HTTP/1.1" <status>`` on the
``uvicorn.access`` logger. Some providers carry a secret in the query string of
a webhook call (Meta's subscription check sends ``hub.verify_token=...``), so
for any webhook path the query string is replaced with ``?<redacted>`` before
the record is formatted. The path itself carries the connection id, never a
secret.

"Webhook path" is matched loosely on purpose: nginx normalises the path to pick
its (unlogged) webhook location but forwards the RAW path, so uvicorn sees
variants like ``/api//channels/webhooks/...`` or
``/api/channels/../channels/webhooks/...``. Any path that contains
``/channels/webhooks`` — as sent, after collapsing repeated slashes, or after
resolving ``.``/``..`` segments, case-insensitively — is redacted. Headers are never logged by
uvicorn, so header-borne secrets (Telegram's secret-token header, LINE and
Meta signatures) need nothing here.

nginx is the other log on the request path; its webhook location runs with
``access_log off`` (deploy/nginx/clawmeets.ai.conf).
"""
from __future__ import annotations

import logging
import posixpath
import re

WEBHOOK_PATH_PREFIX = "/api/channels/webhooks"
WEBHOOK_PATH_MARKER = "/channels/webhooks"
ACCESS_LOGGER_NAME = "uvicorn.access"
_PATH_ARG_INDEX = 2  # uvicorn: (client_addr, method, full_path, http_version, status)


def is_webhook_path(path: str) -> bool:
    """True if ``path`` (query string excluded) is, or normalises to, a webhook path."""
    collapsed = re.sub(r"/+", "/", path.lower())
    return WEBHOOK_PATH_MARKER in collapsed or WEBHOOK_PATH_MARKER in posixpath.normpath(collapsed)


class WebhookQueryRedactionFilter(logging.Filter):
    """Rewrite ``full_path`` on webhook access-log records; never drops a record."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) > _PATH_ARG_INDEX:
            path = args[_PATH_ARG_INDEX]
            if isinstance(path, str) and "?" in path:
                bare = path.split("?", 1)[0]
                if is_webhook_path(bare):
                    redacted = bare + "?<redacted>"
                    record.args = args[:_PATH_ARG_INDEX] + (redacted,) + args[_PATH_ARG_INDEX + 1:]
        return True


#: ``bot<id>:<secret>`` (in a URL) or a bare ``<id>:<secret>`` token.
_BOT_TOKEN_RE = re.compile(r"(?:bot)?\d{3,}:[A-Za-z0-9_-]{20,}")
#: A SendGrid API key: ``SG.<id>.<secret>``.
_SENDGRID_KEY_RE = re.compile(r"SG\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{6,})?")
#: A derived webhook secret: 64 hex characters (HMAC-SHA256).
_HEX_SECRET_RE = re.compile(r"(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])")
#: A LINE user id: ``U`` + 32 lowercase hex.
_LINE_USER_ID_RE = re.compile(r"(?<![0-9A-Za-z])U[0-9a-f]{32}(?![0-9a-fA-F])")
REDACTED = "<redacted>"

#: Loggers the filter is attached to. ``httpcore`` logs on its submodules'
#: own loggers, so each is named.
SCRUBBED_LOGGERS = (
    "httpx",
    "httpcore",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
    "httpcore.socks",
)


def scrub(text: str) -> str:
    text = _SENDGRID_KEY_RE.sub(REDACTED, text)
    text = _LINE_USER_ID_RE.sub(REDACTED, text)
    return _HEX_SECRET_RE.sub(REDACTED, _BOT_TOKEN_RE.sub(REDACTED, text))


class SecretScrubFilter(logging.Filter):
    """Replace bot tokens and derived webhook secrets in a record's message
    and traceback text; never drops a record."""

    _formatter = logging.Formatter()

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 — a malformed record still gets logged
            message = str(record.msg)
        record.msg = scrub(message)
        record.args = None
        if record.exc_info:
            record.exc_text = scrub(self._formatter.formatException(record.exc_info))
            # The handler would format the traceback again from exc_info.
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = scrub(record.exc_text)
        if record.stack_info:
            record.stack_info = scrub(record.stack_info)
        return True


def install_secret_scrubbing(*extra_loggers: str) -> None:
    """Attach the scrubbing filter to the HTTP client loggers and ``extra_loggers``
    (idempotent)."""
    for name in (*SCRUBBED_LOGGERS, *extra_loggers):
        target = logging.getLogger(name)
        if not any(isinstance(f, SecretScrubFilter) for f in target.filters):
            target.addFilter(SecretScrubFilter())


def install_webhook_log_redaction() -> None:
    """Attach the filter to ``uvicorn.access`` once (idempotent)."""
    access_logger = logging.getLogger(ACCESS_LOGGER_NAME)
    if not any(isinstance(f, WebhookQueryRedactionFilter) for f in access_logger.filters):
        access_logger.addFilter(WebhookQueryRedactionFilter())
