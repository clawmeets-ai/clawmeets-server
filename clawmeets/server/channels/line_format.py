# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/line_format.py
The agent's markdown as LINE text messages: plain text, split at 5000.

**Conversion** (``to_text``). A LINE ``text`` message renders no markup at all
(the app only auto-links URLs), so the agent's markdown becomes readable plain
text. The adapter sends ``type: "text"``, never ``textV2``, so ``{user}``-style
braces are ordinary text and are left alone. Nothing is ever HTML-escaped:
whatever the agent wrote as literal HTML (``a < b && c > d``) is sent as
written.

- ``**bold**`` / ``__bold__`` / ``*em*`` / ``_em_`` / ``~~strike~~`` → the
  text, markers removed. The word guards are those of ``telegram_format``: an
  opener must not follow a letter or digit and a closer must not precede one,
  so ``snake_case_name`` and ``2*3*4`` stay as written. Unbalanced markers
  (``**bold``) stay literal. ``\\*``-style escapes become the bare character.
- headings → their text on its own line; bullets → ``• ``; numbered items keep
  ``1. ``; a nested item keeps its leading indentation.
- ``[label](url)`` → ``label (url)``; a link whose label is its URL → the URL
  once; a bare URL stays as it is; an angle-bracket autolink ``<https://x>``
  or ``<a@b.com>`` → the URL / address without its brackets or ``mailto:``
  (an autolink with any other scheme stays literal, like other literal
  HTML). Only http, https, mailto, tel and line links are shown: any other
  scheme (``javascript:``, ``data:``) or a relative link keeps the label and
  drops the URL. An image ``![alt](url)`` reads
  ``alt (url)`` under the same rule.
- ``inline code`` → its text; a fenced block → its lines VERBATIM without the
  fence lines (no marker is stripped inside code).
- a table → one row per line, cells joined by `` | ``; the separator row is
  dropped. ``\\|`` inside a cell is a literal ``|``, not a cell boundary.
- ``> quote`` lines stay ``> text``: LINE has no quote styling, and the ``>``
  prefix is the one plain-text convention every reader recognises as quoted.

**Splitting** (``split_text``). LINE's limit is 5000 characters counted in
UTF-16 code units (an astral emoji counts 2), and a part may never be empty or
whitespace-only (LINE rejects it). A part ends at the last paragraph break that
fits, else the last line break, else the last space, else (one word longer
than the limit) at the last grapheme-cluster boundary that fits — never inside
a surrogate pair, a ZWJ emoji sequence, a flag, a skin-tone modifier or a
combining accent. At a hard cut a URL that started in the part moves whole to
the next one, unless the URL alone is longer than the limit. The whitespace at
a cut is dropped; otherwise the parts, in order, are exactly the text.

A fenced code block that fits in one part but would straddle a cut moves whole
to the next part. A code block longer than the limit is cut between its lines
(at a hard cut only if one line is itself longer than the limit). LINE shows no
markup, so no fences are added: each part of a split block simply continues
the code's lines verbatim, indentation included.

Grapheme clusters are found without third-party packages (``_Splitter``):
CR LF, combining marks (categories Mn / Me / Mc), ZWJ joins, variation
selectors, skin-tone modifiers, tag characters and regional-indicator pairs.
A single cluster longer than the whole limit (thousands of stacked accents) is
cut between code points.

**Cap** (``format_parts``). Each part is one push and costs quota, so a reply
is at most ``MAX_PARTS`` parts; when it needs more, the last part ends with
``TRUNCATED_MARKER`` on its own line and still fits the limit.

Every pass is linear (no regex here can backtrack catastrophically), so
pathological input — deep nesting, 100 000 ``*``, a 200 000-character word —
converts and splits in bounded time.
"""
from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left, bisect_right

from clawmeets.server.channels.telegram_format import utf16_len

LINE_LIMIT = 5000          # UTF-16 code units per text message
MAX_PARTS = 5              # parts per reply; each part is one push and costs quota
TRUNCATED_MARKER = "[reply truncated]"
SAFE_SCHEMES = ("http://", "https://", "mailto:", "tel:", "line:")

_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_HEADING_RE = re.compile(r"^ {0,3}#{1,6}(?:[ \t]+(.*))?$")
_BULLET_RE = re.compile(r"^([ \t]*)[-*+][ \t]+(.*)$")
_NUMBERED_RE = re.compile(r"^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$")
_QUOTE_RE = re.compile(r"^ {0,3}>[ \t]?(.*)$")
_SEP_CELL_RE = re.compile(r"[ \t]*:?-+:?[ \t]*")

_ESCAPE_RE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!~|>])")
# A label holds no bracket and a URL no bracket or whitespace, so each scan
# stops at the next ``[`` and the passes stay linear.
_URL = r"((?:[^()\s\[\]]|\([^()\s\[\]]*\))+)"
_IMAGE_RE = re.compile(r"!\[([^\[\]\n]*)\]\(" + _URL + r"\)")
_LINK_RE = re.compile(r"\[([^\[\]\n]+)\]\(" + _URL + r"\)")
_BARE_URL_RE = re.compile(r"https?://[^\s*]+")
# CommonMark autolinks: ``<scheme:...>`` (no space, ``<`` or ``>`` inside) and
# ``<address@domain>``. Only the safe schemes lose their brackets.
_ANGLE_LINK_RE = re.compile(
    r"<((?:https?|mailto|tel|line):[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+)>",
    re.IGNORECASE)
_BACKTICKS_RE = re.compile(r"`+")
_PLACEHOLDER_RE = re.compile("\x00(\\d+)\x00")
_URL_START_RE = re.compile(r"https?://")


# ── conversion ───────────────────────────────────────────────────────────


def _is_word(ch: str) -> bool:
    return ch.isalnum() or ch == "_"  # what ``\w`` matches


def _strip_pairs(s: str, marker: str, guard: str | None, single: bool) -> str:
    """Remove ``marker`` pairs from ``s``, keeping the text between them.

    The same matches ``re.sub`` would make with telegram_format's emphasis
    patterns, found in linear time: openers and closers are listed once and
    each opener looks up its closer by bisection instead of rescanning the
    line. ``guard`` holds the extra characters (besides letters and digits)
    an opener may not follow and a closer may not precede (``None``: no word
    guard). ``single``: the text between may not contain the marker.
    """
    k = len(marker)
    n = len(s)
    cands: list[int] = []
    i = s.find(marker)
    while i >= 0:
        cands.append(i)
        i = s.find(marker, i + 1)
    if len(cands) < 2:
        return s

    def blocked(ch: str) -> bool:
        return guard is not None and ch != "" and (_is_word(ch) or ch in guard)

    def bad_inner(ch: str) -> bool:
        return ch == "" or ch.isspace() or (single and ch == marker)

    openers = [i for i in cands
               if not bad_inner(s[i + k] if i + k < n else "")
               and not blocked(s[i - 1] if i else "")]
    closer_set = [j for j in cands
                  if j and not bad_inner(s[j - 1])
                  and not blocked(s[j + k] if j + k < n else "")]
    closers = set(closer_set)
    out: list[str] = []
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
            at = bisect_left(closer_set, i + k + 1)
            if at == len(closer_set):
                continue
            j = closer_set[at]
        out.append(s[pos:i])
        out.append(s[i + k:j])
        pos = j + k
    out.append(s[pos:])
    return "".join(out)


def _emphasis(s: str) -> str:
    s = _strip_pairs(s, "**", "*", single=False)
    s = _strip_pairs(s, "__", "", single=False)
    s = _strip_pairs(s, "*", "*", single=True)
    s = _strip_pairs(s, "_", "_", single=True)
    return _strip_pairs(s, "~~", None, single=False)


def _safe(url: str) -> bool:
    return url.lower().startswith(SAFE_SCHEMES)


def inline(text: str) -> str:
    """One line of markdown as plain text (markers removed, nothing escaped)."""
    stash: list[str] = []

    def keep(fragment: str) -> str:
        stash.append(fragment)
        return f"\x00{len(stash) - 1}\x00"

    def restore(s: str) -> str:
        while "\x00" in s:
            s = _PLACEHOLDER_RE.sub(lambda m: stash[int(m.group(1))], s)
        return s

    work = _code_spans(text.replace("\x00", ""), keep)
    work = _ESCAPE_RE.sub(lambda m: keep(m.group(1)), work)

    def shown(label: str, url: str) -> str:
        url = url.strip()
        label = restore(_emphasis(label)).strip()
        if not _safe(url):
            return keep(label)
        if not label or label == url:
            return keep(url)
        return keep(f"{label} ({url})")

    work = _ANGLE_LINK_RE.sub(lambda m: keep(_angle_link(m.group(1))), work)
    work = _IMAGE_RE.sub(lambda m: shown(m.group(1), m.group(2)), work)
    work = _LINK_RE.sub(lambda m: shown(m.group(1), m.group(2)), work)
    work = _BARE_URL_RE.sub(lambda m: keep(m.group(0)), work)
    return restore(_emphasis(work))


def _angle_link(url: str) -> str:
    """An autolink's text: the URL, or the bare address for ``mailto:``."""
    return url[len("mailto:"):] if url.lower().startswith("mailto:") else url


def _code_spans(s: str, keep) -> str:
    """Stash each inline code span (a backtick run up to the next run of the
    same length), backticks removed. Linear: each run is visited once."""
    if "`" not in s:
        return s
    runs = [(m.start(), m.end()) for m in _BACKTICKS_RE.finditer(s)]
    by_len: dict[int, list[int]] = {}
    for idx, (a, b) in enumerate(runs):
        by_len.setdefault(b - a, []).append(idx)
    ptr = dict.fromkeys(by_len, 0)
    out: list[str] = []
    pos = idx = 0
    while idx < len(runs):
        a, b = runs[idx]
        same = by_len[b - a]
        while ptr[b - a] < len(same) and same[ptr[b - a]] <= idx:
            ptr[b - a] += 1
        if ptr[b - a] < len(same):
            j = same[ptr[b - a]]
            c, d = runs[j]
            content = s[b:c]
            if len(content) > 2 and content[0] == content[-1] == " " and content.strip():
                content = content[1:-1]
            out.append(s[pos:a])
            out.append(keep(content))
            pos = d
            idx = j + 1
            continue
        idx += 1
    out.append(s[pos:])
    return "".join(out)


def _heading_text(rest: str) -> str:
    text = rest.strip()
    if text.endswith("#"):  # optional closing hashes: "## Title ##"
        bare = text.rstrip("#")
        if not bare:
            return ""
        if bare[-1] in " \t":
            text = bare.rstrip()
    return text


def _is_hr(line: str) -> bool:
    compact = line.replace(" ", "").replace("\t", "")
    return len(compact) >= 3 and len(set(compact)) == 1 and compact[0] in "-*_"


def _is_table_row(line: str) -> bool:
    s = line.strip()
    return len(s) >= 2 and s[0] == "|" and s[-1] == "|"


def _table_cells(line: str) -> list[str]:
    """The cells of a table row, its outer pipes removed. ``\\|`` is a literal
    ``|`` inside a cell (GFM, code spans included), never a boundary."""
    s = line.strip()[1:-1]
    cells: list[str] = []
    cell: list[str] = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s):
            nxt = s[i + 1]
            cell.append("|" if nxt == "|" else ch + nxt)
            i += 2
            continue
        if ch == "|":
            cells.append("".join(cell))
            cell = []
        else:
            cell.append(ch)
        i += 1
    cells.append("".join(cell))
    return cells


def _is_table_sep(line: str) -> bool:
    s = line.strip()
    if "-" not in s:
        return False
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return all(_SEP_CELL_RE.fullmatch(cell) for cell in s.split("|"))


def _convert(markdown: str) -> tuple[str, list[tuple[int, int]]]:
    """``to_text`` plus the ``(start, end)`` offsets of each fenced code
    block's lines in the text, so the splitter can keep a block together."""
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[tuple[str, bool]] = []  # (text, is a code block)
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
            blocks.append(("\n".join(body), True))
            continue
        if _is_table_row(line) and i + 1 < len(lines) and _is_table_sep(lines[i + 1]):
            while i < len(lines) and (_is_table_row(lines[i]) or _is_table_sep(lines[i])):
                if _is_table_row(lines[i]) and not _is_table_sep(lines[i]):
                    cells = _table_cells(lines[i])
                    blocks.append((" | ".join(inline(c.strip()) for c in cells), False))
                i += 1
            continue
        quote = _QUOTE_RE.match(line)
        heading = _HEADING_RE.match(line)
        bullet = _BULLET_RE.match(line)
        numbered = _NUMBERED_RE.match(line)
        if quote:
            blocks.append((f"> {inline(quote.group(1))}".rstrip(), False))
        elif heading:
            blocks.append((inline(_heading_text(heading.group(1) or "")), False))
        elif _is_hr(line):
            blocks.append((line.strip(), False))
        elif bullet:
            blocks.append((f"{bullet.group(1)}• {inline(bullet.group(2))}", False))
        elif numbered:
            blocks.append((f"{numbered.group(1)}{numbered.group(2)}. {inline(numbered.group(3))}", False))
        else:
            blocks.append((inline(line), False))
        i += 1

    pieces: list[str] = []
    spans: list[tuple[int, int]] = []
    at = 0
    for text, is_code in blocks:
        if is_code and text:
            spans.append((at, at + len(text)))
        pieces.append(text)
        at += len(text) + 1
    whole = "\n".join(pieces)
    first = len(whole) - len(whole.lstrip())
    if first == len(whole):
        return "", []
    lead = whole.rfind("\n", 0, first) + 1  # keep the first line's indentation
    whole = whole[lead:].rstrip()
    spans = [(max(s - lead, 0), min(e - lead, len(whole))) for s, e in spans]
    return whole, [(s, e) for s, e in spans if e > s]


def to_text(markdown: str) -> str:
    """The agent's markdown as LINE plain text (see the module docstring)."""
    return _convert(markdown)[0]


# ── splitting ────────────────────────────────────────────────────────────


def _units(ch: str) -> int:
    return 2 if ch > "\uffff" else 1


def _is_extend(o: int, ch: str) -> bool:
    """Joins the cluster before it: combining marks, ZWJ, variation selectors,
    skin-tone modifiers, tag characters."""
    if o < 0x300:
        return False
    if (o == 0x200D or 0xFE00 <= o <= 0xFE0F or 0x1F3FB <= o <= 0x1F3FF
            or 0xE0020 <= o <= 0xE007F):
        return True
    return unicodedata.category(ch) in ("Mn", "Me", "Mc")


def _is_ri(o: int) -> bool:
    return 0x1F1E6 <= o <= 0x1F1FF


def _is_control(o: int) -> bool:
    return o < 0x20 or o == 0x7F


class _Splitter:
    """The text being split, with its UTF-16 offsets and grapheme-cluster
    boundaries computed lazily — only as far as the cuts have looked, so a
    capped reply of a huge answer costs ``max_parts`` windows, not the text."""

    _CHUNK = 8192

    def __init__(self, text: str, spans: list[tuple[int, int]]) -> None:
        self.text = text
        self.n = len(text)
        self.u = [0]            # u[i]: UTF-16 units in text[:i]
        self.b = bytearray()    # b[i]: 1 where a cluster may end before text[i]
        self._prev = -1         # code point before the next one to scan
        self._ri = 0            # regional indicators in a row just before it
        self.spans = sorted(spans)
        self.starts = [s for s, _ in self.spans]

    def _ensure(self, upto: int) -> None:
        """Scan far enough that ``u[upto]`` and ``b[upto]`` exist."""
        done = len(self.b)
        if upto < done or done > self.n:
            return
        stop = min(self.n, max(upto + 1, done + self._CHUNK))
        text, u, b = self.text, self.u, self.b
        acc, prev, ri_run = u[-1], self._prev, self._ri
        for i in range(done, stop):
            ch = text[i]
            o = ord(ch)
            brk = 1
            if i:
                if prev == 0x0D and o == 0x0A:  # CR LF
                    brk = 0
                elif _is_control(prev) or _is_control(o):
                    pass
                elif _is_extend(o, ch) or prev == 0x200D:  # marks; after ZWJ
                    brk = 0
                elif _is_ri(o) and ri_run % 2 == 1:  # second of a flag pair
                    brk = 0
            b.append(brk)
            ri_run = ri_run + 1 if _is_ri(o) else 0
            prev = o
            acc += _units(ch)
            u.append(acc)
        if stop == self.n:
            b.append(1)  # the end of the text is always a boundary
        self._prev, self._ri = prev, ri_run

    def size(self, a: int, b: int) -> int:
        self._ensure(b)
        return self.u[b] - self.u[a]

    def fits(self, a: int, b: int, limit: int) -> bool:
        """``text[a:b]`` is at most ``limit`` units (never scans past
        ``a + limit`` characters: a unit is at least a character)."""
        return b - a <= limit and self.size(a, b) <= limit

    def bound(self, i: int) -> bool:
        self._ensure(i)
        return bool(self.b[i])

    def _guarded(self, p: int, pos: int, limit: int) -> tuple[int, int] | None:
        """The code block ``p`` falls strictly inside, if it fits in a part
        and starts at or after ``pos`` (one already cut cannot be saved)."""
        k = bisect_right(self.starts, p - 1) - 1
        if k < 0:
            return None
        s, e = self.spans[k]
        if s < p < e and s >= pos and self.fits(s, e, limit):
            return s, e
        return None

    def window(self, pos: int, limit: int) -> int:
        """The furthest cluster boundary within ``limit`` units of ``pos``."""
        self._ensure(pos + limit + 1)
        e = bisect_right(self.u, self.u[pos] + limit, pos) - 1
        if e >= self.n:
            return self.n
        e = max(e, pos + 1)  # limit >= 2, so only a no-op guard
        w = e
        while w > pos and not self.bound(w):
            w -= 1
        return w if w > pos else e  # one cluster longer than the limit

    def cut(self, pos: int, limit: int) -> tuple[int, str]:
        """Where the part starting at ``pos`` ends, and the kind of cut."""
        text = self.text
        w = self.window(pos, limit)
        for sep, kind in (("\n\n", "para"), ("\n", "line"), (" ", "space")):
            hi = w
            while True:
                q = text.rfind(sep, pos, hi)
                if q <= pos:
                    break
                p = q + len(sep)
                block = self._guarded(p, pos, limit)
                if block is not None:
                    hi = block[0]
                    continue
                if not self.bound(p):
                    hi = p - 1
                    continue
                return p, kind
        # Hard cut: no break fits.
        block = self._guarded(w, pos, limit)
        if block is not None and block[0] > pos:
            return block[0], "hard"
        url = self._url_at(pos, w, limit)
        if url is not None:
            return url, "hard"
        return w, "hard"

    def _url_at(self, pos: int, w: int, limit: int) -> int | None:
        """The start of a URL the cut at ``w`` would split, when moving it
        whole to the next part helps."""
        text = self.text
        if w >= self.n or text[w].isspace():
            return None
        tok = max(text.rfind(c, pos, w) for c in " \n\t") + 1
        m = _URL_START_RE.search(text, max(tok, pos), min(self.n, w + 8))
        if m is None or m.start() >= w or m.start() <= pos or not self.bound(m.start()):
            return None
        end = m.start()
        while end < self.n and not text[end].isspace():
            end += 1
        if not self.fits(m.start(), end, limit):
            return None
        return m.start()

    def skip(self, pos: int, kind: str = "") -> int:
        """Past the whitespace at a cut: newlines, whitespace-only lines and,
        after a cut at a space, further spaces (never a line's indentation)."""
        text, n = self.text, self.n
        if kind == "space":
            while pos < n and text[pos] == " " and (pos + 1 >= n or self.bound(pos + 1)):
                pos += 1
        while pos < n:
            if text[pos] in "\r\n":
                pos += 1
                continue
            j = pos
            while j < n and text[j] in " \t":
                j += 1
            if j == n:
                return n
            if text[j] in "\r\n":
                pos = j
                continue
            break
        return pos


def _parts(text: str, spans: list[tuple[int, int]], limit: int,
           max_parts: int | None = None) -> list[str]:
    if limit < 2:
        raise ValueError("limit must be at least 2 UTF-16 units")
    if not text.strip():
        return []
    sp = _Splitter(text, spans)
    end = len(text.rstrip())
    marker = "\n" + TRUNCATED_MARKER
    out: list[str] = []
    pos = sp.skip(0)
    while pos < end:
        if sp.fits(pos, end, limit):
            out.append(text[pos:end])
            break
        if max_parts is not None and len(out) >= max_parts - 1:
            room = max(limit - utf16_len(marker), 2)
            p, _ = sp.cut(pos, room)
            out.append((text[pos:p].rstrip() + marker).lstrip("\n"))
            break
        p, kind = sp.cut(pos, limit)
        part = text[pos:p].rstrip()
        if part:
            out.append(part)
        pos = sp.skip(p, kind)
    return out


def split_text(text: str, limit: int = LINE_LIMIT) -> list[str]:
    """``text`` as parts of at most ``limit`` UTF-16 units each, none empty or
    whitespace-only (see the module docstring)."""
    return _parts(text, [], limit)


def format_parts(markdown: str, limit: int = LINE_LIMIT,
                 max_parts: int = MAX_PARTS) -> list[str]:
    """The agent's markdown as the LINE text messages to send, in order: at
    most ``max_parts``, the last ending with ``TRUNCATED_MARKER`` when the
    reply needed more."""
    text, spans = _convert(markdown)
    return _parts(text, spans, limit, max_parts)
