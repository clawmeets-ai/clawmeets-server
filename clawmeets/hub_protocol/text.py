# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/text.py

Cleaning text that came from another deployment: names, usernames,
descriptions, capabilities and reply text.

``strip_invisible`` removes every code point that can reorder or hide text:
Bidi_Control, Default_Ignorable_Code_Point and the control characters (Cc).
The set is a pinned table taken from Unicode 15.1, not Python's
``unicodedata`` (3.11 ships Unicode 14.0, 3.13 ships 15.1), so every Python
version and the frontend's ``safeRemoteText`` remove exactly the same code
points. ``invisible_ranges_json()`` is the frontend's parity source.

Lengths are counted in code points, as Python's ``len``. The frontend must
count the same way (``Array.from(s).length``, not ``s.length``, which counts
UTF-16 units).

Models never call these on parse: rewriting a string would change signed
bytes. Senders clean before signing; receivers clean again at ingestion,
after verification.
"""
from __future__ import annotations

import re
from enum import IntEnum

UNICODE_VERSION: str = "15.1.0"

# Bidi_Control (PropList.txt) | Default_Ignorable_Code_Point
# (DerivedCoreProperties.txt) | General_Category=Cc, merged and sorted.
# tests/hub_protocol/test_text.py re-derives it from the checked-in UCD lines.
INVISIBLE_RANGES: tuple[tuple[int, int], ...] = (
    (0x0000, 0x001F), (0x007F, 0x009F), (0x00AD, 0x00AD), (0x034F, 0x034F),
    (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F),
    (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
    (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF),
)

# TAB, LF, VT, FF, CR and NEL become one space before stripping, so words on
# two lines do not run together.
_WHITESPACE_CONTROLS = re.compile("[\t\n\x0b\x0c\r\x85]")
_INVISIBLE = re.compile(
    "[" + "".join(f"\\U{lo:08x}-\\U{hi:08x}" for lo, hi in INVISIBLE_RANGES) + "]"
)
_SPACES = re.compile(" {2,}")


class TextField(IntEnum):
    """Length cap per kind of remote text, in code points."""

    NAME = 80
    USERNAME = 40
    DESCRIPTION = 500
    CAPABILITY = 32


# Remove every code point in INVISIBLE_RANGES, after first mapping
# TAB/LF/VT/FF/CR/NEL to a space. Idempotent; never raises; "" for "".
def strip_invisible(text: str) -> str:
    if not isinstance(text, str):
        return ""
    return _INVISIBLE.sub("", _WHITESPACE_CONTROLS.sub(" ", text))


# strip_invisible, collapse runs of spaces, trim, then cut to `field` code points.
def clean_remote_text(text: str, field: TextField) -> str:
    cleaned = _SPACES.sub(" ", strip_invisible(text)).strip(" ")
    return cleaned[: int(field)].rstrip(" ")


# The table as JSON-ready [[lo, hi], ...]: the frontend's safeRemoteText parity source.
def invisible_ranges_json() -> list[list[int]]:
    return [[lo, hi] for lo, hi in INVISIBLE_RANGES]
