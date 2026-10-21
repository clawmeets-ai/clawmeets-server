# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/whatsapp_format.py
The agent's markdown as WhatsApp Cloud API text messages, split at 4096.

**Conversion** (``to_whatsapp``). A WhatsApp text message renders its own
small markup and nothing else: ``*bold*``, ``_italic_``, ``~strike~``,
```` ```monospace``` ```` (a fenced block), inline `` `code` ``, ``> quote``
lines and ``- `` / ``1. `` lists. It has no link labels, no headings, no
tables and NO escape character, so a marker the agent did not mean as markup
is simply left as written. Nothing is ever HTML-escaped: literal HTML
(``a < b && c > d``) is sent as written.

- ``**bold**`` / ``__bold__`` → ``*bold*``; ``*em*`` / ``_em_`` → ``_em_``;
  ``~~strike~~`` → ``~strike~``; ``***both***`` → ``*_both_*``. The pairs are
  matched exactly as ``line_format`` matches them (linear; same word guards):
  an opener must not follow a letter or digit and a closer must not precede
  one, so ``snake_case_name``, ``file_name_v2`` and ``2*3*4`` stay as written,
  and nothing pairs across word characters or inside a URL. Unbalanced
  markers (``**bold``) stay literal. ``\\*``-style escapes become the bare
  character (WhatsApp has no escape, so ``\\*x\\*`` reads ``*x*``).
- headings (``# H``, ``## H`` …) → ``*H*`` on its own line (bold inside a
  heading is not doubled).
- bullets ``-`` / ``*`` / ``+`` → ``- ``; numbered items keep ``1. ``; a nested
  item keeps its leading indentation.
- ``[label](url)`` → ``label (url)``; a link whose label is its URL → the URL
  once; a bare URL stays as it is, character for character (it runs to the
  next whitespace, ``*`` ``_`` ``~`` included, minus trailing markers, so
  ``https://x.com/a_b_c*d`` never pairs but ``**https://e.com**`` is bold).
  Only http, https,
  mailto and tel links are shown: any other scheme (``javascript:``,
  ``data:``) or a relative link keeps the label and drops the URL. An image
  ``![alt](url)`` reads ``alt (url)`` under the same rule.
- inline code → `` `code` `` as written; a fenced block → a block fenced with
  ```` ``` ```` on its own lines (the language tag dropped), its lines
  VERBATIM — no marker is converted inside code (``**x**`` stays ``**x**``). A
  block with no visible content is dropped.
- a table → one row per line, cells joined by `` | ``; the separator row is
  dropped. ``\\|`` inside a cell is a literal ``|``, not a cell boundary.
- ``> quote`` lines stay ``> text``.
- non-ASCII, RTL text and emoji (ZWJ sequences, flags, skin tones) are left
  untouched. NUL and the Unicode noncharacters U+FDD0–U+FDEF (used internally
  to mark spans) are removed from the input; every other character is kept.

**Splitting** (``split_text``, ``format_parts``). WhatsApp's limit is 4096
characters counted in UTF-16 code units (``utf16_len``: an astral emoji counts
2), and a part may never be empty or whitespace-only. A part ends at the last
paragraph break that fits, else the last line break, else the last space,
else (one word longer than the limit) at the last grapheme-cluster boundary
that fits — never inside a surrogate pair, a ZWJ emoji sequence, a flag, a
skin-tone modifier or a combining accent (``line_format._Splitter``). At a hard
cut a URL that started in the part moves whole to the next one, unless the URL
alone is longer than the limit. The whitespace at a cut is dropped.

Conversion records the SPANS of its output, so the splitter never leaves a
lone marker:

- an emphasis or inline-code span (``*x*``, ``_x_``, ``~x~``, `` `x` ``) that
  would cross the cut moves whole to the next part. A span longer than the
  limit is closed at the cut and reopened at the start of the next part, so
  each part is balanced on its own.
- a fenced block that fits in one part but would straddle a cut moves whole
  to the next part. A block longer than the limit is cut between its lines (at
  a space or a hard cut only if one line is itself too long), and EVERY part of
  it is re-fenced: an opening ```` ``` ```` line and a closing one in each,
  still within the limit including the fences.

Apart from the whitespace at the cuts and the markers and fences re-added
there, the parts, in order, are exactly the converted text. ``split_text``
splits text that is already WhatsApp text and knows no spans (the rules above
that need them apply through ``format_parts``).

**Cap** (``format_parts``). A reply is at most ``MAX_PARTS`` parts; when it
needs more, the last part ends with ``TRUNCATED_MARKER`` on its own line and
still fits the limit. An empty or whitespace-only reply is no parts. A
``limit`` below ``MIN_LIMIT`` (no room for fences and the marker) is a
``ValueError``; that is the only way either function raises.

Every pass is linear (the regexes are ``line_format``'s plus the bare-URL
pattern, none of which can backtrack catastrophically; the pairing, span scan
and span lookups are
linear or logarithmic), so pathological input — deep ``>>>>`` nesting,
100 000 ``*``, a 200 000-character word, 10 000 nested ``[`` — converts and
splits in bounded time, and no ``str`` input raises.
"""
from __future__ import annotations

import re
from bisect import bisect_left, bisect_right

from clawmeets.server.channels.line_format import (
    _BULLET_RE,
    _ESCAPE_RE,
    _FENCE_RE,
    _HEADING_RE,
    _IMAGE_RE,
    _LINK_RE,
    _NUMBERED_RE,
    _PLACEHOLDER_RE,
    _QUOTE_RE,
    _code_spans,
    _heading_text,
    _is_hr,
    _is_table_row,
    _is_table_sep,
    _is_word,
    _table_cells,
    _Splitter,
)
from clawmeets.server.channels.telegram_format import utf16_len

WHATSAPP_LIMIT = 4096      # UTF-16 code units per text message
MAX_PARTS = 10             # parts per reply
TRUNCATED_MARKER = "[reply truncated]"
SAFE_SCHEMES = ("http://", "https://", "mailto:", "tel:")
MIN_LIMIT = 32             # room for a re-fenced line and the truncation marker

# Span sentinels: noncharacters, removed from the input, so each one in the
# converted text is ours. Opener → (closer, the text each one becomes).
_BOLD, _BOLD_END = "\ufdd0", "\ufdd1"
_ITAL, _ITAL_END = "\ufdd2", "\ufdd3"
_STRIKE, _STRIKE_END = "\ufdd4", "\ufdd5"
_CODE, _CODE_END = "\ufdd6", "\ufdd7"
_FENCE, _FENCE_END = "\ufdd8", "\ufdd9"
_OPENERS = {_BOLD: "*", _ITAL: "_", _STRIKE: "~", _CODE: "`", _FENCE: "```\n"}
_CLOSERS = {_BOLD_END: (_BOLD, "*"), _ITAL_END: (_ITAL, "_"),
            _STRIKE_END: (_STRIKE, "~"), _CODE_END: (_CODE, "`"),
            _FENCE_END: (_FENCE, "\n```")}
_SENTINEL_RE = re.compile("[\ufdd0-\ufdd9]")
# A bare URL runs to the next whitespace, ``*`` ``_`` ``~`` included (WhatsApp
# has no escape, so a URL must come out byte-identical), minus trailing
# markers, so ``**https://e.com**`` still pairs. ``line_format``'s pattern stops
# at the first ``*``, which would let ``https://e.com/*y*`` pair inside the URL.
_BARE_URL_RE = re.compile(r"https?://\S*[^\s*_~]")
_DROP = {0: None, **{c: None for c in range(0xFDD0, 0xFDF0)}}


# ── conversion ───────────────────────────────────────────────────────────


def _pairs(s: str, marker: str, guard: str | None, single: bool) -> list[tuple[int, int]]:
    """The ``(opener, closer)`` offsets of the ``marker`` pairs in ``s``.

    The same pairs ``line_format._strip_pairs`` removes (which returns only the
    stripped text, so its matching is mirrored here to keep the positions):
    linear, each opener finding its closer by bisection. ``guard`` holds the
    extra characters (besides letters and digits) an opener may not follow and
    a closer may not precede (``None``: no word guard); ``single``: the text
    between may not contain the marker.
    """
    k = len(marker)
    n = len(s)
    cands: list[int] = []
    i = s.find(marker)
    while i >= 0:
        cands.append(i)
        i = s.find(marker, i + 1)
    if len(cands) < 2:
        return []

    def blocked(ch: str) -> bool:
        return guard is not None and ch != "" and (_is_word(ch) or ch in guard)

    def bad_inner(ch: str) -> bool:
        return ch == "" or ch.isspace() or (single and ch == marker)

    openers = [i for i in cands
               if not bad_inner(s[i + k] if i + k < n else "")
               and not blocked(s[i - 1] if i else "")]
    closer_list = [j for j in cands
                   if j and not bad_inner(s[j - 1])
                   and not blocked(s[j + k] if j + k < n else "")]
    closers = set(closer_list)
    out: list[tuple[int, int]] = []
    pos = 0
    for i in openers:
        if i < pos:
            continue
        if single:  # the closer is the very next marker
            nxt = bisect_right(cands, i)
            j = cands[nxt] if nxt < len(cands) else -1
            if j < 0 or j not in closers:
                continue
        else:
            at = bisect_left(closer_list, i + k + 1)
            if at == len(closer_list):
                continue
            j = closer_list[at]
        out.append((i, j))
        pos = j + k
    return out


def _wrap(s: str, marker: str, guard: str | None, single: bool,
          opener: str, closer: str) -> str:
    """``s`` with each ``marker`` pair replaced by span sentinels."""
    pairs = _pairs(s, marker, guard, single)
    if not pairs:
        return s
    k = len(marker)
    out: list[str] = []
    pos = 0
    for i, j in pairs:
        out += [s[pos:i], opener, s[i + k:j], closer]
        pos = j + k
    out.append(s[pos:])
    return "".join(out)


def _emphasis(s: str) -> str:
    """The emphasis passes of ``line_format._emphasis``, in the same order,
    turning each pair into sentinels instead of removing it. A converted pair
    leaves no marker behind, so a later pass never sees it."""
    s = _wrap(s, "**", "*", False, _BOLD, _BOLD_END)
    s = _wrap(s, "__", "", False, _BOLD, _BOLD_END)
    s = _wrap(s, "*", "*", True, _ITAL, _ITAL_END)
    s = _wrap(s, "_", "_", True, _ITAL, _ITAL_END)
    return _wrap(s, "~~", None, False, _STRIKE, _STRIKE_END)


def _safe(url: str) -> bool:
    return url.lower().startswith(SAFE_SCHEMES)


def _inline(text: str) -> str:
    """One line of markdown as WhatsApp text, with span sentinels."""
    stash: list[str] = []

    def keep(fragment: str) -> str:
        stash.append(fragment)
        return f"\x00{len(stash) - 1}\x00"

    def restore(s: str) -> str:
        while "\x00" in s:
            s = _PLACEHOLDER_RE.sub(lambda m: stash[int(m.group(1))], s)
        return s

    work = _code_spans(text, lambda code: keep(_CODE + code + _CODE_END))
    work = _ESCAPE_RE.sub(lambda m: keep(m.group(1)), work)

    def shown(label: str, url: str) -> str:
        url = url.strip()
        label = restore(_emphasis(label)).strip()
        plain = _SENTINEL_RE.sub("", label)
        if not _safe(url):
            return keep(label)
        if not plain or plain == url:
            return keep(url)
        return keep(f"{label} ({url})")

    work = _IMAGE_RE.sub(lambda m: shown(m.group(1), m.group(2)), work)
    work = _LINK_RE.sub(lambda m: shown(m.group(1), m.group(2)), work)
    work = _BARE_URL_RE.sub(lambda m: keep(m.group(0)), work)
    return restore(_emphasis(work))


def _heading(rest: str) -> str:
    text = _inline(_heading_text(rest)).replace(_BOLD, "").replace(_BOLD_END, "")
    return f"{_BOLD}{text}{_BOLD_END}" if text.strip() else ""


def _sentinel_text(markdown: str) -> str:
    """The converted text, spans still marked by sentinels."""
    lines = markdown.translate(_DROP).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        fence = _FENCE_RE.match(line)
        if fence and not (fence.group(1)[0] == "`" and "`" in fence.group(2)):
            mark = fence.group(1)
            body: list[str] = []
            i += 1
            while i < len(lines):
                s = lines[i].strip()
                if len(s) >= len(mark) and s == mark[0] * len(s):
                    break
                body.append(lines[i])
                i += 1
            i += 1  # the closing fence (or the end)
            code = "\n".join(body)
            out.append(f"{_FENCE}{code}{_FENCE_END}" if code.strip() else "")
            continue
        if _is_table_row(line) and i + 1 < len(lines) and _is_table_sep(lines[i + 1]):
            while i < len(lines) and (_is_table_row(lines[i]) or _is_table_sep(lines[i])):
                if _is_table_row(lines[i]) and not _is_table_sep(lines[i]):
                    cells = _table_cells(lines[i])
                    out.append(" | ".join(_inline(c.strip()) for c in cells))
                i += 1
            continue
        quote = _QUOTE_RE.match(line)
        heading = _HEADING_RE.match(line)
        bullet = _BULLET_RE.match(line)
        numbered = _NUMBERED_RE.match(line)
        if quote:
            out.append(f"> {_inline(quote.group(1))}".rstrip())
        elif heading:
            out.append(_heading(heading.group(1) or ""))
        elif _is_hr(line):
            out.append(line.strip())
        elif bullet:
            out.append(f"{bullet.group(1)}- {_inline(bullet.group(2))}")
        elif numbered:
            out.append(f"{numbered.group(1)}{numbered.group(2)}. {_inline(numbered.group(3))}")
        else:
            out.append(_inline(line))
        i += 1

    whole = "\n".join(out)
    first = len(whole) - len(whole.lstrip())
    if first == len(whole):
        return ""
    lead = whole.rfind("\n", 0, first) + 1  # keep the first line's indentation
    return whole[lead:].rstrip()


# A span of the converted text: (start, end, first_ink, last_ink, opener, closer).
# ``start``/``end`` cover the markers; ``first_ink``/``last_ink`` are the first
# and last non-whitespace characters inside them.
_Span = tuple[int, int, int, int, str, str]


def _convert(markdown: str) -> tuple[str, list[_Span]]:
    """``to_whatsapp`` plus the spans of its output (one linear scan that
    turns the sentinels into markers and records where each pair landed)."""
    marked = _sentinel_text(markdown)
    out: list[str] = []
    spans: list[_Span] = []
    open_at: dict[str, list[int]] = {o: [] for o in _OPENERS}
    at = pos = 0
    for m in _SENTINEL_RE.finditer(marked):
        chunk = marked[pos:m.start()]
        out.append(chunk)
        at += len(chunk)
        pos = m.end()
        ch = m.group(0)
        if ch in _OPENERS:
            open_at[ch].append(at)
            out.append(_OPENERS[ch])
            at += len(_OPENERS[ch])
            continue
        opener_sentinel, closer = _CLOSERS[ch]
        out.append(closer)
        at += len(closer)
        if open_at[opener_sentinel]:
            s = open_at[opener_sentinel].pop()
            spans.append((s, at, len(_OPENERS[opener_sentinel]), len(closer),
                          _OPENERS[opener_sentinel], closer))
    out.append(marked[pos:])
    text = "".join(out)
    full: list[_Span] = []
    for s, e, olen, clen, opener, closer in spans:
        a, b = s + olen, e - clen
        inner = text[a:b]
        lead = len(inner) - len(inner.lstrip())
        trail = len(inner) - len(inner.rstrip())
        if lead == len(inner):
            continue  # nothing visible inside: never cut, never reopened
        full.append((s, e, a + lead, b - trail - 1, opener, closer))
    return text, full


def to_whatsapp(markdown: str) -> str:
    """The agent's markdown as WhatsApp text (see the module docstring)."""
    return _convert(markdown)[0]


# ── splitting ────────────────────────────────────────────────────────────


class _WaSplitter(_Splitter):
    """``line_format._Splitter`` (UTF-16 offsets, grapheme clusters, URL and
    whitespace handling) with a cut that knows the spans of the text: it moves
    a span that fits to the next part and never leaves a span with nothing
    visible on one side of the cut."""

    def __init__(self, text: str, spans: list[_Span]) -> None:
        super().__init__(text, [])
        # Spans in layers of disjoint spans (first fit by start), so the spans
        # around an offset are one bisection per layer. Same-kind spans never
        # overlap and the kinds are few, so the layers are few.
        self.layers: list[list[_Span]] = []
        ends: list[int] = []
        for span in sorted(spans):
            for k, last in enumerate(ends):
                if last <= span[0]:
                    self.layers[k].append(span)
                    ends[k] = span[1]
                    break
            else:
                self.layers.append([span])
                ends.append(span[1])
        self.layer_starts = [[sp[0] for sp in layer] for layer in self.layers]

    def around(self, p: int) -> list[_Span]:
        """The spans ``p`` falls strictly inside, outermost first."""
        found: list[_Span] = []
        for layer, starts in zip(self.layers, self.layer_starts):
            k = bisect_left(starts, p) - 1
            if k >= 0 and layer[k][1] > p:
                found.append(layer[k])
        found.sort()
        return found

    def opening(self, pos: int) -> str:
        return "".join(sp[4] for sp in self.around(pos))

    def closing(self, p: int) -> str:
        return "".join(sp[5] for sp in reversed(self.around(p)))

    def _blocked(self, p: int, pos: int, limit: int) -> int | None:
        """``None`` when a part may end at ``p``; else a smaller offset to
        retry below: the start of a span that fits and should move whole, or
        the last visible character of a span the cut would leave empty."""
        best: int | None = None
        for s, e, first, last, _, _ in self.around(p):
            if s > pos and (p <= first or self.fits(s, e, limit)):
                alt = s
            elif s == pos and p <= first:
                alt = pos  # nothing of it would be in this part: no break below
            elif p > last:
                alt = max(last, pos)
            else:
                continue
            best = alt if best is None else min(best, alt)
        return best

    def cut(self, pos: int, limit: int) -> tuple[int, str]:
        """Where the part starting at ``pos`` ends, and the kind of cut."""
        text = self.text
        w = self.window(pos, limit)
        ink = pos  # a break must follow some visible text (not indentation)
        while ink < w and text[ink].isspace():
            ink += 1
        for sep, kind in (("\n\n", "para"), ("\n", "line"), (" ", "space")):
            hi = w
            while True:
                q = text.rfind(sep, pos, hi)
                if q <= ink:
                    break
                p = q + len(sep)
                alt = self._blocked(p, pos, limit)
                if alt is not None:
                    hi = alt
                    continue
                if not self.bound(p):
                    hi = p - 1
                    continue
                return p, kind
        # Hard cut: no break fits.
        url = self._url_at(pos, w, limit)
        p = w if url is None else url
        while p > pos:
            alt = self._blocked(p, pos, limit)
            if alt is None:
                return p, "hard"
            p = alt
            while p > pos and not self.bound(p):
                p -= 1
        return w, "hard"  # nowhere better: cut inside


def _pieces(text: str, spans: list[_Span], limit: int,
            max_parts: int | None = None) -> list[tuple[str, str, str]]:
    """Each part as ``(reopened markers, text, closing markers + tail)``."""
    if limit < MIN_LIMIT:
        raise ValueError(f"limit must be at least {MIN_LIMIT} UTF-16 units")
    if not text.strip():
        return []
    sp = _WaSplitter(text, spans)
    end = len(text.rstrip())
    out: list[tuple[str, str, str]] = []
    pos = sp.skip(0)
    while pos < end:
        prefix = sp.opening(pos)
        room = limit - utf16_len(prefix)
        if sp.fits(pos, end, room):
            out.append((prefix, text[pos:end], ""))
            break
        tail = ""
        if max_parts is not None and len(out) >= max_parts - 1:
            tail = "\n" + TRUNCATED_MARKER
        reserve = 0
        while True:
            p, kind = sp.cut(pos, room - utf16_len(tail) - reserve)
            body = text[pos:p].rstrip()
            suffix = sp.closing(p)
            if utf16_len(suffix) <= reserve or reserve >= room // 2:
                break
            reserve = utf16_len(suffix)
        if body.strip():  # whitespace-only window (deep indentation): skip it
            out.append((prefix, body, suffix + tail))
            if tail:
                break
        pos = sp.skip(p, kind)
    return out


def split_text(text: str, limit: int = WHATSAPP_LIMIT) -> list[str]:
    """``text`` as parts of at most ``limit`` UTF-16 units each, none empty or
    whitespace-only (see the module docstring)."""
    return ["".join(piece) for piece in _pieces(text, [], limit)]


def format_parts(markdown: str, limit: int = WHATSAPP_LIMIT,
                 max_parts: int = MAX_PARTS) -> list[str]:
    """The agent's markdown as the WhatsApp text messages to send, in order:
    at most ``max_parts``, the last ending with ``TRUNCATED_MARKER`` when the
    reply needed more."""
    text, spans = _convert(markdown)
    return ["".join(piece) for piece in _pieces(text, spans, limit, max_parts)]
