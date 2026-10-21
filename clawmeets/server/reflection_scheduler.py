# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/reflection_scheduler.py
Background loop that fires user-level reflection schedules.

When a ReflectionSchedule fires, the scheduler walks the user's agents and
posts a reflection trigger to each agent's DM chatroom — but only for those
with new activity since their last reflection (activity-gated to avoid
spamming idle agents).

The trigger message body contains the rendered recent-activity transcript
(produced by `recent_activity.render_text_transcript`) plus the marker
`<!-- clawmeets:reflect-trigger -->` so `ReflectionCompletionSubscriber` can
detect the agent's reply and update `Agent.last_reflected_at`.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from clawmeets.models.agent import Agent
from clawmeets.models.reflection_schedule import ReflectionSchedule
from clawmeets.models.user import User
from .recent_activity import (
    collect_recent_activity,
    latest_message_ts,
    render_text_transcript,
)
from .routes.projects import _ensure_own_dm_project

# Window size for the reflection trigger transcript. The agent applies its
# own narrowness via cursor comparison against `last_reflected_at`.
REFLECT_WINDOW_MESSAGES = 100

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.models.reflection_schedule import ReflectionScheduleStore
    from clawmeets.sync.runloop_manager import ChangelogRunloopManager
    from clawmeets.server.ws_hub import WSHub

logger = logging.getLogger("clawmeets.server.reflection_scheduler")

# Marker that ReflectionCompletionSubscriber matches on. HTML comment so
# it's invisible in the rendered chat surface but preserved in CHATS.ndjson.
REFLECT_TRIGGER_MARKER = "<!-- clawmeets:reflect-trigger -->"


def build_trigger_message(transcript: str) -> str:
    """Compose the canned reflect trigger body around the rendered transcript.

    The transcript is the agent's last-N message window across all chatrooms.
    The agent reads its own ``learnings/log.md`` cursor to dedupe within a
    single day.
    """
    return (
        f"{REFLECT_TRIGGER_MARKER}\n"
        "Time to reflect. Below is a transcript of your most-recent activity "
        "across DMs and project chatrooms. Run `/clawmeets:reflect` to distill "
        "new lessons into `learnings/` and audit the wiki for contradictions "
        "or staleness in the same pass. Reply in this DM with a 3-bullet "
        "summary of what changed so I can correct it.\n\n"
        f"{transcript}"
    )


class ReflectionScheduler:
    """Background task that fires user-level reflection schedules with fan-out."""

    def __init__(
        self,
        store: "ReflectionScheduleStore",
        runloop_manager: "ChangelogRunloopManager",
        ws_hub: "WSHub",
        model_ctx: "ModelContext",
        interval_seconds: float = 30.0,
    ) -> None:
        self._store = store
        self._runloop_manager = runloop_manager
        self._ws_hub = ws_hub
        self._model_ctx = model_ctx
        self._interval = interval_seconds
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._task is not None:
            logger.warning("ReflectionScheduler already running")
            return
        self._task = asyncio.create_task(self._check_loop())
        logger.info(f"ReflectionScheduler started (interval={self._interval}s)")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("ReflectionScheduler stopped")

    async def _check_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self._interval)
                await self._check_and_fire()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Error in reflection scheduler loop")

    async def _check_and_fire(self) -> None:
        now = datetime.now(UTC)
        for schedule in await self._store.list_active():
            # Fan out to agents with new activity since their last reflection.
            # Always advance the cursor so a broken fan-out cannot wedge
            # future cycles.
            if schedule.next_fire_at <= now:
                logger.info(
                    f"Firing reflect schedule for user={schedule.username!r} "
                    f"cron={schedule.cron_expression!r}"
                )
                try:
                    await self._fan_out_reflect(schedule, now)
                except Exception:
                    logger.exception(
                        f"Reflect fan-out failed for user={schedule.username!r}"
                    )
                await self._store.update_after_fire(schedule.user_id, now)

    async def _fan_out_reflect(self, schedule: ReflectionSchedule, now: datetime) -> None:
        """Trigger reflection for each owned agent that has unreflected activity."""
        owned_agents = [
            a for a in Agent.list_all(self._model_ctx, discoverable_only=False, include_private=True)
            if a.registered_by == schedule.user_id
        ]

        if not owned_agents:
            logger.debug(f"No agents owned by user={schedule.username!r}, skipping fan-out")
            return

        user = User.get(schedule.user_id, self._model_ctx)
        if user is None:
            logger.warning(
                f"User {schedule.username!r} ({schedule.user_id}) not found; skipping fan-out"
            )
            return

        ctx = _SchedulerContext(
            model_ctx=self._model_ctx,
            runloop_manager=self._runloop_manager,
            ws_hub=self._ws_hub,
        )
        for agent in owned_agents:
            try:
                await self._maybe_trigger_for_agent(agent, schedule, user, ctx, now)
            except Exception:
                logger.exception(
                    f"Failed to trigger reflection for agent={agent.name!r}"
                )

    async def _maybe_trigger_for_agent(
        self,
        agent: Agent,
        schedule: ReflectionSchedule,
        user: User,
        ctx: "_SchedulerContext",
        now: datetime,
    ) -> None:
        """Activity-gate, render, and post a trigger to the agent's DM."""
        # Activity gate: skip when the agent's most-recent message is older
        # than (or equal to) its last reflection. Single-row check — no
        # transcript fetch / render when idle.
        latest = latest_message_ts(agent.id, self._model_ctx)
        last_reflected = agent.last_reflected_at
        if latest is None:
            logger.debug(
                f"Skipping reflection for agent={agent.name!r}: no activity at all"
            )
            return
        if last_reflected is not None and latest <= last_reflected:
            logger.debug(
                f"Skipping reflection for agent={agent.name!r}: latest activity "
                f"{latest.isoformat()} ≤ last_reflected_at {last_reflected.isoformat()}"
            )
            return

        # Lazy-ensure the per-agent DM project (`{username}-dm-{agent_short}`)
        # and post the trigger to its `user-communication` chatroom. The
        # project + room are auto-created on first fire — the user does not
        # need to have opened the DM beforehand.
        dm_project = await _ensure_own_dm_project(ctx, user, agent.name)
        chatroom_name = "user-communication"

        # The window feeds the reflect distill+audit cycle. The agent uses
        # its own `last_reflected_at` cursor + today's log.md entry to dedupe.
        rows = collect_recent_activity(
            agent.id, None, self._model_ctx, max_count=REFLECT_WINDOW_MESSAGES,
        )

        agent_short = agent.short_name_for(schedule.username)
        transcript = render_text_transcript(
            rows,
            agent_short_name=agent_short,
            max_count=REFLECT_WINDOW_MESSAGES,
        )
        body = build_trigger_message(transcript)

        # Post as the user — same path the message scheduler uses.
        from clawmeets.server.routes.messages import send_message_as_user

        try:
            await send_message_as_user(
                ctx,
                user_id=schedule.user_id,
                username=schedule.username,
                project_id=dm_project.id,
                chatroom_name=chatroom_name,
                content=body,
            )
            logger.info(
                f"Reflection trigger posted: user={schedule.username!r} "
                f"agent={agent.name!r} rows={len(rows)}"
            )
        except Exception as e:
            logger.warning(
                f"Failed to post reflection trigger to {dm_project.name!r}/{chatroom_name!r}: {e}"
            )


class _SchedulerContext:
    """Lightweight context for send_message_as_user (mirrors MessageScheduler's helper)."""

    def __init__(self, model_ctx, runloop_manager, ws_hub):
        self.model_ctx = model_ctx
        self.runloop_manager = runloop_manager
        self.ws_hub = ws_hub
