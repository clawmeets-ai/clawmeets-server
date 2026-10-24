# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/email_mail.py
One SendGrid Inbound Parse POST (parsed mode) read into an :class:`InboundMail`
— or, through ``read_raw_mail``, one raw message (Mailgun's ``body-mime``),
read by the same rules except where noted there.

**Who sent it** (``from_address``): the ``From:`` header's addr-spec, through
``email_address.normalize_address``. Read from SendGrid's ``headers`` field
(the raw header block), so two ``From:`` headers can be seen. The display name
is never used for matching: ``From: "ceo@allowed.com" <x@attacker.com>`` is
``x@attacker.com``. A ``From:`` that is not exactly ONE address — two ``From:``
headers, an address list, a group, an empty or unparseable one — fails the
sender check (``from_ok`` False); the first address found, if any, is still
reported so the mail can be held under it in a Request.

**The SPF/DKIM gate** (``auth_verdict``): ``AUTH_PASS`` only when SendGrid's
own results show a pass that ALIGNS with the ``From:`` domain
(``email_address.aligned``: the same domain or a parent of it):

- DKIM: SendGrid's ``dkim`` field lists every signature —
  ``{@example.com : pass, @sendgrid.info : pass}``. Any aligned pass counts.
- SPF: SendGrid's ``SPF`` field is the result for the ENVELOPE sender
  (``envelope.from``), so it counts only when that domain aligns.

Everything else is ``AUTH_FAIL``. ``Authentication-Results`` and
``Received-SPF`` headers inside the mail are never read: the sender writes
those.

**Recipients** come from ``envelope.to`` (the SMTP RCPT TO list), never the
``To:`` header: a Bcc has no ``To:`` match, and a forged ``To:`` can name an
address the mail was never sent to.

**Automatic mail** (``automatic``, RFC 3834): ``Auto-Submitted`` other than
``no``; ``Precedence: bulk|junk|list|auto_reply``; ``X-Autoreply``,
``X-Autorespond``, or ``X-Auto-Response-Suppress`` naming All/OOF/AutoReply;
a ``List-Id`` or ``List-Unsubscribe`` header; an empty envelope sender (a
bounce); a ``From:`` local part of mailer-daemon, postmaster, noreply or
no-reply; ``Content-Type: multipart/report``. ``automatic_reason`` names
which kind of signal it was (``AUTO_*``, a fixed code with nothing the sender
wrote in it), so a dropped one can be counted and logged by kind.

**Text fields** are decoded with the charset SendGrid names for each in
``charsets`` (an unknown name → UTF-8), with replacement characters for bytes
that don't decode. The subject and display name are also decoded from RFC 2047
encoded words where SendGrid left them encoded.
"""
from __future__ import annotations

import codecs
import email.parser
import email.policy
import hashlib
import json
import re
from dataclasses import dataclass, field
from email.header import decode_header, make_header
from email.headerregistry import Address
from email.parser import HeaderParser
from typing import Optional

from . import access
from .email_address import aligned, id_list, normalize_address, normalize_domain, split_address
from .email_form import InboundForm
from .email_text import (
    EMPTY_MESSAGE,
    MAX_AGENT_TEXT_BYTES,
    TRUNCATED_MARKER,
    attachment_line,
    cap_text,
    new_text,
)

_DKIM_RE = re.compile(r"@([^\s:,{}@]+)\s*:\s*([A-Za-z]+)")
_AUTO_LOCAL_PARTS = {"mailer-daemon", "postmaster", "noreply", "no-reply"}
_PRECEDENCE_AUTOMATIC = {"bulk", "junk", "list", "auto_reply"}
_SUPPRESS_RE = re.compile(r"\b(all|oof|autoreply)\b", re.IGNORECASE)


# Why a mail counts as automatic (``InboundMail.automatic_reason``).
AUTO_SUBMITTED = "auto_submitted"       # Auto-Submitted other than "no"
AUTO_PRECEDENCE = "precedence"          # Precedence: bulk | junk | list | auto_reply
AUTO_REPLY_HEADER = "autoreply_header"  # X-Autoreply, X-Autorespond, X-Auto-Response-Suppress
AUTO_LIST = "mailing_list"              # List-Id or List-Unsubscribe
AUTO_BOUNCE = "bounce"                  # empty envelope sender
AUTO_SYSTEM_SENDER = "system_sender"    # mailer-daemon, postmaster, noreply, no-reply
AUTO_REPORT = "delivery_report"         # Content-Type: multipart/report


class MailUnreadable(Exception):
    """The POST lacks what every Inbound Parse POST carries (``envelope``,
    a ``From:``); a retry cannot fix it."""


@dataclass(frozen=True)
class InboundMail:
    #: The normalised ``From:`` address (the contact's ``user_key``); None
    #: when no address could be read at all.
    from_address: Optional[str]
    #: True only when ``From:`` is exactly one well-formed address.
    from_ok: bool
    display_name: str
    #: The envelope sender, normalised; "" for a bounce's empty ``<>``.
    envelope_from: str
    recipients: list[str]
    subject: str
    message_id: Optional[str]
    in_reply_to: list[str]
    references: list[str]
    date: str
    #: The new text plus one placeholder line per attachment, capped.
    text: str
    #: Why the mail is automatic (``AUTO_*``); None for a person's mail.
    automatic_reason: Optional[str]
    auth_verdict: str
    dkim_domains: list[str] = field(default_factory=list)

    @property
    def automatic(self) -> bool:
        return self.automatic_reason is not None


def _charsets(form: InboundForm) -> dict[str, str]:
    raw = form.fields.get("charsets")
    if not raw:
        return {}
    try:
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return {}
    return {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}


def _decode(form: InboundForm, name: str, charsets: dict[str, str]) -> Optional[str]:
    raw = form.fields.get(name)
    if raw is None:
        return None
    charset = charsets.get(name) or "utf-8"
    try:
        codecs.lookup(charset)
    except LookupError:
        charset = "utf-8"
    return raw.decode(charset, errors="replace")


def decode_words(text: str) -> str:
    """RFC 2047 encoded words decoded; plain text returned as is."""
    if "=?" not in text:
        return text
    try:
        return str(make_header(decode_header(text)))
    except Exception:  # noqa: BLE001 — a malformed encoded word stays as written
        return text


def _envelope(form: InboundForm) -> tuple[str, list[str]]:
    raw = form.fields.get("envelope")
    if raw is None:
        raise MailUnreadable()
    try:
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        raise MailUnreadable() from None
    if not isinstance(value, dict):
        raise MailUnreadable()
    sender = value.get("from")
    sender = sender.strip() if isinstance(sender, str) else ""
    if sender in ("", "<>"):
        envelope_from = ""
    else:
        envelope_from = normalize_address(sender.strip("<>")) or ""
    to = value.get("to")
    recipients: list[str] = []
    for item in to if isinstance(to, list) else []:
        if isinstance(item, str):
            address = normalize_address(item.strip().strip("<>"))
            if address is not None and address not in recipients:
                recipients.append(address)
    return envelope_from, recipients


def _from_header(headers, form_from: Optional[str]) -> tuple[Optional[str], bool, str]:
    """(first address found, exactly-one-address, display name)."""
    values = headers.get_all("from") if headers is not None else None
    if not values:
        if not form_from:
            return None, False, ""
        values = [form_from]
    addresses: list[Address] = []
    ok = len(values) == 1
    for value in values:
        try:
            parsed = email.policy.default.header_factory("from", str(value))
        except Exception:  # noqa: BLE001 — unparseable: not one address
            ok = False
            continue
        groups = getattr(parsed, "groups", ())
        if any(g.display_name is not None for g in groups) or getattr(parsed, "defects", None):
            ok = False
        addresses.extend(parsed.addresses)
    if len(addresses) != 1:
        ok = False
    first = None
    name = ""
    for address in addresses:
        normalised = normalize_address(address.addr_spec) if address.addr_spec else None
        if normalised is not None:
            first = normalised
            name = address.display_name or ""
            break
    if first is None:
        ok = False
    return first, ok, decode_words(name)


def _header(headers, name: str) -> str:
    if headers is None:
        return ""
    value = headers.get(name)
    return str(value) if value is not None else ""


def automatic_reason(headers, from_address: Optional[str], envelope_from: str) -> Optional[str]:
    """The first automatic-mail signal the mail carries, or None."""
    auto = _header(headers, "auto-submitted").strip().lower()
    if auto and auto.split(";")[0].strip() != "no":
        return AUTO_SUBMITTED
    if _header(headers, "precedence").strip().lower() in _PRECEDENCE_AUTOMATIC:
        return AUTO_PRECEDENCE
    if _header(headers, "x-autoreply").strip() or _header(headers, "x-autorespond").strip():
        return AUTO_REPLY_HEADER
    if _SUPPRESS_RE.search(_header(headers, "x-auto-response-suppress")):
        return AUTO_REPLY_HEADER
    if _header(headers, "list-id").strip() or _header(headers, "list-unsubscribe").strip():
        return AUTO_LIST
    if envelope_from == "":
        return AUTO_BOUNCE
    if from_address is not None and split_address(from_address)[0] in _AUTO_LOCAL_PARTS:
        return AUTO_SYSTEM_SENDER
    if _header(headers, "content-type").strip().lower().startswith("multipart/report"):
        return AUTO_REPORT
    return None


def dkim_passes(raw: str) -> list[str]:
    """Domains of the DKIM signatures SendGrid reports as passing."""
    domains: list[str] = []
    for domain, result in _DKIM_RE.findall(raw or ""):
        if result.lower() == "pass":
            normalised = normalize_domain(domain)
            if normalised is not None:
                domains.append(normalised)
    return domains


def verdict(from_address: Optional[str], from_ok: bool, *, dkim: str, spf: str,
            envelope_from: str) -> str:
    """``AUTH_PASS`` when an aligned DKIM or SPF pass vouches for the From:."""
    if not from_ok or from_address is None:
        return access.AUTH_FAIL
    from_domain = split_address(from_address)[1]
    if any(aligned(from_domain, d) for d in dkim_passes(dkim)):
        return access.AUTH_PASS
    if spf.strip().lower() == "pass" and envelope_from and aligned(
        from_domain, split_address(envelope_from)[1],
    ):
        return access.AUTH_PASS
    return access.AUTH_FAIL


def _attachment_lines(form: InboundForm, charsets: dict[str, str]) -> list[str]:
    info: dict = {}
    raw = form.fields.get("attachment-info")
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8", errors="replace"))
            info = parsed if isinstance(parsed, dict) else {}
        except ValueError:
            info = {}
    lines = []
    for part in form.files:
        meta = info.get(part.field) if isinstance(info.get(part.field), dict) else {}
        filename = meta.get("filename") if isinstance(meta.get("filename"), str) else part.filename
        ctype = meta.get("type") if isinstance(meta.get("type"), str) else part.content_type
        lines.append(attachment_line(decode_words(filename or ""), ctype or "", part.size))
    return lines


def read_mail(form: InboundForm) -> InboundMail:
    """Raises :class:`MailUnreadable` when ``envelope`` or ``From:`` is missing."""
    charsets = _charsets(form)
    envelope_from, recipients = _envelope(form)
    headers_text = _decode(form, "headers", {}) or ""
    headers = HeaderParser(policy=email.policy.compat32).parsestr(headers_text) if headers_text else None
    from_address, from_ok, display_name = _from_header(headers, _decode(form, "from", charsets))
    if from_address is None and not from_ok and not (
        (headers is not None and headers.get_all("from")) or form.fields.get("from")
    ):
        raise MailUnreadable()
    subject_raw = _decode(form, "subject", charsets)
    if subject_raw is None:
        subject_raw = _header(headers, "subject")
    subject = decode_words(subject_raw).strip()
    body = new_text(_decode(form, "text", charsets), _decode(form, "html", charsets))
    lines = _attachment_lines(form, charsets)
    text = cap_text("\n".join(([body] if body else []) + lines) or EMPTY_MESSAGE)
    if ("text" in form.truncated or "html" in form.truncated) and not text.endswith(TRUNCATED_MARKER):
        # The reader already cut the field: say so, as cap_text would have.
        room = MAX_AGENT_TEXT_BYTES - len(TRUNCATED_MARKER.encode("utf-8"))
        text = cap_text(text, room).removesuffix(TRUNCATED_MARKER) + TRUNCATED_MARKER
    message_ids = id_list(_header(headers, "message-id"))
    return InboundMail(
        from_address=from_address,
        from_ok=from_ok,
        display_name=display_name,
        envelope_from=envelope_from,
        recipients=recipients,
        subject=subject,
        message_id=message_ids[0] if message_ids else None,
        in_reply_to=id_list(_header(headers, "in-reply-to")),
        references=id_list(_header(headers, "references")),
        date=_header(headers, "date"),
        text=text,
        automatic_reason=automatic_reason(headers, from_address, envelope_from),
        auth_verdict=verdict(
            from_address, from_ok,
            dkim=(form.fields.get("dkim") or b"").decode("utf-8", errors="replace"),
            spf=(form.fields.get("SPF") or b"").decode("utf-8", errors="replace"),
            envelope_from=envelope_from,
        ),
        dkim_domains=dkim_passes((form.fields.get("dkim") or b"").decode("utf-8", errors="replace")),
    )


def event_id(mail: InboundMail, user_key: str) -> str:
    """The dedupe key: the sender plus the Message-ID, hashed — never the bare
    Message-ID (a forger could pre-empt a real one), never a fresh uuid
    (SendGrid's retries would duplicate). Without a Message-ID: the sender,
    Date, Subject and text."""
    if mail.message_id:
        material = f"mid\0{user_key}\0{mail.message_id}"
    else:
        material = f"nomid\0{user_key}\0{mail.date}\0{mail.subject}\0{mail.text}"
    return "em-" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def thread_key(user_key: str, root: str) -> str:
    """A new thread's conversation key: its first mail's id, scoped to the
    sender, so two senders can never share one (a forger who reuses a real
    Message-ID as their own starts their own thread)."""
    return "et-" + hashlib.sha256(f"{user_key}\0{root}".encode("utf-8")).hexdigest()[:40]


def read_raw_mail(
    raw: bytes, *, envelope_from: str, recipients: list[str], dkim_domains: list[str],
    truncated: bool = False,
) -> InboundMail:
    """One raw RFC 5322 message (Mailgun's ``body-mime``) read the same way as
    a parsed-mode POST. The envelope comes from the caller (the provider's SMTP
    transcript, never the ``To:`` header) and so do the domains whose DKIM
    signatures verified: the verdict is an aligned DKIM pass and nothing else —
    no SPF result is trusted, because no provider here reports it for the
    envelope domain alone. Raises :class:`MailUnreadable` without a ``From:``."""
    headers = email.parser.BytesParser(policy=email.policy.compat32).parsebytes(
        raw, headersonly=True,
    )
    from_address, from_ok, display_name = _from_header(headers, None)
    if from_address is None and not headers.get_all("from"):
        raise MailUnreadable()
    subject = decode_words(_header(headers, "subject")).strip()
    plain, html, lines = _mime_parts(raw)
    body = new_text(plain, html)
    text = cap_text("\n".join(([body] if body else []) + lines) or EMPTY_MESSAGE)
    if truncated and not text.endswith(TRUNCATED_MARKER):
        room = MAX_AGENT_TEXT_BYTES - len(TRUNCATED_MARKER.encode("utf-8"))
        text = cap_text(text, room).removesuffix(TRUNCATED_MARKER) + TRUNCATED_MARKER
    message_ids = id_list(_header(headers, "message-id"))
    verified = from_ok and from_address is not None and any(
        aligned(split_address(from_address)[1], d) for d in dkim_domains
    )
    return InboundMail(
        from_address=from_address,
        from_ok=from_ok,
        display_name=display_name,
        envelope_from=envelope_from,
        recipients=recipients,
        subject=subject,
        message_id=message_ids[0] if message_ids else None,
        in_reply_to=id_list(_header(headers, "in-reply-to")),
        references=id_list(_header(headers, "references")),
        date=_header(headers, "date"),
        text=text,
        automatic_reason=automatic_reason(headers, from_address, envelope_from),
        auth_verdict=access.AUTH_PASS if verified else access.AUTH_FAIL,
        dkim_domains=list(dkim_domains),
    )


def _mime_parts(raw: bytes) -> tuple[Optional[str], Optional[str], list[str]]:
    """(text/plain body, text/html body, one placeholder line per attachment).
    A part that will not decode is skipped, never fatal: the sender's other
    parts still arrive."""
    try:
        message = email.parser.BytesParser(policy=email.policy.default).parsebytes(raw)
    except Exception:  # noqa: BLE001 — a broken body still has its headers
        return None, None, []
    texts: dict[str, Optional[str]] = {}
    for kind in ("plain", "html"):
        try:
            part = message.get_body(preferencelist=(kind,))
            texts[kind] = part.get_content() if part is not None else None
        except Exception:  # noqa: BLE001 — undecodable part
            texts[kind] = None
    lines = []
    try:
        attachments = list(message.iter_attachments())
    except Exception:  # noqa: BLE001 — not multipart, or broken framing
        attachments = []
    for part in attachments:
        try:
            size = len(part.get_payload(decode=True) or b"")
        except Exception:  # noqa: BLE001
            size = 0
        lines.append(attachment_line(
            decode_words(part.get_filename() or ""), part.get_content_type() or "", size,
        ))
    return texts.get("plain"), texts.get("html"), lines
