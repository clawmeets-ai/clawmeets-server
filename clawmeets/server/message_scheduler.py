# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/message_scheduler.py
Background task for firing scheduled messages.

Periodically checks for scheduled messages whose next_fire_at has passed,
sends them as user messages, and updates the schedule for the next fire time.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from clawmeets.models.scheduled_message import ScheduledMessage

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.models.scheduled_message import ScheduledMessageStore
    from clawmeets.models.work_tracker import WorkTracker
    from clawmeets.runner.runloop_manager import ChangelogRunloopManager
    from clawmeets.server.ws_hub import WSHub

logger = logging.getLogger("clawmeets.server.message_scheduler")


class MessageScheduler:
    """Background task that fires scheduled messages.

    Periodically scans ScheduledMessageStore for active messages whose
    next_fire_at <= now. When found:
    1. Sends the message as the user via send_message_as_user()
    2. Updates last_fired_at and computes next_fire_at
    3. Deactivates if project/chatroom no longer exists
    """

    def __init__(
        self,
        store: "ScheduledMessageStore",
        runloop_manager: "ChangelogRunloopManager",
        ws_hub: "WSHub",
        model_ctx: "ModelContext",
        work_tracker: "WorkTracker",
        batch_timeout: int = 1800,
        interval_seconds: float = 30.0,
    ) -> None:
        self._store = store
        self._runloop_manager = runloop_manager
        self._ws_hub = ws_hub
        self._model_ctx = model_ctx
        self._work_tracker = work_tracker
        self._batch_timeout = batch_timeout
        self._interval = interval_seconds
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the background scheduler task."""
        if self._task is not None:
            logger.warning("MessageScheduler already running")
            return
        self._task = asyncio.create_task(self._check_loop())
        logger.info(f"MessageScheduler started (interval={self._interval}s)")

    async def stop(self) -> None:
        """Stop the background scheduler task."""
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("MessageScheduler stopped")

    async def _check_loop(self) -> None:
        """Main loop that periodically checks for due messages."""
        while True:
            try:
                await asyncio.sleep(self._interval)
                await self._check_and_fire()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Error in message scheduler loop")

    async def _check_and_fire(self) -> None:
        """Check all active scheduled messages and fire any that are due."""
        now = datetime.now(UTC)
        active = await self._store.get_active()

        for scheduled in active:
            if scheduled.next_fire_at <= now:
                logger.info(
                    f"Firing scheduled message: id={scheduled.id[:8]} "
                    f"user={scheduled.username} room={scheduled.chatroom_name} "
                    f"cron={scheduled.cron_expression!r}"
                )
                await self._fire_message(scheduled, now)

    async def _fire_message(self, scheduled: ScheduledMessage, now: datetime) -> None:
        """Fire a single scheduled message.

        Sends the message as the user and updates the schedule.
        If the project or chatroom no longer exists, deactivates the schedule.
        """
        # Import here to avoid circular imports
        from clawmeets.server.routes.messages import send_message_as_user
        from clawmeets.server.context import ServerContext

        # Idle gate: skip this tick if the schedule is idle-only and the
        # project has any open batch. Advance next_fire_at so the scheduler
        # doesn't immediately re-evaluate the same overdue cron tick, but
        # leave last_fired_at untouched so the schedule shows up as still
        # waiting for its first real fire.
        if scheduled.idle_only and not await self._work_tracker.is_project_idle(
            scheduled.project_id
        ):
            logger.info(
                f"Deferring scheduled message {scheduled.id[:8]}: "
                f"project {scheduled.project_id[:8]} busy"
            )
            await self._store.update_next_fire_only(scheduled.id, now)
            return

        # Build a minimal ServerContext-like object for send_message_as_user.
        # Must carry every field that handler reads: model_ctx, runloop_manager,
        # ws_hub, work_tracker (for create_pending_work → typing indicator) and
        # batch_timeout (PendingWork timeout).
        ctx = _SchedulerContext(
            model_ctx=self._model_ctx,
            runloop_manager=self._runloop_manager,
            ws_hub=self._ws_hub,
            work_tracker=self._work_tracker,
            batch_timeout=self._batch_timeout,
        )

        try:
            await send_message_as_user(
                ctx,
                user_id=scheduled.user_id,
                username=scheduled.username,
                project_id=scheduled.project_id,
                chatroom_name=scheduled.chatroom_name,
                content=scheduled.content,
            )
        except Exception as e:
            error_msg = str(e)
            # If project or chatroom not found, deactivate
            if "not found" in error_msg.lower():
                logger.warning(
                    f"Deactivating scheduled message {scheduled.id[:8]}: {error_msg}"
                )
                await self._store.deactivate_by_id(scheduled.id)
                return
            logger.exception(f"Failed to fire scheduled message {scheduled.id[:8]}")
            return

        # Update schedule after successful fire
        await self._store.update_after_fire(scheduled.id, now)


class _SchedulerContext:
    """Lightweight context for the scheduler to pass to send_message_as_user.

    Provides the same interface as ServerContext for the fields that
    send_message_as_user needs.
    """

    def __init__(self, model_ctx, runloop_manager, ws_hub, work_tracker, batch_timeout):
        self.model_ctx = model_ctx
        self.runloop_manager = runloop_manager
        self.ws_hub = ws_hub
        self.work_tracker = work_tracker
        self.batch_timeout = batch_timeout
