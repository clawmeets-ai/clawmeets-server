# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/scheduled_messages.py
Scheduled message management routes.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel

from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project
from clawmeets.models.scheduled_message import (
    ScheduledMessage,
    compute_next_fire,
    validate_cron_expression,
    validate_timezone,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


class CreateScheduledMessageBody(BaseModel):
    """Request body for creating a scheduled message."""

    project_id: str
    chatroom_name: str
    content: str
    cron_expression: str  # e.g. "0 9 * * *", "@daily", "@hourly"
    timezone: str = "UTC"  # IANA name; cron is evaluated in this zone
    start_at: Optional[datetime] = None  # first fire time (default: next cron match)
    end_at: Optional[datetime] = None  # optional expiration
    idle_only: bool = False  # skip ticks while the target project has open batches


class UpdateScheduledMessageBody(BaseModel):
    """Request body for updating an existing scheduled message."""

    project_id: str
    chatroom_name: str
    content: str
    cron_expression: str
    timezone: str = "UTC"
    end_at: Optional[datetime] = None


class ScheduledMessageResponse(BaseModel):
    """Response model for scheduled messages."""

    id: str
    user_id: str
    username: str
    project_id: str
    chatroom_name: str
    content: str
    cron_expression: str
    timezone: str = "UTC"
    end_at: Optional[datetime] = None
    created_at: datetime
    last_fired_at: Optional[datetime] = None
    next_fire_at: datetime
    is_active: bool
    idle_only: bool = False


def create_scheduled_messages_router(ctx: "ServerContext") -> APIRouter:
    """Create the scheduled messages router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["scheduled-messages"])

    @router.post("/scheduled-messages", response_model=ScheduledMessageResponse)
    async def create_scheduled_message(
        body: CreateScheduledMessageBody = Body(...),
        authorization: str = Header(default=""),
    ):
        """Create a new scheduled message.

        Schedules a message to be sent to a chatroom on a cron schedule.
        Supports standard cron expressions and presets (@hourly, @daily, @weekly).

        Accepts a user JWT or the user's assistant-agent bearer token.
        """
        current_user = await ctx.auth.resolve_user_from_credential(authorization)

        # Validate cron expression
        if not validate_cron_expression(body.cron_expression):
            raise HTTPException(422, f"Invalid cron expression: {body.cron_expression!r}")

        # Validate timezone
        if not validate_timezone(body.timezone):
            raise HTTPException(422, f"Invalid timezone: {body.timezone!r}")

        # Validate project
        project = Project.get(body.project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(404, f"Project {body.project_id!r} not found")
        if project.created_by != current_user.id:
            raise HTTPException(403, "Not authorized for this project")

        # Validate chatroom
        room = Chatroom.get(body.project_id, body.chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {body.chatroom_name!r} not found")
        if not room.is_user_communication_room:
            raise HTTPException(400, "Can only schedule messages to user-communication chatrooms")

        # Compute first fire time
        now = datetime.now(UTC)
        if body.start_at:
            next_fire = body.start_at
        else:
            next_fire = compute_next_fire(body.cron_expression, now, body.timezone)

        # Validate end_at
        if body.end_at and body.end_at <= now:
            raise HTTPException(400, "end_at must be in the future")
        if body.end_at and next_fire > body.end_at:
            raise HTTPException(400, "First fire time would be after end_at")

        msg = ScheduledMessage(
            id=str(uuid.uuid4()),
            user_id=current_user.id,
            username=current_user.username,
            project_id=body.project_id,
            chatroom_name=body.chatroom_name,
            content=body.content,
            cron_expression=body.cron_expression,
            timezone=body.timezone,
            end_at=body.end_at,
            created_at=now,
            next_fire_at=next_fire,
            idle_only=body.idle_only,
        )

        await ctx.scheduled_message_store.add(msg)
        logger.info(
            f"Scheduled message created: id={msg.id[:8]} "
            f"user={current_user.username} room={body.chatroom_name} "
            f"cron={body.cron_expression!r} tz={body.timezone!r} "
            f"next_fire={next_fire.isoformat()}"
        )

        return ScheduledMessageResponse(**msg.model_dump())

    @router.put(
        "/scheduled-messages/{message_id}", response_model=ScheduledMessageResponse
    )
    async def update_scheduled_message(
        message_id: str,
        body: UpdateScheduledMessageBody = Body(...),
        authorization: str = Header(default=""),
    ):
        """Update an existing scheduled message.

        Rewrites content/cron/timezone/end_at and the target chatroom, then
        recomputes the next fire time. Mirrors the create-time validation.

        Accepts a user JWT or the user's assistant-agent bearer token.
        """
        current_user = await ctx.auth.resolve_user_from_credential(authorization)

        # Validate cron expression
        if not validate_cron_expression(body.cron_expression):
            raise HTTPException(422, f"Invalid cron expression: {body.cron_expression!r}")

        # Validate timezone
        if not validate_timezone(body.timezone):
            raise HTTPException(422, f"Invalid timezone: {body.timezone!r}")

        # Validate project
        project = Project.get(body.project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(404, f"Project {body.project_id!r} not found")
        if project.created_by != current_user.id:
            raise HTTPException(403, "Not authorized for this project")

        # Validate chatroom
        room = Chatroom.get(body.project_id, body.chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {body.chatroom_name!r} not found")
        if not room.is_user_communication_room:
            raise HTTPException(400, "Can only schedule messages to user-communication chatrooms")

        # Validate end_at against the freshly computed first fire time
        now = datetime.now(UTC)
        next_fire = compute_next_fire(body.cron_expression, now, body.timezone)
        if body.end_at and body.end_at <= now:
            raise HTTPException(400, "end_at must be in the future")
        if body.end_at and next_fire > body.end_at:
            raise HTTPException(400, "Next fire time would be after end_at")

        updated = await ctx.scheduled_message_store.update(
            message_id,
            current_user.id,
            project_id=body.project_id,
            chatroom_name=body.chatroom_name,
            content=body.content,
            cron_expression=body.cron_expression,
            timezone=body.timezone,
            end_at=body.end_at,
        )
        if updated is None:
            raise HTTPException(404, "Scheduled message not found")

        logger.info(
            f"Scheduled message updated: id={message_id[:8]} "
            f"user={current_user.username} room={body.chatroom_name} "
            f"cron={body.cron_expression!r} tz={body.timezone!r} "
            f"next_fire={updated.next_fire_at.isoformat()}"
        )

        return ScheduledMessageResponse(**updated.model_dump())

    @router.get("/scheduled-messages", response_model=list[ScheduledMessageResponse])
    async def list_scheduled_messages(
        authorization: str = Header(default=""),
        active_only: bool = True,
    ):
        """List scheduled messages for the current user.

        Accepts a user JWT or the user's assistant-agent bearer token.
        """
        current_user = await ctx.auth.resolve_user_from_credential(authorization)

        messages = await ctx.scheduled_message_store.get_by_user(current_user.id)
        if active_only:
            messages = [m for m in messages if m.is_active]

        return [ScheduledMessageResponse(**m.model_dump()) for m in messages]

    @router.delete("/scheduled-messages/{message_id}")
    async def cancel_scheduled_message(
        message_id: str,
        authorization: str = Header(default=""),
    ):
        """Cancel (deactivate) a scheduled message.

        Accepts a user JWT or the user's assistant-agent bearer token.
        """
        current_user = await ctx.auth.resolve_user_from_credential(authorization)

        success = await ctx.scheduled_message_store.deactivate(message_id, current_user.id)
        if not success:
            raise HTTPException(404, "Scheduled message not found or already cancelled")

        logger.info(f"Scheduled message cancelled: id={message_id[:8]} user={current_user.username}")
        return {"status": "cancelled", "id": message_id}

    return router
