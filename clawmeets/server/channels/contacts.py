# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/contacts.py
Cleaning what an outside contact chose to call themselves.

A contact's display name is provider-supplied text that ends up in the agent's
prompt, the reflection transcript and the owner's sidebar. It is cleaned once,
on arrival, and the cleaned value is the only one ever stored or written into
``from_participant_name``:

1. NFC-normalise, so look-alike compositions compare and render the same;
2. drop Unicode categories Cc (control: newlines, ESC sequences), Cf (format:
   bidi overrides such as U+202E, zero-width joiners) and Zl/Zp (line and
   paragraph separators) — the characters that can fake a ``From:`` line,
   reorder the text around them, or hide inside an otherwise ordinary name;
   (whitespace-like ones — newline, tab, U+2028 — become a space first, so
   the words they separated stay apart);
3. collapse runs of whitespace and trim;
4. cap the length in code points;
5. fall back to a fixed label when nothing is left.
"""
from __future__ import annotations

import unicodedata

MAX_DISPLAY_NAME_CHARS = 64
FALLBACK_DISPLAY_NAME = "Contact"
_DROPPED_CATEGORIES = {"Cc", "Cf", "Zl", "Zp"}


def clean_display_name(raw: str | None) -> str:
    text = unicodedata.normalize("NFC", raw or "")
    # Whitespace-like controls (newline, tab, U+2028) separate words: keep the
    # separation as a space, then drop every other control/format character.
    spaced = "".join(" " if ch.isspace() else ch for ch in text)
    kept = "".join(ch for ch in spaced if unicodedata.category(ch) not in _DROPPED_CATEGORIES)
    collapsed = " ".join(kept.split())
    capped = collapsed[:MAX_DISPLAY_NAME_CHARS].strip()
    return capped or FALLBACK_DISPLAY_NAME
