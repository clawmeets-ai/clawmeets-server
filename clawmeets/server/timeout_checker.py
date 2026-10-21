# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/timeout_checker.py
Background task for enforcing batch timeout.

When a coordinator sends @mentions to agents, a PendingWork record is created.
If agents don't respond within timeout_seconds, this checker appends a
BATCH_TIMEOUT entry to the changelog and clears the pending work.

A batch whose message is still waiting for delivery
(``PendingWork.awaiting_delivery``, a request queued for another deployment)
never times out on that clock: its timer starts when the target has the
message (``WorkTracker.start_timer``). A ceiling counted from when it began
waiting (``batch_timeout.AWAITING_DELIVERY_CEILING_SECONDS``) closes it either
way, with a system note and nothing else (``close_undelivered_work``).
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from clawmeets.api.control import (
    CancelLLMPayload,
    ChangelogUpdatePayload,
    ControlEnvelope,
    ControlMessageType,
)
from clawmeets.models.participant import Participant
from clawmeets.server.batch_timeout import (
    NEVER_PICKED_UP_NOTE,
    NO_REPLY_NOTE,
    delivery_ceiling_passed,
    resolve_batch_timeout,
    timer_elapsed,
)
from clawmeets.server.managed_job_events import closing_text, post_job_line
from clawmeets.server.participant_liveness import split_by_liveness
from clawmeets.models.project import Project
from clawmeets.sync.changelog import (
    BatchTimeoutPayload,
    ChangelogEntryType,
    MessagePayload,
)

if TYPE_CHECKING:
    from clawmeets.models.work_tracker import WorkTracker
    from clawmeets.sync.runloop_manager import ChangelogRunloopManager
    from clawmeets.server.ws_hub import WSHub
    from clawmeets.models.context import ModelContext

logger = logging.getLogger("clawmeets.server.timeout_checker")


async def close_undelivered_work(
    work_tracker: "WorkTracker", runloop_manager: "ChangelogRunloopManager", work, note: str,
) -> int:
    """Close a batch whose message waited too long for delivery or an answer:
    one system message with ``note`` in the batch's room, and the batch
    cleared. No BATCH_TIMEOUT entry and no CANCEL_LLM: nothing on this server
    is working on it. Returns the note's changelog version."""
    runloop = await runloop_manager.get_or_create(work.project_id, work.project_name)
    entry = await runloop.append(
        ChangelogEntryType.MESSAGE,
        MessagePayload(
            chatroom_name=work.chatroom_name,
            id=str(uuid.uuid4()),
            ts=datetime.now(UTC),
            from_participant_id="system",
            from_participant_name="ClawMeets",
            content=note,
            expects_response_from=[],
            is_ack=False,
        ),
    )
    await work_tracker.clear_pending_work(work.project_id, work.chatroom_name)
    return entry.version


def _timeout_message(
    *,
    timed_out_names: list[str],
    offline_names: list[str],
    coordinator_name: str,
    minutes: int,
) -> str:
    """Build the visible system message a timed-out batch posts to the room.

    Three shapes, keyed on how many of the non-responders were disconnected
    when the timeout fired:

      * none        the wording is UNCHANGED — this is the overwhelmingly
                    common case and it is not this change's business;
      * all         say nothing is connected for them and name the fix;
      * some        name them apart, because "did not respond" and "was never
                    there" are different failures with different remedies.

    The ``clawmeets start`` line says *your own machine* explicitly. A user who
    reads a disconnect as a ClawMeets outage waits for someone else to fix it
    — which is exactly the 2.5 days the incident user spent — so naming whose
    machine it is carries as much weight as naming the command.

    This is prose from ``ClawMeets`` on a row that already renders as prose, so
    it costs the frontend nothing. The machine-readable half of AC-2.9 is
    ``BatchTimeoutPayload.offline_participants``, which is what the chip reads;
    this string is not parsed by anything.
    """
    everyone = ", ".join(timed_out_names)
    if not offline_names:
        return (
            f"{everyone} did not respond within {minutes} min. "
            f"{coordinator_name} is reviewing."
        )

    many = len(offline_names) > 1
    them = "them" if many else "it"
    # VOCABULARY: user-facing prose says "your own machine", never "runner".
    # The word survives in this module's comments, where it names a process for
    # whoever is reading the code.
    remedy = (
        f"That is on your own machine, not a ClawMeets outage — run "
        f"`clawmeets start` where you set {them} up and the message is still "
        f"queued to be delivered."
    )

    if len(offline_names) == len(timed_out_names):
        connected = "are not connected" if many else "is not connected"
        return (
            f"{everyone} did not respond within {minutes} min — "
            f"{'their computers' if many else 'its computer'} {connected}. "
            f"{remedy} {coordinator_name} is reviewing."
        )

    offline = ", ".join(offline_names)
    return (
        f"{everyone} did not respond within {minutes} min. "
        f"{offline} {'are' if many else 'is'} not connected. "
        f"{remedy} {coordinator_name} is reviewing."
    )


class BatchTimeoutChecker:
    """Background task that checks for timed-out batch work.

    Periodically scans WorkTracker for PendingWork that has exceeded its
    timeout_seconds. When found:
    1. Appends BATCH_TIMEOUT entry to project changelog
    2. Clears the pending work from WorkTracker
    3. Broadcasts changelog update to project participants
    """

    def __init__(
        self,
        work_tracker: "WorkTracker",
        runloop_manager: "ChangelogRunloopManager",
        ws_hub: "WSHub",
        model_ctx: "ModelContext",
        interval_seconds: float = 30.0,
        batch_timeout: int = 1800,
    ) -> None:
        """Initialize the timeout checker.

        Args:
            work_tracker: WorkTracker instance to monitor
            runloop_manager: Manager for project changelogs
            ws_hub: WebSocket hub for broadcasting updates
            model_ctx: Model context for project lookups
            interval_seconds: How often to check for timeouts (default 30s)
            batch_timeout: Timeout in seconds used when creating the
                coordinator self-batch after a timed-out worker batch.
                Matches the value used by ``post_message`` on BATCH_COMPLETE.
        """
        self._work_tracker = work_tracker
        self._runloop_manager = runloop_manager
        self._ws_hub = ws_hub
        self._model_ctx = model_ctx
        self._interval = interval_seconds
        self._batch_timeout = batch_timeout
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Start the background timeout checker task."""
        if self._task is not None:
            logger.warning("BatchTimeoutChecker already running")
            return
        self._task = asyncio.create_task(self._check_loop())
        logger.info(f"BatchTimeoutChecker started (interval={self._interval}s)")

    async def stop(self) -> None:
        """Stop the background timeout checker task."""
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("BatchTimeoutChecker stopped")

    async def _check_loop(self) -> None:
        """Main loop that periodically checks for timeouts."""
        while True:
            try:
                await asyncio.sleep(self._interval)
                await self._check_timeouts()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Error in timeout check loop")

    async def _check_timeouts(self) -> None:
        """Check all pending work for timeouts and handle expired ones."""
        now = datetime.now(UTC)
        pending_work = await self._work_tracker.get_all_pending_work()

        for work in pending_work:
            if work.managed_job_id:
                job = await self._model_ctx_managed_job(work.managed_job_id)
                if job is not None and job.has_healthy_lease:
                    continue
                # An ended job already answered (finish_request) and announced
                # itself; what is left of the batch is other workers' answers,
                # which run on the batch's own clock below.
                if job is not None and not job.is_terminal:
                    logger.info(
                        "Managed job lease ended: job=%s status=%s reason=%s",
                        job.id[:8], job.status.value, job.failure_reason,
                    )
                    await self._handle_timeout(work)
                    await self._announce_job_end(job)
                    continue
            # First match wins: the delivery ceiling, then the pause, then
            # the batch's own clock (from when its timer started).
            if delivery_ceiling_passed(work, now):
                note = NEVER_PICKED_UP_NOTE if work.awaiting_delivery else NO_REPLY_NOTE
                logger.info(
                    f"Batch closed at the delivery ceiling: chatroom={work.chatroom_name} "
                    f"message_id={work.message_id[:8]} picked_up={not work.awaiting_delivery}"
                )
                version = await close_undelivered_work(
                    self._work_tracker, self._runloop_manager, work, note,
                )
                await self._broadcast(work, version)
                continue
            if work.awaiting_delivery:
                continue
            elapsed = timer_elapsed(work, now)
            if elapsed > work.timeout_seconds:
                logger.info(
                    f"Batch timeout: chatroom={work.chatroom_name} "
                    f"message_id={work.message_id[:8]} "
                    f"timed_out={work.timed_out_participants} "
                    f"responded={work.responded_participants}"
                )
                await self._handle_timeout(work)

    async def _model_ctx_managed_job(self, job_id: str):
        """Resolve and expire an attached job through the server-owned store."""
        store = getattr(self, "_managed_job_store", None)
        if store is None:
            return None
        return await store.mark_stalled_if_expired(job_id)

    async def _announce_job_end(self, job) -> None:
        """Tell the job's owner it was stalled (lease or deadline ran out), so
        it learns of it in a turn instead of only the user seeing it."""
        try:
            project = Project.get(job.project_id, self._model_ctx)
        except ValueError:
            return
        try:
            await post_job_line(
                self._runloop_manager, self._ws_hub, project, job,
                closing_text(job), closing=True, wake=True,
            )
        except Exception:
            logger.exception("Managed job %s: stall announcement failed", job.id[:8])

    def bind_managed_job_store(self, store) -> None:
        """Late-bind to keep the checker's existing construction API stable."""
        self._managed_job_store = store

    async def _handle_timeout(self, work) -> None:
        """Handle a single timed-out batch.

        Args:
            work: The PendingWork that has timed out
        """
        # Get runloop for this project
        runloop = await self._runloop_manager.get_or_create(
            work.project_id, work.project_name
        )

        # Which non-responders are offline RIGHT NOW. Re-checked here, never
        # carried forward from dispatch time: the case this exists for is an
        # agent that WAS live when the batch opened and died mid-work, which no
        # cached dispatch-time verdict can describe. The hub is already held
        # here — it is used a few lines down to fan CANCEL_LLM at these same
        # ids — so the check is free.
        #
        # `split_by_liveness`, not a bare `not is_connected`: `expects` may
        # carry human participant ids, and `is_connected` on a user id is False
        # whenever that person simply has no browser socket open. A batch
        # addressed to a person must never report that person as offline.
        _, offline_now = split_by_liveness(
            work.timed_out_participants,
            ws_hub=self._ws_hub,
            model_ctx=self._model_ctx,
        )

        # Append BATCH_TIMEOUT entry to changelog. source_version points at
        # the @mention MESSAGE that opened the batch (parallel to BATCH_COMPLETE).
        entry = await runloop.append(
            ChangelogEntryType.BATCH_TIMEOUT,
            BatchTimeoutPayload(
                chatroom_name=work.chatroom_name,
                message_id=work.message_id,
                coordinator_id=work.coordinator_id,
                responded_participants=work.responded_participants,
                timed_out_participants=work.timed_out_participants,
                offline_participants=offline_now,
            ),
            source_version=work.message_version,
        )

        # Clear pending work
        await self._work_tracker.clear_pending_work(work.project_id, work.chatroom_name)

        # Post a visible system message so the transcript explains why the
        # typing chip is about to jump from the timed-out worker to the
        # coordinator. Append-only to the changelog — does not flow through
        # post_message, so no WorkTracker side effects.
        def _name(pid: str) -> str:
            p = Participant.get(pid, self._model_ctx)
            return p.name if p else pid

        timed_out_names = [_name(pid) for pid in work.timed_out_participants]
        offline_names = [_name(pid) for pid in offline_now]
        coord = Participant.get(work.coordinator_id, self._model_ctx)
        coordinator_name = coord.name if coord else work.coordinator_id
        # Derived from this batch's own window, never hardcoded to 30:
        # `resolve_batch_timeout` widens it to the longest `invoke_timeout_seconds`
        # any addressed agent's card declares, so a fleet with a raised card
        # really did wait longer than half an hour and must not be told otherwise.
        minutes = max(1, work.timeout_seconds // 60)
        system_content = _timeout_message(
            timed_out_names=timed_out_names,
            offline_names=offline_names,
            coordinator_name=coordinator_name,
            minutes=minutes,
        )
        await runloop.append(
            ChangelogEntryType.MESSAGE,
            MessagePayload(
                chatroom_name=work.chatroom_name,
                id=str(uuid.uuid4()),
                ts=datetime.now(UTC),
                from_participant_id="system",
                from_participant_name="ClawMeets",
                content=system_content,
                expects_response_from=[],
                is_ack=False,
            ),
        )

        # Kill the timed-out participants' in-flight LLM subprocesses. Without
        # this, a stuck worker keeps burning tokens long after the server has
        # given up on its response, and the eventual reply is ignored because
        # pending_work is gone. CANCEL_LLM is a no-op on runners that don't
        # have a matching in-flight task.
        for timed_out_id in work.timed_out_participants:
            cancel_envelope = ControlEnvelope(
                type=ControlMessageType.CANCEL_LLM,
                payload=CancelLLMPayload(
                    agent_id=timed_out_id,
                    project_id=work.project_id,
                    chatroom_name=work.chatroom_name,
                ),
            )
            try:
                await self._ws_hub.send_to(timed_out_id, cancel_envelope)
            except Exception:
                logger.exception(
                    f"Failed to send CANCEL_LLM to timed-out participant {timed_out_id[:8]}"
                )

        # Mirror post_message's BATCH_COMPLETE self-batch logic: if this was a
        # coordinator-led batch, create a new pending entry with the coordinator
        # as the expected responder so the typing chip keeps showing the
        # coordinator while it reviews the timed-out output. coordinator_id is
        # set to project.created_by so the eventual BATCH_COMPLETE from this
        # self-batch does not route back to the coordinator (no loop).
        project = Project.get(work.project_id, self._model_ctx)
        if (
            project
            and project.coordinator_id
            and project.created_by
            and project.coordinator_id != project.created_by  # a user coordinator runs no flow
            and work.coordinator_id == project.coordinator_id
            and not project.is_dm_shaped  # DM AND Front Desk ends take DM timeout behavior
        ):
            try:
                await self._work_tracker.create_pending_work(
                    message_id=work.message_id,
                    message_version=entry.version,
                    project_id=work.project_id,
                    project_name=work.project_name,
                    chatroom_name=work.chatroom_name,
                    coordinator_id=project.created_by,
                    expected_participants=[work.coordinator_id],
                    timeout_seconds=resolve_batch_timeout(
                        [work.coordinator_id],
                        default=self._batch_timeout,
                        model_ctx=self._model_ctx,
                    ),
                )
            except ValueError:
                logger.warning(
                    f"Self-batch already exists for "
                    f"({work.project_id[:8]}, {work.chatroom_name})"
                )

        # Broadcast to project participants
        await self._broadcast(work, entry.version, project)

    async def _broadcast(self, work, version: int, project=None) -> None:
        """Tell the project's participants the changelog moved to ``version``."""
        if project is None:
            try:
                project = Project.get(work.project_id, self._model_ctx)
            except ValueError:
                return
        if project:
            envelope = ControlEnvelope(
                type=ControlMessageType.CHANGELOG_UPDATE,
                payload=ChangelogUpdatePayload(
                    project_id=work.project_id,
                    project_name=work.project_name,
                    new_version=version,
                    coordinator_id=project.coordinator_id,
                ),
            )
            await self._ws_hub.broadcast_to_project(envelope, project)
