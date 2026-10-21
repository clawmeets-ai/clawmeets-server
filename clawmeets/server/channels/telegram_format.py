# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/telegram_format.py
The agent's markdown as Telegram messages: HTML parse mode, split at 4096.

**Conversion** (``to_html``). Telegram's HTML mode accepts a small tag set
(``ALLOWED_TAGS``) and needs ``<``, ``>`` and ``&`` escaped everywhere else.
Only constructs written as markdown become tags; anything the agent wrote as
literal HTML is escaped and shows up as text.

- ``**bold**`` / ``__bold__`` → ``<b>``; ``*italic*`` / ``_italic_`` → ``<i>``
  (an opener must not follow a letter or digit and a closer must not precede
  one, so ``snake_case_name`` and ``2*3*4`` stay as written); ``~~x~~`` → ``<s>``.
- ``inline code`` → ``<code>``; a fenced block → ``<pre><code class="language-x">``,
  ``x`` being the first word of the info string (```` ```python title="a.py" ````).
  As in CommonMark, a fence is three or more backticks or tildes and is closed
  only by the same character, at least as many, alone on its line.
- a backslash before ASCII punctuation (``\\*``) makes it a literal character.
- headings → bold lines; bullets → ``•``; numbered items keep their number.
- a table → one ``<pre>`` block of its lines, as written.
- ``> quote`` lines → ``<blockquote>``.
- ``[text](url)`` → ``<a href>`` for http, https, mailto and tg links only;
  any other scheme (``javascript:``, ``data:``) keeps the text and drops the
  link. An image becomes a link to it, labelled with its alt text. A link
  whose opening tag would be longer than ``MAX_LINK_TAG`` (a URL of a
  thousand characters or more) is sent as escaped text, ``label (url)``, so it
  can be cut like any text — a tag never can, and one longer than a whole part
  could not be sent at all.
- Unbalanced markers (``**bold``) stay literal. If a line's inline markup
  would still nest wrongly (``**a *b** c*``), that line is sent as escaped
  plain text instead — Telegram rejects the whole message otherwise.

**Splitting** (``split_html``). Telegram's limit is 4096 characters of text
after entity parsing; parts are measured in UTF-16 code units of the HTML
source, which is never shorter, so a part that fits here fits there (Python's
``len`` counts an astral emoji as 1; Telegram counts 2). A part ends at the
last paragraph break that fits, else the last line break, else the last space,
else (one word longer than the limit) wherever the limit falls — never inside
a tag, an entity or a character. Tags open at the cut are closed at the end of
the part and reopened, with the same attributes, at the start of the next, so a
long code block continues as a code block and every part is valid on its own.
The text of the parts, joined, is exactly the text of the whole.

``split_html`` never raises on agent text: if the tags open at a cut leave no
room for the next token, the whole message is split again as escaped plain
text (its markup dropped, its words kept), which always fits.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass

TELEGRAM_LIMIT = 4096
ALLOWED_TAGS = frozenset({
    "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span",
    "a", "code", "pre", "blockquote", "tg-spoiler",
})
SAFE_SCHEMES = ("http://", "https://", "mailto:", "tg://")
MAX_LINK_TAG = 1024  # UTF-16 units of an ``<a href>`` tag; longer → text

# An opening fence: three or more backticks or tildes, then an optional info
# string whose first word is the language (``python title="a.py"`` → python).
# A backtick fence's info string may not contain a backtick (CommonMark).
_FENCE_RE = re.compile(r"^\s{0,3}(`{3,}(?=[^`]*$)|~{3,})\s*(\S*)")
_LANG_RE = re.compile(r"[A-Za-z0-9_+#.-]+")
_ESCAPE_RE = re.compile(r"\\([!-/:-@\[-`{-~])")  # a backslash before ASCII punctuation
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
_BULLET_RE = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUMBERED_RE = re.compile(r"^(\s*)(\d{1,9})[.)]\s+(.*)$")
_QUOTE_RE = re.compile(r"^\s{0,3}>\s?(.*)$")
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")

_CODE_SPAN_RE = re.compile(r"(`+)(.+?)\1")
_URL = r"((?:[^()\s]|\([^()\s]*\))+)"  # one level of parentheses, as in alert(1)
_IMAGE_RE = re.compile(r"!\[([^\]\n]*)\]\(" + _URL + r"\)")
_LINK_RE = re.compile(r"\[([^\]\n]+)\]\(" + _URL + r"\)")
_BOLD_RE = re.compile(r"(?<![\w*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w*])|(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)")
_ITALIC_RE = re.compile(r"(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])")
_STRIKE_RE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~")
_PLACEHOLDER_RE = re.compile("\x00(\\d+)\x00")
_TAG_RE = re.compile(r"<(/?)([a-z-]+)((?:\s[^<>]*)?)>")


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def escape(text: str) -> str:
    return html.escape(text, quote=False)


def _safe_href(url: str) -> str | None:
    lowered = url.strip().lower()
    if not lowered.startswith(SAFE_SCHEMES):
        return None
    return html.escape(url.strip(), quote=True)


def _balanced(fragment: str) -> bool:
    stack: list[str] = []
    for m in _TAG_RE.finditer(fragment):
        closing, name = m.group(1), m.group(2)
        if not closing:
            stack.append(name)
        elif not stack or stack.pop() != name:
            return False
    return not stack


def inline(text: str) -> str:
    """One line of markdown as Telegram HTML (escaped; tags balanced)."""
    stash: list[str] = []

    def keep(fragment: str) -> str:
        stash.append(fragment)
        return f"\x00{len(stash) - 1}\x00"

    work = text.replace("\x00", "")
    work = _CODE_SPAN_RE.sub(lambda m: keep(f"<code>{escape(m.group(2))}</code>"), work)
    work = _ESCAPE_RE.sub(lambda m: keep(escape(m.group(1))), work)  # ``\*`` → a literal *

    def anchor(label: str, url: str) -> str:
        href = _safe_href(url)
        if href is None:
            return keep(escape(label))
        tag = f'<a href="{href}">'
        if utf16_len(tag) > MAX_LINK_TAG:
            return keep(escape(f"{label} ({url.strip()})"))
        return keep(f"{tag}{escape(label)}</a>")

    def image(m: re.Match) -> str:
        return anchor(m.group(1) or "image", m.group(2))

    def link(m: re.Match) -> str:
        return anchor(m.group(1), m.group(2))

    work = _IMAGE_RE.sub(image, work)
    work = _LINK_RE.sub(link, work)
    work = escape(work)
    work = _BOLD_RE.sub(lambda m: f"<b>{m.group(1) or m.group(2)}</b>", work)
    work = _ITALIC_RE.sub(lambda m: f"<i>{m.group(1) or m.group(2)}</i>", work)
    work = _STRIKE_RE.sub(lambda m: f"<s>{m.group(1)}</s>", work)
    if not _balanced(work):
        return escape(_ESCAPE_RE.sub(r"\1", text.replace("\x00", "")))  # no markup
    while _PLACEHOLDER_RE.search(work):  # a link label can hold an escape's placeholder
        work = _PLACEHOLDER_RE.sub(lambda m: stash[int(m.group(1))], work)
    return work


def to_html(markdown: str) -> str:
    """The agent's markdown as Telegram HTML (see the module docstring)."""
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        fence = _FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            lang_m = _LANG_RE.match(fence.group(2))
            lang = lang_m.group(0) if lang_m else ""
            # Closed only by the same character, at least as many, and nothing
            # else on the line: a ```js line inside a ```` block is code.
            closing = re.compile(r"^\s{0,3}" + re.escape(marker[0]) + "{" + str(len(marker)) + r",}\s*$")
            body: list[str] = []
            i += 1
            while i < len(lines) and not closing.match(lines[i]):
                body.append(lines[i])
                i += 1
            i += 1  # the closing fence (or the end)
            attr = f' class="language-{escape(lang)}"' if lang else ""
            out.append(f"<pre><code{attr}>{escape(chr(10).join(body))}</code></pre>")
            continue
        if (_TABLE_ROW_RE.match(line) and i + 1 < len(lines)
                and _TABLE_SEP_RE.match(lines[i + 1])):
            rows: list[str] = []
            while i < len(lines) and (_TABLE_ROW_RE.match(lines[i]) or _TABLE_SEP_RE.match(lines[i])):
                rows.append(lines[i].strip())
                i += 1
            out.append(f"<pre>{escape(chr(10).join(rows))}</pre>")
            continue
        if _QUOTE_RE.match(line):
            quoted: list[str] = []
            while i < len(lines) and (m := _QUOTE_RE.match(lines[i])):
                quoted.append(inline(m.group(1)))
                i += 1
            out.append(f"<blockquote>{chr(10).join(quoted)}</blockquote>")
            continue
        heading = _HEADING_RE.match(line)
        bullet = _BULLET_RE.match(line)
        numbered = _NUMBERED_RE.match(line)
        if heading:
            out.append(f"<b>{inline(heading.group(1))}</b>" if heading.group(1) else "")
        elif bullet and not re.match(r"^\s*[-*+]\s*[-*+]\s*[-*+]\s*$", line):
            out.append(f"{bullet.group(1)}• {inline(bullet.group(2))}")
        elif numbered:
            out.append(f"{numbered.group(1)}{numbered.group(2)}. {inline(numbered.group(3))}")
        else:
            out.append(inline(line))
        i += 1
    return "\n".join(out).strip("\n")


# ── splitting ────────────────────────────────────────────────────────────

_TOKEN_RE = re.compile(r"<[^<>]*>|&#?[A-Za-z0-9]+;|.", re.DOTALL)


@dataclass
class _Tok:
    text: str
    open_tag: str | None = None   # the full opening tag, for a start tag
    close_name: str | None = None  # the tag name, for an end tag

    @property
    def size(self) -> int:
        return utf16_len(self.text)


def _tokens(source: str) -> list[_Tok]:
    out: list[_Tok] = []
    for m in _TOKEN_RE.finditer(source):
        text = m.group(0)
        tag = _TAG_RE.fullmatch(text)
        if tag and tag.group(1):
            out.append(_Tok(text, close_name=tag.group(2)))
        elif tag:
            out.append(_Tok(text, open_tag=text))
        else:
            out.append(_Tok(text))
    return out


def _closing(stack: list[str]) -> str:
    return "".join(f"</{_TAG_RE.fullmatch(t).group(2)}>" for t in reversed(stack))


class _NoRoom(Exception):
    """The tags open at a cut leave no room for the next token."""


def split_html(source: str, limit: int = TELEGRAM_LIMIT) -> list[str]:
    """``source`` (balanced Telegram HTML) as parts of at most ``limit``
    UTF-16 units each (see the module docstring)."""
    try:
        return _split(source, limit)
    except _NoRoom:
        return _split(escape(strip_tags(source)), limit)


def _split(source: str, limit: int) -> list[str]:
    if not source.strip():
        return []
    if utf16_len(source) <= limit:
        return [source]
    toks = _tokens(source)
    parts: list[str] = []
    stack: list[str] = []      # open tags at the current position
    i = 0
    while i < len(toks):
        prefix = "".join(stack)
        size = utf16_len(prefix)
        cur_stack = list(stack)
        # Best cut so far: (token index after the cut, stack there), per kind.
        best: dict[str, tuple[int, list[str]]] = {}
        j = i
        while j < len(toks):
            tok = toks[j]
            next_stack = list(cur_stack)
            if tok.open_tag is not None:
                next_stack.append(tok.open_tag)
            elif tok.close_name is not None and next_stack:
                next_stack.pop()
            closing = utf16_len(_closing(next_stack))
            if size + tok.size + closing > limit:
                break
            size += tok.size
            cur_stack = next_stack
            j += 1
            if tok.text == "\n":
                kind = "para" if j >= 2 and toks[j - 2].text == "\n" else "line"
                best[kind] = (j, list(cur_stack))
            elif tok.text == " ":
                best["space"] = (j, list(cur_stack))
        if j >= len(toks):
            parts.append(prefix + "".join(t.text for t in toks[i:]))
            break
        cut = best.get("para") or best.get("line") or best.get("space")
        if cut is None or cut[0] <= i:
            if j == i:  # nothing fits beside the reopened tags: drop them
                raise _NoRoom
            cut = (j, cur_stack)
        end, end_stack = cut
        parts.append(prefix + "".join(t.text for t in toks[i:end]) + _closing(end_stack))
        stack = end_stack
        i = end
    return [p for p in parts if strip_tags(p).strip()] or parts[:1]


def strip_tags(source: str) -> str:
    """The text a part shows: tags removed, entities decoded."""
    return html.unescape(re.sub(r"<[^<>]*>", "", source))


def format_parts(markdown: str, limit: int = TELEGRAM_LIMIT) -> list[str]:
    """The agent's markdown as the Telegram messages to send, in order. A part
    that would show nothing (an empty code block or quote on its own) is
    dropped: Telegram refuses an empty message, and that refusal is not a
    formatting error the plain-text retry would recover from."""
    return [p for p in split_html(to_html(markdown), limit) if strip_tags(p).strip()]
