# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/email_text.py
What an inbound mail's body becomes before the agent (or the owner, in a
Request) reads it: the NEW text only.

**HTML-only mail** is turned into text by ``html.parser`` (never a regex):
``<script>``/``<style>``/``<head>`` content is dropped, entities are decoded,
block elements and ``<br>`` become line breaks, and a link becomes
``text (url)`` when its target is http(s) or mailto and differs from its text.
Quoted history in HTML is cut before conversion: ``<blockquote>``,
``<div class="gmail_quote">`` and everything from Outlook's
``<div id="divRplyFwdMsg">`` (or its ``<hr id="stopSpelling">``) on.

**Quoted history in text** (``strip_quoted``), one rule per client shape:

- an attribution line followed by ``>`` lines: Gmail / Apple Mail
  ``On <date>, <name> <addr> wrote:`` (also wrapped over two lines), and the
  localised forms ``Am … schrieb …:`` (de), ``Le … a écrit :`` (fr),
  ``El … escribió:`` (es), ``Op … schreef …:`` (nl), ``Il … ha scritto:`` (it).
  The line must START with the opener and END with the verb and a colon, and
  the next non-blank line must start with ``>`` — so ``I said on Monday, John
  wrote: the report…`` in the middle of new text is left alone;
- Outlook: a ``-----Original Message-----`` line, a line of 10+ ``_``
  followed by a ``From:`` line, or a ``From:`` line followed within four lines
  by ``Sent:``/``Date:`` and ``Subject:`` — everything from there on is cut;
- bottom-posting (``>`` lines interleaved with answers): only the ``>`` lines
  (and an attribution right before them) go; the answers stay;
- a signature after a ``-- `` line.

A forward (``---------- Forwarded message ---------``) is content, not history:
nothing from that line on is cut. If stripping would leave no text at all (a
reply that is only a quote) the unstripped text is used — the agent never gets
an empty message because of this module.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Optional

#: The text that reaches the agent, after stripping.
MAX_AGENT_TEXT_BYTES = 32 * 1024
TRUNCATED_MARKER = "\n\n[message truncated]"
EMPTY_MESSAGE = "[empty message]"
MAX_FILENAME_CHARS = 100

_ATTRIBUTION_RES = (
    re.compile(r"^on\b.{0,400}\bwrote:?\s*$", re.IGNORECASE),
    re.compile(r"^am\b.{0,400}\bschrieb\b.{0,200}:\s*$", re.IGNORECASE),
    re.compile(r"^le\b.{0,400}\ba\s+écrit\s*:\s*$", re.IGNORECASE),
    re.compile(r"^el\b.{0,400}\bescribió\s*:\s*$", re.IGNORECASE),
    re.compile(r"^op\b.{0,400}\bschreef\b.{0,200}:\s*$", re.IGNORECASE),
    re.compile(r"^il\b.{0,400}\bha\s+scritto\s*:\s*$", re.IGNORECASE),
)
_ORIGINAL_MESSAGE_RE = re.compile(r"^-{2,}\s*original message\s*-{2,}\s*$", re.IGNORECASE)
_UNDERSCORE_RULE_RE = re.compile(r"^_{10,}\s*$")
_FORWARD_RE = re.compile(r"^-{3,}\s*forwarded message\s*-{3,}\s*$", re.IGNORECASE)
_HEADER_LINE_RES = {
    "from": re.compile(r"^\*?from:\*?\s", re.IGNORECASE),
    "sent": re.compile(r"^\*?(sent|date):\*?\s", re.IGNORECASE),
    "subject": re.compile(r"^\*?subject:\*?\s", re.IGNORECASE),
}


def _is_quote(line: str) -> bool:
    return line.lstrip().startswith(">")


def _next_nonblank(lines: list[str], start: int) -> Optional[int]:
    for index in range(start, len(lines)):
        if lines[index].strip():
            return index
    return None


def _attribution_at(lines: list[str], index: int) -> int:
    """How many lines the attribution starting at ``index`` spans (0: none).
    Gmail wraps a long one as ``On …, Name <addr>`` + ``wrote:``."""
    line = lines[index].strip()
    if any(r.match(line) for r in _ATTRIBUTION_RES):
        span = 1
    elif index + 1 < len(lines) and line.lower().startswith("on ") and any(
        r.match(f"{line} {lines[index + 1].strip()}") for r in _ATTRIBUTION_RES
    ):
        span = 2
    else:
        return 0
    following = _next_nonblank(lines, index + span)
    return span if following is not None and _is_quote(lines[following]) else 0


def _outlook_header_at(lines: list[str], index: int) -> bool:
    line = lines[index].strip()
    if _ORIGINAL_MESSAGE_RE.match(line):
        return True
    if _UNDERSCORE_RULE_RE.match(line):
        following = _next_nonblank(lines, index + 1)
        return following is not None and bool(_HEADER_LINE_RES["from"].match(lines[following].strip()))
    if _HEADER_LINE_RES["from"].match(line):
        window = [ln.strip() for ln in lines[index + 1:index + 5]]
        return any(_HEADER_LINE_RES["sent"].match(w) for w in window) and any(
            _HEADER_LINE_RES["subject"].match(w) for w in window
        )
    return False


def strip_quoted(text: str) -> str:
    """The new text of a reply (see the module docstring). Never empty when
    ``text`` has any content."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    kept: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if _FORWARD_RE.match(line.strip()):
            kept.extend(lines[index:])
            break
        if line.rstrip() in ("-- ", "--") and any(k.strip() for k in kept):
            break  # signature
        if _outlook_header_at(lines, index):
            break
        span = _attribution_at(lines, index)
        if span:
            rest = [ln for ln in lines[index + span:] if ln.strip()]
            if all(_is_quote(ln) for ln in rest):
                break  # top-posted reply: everything below is history
            index += span  # bottom-posting: drop the attribution, keep answers
            continue
        if not _is_quote(line):
            kept.append(line)
        index += 1
    result = "\n".join(kept).strip("\n")
    result = re.sub(r"\n{3,}", "\n\n", result).strip()
    return result if result else text.strip()


class _HtmlToText(HTMLParser):
    _SKIP = {"script", "style", "head", "title", "template", "noscript"}
    _BLOCK = {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table",
              "ul", "ol", "pre", "section", "article", "header", "footer", "dl", "dt", "dd"}

    def __init__(self, *, strip_history: bool) -> None:
        super().__init__(convert_charrefs=True)
        self.strip_history = strip_history
        self.parts: list[str] = []
        self._skip_depth = 0           # inside script/style/…
        self._quote_stack: list[str] = []  # open tags of a quoted subtree
        self._stopped = False          # Outlook's history marker reached
        self._links: list[tuple[str, int]] = []

    def _history_start(self, tag: str, attrs: dict) -> bool:
        if not self.strip_history:
            return False
        classes = (attrs.get("class") or "").split()
        if tag == "blockquote" or (tag == "div" and "gmail_quote" in classes):
            return True
        return False

    def handle_starttag(self, tag, attrs):
        if self._stopped:
            return
        attr = {k: (v or "") for k, v in attrs}
        if self.strip_history and (
            (tag == "div" and attr.get("id") == "divRplyFwdMsg")
            or (tag == "hr" and attr.get("id") == "stopSpelling")
        ):
            self._stopped = True
            return
        if self._quote_stack:
            if tag not in _VOID:
                self._quote_stack.append(tag)
            return
        if self._history_start(tag, attr):
            self._quote_stack.append(tag)
            return
        if tag in self._SKIP:
            self._skip_depth += 1
            return
        if tag == "br":
            self.parts.append("\n")
        elif tag in self._BLOCK:
            self.parts.append("\n")
        elif tag == "a":
            self._links.append((attr.get("href", ""), len(self.parts)))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in _VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self._stopped:
            return
        if self._quote_stack:
            if tag in self._quote_stack:
                while self._quote_stack and self._quote_stack.pop() != tag:
                    pass
            return
        if tag in self._SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag in self._BLOCK:
            self.parts.append("\n")
        elif tag == "a" and self._links:
            href, start = self._links.pop()
            label = "".join(self.parts[start:]).strip()
            if href.lower().startswith(("http://", "https://", "mailto:")) and href != label:
                target = href[len("mailto:"):] if href.lower().startswith("mailto:") else href
                if target != label:
                    self.parts.append(f" ({href})")

    def handle_data(self, data):
        if self._stopped or self._quote_stack or self._skip_depth:
            return
        self.parts.append(re.sub(r"[ \t\r\n\f]+", " ", data))

    def text(self) -> str:
        raw = "".join(self.parts)
        lines = [line.strip() for line in raw.split("\n")]
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
         "source", "track", "wbr"}


def html_to_text(html: str, *, strip_history: bool = False) -> str:
    parser = _HtmlToText(strip_history=strip_history)
    parser.feed(html)
    parser.close()
    return parser.text()


def new_text(text: Optional[str], html: Optional[str]) -> str:
    """The new text of a mail: from ``text`` when it has any, else from
    ``html``; quoted history stripped, but never to nothing."""
    if text and text.strip():
        return strip_quoted(text)
    if html and html.strip():
        stripped = html_to_text(html, strip_history=True)
        if stripped.strip():
            return strip_quoted(stripped)
        return html_to_text(html)
    return ""


def clean_filename(raw: str) -> str:
    """An attachment name as plain text: control/format characters removed,
    whitespace collapsed, at most 100 characters."""
    import unicodedata

    kept = "".join(
        " " if ch.isspace() else ch for ch in unicodedata.normalize("NFC", raw or "")
        if unicodedata.category(ch) not in ("Cc", "Cf", "Zl", "Zp") or ch.isspace()
    )
    return " ".join(kept.split())[:MAX_FILENAME_CHARS] or "attachment"


def human_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} bytes"


def attachment_line(filename: str, content_type: str, size: int) -> str:
    kind = clean_filename(content_type or "application/octet-stream")[:60]
    return f"[attachment: {clean_filename(filename)}, {kind}, {human_size(size)}]"


def cap_text(text: str, max_bytes: int = MAX_AGENT_TEXT_BYTES) -> str:
    """At most ``max_bytes`` of UTF-8 (never mid-character), with a visible
    marker when cut."""
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text
    room = max_bytes - len(TRUNCATED_MARKER.encode("utf-8"))
    return raw[:room].decode("utf-8", errors="ignore").rstrip() + TRUNCATED_MARKER
