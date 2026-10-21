# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/recent_activity.py
Build a reflection-shaped transcript of an agent's recent participation.

The reformatter is a pure function so it can be unit-tested in isolation
and reused by both the HTTP endpoint and the reflection scheduler.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

from clawmeets.models.chat_message import ChatFileEvent, ChatMessage
from clawmeets.sync.changelog import sender_label

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext

# Truncate any single message body longer than this in the rendered transcript.
SINGLE_MESSAGE_TRUNCATE_CHARS = 800

# Cap the rendered transcript at this many lines (keeps prompt windows sane).
DEFAULT_LINE_LIMIT = 800


@dataclass
class RecentActivityRow:
    """One reflection-shaped row, suitable for both text and JSON rendering."""
    project_id: str
    project_name: str
    chatroom_name: str
    from_participant_id: str
    from_participant_name: str
    content: str
    created_at: datetime
    version: int | None
    source_version: int | None
    entry_type: str  # "message" | "file_created" | "file_updated"

    def to_dict(self) -> dict:
        return {
            "project_id": self.project_id,
            "project_name": self.project_name,
            "chatroom_name": self.chatroom_name,
            "from_participant_id": self.from_participant_id,
            "from_participant_name": self.from_participant_name,
            "content": self.content,
            "created_at": self.created_at.isoformat(),
            "version": self.version,
            "source_version": self.source_version,
            "entry_type": self.entry_type,
        }


def collect_recent_activity(
    agent_id: str,
    since: datetime | None,
    ctx: "ModelContext",
    *,
    max_count: int | None = None,
) -> list[RecentActivityRow]:
    """Walk every chatroom the agent participates in and collect activity rows.

    Skips ack messages and BATCH_COMPLETE / BATCH_TIMEOUT system noise, every
    memory-excluded project (hub threads are born marked) and every row by a
    hub stand-in or another account's agent wherever it appears, a room-bridge
    reply in a workroom included (``excluded_from_memory``): a remote agent's
    words never reach an agent's reflection or memory.
    Returns rows in chronological order (oldest first) for rendering.

    Modes (exactly one must be set):
    - ``since`` only: rows with ``ts > since``. Used by the recent-activity
      HTTP endpoint.
    - ``max_count`` only: the ``max_count`` most-recent rows regardless of age.
      Used by the reflection scheduler so Reflect / Promote / Correct modes
      all reason from the same window.
    """
    if (since is None) == (max_count is None):
        raise ValueError("collect_recent_activity: pass exactly one of since= or max_count=")

    from clawmeets.models.project import Project
    from clawmeets.models.provenance import is_memory_excluded, row_excluded_from_memory

    rows: list[RecentActivityRow] = []
    for room in Project.get_agent_memberships(agent_id, ctx):
        # Resolve the project name for the room (for grouping in the output).
        project = Project.get(room.project_id, ctx)
        if project is None or is_memory_excluded(project):
            continue
        for entry in room.get_log_entries():
            # Per row: a hub stand-in's or another account's agent's words
            # never reach a durable input (models/provenance.py).
            if isinstance(entry, (ChatMessage, ChatFileEvent)) and row_excluded_from_memory(project, entry, ctx):
                continue
            if isinstance(entry, ChatMessage):
                if entry.is_ack:
                    continue
                if since is not None and entry.ts <= since:
                    continue
                content = entry.content
                if len(content) > SINGLE_MESSAGE_TRUNCATE_CHARS:
                    content = content[:SINGLE_MESSAGE_TRUNCATE_CHARS] + "…[truncated]"
                rows.append(RecentActivityRow(
                    project_id=room.project_id,
                    project_name=project.name,
                    chatroom_name=room.name,
                    from_participant_id=entry.from_participant_id,
                    from_participant_name=entry.from_participant_name,
                    content=content,
                    created_at=entry.ts,
                    version=entry.version,
                    source_version=entry.source_version,
                    entry_type="message",
                ))
            elif isinstance(entry, ChatFileEvent):
                if since is not None and entry.ts <= since:
                    continue
                rows.append(RecentActivityRow(
                    project_id=room.project_id,
                    project_name=project.name,
                    chatroom_name=room.name,
                    from_participant_id=entry.from_participant_id,
                    from_participant_name=entry.from_participant_name,
                    content=entry.filename,
                    created_at=entry.ts,
                    version=entry.version,
                    source_version=entry.source_version,
                    entry_type=entry.entry_type,
                ))
    rows.sort(key=lambda r: r.created_at)
    if max_count is not None and len(rows) > max_count:
        rows = rows[-max_count:]
    return rows


def latest_message_ts(agent_id: str, ctx: "ModelContext") -> datetime | None:
    """Return the timestamp of the agent's most-recent non-ack activity row.

    Walks every chatroom the agent participates in and tracks the max
    timestamp across non-ack messages and file events, skipping hub requester
    threads like ``collect_recent_activity``. Returns None if the
    agent has no qualifying activity. Used as the reflection scheduler's
    activity gate — single-row check, cheaper than rendering when the agent
    is idle.
    """
    from clawmeets.models.project import Project
    from clawmeets.models.provenance import is_memory_excluded, row_excluded_from_memory

    latest: datetime | None = None
    for room in Project.get_agent_memberships(agent_id, ctx):
        try:
            project = Project.get(room.project_id, ctx)
        except ValueError:          # deleted since the membership scan
            continue
        if is_memory_excluded(project):
            continue
        for entry in room.get_log_entries():
            if isinstance(entry, (ChatMessage, ChatFileEvent)) and row_excluded_from_memory(project, entry, ctx):
                continue
            if isinstance(entry, ChatMessage):
                if entry.is_ack:
                    continue
            elif not isinstance(entry, ChatFileEvent):
                continue
            if latest is None or entry.ts > latest:
                latest = entry.ts
    return latest


def render_text_transcript(
    rows: list[RecentActivityRow],
    *,
    agent_short_name: str,
    since: datetime | None = None,
    max_count: int | None = None,
    line_limit: int = DEFAULT_LINE_LIMIT,
) -> str:
    """Format rows as a markdown transcript suitable for LLM ingestion.

    Header style depends on which window-mode produced the rows:
    - ``since`` set → ``== Recent activity for X (since <iso>) ==`` (HTTP endpoint).
    - ``max_count`` set → ``== Recent activity for X (last N messages) ==``
      (reflection scheduler — same window for Reflect / Promote / Correct).

    Body shape is otherwise identical: groups ordered most-recent-first,
    chronological within group, capped at ``line_limit`` lines.
    """
    if (since is None) == (max_count is None):
        raise ValueError("render_text_transcript: pass exactly one of since= or max_count=")

    if max_count is not None:
        header = f"== Recent activity for {agent_short_name} (last {max_count} messages) =="
    else:
        header = f"== Recent activity for {agent_short_name} (since {since.isoformat()}) =="

    if not rows:
        return f"{header}\n\n(no recent activity)"

    # Group by (project_name, chatroom_name); track the most recent ts per group
    grouped: dict[tuple[str, str], list[RecentActivityRow]] = {}
    last_ts: dict[tuple[str, str], datetime] = {}
    for row in rows:
        key = (row.project_name, row.chatroom_name)
        grouped.setdefault(key, []).append(row)
        if key not in last_ts or row.created_at > last_ts[key]:
            last_ts[key] = row.created_at

    sorted_keys = sorted(grouped.keys(), key=lambda k: last_ts[k], reverse=True)

    body_lines: list[str] = []
    truncated_count = 0
    for key in sorted_keys:
        if len(body_lines) >= line_limit:
            truncated_count += sum(len(grouped[k]) for k in sorted_keys[sorted_keys.index(key):])
            break
        project_name, chatroom_name = key
        body_lines.append(_render_group_header(project_name, chatroom_name))
        for row in grouped[key]:
            if len(body_lines) >= line_limit:
                truncated_count += 1
                continue
            body_lines.append(_render_row(row))
        body_lines.append("")  # Blank line between groups

    parts = [header, ""]
    parts.extend(body_lines)
    if truncated_count:
        parts.append(f"... ({truncated_count} more entries truncated, raise --limit to see more)")
    parts.append("(end of recent activity)")
    return "\n".join(parts)


def _render_group_header(project_name: str, chatroom_name: str) -> str:
    """Header line for a (project, chatroom) group."""
    return f"# project: {project_name} / room: {chatroom_name}"


def _render_row(row: RecentActivityRow) -> str:
    """Render a single row as a transcript line."""
    ts = row.created_at.strftime("%Y-%m-%d %H:%M")
    sender = sender_label(row.from_participant_id, row.from_participant_name)
    if row.entry_type == "message":
        return f"[{ts}] {sender}: {row.content}"
    elif row.entry_type == "file_created":
        return f"[{ts}] *{sender} uploaded {row.content}*"
    elif row.entry_type == "file_updated":
        return f"[{ts}] *{sender} updated {row.content}*"
    return f"[{ts}] {row.from_participant_name}: {row.content}"
