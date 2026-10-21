# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/access.py
Who may reach the agent over a channel: allowlist entries and the rules that
compare them with a sender. Pure functions — the transactions that apply them
are in store.py, the orchestration (Requests, Allow, Block) in gateway.py.

**Order of precedence**, judged per message when it arrives:
    a block on the sender  >  an allowlist entry  >  the connection's mode.

**Entries.** What an owner types is classified by its shape, among the kinds
the connection's adapter accepts (``ChannelAdapter.allowlist_kinds``), and
stored normalised:

    user_id   the provider's stable sender id (Telegram's numeric ``from.id``,
              LINE's user id) — compared exactly with ``InboundEvent.user_key``
    username  ``@alice`` (Telegram). Case-insensitive. Starts UNPINNED; the
              first verified sender whose handle matches pins it to their
              ``user_key`` (compare-and-set, in the transaction that admits
              them), and from then on it matches that ``user_key`` only —
              whatever they rename to, and never whoever takes the handle next
    phone     a WhatsApp number, compared as E.164 digits with the ``wa_id``
    email     ``bob@example.com``; compared in ``email_address``'s one canonical
              form (domain as its IDNA A-label, local part lowercased)
    domain    ``*@example.com`` (or ``*@bücher.de``); exact domain, subdomains
              do NOT match

The display name a contact chose is never used for matching.

**Sender verification** (the hook the email SPF/DKIM gate plugs into): an entry
admits a sender only when :func:`sender_verified` is true for the message, and
an ``email`` / ``domain`` entry only on an explicit ``pass``. The same rule
decides whether a waiting sender gets the fixed reply, so a forged ``From:``
never makes us send mail to the address it forged.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .email_address import normalize_address, normalize_domain, split_address

USER_ID = "user_id"
USERNAME = "username"
PHONE = "phone"
EMAIL = "email"
DOMAIN = "domain"
ALL_KINDS = (USER_ID, USERNAME, PHONE, EMAIL, DOMAIN)
#: Kinds whose match needs an explicit ``pass`` verdict, whatever the adapter says.
VERDICT_PASS_KINDS = (EMAIL, DOMAIN)

# InboundEvent.auth_verdict values.
AUTH_PASS = "pass"          # the adapter checked the sender (email: SPF/DKIM aligned)
AUTH_FAIL = "fail"          # the adapter checked, and the check failed
AUTH_PROVIDER = "provider"  # the provider itself authenticated the sender (Telegram, LINE, WhatsApp)

MODE_ALLOWLIST = "allowlist"
MODE_ANYONE = "anyone"
MODES = (MODE_ALLOWLIST, MODE_ANYONE)
#: Returned with the connection while its mode is "anyone": strangers reach an
#: agent that has its full tools. A fixed code so the page can key off it.
WARNING_ANYONE = "strangers_reach_full_tools"

_USER_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_PHONE_RE = re.compile(r"^\+?[0-9 ().-]+$")
#: ``(0)`` — a trunk prefix written in brackets, as in ``+44 (0)20 …``.
_TRUNK_ZERO_RE = re.compile(r"\(\s*0\s*\)")
PHONE_PREFIX_ERROR = "include the country code, e.g. +1 415 555 0100"


class EntryError(ValueError):
    """An allowlist entry the owner typed is not valid for this channel."""


@dataclass(frozen=True)
class ParsedEntry:
    kind: str
    value: str  # normalised: what the matcher compares


def normalize_phone(raw: str) -> Optional[str]:
    """E.164 digits without the ``+`` (WhatsApp's ``wa_id`` form), or None.

    ``+1 415 555 0100``, ``14155550100`` and ``0014155550100`` all give
    ``14155550100``. A trunk zero written in brackets after the country code
    is not dialled internationally, so it is dropped: ``+44 (0)20 7946 0018``
    gives ``442079460018``, the ``wa_id`` WhatsApp sends. Letters, or a digit
    count outside E.164's 7..15, give None.
    """
    text = raw.strip()
    if not _PHONE_RE.match(text):
        return None
    if has_country_prefix(text):
        text = _TRUNK_ZERO_RE.sub("", text)
    digits = re.sub(r"[^0-9]", "", text)
    if not text.startswith("+") and digits.startswith("00"):
        digits = digits[2:]
    if not 7 <= len(digits) <= 15:
        return None
    return digits


def has_country_prefix(text: str) -> bool:
    """Whether a typed number starts with ``+`` or the international ``00``,
    so its first digits are a country code rather than a national number."""
    text = text.strip()
    return text.startswith("+") or re.sub(r"[^0-9]", "", text).startswith("00")


def normalize_handle(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    handle = raw.strip().lstrip("@").casefold()
    return handle or None


def parse_entry(
    raw: str, kinds: tuple[str, ...], *,
    user_id_pattern: Optional[re.Pattern] = None, user_id_error: str = "not a valid user id",
    phone_prefix_required: bool = False,
) -> ParsedEntry:
    """Classify and normalise what the owner typed. Raises :class:`EntryError`.

    ``user_id_pattern``: the channel's own shape for a ``user_id`` entry
    (LINE's ``U`` + 32 hex), so a typo is refused rather than stored as an
    entry that can never match. ``phone_prefix_required`` (WhatsApp): a
    number typed without ``+`` or ``00`` is refused — ``415 555 0100`` would
    be stored as ``4155550100`` and never match the ``wa_id`` ``14155550100``."""
    text = (raw or "").strip()
    if not text:
        raise EntryError("empty entry")
    if text.startswith("*"):
        domain = normalize_domain(text[2:]) if text.startswith("*@") else None
        if domain is None:
            raise EntryError("a domain entry is written *@example.com")
        return _allowed(ParsedEntry(DOMAIN, domain), kinds)
    if text.startswith("@"):
        handle = text[1:]
        if not _USERNAME_RE.match(handle):
            raise EntryError("a username is @ followed by letters, digits or _")
        return _allowed(ParsedEntry(USERNAME, handle.casefold()), kinds)
    if "@" in text:
        address = normalize_address(text)
        if address is None:
            raise EntryError("not a valid email address")
        return _allowed(ParsedEntry(EMAIL, address), kinds)
    if PHONE in kinds:
        phone = normalize_phone(text)
        if phone is None:
            raise EntryError("a phone number has 7 to 15 digits and no letters")
        if phone_prefix_required and not has_country_prefix(text):
            raise EntryError(PHONE_PREFIX_ERROR)
        return ParsedEntry(PHONE, phone)
    if USER_ID in kinds:
        if not (user_id_pattern or _USER_ID_RE).match(text):
            raise EntryError(user_id_error if user_id_pattern else "not a valid user id")
        return ParsedEntry(USER_ID, text)
    raise EntryError("this channel does not take that kind of entry")


def _allowed(entry: ParsedEntry, kinds: tuple[str, ...]) -> ParsedEntry:
    if entry.kind not in kinds:
        raise EntryError(f"this channel does not take {entry.kind} entries")
    return entry


def sender_verified(verdict: Optional[str], provider_authenticates_sender: bool) -> bool:
    """Whether a message may be admitted by an entry, or answered with the
    fixed reply. A missing verdict counts as a failed one."""
    if verdict == AUTH_PASS:
        return True
    return verdict == AUTH_PROVIDER and provider_authenticates_sender


def entry_matches(kind: str, value: str, *, user_key: str, verdict: Optional[str]) -> bool:
    """The non-username kinds (a username entry is matched by its pin, in the
    store, because pinning writes). The caller has already checked
    :func:`sender_verified`."""
    if kind == USER_ID:
        return value == user_key
    if kind == PHONE:
        return value == normalize_phone(user_key)
    if kind in VERDICT_PASS_KINDS and verdict != AUTH_PASS:
        return False
    if kind in VERDICT_PASS_KINDS:
        address = normalize_address(user_key)
        if address is None:
            return False
        if kind == EMAIL:
            return value == address
        return split_address(address)[1] == value
    return False
