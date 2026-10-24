# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/email_mailgun.py
The email channel on Mailgun (``CLAWMEETS_EMAIL_PROVIDER=mailgun``): what
differs from SendGrid, kept out of the adapter so each provider reads alone.

**Inbound** arrives from ONE Mailgun route, set up by hand, whose action is
``forward("https://<host>/api/channels/webhooks/email/mailgun/mime")`` — a URL
ending in ``mime`` makes Mailgun post the untouched message as ``body-mime``
(``MAILGUN_FIELD_LIMITS``) beside its SMTP envelope: ``recipient`` (RCPT TO,
comma-separated when several) and ``sender`` (MAIL FROM, empty for a bounce).

**Webhook authenticity** (``check_signature``): every POST carries
``timestamp``, ``token`` and ``signature`` = HMAC-SHA256 of
``timestamp + token`` under ``MAILGUN_WEBHOOK_SIGNING_KEY``, compared in
constant time. A timestamp more than ``MAX_SIGNATURE_AGE_S`` from our clock is
refused, so a captured POST stops working; one replayed inside the window is a
duplicate of the mail it carries (``email_mail.event_id``) and changes nothing.
The fields are in the body, so unlike SendGrid's header the body is read
(under the same 40 MiB cap) before the check.

**Sender verification** (``dkim_pass_domains``): Mailgun reports one DKIM
pass/fail for the whole message and does not say WHICH domain signed, so it
cannot tell "signed by the sender's own domain" from "signed by some relay".
We verify each ``DKIM-Signature`` ourselves (dkimpy, at most
``MAX_DKIM_SIGNATURES``, each required to cover ``From``) and hand the
passing ``d=`` domains to ``email_mail.read_raw_mail``, which accepts only one
aligned with the ``From:`` domain. SPF is not consulted: mail with only an SPF
pass reaches the owner as unverified, like any other unverified mail. The DNS
lookups run in a worker thread under ``DKIM_TIMEOUT_S``; a timeout is no pass.

**Outbound** (``reply_form``): ``POST /v3/<agent domain>/messages`` with
HTTP basic auth ``api:<MAILGUN_AGENTS_API_KEY>`` and the same message the
SendGrid path builds — the headers ride as ``h:`` fields and tracking is off
on every message (``o:tracking*``), whatever the dashboard says. Mailgun's
answer maps onto the adapter's codes the way SendGrid's does (``classify``);
its error text is ``{"message": ...}``, shown to the owner through
``email_adapter.safe_detail``.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
from email.utils import formataddr
from typing import Callable, Optional

from .email_address import normalize_address
from .email_form import MAX_EMAIL_BODY_BYTES, SMALL_FIELD_BYTES, InboundForm
from .email_mail import InboundMail, read_raw_mail

logger = logging.getLogger(__name__)

API_BASE = "https://api.mailgun.net"
MAX_SIGNATURE_AGE_S = 15 * 60
MAX_DKIM_SIGNATURES = 5
DKIM_TIMEOUT_S = 15.0
WEBHOOK_PATH = "/email/mailgun/mime"

#: The fields of a ``forward(".../mime")`` POST that are read; the rest are
#: thrown away. ``body-mime`` may be the whole 40 MiB: DKIM covers the body.
MAILGUN_FIELD_LIMITS = {
    "body-mime": MAX_EMAIL_BODY_BYTES,
    "recipient": SMALL_FIELD_BYTES,
    "sender": SMALL_FIELD_BYTES,
    "timestamp": SMALL_FIELD_BYTES,
    "token": SMALL_FIELD_BYTES,
    "signature": SMALL_FIELD_BYTES,
}


def _field(form: InboundForm, name: str) -> str:
    return (form.fields.get(name) or b"").decode("utf-8", errors="replace").strip()


def check_signature(form: InboundForm, signing_key: str, *, now: float) -> bool:
    """The POST's own ``timestamp``/``token``/``signature``, under the key and
    inside the age window. Anything missing or malformed is simply False."""
    timestamp, token, signature = (_field(form, n) for n in ("timestamp", "token", "signature"))
    if not (signing_key and timestamp.isdigit() and token and signature):
        return False
    if abs(now - int(timestamp)) > MAX_SIGNATURE_AGE_S:
        return False
    expected = hmac.new(
        signing_key.encode("utf-8"), (timestamp + token).encode("utf-8"), hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected.encode("ascii"), signature.lower().encode("utf-8"))


def dkim_pass_domains(raw: bytes, *, dnsfunc: Optional[Callable] = None) -> list[str]:
    """The ``d=`` domains of the signatures that verify AND sign ``From``,
    lowercased. Blocking (DNS): call through :func:`read_mailgun_mail`."""
    import dkim

    try:
        verifier = dkim.DKIM(raw)
    except Exception:  # noqa: BLE001 — a message dkimpy cannot even parse
        return []
    count = sum(1 for name, _ in verifier.headers if name.lower() == b"dkim-signature")
    domains: list[str] = []
    for idx in range(min(count, MAX_DKIM_SIGNATURES)):
        try:
            ok = (verifier.verify(idx=idx, dnsfunc=dnsfunc) if dnsfunc is not None
                  else verifier.verify(idx=idx))
        except Exception:  # noqa: BLE001 — a bad signature, key or DNS answer is no pass
            continue
        if ok and b"from" in (verifier.include_headers or ()) and verifier.domain:
            domain = verifier.domain.decode("ascii", errors="replace").lower().rstrip(".")
            if domain not in domains:
                domains.append(domain)
    return domains


def envelope(form: InboundForm) -> tuple[str, list[str]]:
    """(MAIL FROM, RCPT TO list), normalised; MAIL FROM is "" for a bounce."""
    sender = _field(form, "sender").strip("<>")
    envelope_from = normalize_address(sender) or "" if sender else ""
    recipients: list[str] = []
    for item in _field(form, "recipient").split(","):
        address = normalize_address(item.strip().strip("<>")) if item.strip() else None
        if address is not None and address not in recipients:
            recipients.append(address)
    return envelope_from, recipients


async def read_mailgun_mail(
    form: InboundForm, *, dnsfunc: Optional[Callable] = None, timeout: float = DKIM_TIMEOUT_S,
) -> InboundMail:
    """A verified POST read into an :class:`InboundMail`. Raises
    ``email_mail.MailUnreadable`` without ``body-mime`` or a ``From:``."""
    from .email_mail import MailUnreadable

    raw = form.fields.get("body-mime")
    if not raw:
        raise MailUnreadable()
    envelope_from, recipients = envelope(form)
    try:
        domains = await asyncio.wait_for(
            asyncio.to_thread(dkim_pass_domains, raw, dnsfunc=dnsfunc), timeout=timeout,
        )
    except asyncio.TimeoutError:
        logger.warning("Channel email: DKIM check timed out; the mail counts as unverified")
        domains = []
    return read_raw_mail(
        raw, envelope_from=envelope_from, recipients=recipients, dkim_domains=domains,
        truncated="body-mime" in form.truncated,
    )


def reply_form(*, to: str, from_email: str, from_name: str, subject: str, plain: str,
               html: str, headers: dict[str, str]) -> list[tuple[str, str]]:
    """The ``messages`` POST for one reply, as form fields (a list: ``h:`` and
    ``o:`` names may not collide, but order is kept for the tests)."""
    fields = [
        ("from", formataddr((from_name, from_email)) if from_name else from_email),
        ("to", to),
        ("subject", subject),
        ("text", plain),
        ("html", html),
    ]
    fields += [(f"h:{name}", value) for name, value in headers.items()]
    fields += [("o:tracking", "no"), ("o:tracking-clicks", "no"), ("o:tracking-opens", "no")]
    return fields
