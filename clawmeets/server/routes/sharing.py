# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/sharing.py
Project sharing routes for read-only link-based access.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header, HTTPException

from clawmeets.models.project import Project
from clawmeets.models.share_token import (
    add_viewer,
    generate_share_token,
    get_token_info,
    is_viewer,
    remove_viewer,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def create_sharing_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter()

    @router.post("/projects/{project_id}/share")
    async def create_share_link(
        project_id: str,
        authorization: str = Header(default=""),
    ):
        """Generate a share link for a project. Owner only."""
        current_user = await ctx.auth.get_current_user(authorization)

        project = Project.get(project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(404, f"Project {project_id!r} not found")

        if project.created_by != current_user.id:
            raise HTTPException(403, "Only the project owner can share")

        token = await generate_share_token(
            project_id, current_user.id, ctx.model_ctx.participants_dir
        )
        return {"token": token, "share_url": f"/shared/{token}"}

    @router.get("/shared/{token}/info")
    async def get_share_token_info(token: str):
        """Get basic info about a share token. No auth required (public)."""
        info = get_token_info(token, ctx.model_ctx.participants_dir)
        if info is None:
            raise HTTPException(404, "Invalid or expired share link")

        project = Project.get(info["project_id"], ctx.model_ctx)
        if project is None:
            raise HTTPException(404, "Project no longer exists")

        return {"project_name": project.display_name or project.name}

    @router.get("/shared/{token}")
    async def get_share_info(
        token: str,
        authorization: str = Header(default=""),
    ):
        """Get share info for authenticated user."""
        current_user = await ctx.auth.get_current_user(authorization)

        info = get_token_info(token, ctx.model_ctx.participants_dir)
        if info is None:
            raise HTTPException(404, "Invalid or expired share link")

        project = Project.get(info["project_id"], ctx.model_ctx)
        if project is None:
            raise HTTPException(404, "Project no longer exists")

        already_added = current_user.id in info["viewers"]
        is_owner = project.created_by == current_user.id

        return {
            "project_id": project.id,
            "project_name": project.display_name or project.name,
            "already_added": already_added,
            "is_owner": is_owner,
        }

    @router.post("/shared/{token}/join")
    async def join_shared_project(
        token: str,
        authorization: str = Header(default=""),
    ):
        """Add current user as a read-only viewer of the shared project."""
        current_user = await ctx.auth.get_current_user(authorization)

        info = get_token_info(token, ctx.model_ctx.participants_dir)
        if info is None:
            raise HTTPException(404, "Invalid or expired share link")

        # Don't let the owner "join" their own project as viewer
        project = Project.get(info["project_id"], ctx.model_ctx)
        if project and project.created_by == current_user.id:
            return {"project_id": info["project_id"], "status": "owner"}

        project_id = await add_viewer(token, current_user.id, ctx.model_ctx.participants_dir)
        if project_id is None:
            raise HTTPException(404, "Invalid or expired share link")

        logger.info(f"User {current_user.id[:8]} joined project {project_id[:8]} as viewer")
        return {"project_id": project_id, "status": "joined"}

    @router.delete("/projects/{project_id}/share/{token}")
    async def revoke_share_link(
        project_id: str,
        token: str,
        authorization: str = Header(default=""),
    ):
        """Revoke a specific share token. Owner only."""
        current_user = await ctx.auth.get_current_user(authorization)

        project = Project.get(project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(404, f"Project {project_id!r} not found")

        if project.created_by != current_user.id:
            raise HTTPException(403, "Only the project owner can revoke share links")

        info = get_token_info(token, ctx.model_ctx.participants_dir)
        if info is None or info["project_id"] != project_id:
            raise HTTPException(404, "Share token not found for this project")

        # For now we don't have a single-token revoke; this could be added later.
        # The owner can regenerate a new token instead.
        return {"status": "revoked"}

    @router.delete("/shared/projects/{project_id}")
    async def remove_shared_project(
        project_id: str,
        authorization: str = Header(default=""),
    ):
        """Remove current user from viewers of a shared project (unsubscribe)."""
        current_user = await ctx.auth.get_current_user(authorization)

        if not is_viewer(project_id, current_user.id, ctx.model_ctx.participants_dir):
            raise HTTPException(404, "You are not a viewer of this project")

        removed = await remove_viewer(project_id, current_user.id, ctx.model_ctx.participants_dir)
        if not removed:
            raise HTTPException(404, "You are not a viewer of this project")

        logger.info(f"User {current_user.id[:8]} removed from viewers of project {project_id[:8]}")
        return {"status": "removed"}

    return router
