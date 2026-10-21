# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/in_flight_restore.py

Rebuild the pending batches of LLM turns a runner reports as still running
when it (re)connects.

``WorkTracker`` is in-memory, so a server restart forgets every open batch
while the runners keep working. The desk derives "Working" from that tracker
alone, so a live project fell out of Working and was misfiled under Review
until the agent replied. The runner is the only party that knows a turn is
actually alive, so its report — ``in_flight_turns`` in the WS auth frame — is
the source of truth: persisting the tracker instead would also restore
batches whose runners died during the outage.

Only the reporting agent is restored, not the whole original batch: the
restored batch closes on this agent's reply alone, which is the same shape
``record_response_opening_if_missing`` produces today for a reply with no
open batch.

Kept beside ``batch_timeout.py`` / ``participant_liveness.py`` so
``routes/websocket.py`` stays transport-only and ``WorkTracker`` stays free of
server imports.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from clawmeets.server.batch_timeout import resolve_batch_timeout
from clawmeets.sync.changelog import ChangelogEntryType

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

# A runner holds at most one turn per (project, room); anything past this is
# not a real report.
MAX_REPORTED_TURNS = 32


@dataclass(frozen=True)
class ReportedTurn:
    project_id: str
    chatroom_name: str
    trigger_version: int
    started_at: datetime


def parse_in_flight_turns(raw: object) -> list[ReportedTurn]:
    """Lenient parse of the auth frame's ``in_flight_turns``.

    A missing field or a non-list (an older runner) is ``[]``. Malformed
    entries are dropped one by one; the list is capped at
    ``MAX_REPORTED_TURNS``. Never raises — a bad report must not fail the
    connection.
    """
    if not isinstance(raw, list):
        return []
    turns: list[ReportedTurn] = []
    for item in raw[:MAX_REPORTED_TURNS]:
        if not isinstance(item, dict):
            continue
        project_id = item.get("project_id")
        chatroom_name = item.get("chatroom_name")
        trigger_version = item.get("trigger_version")
        if not (isinstance(project_id, str) and project_id
                and isinstance(chatroom_name, str) and chatroom_name):
            continue
        if isinstance(trigger_version, bool) or not isinstance(trigger_version, int) \
                or trigger_version <= 0:
            continue
        try:
            started_at = datetime.fromisoformat(item.get("started_at"))
        except (TypeError, ValueError):
            continue
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=UTC)
        # A future start time would postpone the timeout; clamp to now.
        started_at = min(started_at, datetime.now(UTC))
        turns.append(ReportedTurn(project_id, chatroom_name, trigger_version, started_at))
    return turns


async def restore_in_flight_turns(
    agent_id: str, turns: list[ReportedTurn], ctx: "ServerContext"
) -> int:
    """Restore a pending batch for each reported turn; return how many.

    Never raises: each turn is attempted and logged on its own.
    """
    restored = 0
    for turn in turns:
        try:
            if await _restore_one(agent_id, turn, ctx):
                restored += 1
        except Exception:
            logger.exception(
                "in_flight_restore: failed for agent=%s project=%s room=%s",
                agent_id[:8], turn.project_id[:8], turn.chatroom_name,
            )
    return restored


async def _restore_one(agent_id: str, turn: ReportedTurn, ctx: "ServerContext") -> bool:
    from clawmeets.models.chatroom import Chatroom
    from clawmeets.models.project import Project

    tag = f"agent={agent_id[:8]} project={turn.project_id[:8]} room={turn.chatroom_name}"
    try:
        project = Project.get(turn.project_id, ctx.model_ctx)
    except ValueError:
        logger.info(f"in_flight_restore: skip {tag}: unknown project")
        return False
    room = Chatroom.get(turn.project_id, turn.chatroom_name, ctx.model_ctx)
    if room is None or agent_id not in room.participants:
        logger.info(f"in_flight_restore: skip {tag}: not a member of the room")
        return False

    # Mirror routes/messages.py: the room coordinator's own turn uses the
    # self-batch shape (owner as coordinator_id) so its reply cannot wake
    # itself; any other agent's batch reports to the room coordinator.
    if agent_id == project.coordinator_id:
        coordinator_id = project.created_by
    else:
        coordinator_id = project.coordinator_id
    if not coordinator_id:
        logger.info(f"in_flight_restore: skip {tag}: no coordinator to report to")
        return False

    runloop = await ctx.runloop_manager.get_or_create(project.id, project.name)
    entries = await asyncio.to_thread(
        runloop.get_entries_since, turn.trigger_version - 1
    )
    trigger = next((e for e in entries if e.version == turn.trigger_version), None)
    if trigger is None:
        logger.info(f"in_flight_restore: skip {tag}: no entry at v{turn.trigger_version}")
        return False

    # Race guard: the turn may have finished and posted while the auth frame
    # was in transit. Restoring then would leave a stale Working until timeout.
    for e in entries:
        if (
            e.version > turn.trigger_version
            and e.entry_type == ChangelogEntryType.MESSAGE
            and e.payload.chatroom_name == turn.chatroom_name
            and e.payload.from_participant_id == agent_id
            and not e.payload.is_ack
        ):
            logger.info(f"in_flight_restore: skip {tag}: already replied at v{e.version}")
            return False

    # The batch's message_id is the one BATCH_COMPLETE will cite: the
    # triggering message itself, or the message a BATCH_COMPLETE/TIMEOUT
    # trigger was about.
    message_id = getattr(trigger.payload, "id", None) or getattr(
        trigger.payload, "message_id", None
    )
    if not isinstance(message_id, str):
        logger.info(f"in_flight_restore: skip {tag}: v{turn.trigger_version} names no message")
        return False

    await ctx.work_tracker.restore_in_flight(
        message_id=message_id,
        message_version=turn.trigger_version,
        project_id=project.id,
        project_name=project.name,
        chatroom_name=turn.chatroom_name,
        coordinator_id=coordinator_id,
        participant_id=agent_id,
        started_at=turn.started_at,
        timeout_seconds=resolve_batch_timeout(
            [agent_id], default=ctx.batch_timeout, model_ctx=ctx.model_ctx,
        ),
    )
    logger.info(f"in_flight_restore: restored {tag} (v{turn.trigger_version})")
    return True
