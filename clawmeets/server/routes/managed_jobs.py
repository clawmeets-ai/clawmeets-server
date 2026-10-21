# SPDX-License-Identifier: BUSL-1.1
"""Authenticated lifecycle API for runner-managed background jobs."""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel, Field

from clawmeets.models.managed_job import ManagedJob, ManagedJobError, ManagedJobStatus
from clawmeets.models.project import Project
from clawmeets.models.chatroom import Chatroom
from clawmeets.server.managed_job_events import (
    LIVE_STATUSES,
    closing_text,
    ensure_pending_for_job,
    finish_request,
    post_job_line,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext


class StartJobBody(BaseModel):
    project_id: str
    chatroom_name: str
    pending_message_id: str | None = None
    #: None = no absolute deadline; the heartbeat lease still applies.
    deadline_at: datetime | None = None
    heartbeat_timeout_seconds: int = Field(default=300, ge=10, le=86400)
    step: str | None = None


class JobEventBody(BaseModel):
    expected_sequence: int = Field(ge=0)
    summary: str | None = None
    step: str | None = None
    checkpoint: str | None = None
    reason: str | None = None
    #: complete / fail only: address the closing line to the job's owner so
    #: it wakes once. An agent closing its own job mid-turn passes False.
    wake_owner: bool = True


def create_managed_jobs_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(prefix="/jobs", tags=["managed-jobs"])

    async def caller(authorization: str, agent_id: str) -> str:
        if not agent_id:
            raise HTTPException(401, "Missing X-Agent-ID header")
        await ctx.auth.check_agent_token(agent_id, authorization)
        return agent_id

    async def owned(job_id: str, authorization: str, agent_id: str) -> ManagedJob:
        await caller(authorization, agent_id)
        job = await ctx.managed_job_store.get(job_id)
        if job is None:
            raise HTTPException(404, "Managed job not found")
        if job.owner_agent_id != agent_id:
            raise HTTPException(403, "Managed job belongs to another agent")
        return job

    async def mutate(
        job_id: str,
        body: JobEventBody,
        authorization: str,
        agent_id: str,
        *,
        status: ManagedJobStatus | None = None,
        renew_lease: bool = False,
    ) -> ManagedJob:
        before = await owned(job_id, authorization, agent_id)
        try:
            job = await ctx.managed_job_store.update(
                job_id,
                owner_agent_id=agent_id,
                expected_sequence=body.expected_sequence,
                status=status,
                progress=body.summary,
                step=body.step,
                checkpoint=body.checkpoint,
                failure_reason=body.reason,
                renew_lease=renew_lease,
            )
        except KeyError:
            raise HTTPException(404, "Managed job not found")
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except ManagedJobError as exc:
            raise HTTPException(409, str(exc)) from exc
        await ensure_pending_for_job(
            ctx.work_tracker, job, default_timeout=ctx.batch_timeout,
            rebuild=before.status in LIVE_STATUSES,
        )
        try:
            project = Project.get(job.project_id, ctx.model_ctx)
        except ValueError:
            project = None
        if project is not None and job.is_terminal:
            await post_job_line(
                ctx.runloop_manager, ctx.ws_hub, project, job,
                closing_text(job, body.summary if status == ManagedJobStatus.SUCCEEDED else body.reason),
                closing=True, wake=body.wake_owner,
            )
        elif project is not None and body.summary:
            await post_job_line(
                ctx.runloop_manager, ctx.ws_hub, project, job, body.summary,
                closing=False, wake=False,
            )
        if job.is_terminal:
            await finish_request(
                ctx.work_tracker, ctx.runloop_manager, ctx.ws_hub, project, job,
                batch_timeout=ctx.batch_timeout, model_ctx=ctx.model_ctx,
            )
        return job

    @router.post("", response_model=ManagedJob)
    async def start_job(
        body: StartJobBody = Body(...),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ) -> ManagedJob:
        agent_id = await caller(authorization, x_agent_id)
        project = Project.get(body.project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(404, "Project not found")
        room = Chatroom.get(body.project_id, body.chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, "Chatroom not found")
        if agent_id not in room.participants:
            raise HTTPException(403, "Agent is not a project participant")
        work = await ctx.work_tracker.get_pending_work(body.project_id, body.chatroom_name)
        if work is None:
            raise HTTPException(409, "Matching pending work is no longer open")
        if body.pending_message_id and work.message_id != body.pending_message_id:
            raise HTTPException(409, "Matching pending work is no longer open")
        if agent_id not in work.expected_participants:
            raise HTTPException(403, "Pending work is not waiting for this agent")
        try:
            job = await ctx.managed_job_store.create(
                project_id=project.id,
                project_name=project.name,
                chatroom_name=body.chatroom_name,
                pending_message_id=work.message_id,
                pending_message_version=work.message_version,
                coordinator_id=work.coordinator_id,
                owner_agent_id=agent_id,
                deadline_at=body.deadline_at,
                heartbeat_timeout_seconds=body.heartbeat_timeout_seconds,
                step=body.step,
            )
            await ctx.work_tracker.attach_managed_job(
                project.id,
                body.chatroom_name,
                message_id=work.message_id,
                job_id=job.id,
                owner_id=agent_id,
                lease_expires_at=job.lease_expires_at,
            )
        except ManagedJobError as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        return job

    @router.get("/{job_id}", response_model=ManagedJob)
    async def inspect_job(
        job_id: str,
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ) -> ManagedJob:
        return await owned(job_id, authorization, x_agent_id)

    @router.post("/{job_id}/heartbeat", response_model=ManagedJob)
    async def heartbeat(job_id: str, body: JobEventBody, authorization: str = Header(default=""), x_agent_id: str = Header(default="", alias="X-Agent-ID")) -> ManagedJob:
        return await mutate(job_id, body, authorization, x_agent_id, renew_lease=True)

    @router.post("/{job_id}/progress", response_model=ManagedJob)
    async def progress(job_id: str, body: JobEventBody, authorization: str = Header(default=""), x_agent_id: str = Header(default="", alias="X-Agent-ID")) -> ManagedJob:
        return await mutate(job_id, body, authorization, x_agent_id, renew_lease=True)

    @router.post("/{job_id}/complete", response_model=ManagedJob)
    async def complete(job_id: str, body: JobEventBody, authorization: str = Header(default=""), x_agent_id: str = Header(default="", alias="X-Agent-ID")) -> ManagedJob:
        return await mutate(job_id, body, authorization, x_agent_id, status=ManagedJobStatus.SUCCEEDED)

    @router.post("/{job_id}/fail", response_model=ManagedJob)
    async def fail(job_id: str, body: JobEventBody, authorization: str = Header(default=""), x_agent_id: str = Header(default="", alias="X-Agent-ID")) -> ManagedJob:
        return await mutate(job_id, body, authorization, x_agent_id, status=ManagedJobStatus.FAILED)

    @router.post("/{job_id}/cancel", response_model=ManagedJob)
    async def cancel(job_id: str, body: JobEventBody, authorization: str = Header(default=""), x_agent_id: str = Header(default="", alias="X-Agent-ID")) -> ManagedJob:
        return await mutate(job_id, body, authorization, x_agent_id, status=ManagedJobStatus.CANCELLED)

    return router
