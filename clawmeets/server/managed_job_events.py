# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/managed_job_events.py

What the server does around a managed background job's open request, shared
by the job routes, the timeout checker and server start-up:

  * ``ensure_pending_for_job`` — the request a job is attached to lives in the
    in-memory ``WorkTracker``; rebuild it from the durable job after a restart.
  * ``restore_active_jobs`` — do that for every live job at start-up, so a job
    whose process died while the server was down is still reported as stalled.
  * ``post_job_line`` — the job's lines in the room. Progress lines carry
    ``managed_job_id`` and address nobody, so no agent wakes on them; a closing
    line (succeeded / failed / stalled) is addressed to the job's owner, which
    wakes it once, on purpose.
  * ``finish_request`` — the job ended: credit it against its request and send
    BATCH_COMPLETE, exactly once.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from clawmeets.api.control import ChangelogUpdatePayload, ControlEnvelope, ControlMessageType
from clawmeets.models.managed_job import ManagedJob, ManagedJobStatus
from clawmeets.server.batch_timeout import resolve_batch_timeout
from clawmeets.sync.changelog import BatchCompletePayload, ChangelogEntryType, MessagePayload

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.models.managed_job import ManagedJobStore
    from clawmeets.models.project import Project
    from clawmeets.models.work_tracker import PendingWork, WorkTracker
    from clawmeets.server.ws_hub import WSHub
    from clawmeets.sync.runloop_manager import ChangelogRunloopManager

logger = logging.getLogger(__name__)

#: Statuses whose request is still open. A STALLED job's request was already
#: closed by the timeout checker and is never rebuilt.
LIVE_STATUSES = {ManagedJobStatus.QUEUED, ManagedJobStatus.RUNNING, ManagedJobStatus.RETRY_WAIT}


async def ensure_pending_for_job(
    work_tracker: "WorkTracker",
    job: ManagedJob,
    *,
    default_timeout: int,
    rebuild: bool | None = None,
) -> "PendingWork | None":
    """The open request for ``job``, rebuilt if the tracker forgot it.
    Idempotent; a concurrent restore wins. ``rebuild`` defaults to "the job
    is live"; the routes pass whether it was live BEFORE the event, so the
    event that ends a job still closes its request after a restart. None when
    nothing is rebuilt, or the room's open request is another message."""
    pending = await work_tracker.renew_from_managed_job(
        job.project_id, job.chatroom_name, job.id, job.lease_expires_at
    )
    if rebuild is None:
        rebuild = job.status in LIVE_STATUSES
    if pending is not None or not rebuild:
        return pending
    timeout = (
        max(1, int((job.deadline_at - job.created_at).total_seconds()))
        if job.deadline_at is not None else default_timeout
    )
    try:
        await work_tracker.create_pending_work(
            message_id=job.pending_message_id,
            message_version=job.pending_message_version,
            project_id=job.project_id,
            project_name=job.project_name,
            chatroom_name=job.chatroom_name,
            coordinator_id=job.coordinator_id,
            expected_participants=[job.owner_agent_id],
            timeout_seconds=timeout,
        )
    except ValueError:
        pass  # a concurrent request (or a reconnecting runner) opened it first
    try:
        return await work_tracker.attach_managed_job(
            job.project_id,
            job.chatroom_name,
            message_id=job.pending_message_id,
            job_id=job.id,
            owner_id=job.owner_agent_id,
            lease_expires_at=job.lease_expires_at,
        )
    except ValueError:
        logger.warning(
            "Managed job %s: the room's open request is another message; not restored",
            job.id[:8],
        )
        return None


async def restore_active_jobs(
    store: "ManagedJobStore", work_tracker: "WorkTracker", *, default_timeout: int,
) -> int:
    """Start-up: rebuild the request of every live job. The timeout checker
    then reports a dead one as stalled on its next pass. Returns how many."""
    restored = 0
    for job in await store.list_active():
        if job.status not in LIVE_STATUSES:
            continue
        try:
            if await ensure_pending_for_job(work_tracker, job, default_timeout=default_timeout):
                restored += 1
        except Exception:
            logger.exception("Managed job %s: restore failed", job.id[:8])
    if restored:
        logger.info("Restored the open request of %d managed job(s)", restored)
    return restored


def closing_text(job: ManagedJob, detail: str | None = None) -> str:
    """The room line for a job that ended or stalled."""
    short = job.id[:8]
    reason = detail or job.failure_reason
    match job.status:
        case ManagedJobStatus.SUCCEEDED:
            return f"Managed job {short} completed" + (f": {detail}" if detail else ".")
        case ManagedJobStatus.FAILED:
            return f"Managed job {short} failed" + (f": {reason}" if reason else ".")
        case ManagedJobStatus.STALLED:
            return (
                f"Managed job {short} stalled ({reason or 'lease expired'}). Its request "
                f"is closed; the work is no longer tracked."
            )
        case ManagedJobStatus.CANCELLED:
            return f"Managed job {short} was cancelled" + (f": {reason}" if reason else ".")
    return f"Managed job {short} is {job.status.value}"


async def post_job_line(
    runloop_manager: "ChangelogRunloopManager",
    ws_hub: "WSHub",
    project: "Project",
    job: ManagedJob,
    text: str,
    *,
    closing: bool,
    wake: bool,
) -> int:
    """Append one system line for ``job`` and tell the project. A progress
    line addresses nobody; a closing line addresses the job's owner unless
    ``wake`` is False. A cancel never wakes. Returns the entry's version."""
    addressed = (
        [job.owner_agent_id]
        if closing and wake and job.status != ManagedJobStatus.CANCELLED
        else []
    )
    runloop = await runloop_manager.get_or_create(project.id, project.name)
    entry = await runloop.append(
        ChangelogEntryType.MESSAGE,
        MessagePayload(
            chatroom_name=job.chatroom_name,
            id=str(uuid.uuid4()),
            ts=datetime.now(UTC),
            from_participant_id="system",
            from_participant_name="ClawMeets",
            content=text,
            expects_response_from=addressed,
            is_ack=False,
            managed_job_id=job.id,
        ),
    )
    await _broadcast(ws_hub, project, entry.version)
    return entry.version


async def finish_request(
    work_tracker: "WorkTracker",
    runloop_manager: "ChangelogRunloopManager",
    ws_hub: "WSHub",
    project: "Project | None",
    job: ManagedJob,
    *,
    batch_timeout: int,
    model_ctx: "ModelContext",
) -> None:
    """A terminal job is the answer to its request: credit it and, when that
    completes the batch, append BATCH_COMPLETE (plus the coordinator's
    self-batch, as ``post_message`` does)."""
    work = await work_tracker.record_response(
        job.project_id, job.chatroom_name, job.owner_agent_id, from_managed_job=True,
    )
    if not (work and work.is_complete):
        return
    await work_tracker.clear_pending_work(job.project_id, job.chatroom_name)
    if project is None:
        return
    runloop = await runloop_manager.get_or_create(project.id, project.name)
    entry = await runloop.append(
        ChangelogEntryType.BATCH_COMPLETE,
        BatchCompletePayload(
            chatroom_name=job.chatroom_name,
            message_id=work.message_id,
            coordinator_id=work.coordinator_id,
            responded_participants=work.responded_participants,
        ),
        source_version=work.message_version,
    )
    if (
        project.coordinator_id
        and project.created_by
        and project.coordinator_id != project.created_by
        and work.coordinator_id == project.coordinator_id
    ):
        try:
            await work_tracker.create_pending_work(
                message_id=work.message_id,
                message_version=entry.version,
                project_id=project.id,
                project_name=project.name,
                chatroom_name=job.chatroom_name,
                coordinator_id=project.created_by,
                expected_participants=[work.coordinator_id],
                timeout_seconds=resolve_batch_timeout(
                    [work.coordinator_id], default=batch_timeout, model_ctx=model_ctx,
                ),
            )
        except ValueError:
            logger.warning("Self-batch already exists for %s", job.chatroom_name)
    await _broadcast(ws_hub, project, entry.version)


async def _broadcast(ws_hub: "WSHub", project: "Project", version: int) -> None:
    await ws_hub.broadcast_to_project(
        ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project.id,
                project_name=project.name,
                new_version=version,
                coordinator_id=project.coordinator_id,
            ),
        ),
        project,
    )
