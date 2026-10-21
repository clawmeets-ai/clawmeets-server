# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/message_forward.py
What a forwarded message says, and which files ride with it.

The user's Forward button hands one agent's message to another of the user's
agents. The user sends it from their own session, so it is an ordinary user
post in their DM with the recipient — the only thing that makes it a forward is
the body, which the SERVER writes from the stored original. The browser names
the source message; it never supplies the quoted text, so the quote cannot be
edited on the way.

Pure functions over chat-log entries: the route authorizes and loads, this
module decides the content. Kept apart from ``routes/messages.py`` so the
quoting format and the attachment rule have one home and one test file.
"""
from __future__ import annotations

from collections.abc import Sequence

from clawmeets.models.chat_message import ChatFileEvent, ChatLogEntry, ChatMessage


def find_messages(entries: Sequence[ChatLogEntry], message_ids: Sequence[str]) -> list[ChatMessage]:
    """The messages named by ``message_ids``, in log order.

    Raises ``KeyError`` naming the first id the log does not contain, so the
    route can answer 404 instead of forwarding a partial quote.
    """
    wanted = set(message_ids)
    found = [e for e in entries if isinstance(e, ChatMessage) and e.id in wanted]
    missing = wanted - {m.id for m in found}
    if missing:
        raise KeyError(sorted(missing)[0])
    return found


def attached_filenames(entries: Sequence[ChatLogEntry], messages: Sequence[ChatMessage]) -> list[str]:
    """Filenames that rode in with ``messages``, deduplicated, in log order.

    Same pairing rule the web UI uses to draw file pills under a message
    (``MessageList.tsx``): a file event belongs to a message from the same
    sender when it shares the message's ``source_version`` (an agent reply and
    its ``update_file`` both point at the triggering mention) or points at the
    message's own ``version`` (a user's attachment, appended atomically with
    the message it rides).
    """
    out: list[str] = []
    for event in entries:
        if not isinstance(event, ChatFileEvent) or event.source_version is None:
            continue
        if event.filename in out:
            continue
        for m in messages:
            if m.from_participant_id != event.from_participant_id:
                continue
            if event.source_version in (m.source_version, m.version):
                out.append(event.filename)
                break
    return out


def compose_forward(note: str, sender_label: str, messages: Sequence[ChatMessage]) -> str:
    """The forwarded message body: the user's note, then the original as a quote.

    The quote is a markdown blockquote under a ``Forwarded from <sender>``
    header, so it renders as a quote in the web UI and reads unambiguously to
    the recipient agent as someone else's words. Several messages (a coalesced
    group) are quoted in order, separated by a blank quoted line.
    """
    quoted_bodies = [_blockquote(m.content.strip()) for m in messages if m.content.strip()]
    quote = f"> **Forwarded from {sender_label}**\n>\n" + "\n>\n".join(quoted_bodies)
    note = note.strip()
    return f"{note}\n\n{quote}" if note else quote


def _blockquote(text: str) -> str:
    return "\n".join(f"> {line}" if line else ">" for line in text.splitlines())
