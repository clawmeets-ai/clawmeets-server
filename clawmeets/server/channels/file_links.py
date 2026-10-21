# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/file_links.py
Files the agent shares in a channel thread, sent to the contact as links.

No channel sends a file natively (an adapter sends text only), so a file the
agent shares in a channel thread's user-communication room is delivered as a
list after its reply — the file's name and a signed download link::

    **Attached files**
    - [report.pdf](https://…/api/channels/webhooks/file?t=…)

The list is ordinary markdown, so each channel renders it its own way (a link
on Telegram, email and the web chat; ``name (url)`` on WhatsApp and LINE).

**The link is the credential.** Anyone holding it can download that one file
until it expires (``FILE_LINK_TTL_SECONDS``); nothing else. The token names
the project, room and file, the first 32 hex characters of the file's SHA-256
when the link was made, and its expiry, and carries an HMAC of all of that
under the server's channel secret key. It is checked against every configured
key, current first, so rotating the keys does not break links already sent.
The file is served only while its content still has that hash: an agent that
later overwrites ``report.pdf`` does not hand the new version to a link made
for the old one (410).

The path sits under the webhook prefix on purpose: the access log replaces the
query string — the token — of any webhook path with ``?<redacted>``.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Optional, Sequence
from urllib.parse import quote

from .log_redaction import WEBHOOK_PATH_PREFIX

FILE_LINK_PATH = WEBHOOK_PATH_PREFIX + "/file"
FILE_LINK_TTL_SECONDS = 7 * 24 * 3600
ATTACHMENTS_HEADING = "**Attached files**"
_HASH_CHARS = 32
_PURPOSE = b"channel-file-link:"


@dataclass(frozen=True)
class FileLink:
    """What a verified token grants: one file, as it was when linked."""

    project_id: str
    chatroom_name: str
    filename: str
    sha256_prefix: str
    expires_at: int

    def matches(self, sha256: str) -> bool:
        return hmac.compare_digest(sha256[:_HASH_CHARS].lower(), self.sha256_prefix)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(key: str, body: str) -> str:
    return _b64(hmac.new(key.encode("utf-8"), _PURPOSE + body.encode("ascii"), hashlib.sha256).digest())


def make_token(
    key: str, *, project_id: str, chatroom_name: str, filename: str, sha256: str, now: float,
    ttl: int = FILE_LINK_TTL_SECONDS,
) -> str:
    claims = {
        "p": project_id, "r": chatroom_name, "f": filename,
        "h": sha256[:_HASH_CHARS].lower(), "e": int(now) + ttl,
    }
    body = _b64(json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    return f"{body}.{_mac(key, body)}"


def read_token(keys: Sequence[str], token: str, *, now: float) -> Optional[FileLink]:
    """The grant in ``token``, or None if it is malformed, signed under none of
    ``keys`` or expired. Never raises on what a stranger sends."""
    body, dot, mac = (token or "").partition(".")
    if not dot or not body or not mac or len(token) > 4096:
        return None
    try:
        body.encode("ascii")
    except UnicodeEncodeError:
        return None
    if not any(hmac.compare_digest(_mac(key, body), mac) for key in keys):
        return None
    try:
        claims = json.loads(_unb64(body))
        link = FileLink(
            project_id=str(claims["p"]), chatroom_name=str(claims["r"]),
            filename=str(claims["f"]), sha256_prefix=str(claims["h"]),
            expires_at=int(claims["e"]),
        )
    except (ValueError, KeyError, TypeError):
        return None
    return link if now < link.expires_at else None


def file_url(server_url: str, token: str) -> str:
    return f"{server_url.rstrip('/')}{FILE_LINK_PATH}?t={quote(token, safe='.')}"


def _label(filename: str) -> str:
    """The file's name as a link label: its last path segment, with the
    characters markdown would read as syntax escaped."""
    name = filename.rsplit("/", 1)[-1] or filename
    name = " ".join(name.split())  # no line breaks in a label
    return "".join("\\" + c if c in "\\[]*_`~<>|" else c for c in name)


def attachments_markdown(files: Sequence[tuple[str, str]]) -> str:
    """The section listing ``(filename, url)`` pairs, in order. A file with
    no url ("") is listed by name alone."""
    lines = [ATTACHMENTS_HEADING]
    lines += [f"- [{_label(name)}]({url})" if url else f"- {_label(name)}" for name, url in files]
    return "\n".join(lines)
