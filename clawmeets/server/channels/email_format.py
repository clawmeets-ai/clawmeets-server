# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/email_format.py
An agent's (markdown) reply as the two parts of an email: text/plain and
text/html.

Length is not a practical limit for email, so a reply is ONE part; a reply over
``MAX_REPLY_MARKDOWN_BYTES`` raises, which the gateway turns into one
``failed``/``format_error`` row.

**HTML** escapes everything the agent wrote. It is NOT the notification
renderer (``utils/email.render_markdown_html``, commonmark with raw HTML on):
an agent reply can quote a contact's ``<img src=tracker>`` or a
``javascript:`` link, and that must go out as text. Here markdown-it runs with
``html=False`` and links only for ``http``, ``https`` and ``mailto`` — any
other scheme stays literal text. An image ``![alt](url)`` is never an
``<img>`` (a remote image is a tracking pixel): it becomes a link labelled
with its alt text (the URL when the alt is empty), under the same scheme rule.
``~~strike~~`` is ``<s>``; a bare ``http(s)://`` URL in text (not in a link or
code) becomes a link, trailing sentence punctuation and an unbalanced ``)``
left outside it. Tables carry inline borders and padding (the only styling
Gmail and Outlook both honour). The document is minimal and self-contained
(no remote CSS, nothing we host), so a reply looks like a person's reply, not
a newsletter.

**Plain text** keeps the markdown readable: headings as ``#`` lines, list
markers, code blocks fenced, links and images as ``text (url)``, table rows as
``a | b``, emphasis and strikethrough markers dropped.
"""
from __future__ import annotations

import re
from typing import Optional

from markdown_it import MarkdownIt
from markdown_it.rules_core import StateCore
from markdown_it.token import Token

MAX_REPLY_MARKDOWN_BYTES = 1024 * 1024
_SAFE_SCHEMES = ("http://", "https://", "mailto:")

_HTML_SHELL = (
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
    '<body><div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; '
    'line-height: 1.5;">{body}</div></body></html>'
)


_BARE_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_TRAILING = ".,;:!?*_~"  # sentence punctuation / emphasis left after a bare URL

_TABLE_STYLES = {
    "table_open": "border-collapse: collapse; border: 1px solid #ddd;",
    "th_open": "border: 1px solid #ddd; padding: 4px 8px; background-color: #f5f5f5;",
    "td_open": "border: 1px solid #ddd; padding: 4px 8px;",
}


def _bare_url_end(url: str) -> int:
    """Length of ``url`` once trailing punctuation and an unbalanced ``)``
    are trimmed off."""
    end = len(url)
    while end:
        ch = url[end - 1]
        if ch in _TRAILING:
            end -= 1
        elif ch == ")" and url.count("(", 0, end) < url.count(")", 0, end):
            end -= 1
        else:
            break
    return end


def _images_as_links(state: StateCore) -> None:
    """Every image becomes a link labelled with its alt text (no ``<img>``,
    so no remote fetch). Inside a link it is just its alt text."""
    for block in state.tokens:
        if block.type != "inline" or not block.children:
            continue
        out: list[Token] = []
        depth = 0
        for tok in block.children:
            if tok.type == "link_open":
                depth += 1
            elif tok.type == "link_close":
                depth -= 1
            if tok.type != "image":
                out.append(tok)
                continue
            label = list(tok.children or [])
            src = tok.attrGet("src") or ""
            if not "".join(t.content for t in label).strip():
                text = Token("text", "", 0)
                text.content = src
                label = [text]
            if depth:
                out.extend(label)
                continue
            link = Token("link_open", "a", 1)
            link.attrSet("href", src)
            out.append(link)
            out.extend(label)
            out.append(Token("link_close", "a", -1))
        block.children = out


def _autolink_bare_urls(state: StateCore) -> None:
    """Bare http(s) URLs in text become links (HTML only: ``env["autolink"]``)."""
    if not state.env.get("autolink"):
        return
    for block in state.tokens:
        if block.type != "inline" or not block.children:
            continue
        out: list[Token] = []
        depth = 0
        for tok in block.children:
            if tok.type == "link_open":
                depth += 1
            elif tok.type == "link_close":
                depth -= 1
            if tok.type != "text" or depth or "://" not in tok.content:
                out.append(tok)
                continue
            text, pos = tok.content, 0
            for m in _BARE_URL_RE.finditer(text):
                start = m.start()
                if start and (text[start - 1].isalnum() or text[start - 1] in "/@="):
                    continue  # mid-word, or an attribute value quoted as text (src=…)
                url = m.group(0)[:_bare_url_end(m.group(0))]
                if len(url) <= len(m.group(0).split("://", 1)[0]) + 3:
                    continue  # nothing after the scheme
                if start > pos:
                    before = Token("text", "", 0)
                    before.content = text[pos:start]
                    out.append(before)
                link = Token("link_open", "a", 1)
                link.attrSet("href", state.md.normalizeLink(url))
                label = Token("text", "", 0)
                label.content = url
                out.extend([link, label, Token("link_close", "a", -1)])
                pos = start + len(url)
            if pos < len(text):
                rest = Token("text", "", 0)
                rest.content = text[pos:]
                out.append(rest)
        block.children = out


def _style_tables(state: StateCore) -> None:
    for tok in state.tokens:
        style = _TABLE_STYLES.get(tok.type)
        if style is not None:
            align = tok.attrGet("style")  # "text-align:right" from the separator row
            if not align and tok.type == "th_open":
                align = "text-align: left"  # clients centre <th> by default
            tok.attrSet("style", f"{style} {align};" if align else style)


def _markdown() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
    md.validateLink = lambda url: url.strip().lower().startswith(_SAFE_SCHEMES)
    md.core.ruler.push("images_as_links", _images_as_links)
    md.core.ruler.push("autolink_bare_urls", _autolink_bare_urls)
    md.core.ruler.push("style_tables", _style_tables)
    return md


_MD = _markdown()


def check_size(markdown: str) -> None:
    if len(markdown.encode("utf-8")) > MAX_REPLY_MARKDOWN_BYTES:
        raise ValueError("reply too large for one email")


def render_html(markdown: str) -> str:
    return _HTML_SHELL.format(body=_MD.render(markdown, {"autolink": True}))


def _inline_text(token) -> str:
    out: list[str] = []
    links: list[tuple[str, int]] = []
    for child in token.children or []:
        kind = child.type
        if kind == "text":
            out.append(child.content)
        elif kind == "code_inline":
            out.append(f"`{child.content}`")
        elif kind in ("softbreak", "hardbreak"):
            out.append("\n")
        elif kind == "link_open":
            links.append((child.attrGet("href") or "", len(out)))
        elif kind == "link_close" and links:
            href, start = links.pop()
            label = "".join(out[start:])
            shown = href[len("mailto:"):] if href.lower().startswith("mailto:") else href
            if label in (href, shown):
                out[start:] = [shown]  # an autolink: the address once, without "mailto:"
            elif shown:
                out.append(f" ({href})")
    return "".join(out)


def render_text(markdown: str) -> str:
    blocks: list[str] = []
    quote = ""                      # "> " per open blockquote
    lists: list[int] = []           # per open list: next number, or 0 for bullets
    marker: Optional[str] = None    # the pending list-item / heading marker
    indent = ""                     # continuation indent inside a list item
    row: list[str] = []
    in_cell = False
    tight = False                   # in a tight list paragraph / a table row
    joins: list[bool] = []          # per block: attach to the one before with one newline
    list_start = False              # the next block opens a top-level list
    for token in _MD.parse(markdown):
        kind = token.type
        if kind == "heading_open":
            marker = "#" * int(token.tag[1]) + " "
        elif kind == "blockquote_open":
            quote += "> "
        elif kind == "blockquote_close":
            quote = quote[:-2]
        elif kind == "bullet_list_open":
            lists.append(0)
            list_start = len(lists) == 1
        elif kind == "ordered_list_open":
            lists.append(int(token.attrGet("start") or 1))
            list_start = len(lists) == 1
        elif kind in ("bullet_list_close", "ordered_list_close"):
            lists.pop()
            indent = "  " * len(lists)
        elif kind == "list_item_open":
            depth = "  " * (len(lists) - 1)
            if lists[-1]:
                marker = f"{depth}{lists[-1]}. "
                lists[-1] += 1
            else:
                marker = f"{depth}- "
            indent = " " * len(marker)
        elif kind == "tr_open":
            row = []
        elif kind == "paragraph_open":
            tight = bool(token.hidden)
        elif kind == "table_open":
            tight = False
        elif kind == "tr_close":
            blocks.append(quote + " | ".join(row))
            joins.append(tight)
            tight = True
        elif kind in ("th_open", "td_open"):
            in_cell = True
        elif kind in ("th_close", "td_close"):
            in_cell = False
        elif kind == "inline":
            text = _inline_text(token)
            if in_cell:
                row.append(text.replace("\n", " "))
                continue
            lead = quote + (marker if marker is not None else indent)
            marker = None
            rest = quote + (indent if lists else "")
            lines = text.split("\n")
            blocks.append("\n".join([lead + lines[0]] + [rest + ln for ln in lines[1:]]))
            joins.append(tight and len(blocks) > 1 and not list_start)
            list_start = False
        elif kind in ("fence", "code_block"):
            info = token.info.strip() if kind == "fence" else ""
            pad = quote + (indent if lists else "")
            body = "\n".join(pad + ln for ln in token.content.rstrip("\n").split("\n"))
            blocks.append(f"{pad}```{info}\n{body}\n{pad}```")
            joins.append(False)
        elif kind == "hr":
            blocks.append(quote + "---")
            joins.append(False)
    out = ""
    for index, (block, join) in enumerate(zip(blocks, joins)):
        out += block if index == 0 else ("\n" if join else "\n\n") + block
    return out.strip()


def render(markdown: str) -> tuple[str, str]:
    """(text/plain, text/html) for one reply."""
    check_size(markdown)
    return render_text(markdown), render_html(markdown)

