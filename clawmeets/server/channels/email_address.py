# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/email_address.py
One notion of "the same address", shared by the allowlist entry, the sender's
``user_key`` and the routing lookup, so the three can never drift apart.

**Addresses.** ``normalize_address`` splits on the LAST ``@``:

- domain: IDNA 2008 to its A-label (``bücher.de`` → ``xn--bcher-kva.de``),
  lowercase, no trailing dot. A domain the IDNA codec refuses (a bad label, a
  mixed-script confusable IDNA 2008 forbids) makes the whole address invalid.
- local part: NFC, then ``lower()`` — NOT ``casefold()``, which maps ``ß`` to
  ``ss`` and would make ``straße@x`` and ``strasse@x`` one sender. Control
  characters, whitespace, ``@`` and more than 64 characters make it invalid.

**Message-IDs.** ``normalize_message_id`` keeps the id between its angle
brackets, drops surrounding whitespace, lowercases the domain part (the left
part is case-sensitive by RFC 5322) and refuses anything with whitespace or a
control character inside, or longer than 998 characters. ``id_list`` reads an
``In-Reply-To`` / ``References`` value and also drops an id with a non-ASCII
character (an SMTPUTF8 sender's ``<ü1@x>``): every id it keeps can go back out
in our ``In-Reply-To`` / ``References`` headers, which must stay ASCII.

**Alignment** (``aligned``): an authenticated domain vouches for a ``From:``
domain only when it is the same domain or a PARENT of it. A sibling or a child
never aligns. No Public Suffix List: ``d=com`` would align with everything
under ``.com``, so a bare TLD is refused outright.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Optional

import idna

MAX_LOCAL_CHARS = 64
MAX_MESSAGE_ID_CHARS = 998
_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_BAD_LOCAL_CHARS = re.compile(r"[\s@<>()\[\]\\,;:\"]")
_ID_RE = re.compile(r"<([^<>]*)>")


def normalize_domain(raw: str) -> Optional[str]:
    """A domain as its lowercase A-label without a trailing dot, or None."""
    text = unicodedata.normalize("NFC", (raw or "").strip()).rstrip(".")
    if not text or len(text) > 253:
        return None
    try:
        ascii_domain = (
            text.lower() if text.isascii()
            else idna.encode(text, uts46=True, transitional=False).decode("ascii")
        )
    except (idna.IDNAError, UnicodeError, ValueError):
        return None
    ascii_domain = ascii_domain.lower()
    labels = ascii_domain.split(".")
    if len(labels) < 2 or not all(_LABEL_RE.match(label) for label in labels):
        return None
    if labels[-1].isdigit():
        return None  # an IP literal is not a mail domain we accept
    if any(label.startswith("xn--") for label in labels):
        try:
            idna.decode(ascii_domain)  # refuses A-labels that don't round-trip
        except (idna.IDNAError, UnicodeError, ValueError):
            return None
    return ascii_domain


def normalize_local(raw: str) -> Optional[str]:
    local = unicodedata.normalize("NFC", raw or "")
    if not local or len(local) > MAX_LOCAL_CHARS or _BAD_LOCAL_CHARS.search(local):
        return None
    if any(unicodedata.category(ch).startswith("C") for ch in local):
        return None
    return local.lower()


def normalize_address(raw: str) -> Optional[str]:
    """``local@domain`` in the one canonical form, or None if it isn't one."""
    local, at, domain = (raw or "").strip().rpartition("@")
    if not at:
        return None
    norm_local = normalize_local(local)
    norm_domain = normalize_domain(domain)
    if norm_local is None or norm_domain is None:
        return None
    return f"{norm_local}@{norm_domain}"


def split_address(address: str) -> tuple[str, str]:
    local, _, domain = address.rpartition("@")
    return local, domain


def without_plus_tag(address: str) -> str:
    """``alice.support+invoices@d`` → ``alice.support@d`` (the tag is ignored)."""
    local, domain = split_address(address)
    return f"{local.split('+', 1)[0]}@{domain}"


def aligned(from_domain: str, authenticated_domain: Optional[str]) -> bool:
    """Whether ``authenticated_domain`` vouches for ``from_domain`` (both
    normalised): equal, or a parent of it. Never a bare TLD."""
    if not authenticated_domain or "." not in authenticated_domain:
        return False
    return from_domain == authenticated_domain or from_domain.endswith("." + authenticated_domain)


def normalize_message_id(raw: str) -> Optional[str]:
    """``<left@right>`` with the right part lowercased, or None."""
    text = (raw or "").strip()
    if text.startswith("<") and text.endswith(">"):
        text = text[1:-1]
    if not text or len(text) > MAX_MESSAGE_ID_CHARS - 2:
        return None
    if any(ch.isspace() or unicodedata.category(ch).startswith("C") for ch in text):
        return None
    if "<" in text or ">" in text:
        return None
    left, at, right = text.rpartition("@")
    if at and left:
        text = f"{left}@{right.lower()}"
    return f"<{text}>"


def id_list(raw: Optional[str]) -> list[str]:
    """The Message-IDs in an ``In-Reply-To`` / ``References`` value, in order,
    normalised; an id with a space, a line break or a non-ASCII character
    inside is dropped."""
    if not raw:
        return []
    ids: list[str] = []
    for match in _ID_RE.finditer(raw):
        normalised = normalize_message_id(f"<{match.group(1)}>")
        if normalised is not None and normalised.isascii() and normalised not in ids:
            ids.append(normalised)
    return ids


def outbound_message_id(retry_key: str, domain: str) -> str:
    """Our own Message-ID for one outbox row: derived from its retry key, so
    every attempt (and a resend after a restart) carries the same id."""
    left = re.sub(r"[^A-Za-z0-9.-]", ".", retry_key).strip(".") or "reply"
    return f"<{left}@{domain}>"
