# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/project_reports.py

Project-scoped interactive report routes — one artifact per project,
authored by the coordinator and rendered in the project detail view.

Reuses the self-serve tab publishing protocol (``data`` JSON +
``render_code_js`` body) but project-scoped instead of user-scoped.

Routes:

- ``GET /projects/{project_id}/report`` — any caller; returns the report
  or 404 if none exists yet.
- ``PUT /projects/{project_id}/report`` — coordinator-only (agent bearer
  matching ``project.coordinator_id``). Upserts the report and broadcasts
  ``PROJECT_REPORT_SYNC`` to every project participant.
- ``DELETE /projects/{project_id}/report`` — coordinator-only.

Payload size bounded: ``data`` JSON ≤ 64 KB serialized, ``render_code_js``
≤ 64 KB — same caps as brief-tabs (keeps the WS envelope small and the
on-disk JSON greppable). Render-code syntax validation is deferred to the
frontend's ``new Function`` try/catch.
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException

from clawmeets.api.control import (
    ChangelogUpdatePayload,
    ControlEnvelope,
    ControlMessageType,
    ProjectReportSyncPayload,
)
from clawmeets.models.agent import Agent
from clawmeets.models.project import Project
from clawmeets.server.isolation_gate import check_project_read
from clawmeets.models.project_report import (
    delete_report,
    get_report,
    upsert_report,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

_MAX_DATA_BYTES = 64 * 1024
_MAX_RENDER_CODE_BYTES = 64 * 1024


def create_project_reports_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["project-reports"])

    def _metadata_dir(project: Project):
        return ctx.model_ctx.llm_log_dir(project.id, project.name)

    async def _broadcast(
        project: Project, payload: ProjectReportSyncPayload
    ) -> None:
        envelope = ControlEnvelope(
            type=ControlMessageType.PROJECT_REPORT_SYNC,
            payload=payload,
        )
        count = await ctx.ws_hub.broadcast_to_project(envelope, project)
        logger.info(
            f"Sent PROJECT_REPORT_SYNC({payload.action}) for project "
            f"{project.id[:8]} to {count} recipients"
        )

    async def _emit_changelog_update(project: Project) -> None:
        """Re-push ``project`` over the EXISTING channel the desk re-derives its
        project list from, so the freshly (re)stamped ``report_published_at`` goes
        live without a page refresh.

        The frontend's CHANGELOG_UPDATE handler invalidates
        ``['user-projects']``/``['all-projects']`` whenever a ``project_id`` is
        present, so the desk refetches the list and picks up the new field value —
        no per-card fetch. A completed-no-report project that had dropped off the
        desk re-enters the Project Reports lane live; a deleted report drops it
        back off, symmetrically.

        Reuses ``runloop.get_current_version()`` WITHOUT appending a changelog
        entry: the report is a file artifact, not a changelog event, so this
        signals "re-read", not "new version". An echo to a project runner is a
        benign no-op (``new_version == current_version`` → delta-sync finds
        nothing). ``broadcast_to_project`` already includes the project owner (the
        desk user) in its recipient set.
        """
        runloop = await ctx.runloop_manager.get_or_create(project.id, project.name)
        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project.id,
                project_name=project.name,
                new_version=runloop.get_current_version(),
                coordinator_id=project.coordinator_id,
            ),
        )
        count = await ctx.ws_hub.broadcast_to_project(envelope, project)
        logger.info(
            f"Sent CHANGELOG_UPDATE (report re-derive) for project "
            f"{project.id[:8]} to {count} recipients"
        )

    @router.get("/projects/{project_id}/report")
    async def get_project_report(
        project_id: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """Fetch the project's report. 404 if none has been authored yet.

        Access matches ``GET /projects/{id}``: anyone with the id can
        read, except that an isolated project passes the isolation gate.
        The frontend already gates project visibility on its own list
        endpoints.
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        await check_project_read(ctx, project, authorization=authorization, x_agent_id=x_agent_id)
        report = get_report(_metadata_dir(project))
        if report is None:
            raise HTTPException(404, f"No report for project {project_id!r}")
        return report.model_dump()

    @router.put("/projects/{project_id}/report")
    async def upsert_project_report(
        project_id: str,
        title: str = Body("", embed=True),
        data: dict | list = Body(default_factory=dict, embed=True),
        render_code_js: str = Body("", embed=True),
        authorization: str = Header(default=""),
    ):
        """Upsert the project's report.

        Coordinator-only — auth via the coordinator's bearer token, the same
        AGENT branch ``POST /projects/{id}/complete`` runs first. It is only
        that branch: completing also accepts the owner's JWT (the desk card's
        Done button), and writing a report is not something an owner does.
        Called by the publishing coordinator via the
        ``clawmeets project upsert-report`` CLI.
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        await ctx.auth.check_agent_token(project.coordinator_id, authorization)

        coordinator = Agent.get(project.coordinator_id, ctx.model_ctx)
        if coordinator is None:
            raise HTTPException(
                500, f"Coordinator {project.coordinator_id!r} not found"
            )

        try:
            data_size = len(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        except (TypeError, ValueError) as e:
            raise HTTPException(400, f"data must be JSON-serializable: {e}")
        if data_size > _MAX_DATA_BYTES:
            raise HTTPException(
                413, f"data exceeds {_MAX_DATA_BYTES} bytes (got {data_size})"
            )
        if len(render_code_js.encode("utf-8")) > _MAX_RENDER_CODE_BYTES:
            raise HTTPException(
                413, f"render_code_js exceeds {_MAX_RENDER_CODE_BYTES} bytes"
            )

        report = await upsert_report(
            _metadata_dir(project),
            project_id=project.id,
            generated_by_agent_id=coordinator.id,
            generated_by_agent_name=coordinator.name,
            title=title,
            data=data,
            render_code_js=render_code_js,
        )

        # Denormalize the report's generated_at into meta.json BEFORE the
        # rebroadcast, so the desk's refetch (triggered below) reads the populated
        # report_published_at. This is the write the list path reads for free.
        project.state().set_report_published_at(report.generated_at)

        await _broadcast(
            project,
            ProjectReportSyncPayload(
                project_id=project.id,
                action="upsert",
                title=report.title,
                generated_by_agent_name=report.generated_by_agent_name,
                generated_at=report.generated_at,
            ),
        )
        # Re-push the project over the desk's existing channel so a dropped
        # (completed-no-report) project reappears in the Project Reports lane live.
        await _emit_changelog_update(project)
        return report.model_dump()

    @router.delete("/projects/{project_id}/report")
    async def delete_project_report(
        project_id: str,
        authorization: str = Header(default=""),
    ):
        """Delete the project's report. Coordinator-only."""
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        await ctx.auth.check_agent_token(project.coordinator_id, authorization)

        existed = await delete_report(_metadata_dir(project))
        if not existed:
            raise HTTPException(404, f"No report for project {project_id!r}")

        # Clear the denormalized field: report.json is gone, so
        # report_published_at must return to null (getProjectReport would 404).
        project.state().set_report_published_at(None)

        await _broadcast(
            project,
            ProjectReportSyncPayload(project_id=project.id, action="delete"),
        )
        # Symmetric re-push: the desk refetches and the now-null field drops the
        # project back off the Project Reports lane live.
        await _emit_changelog_update(project)
        return {"status": "deleted", "project_id": project.id}

    return router
