# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/reflection.py
Account-level reflection-schedule routes.

A user has at most one ReflectionSchedule. When it fires, the
ReflectionScheduler fans out to the user's agents and triggers reflection
only for those with unreflected activity.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Body, Header, HTTPException

from clawmeets.models.scheduled_message import validate_cron_expression, validate_timezone

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server.reflection")


def create_reflection_router(ctx: "ServerContext") -> APIRouter:
    """Create the account-level reflection-schedule router."""
    router = APIRouter(tags=["reflection"])

    def _to_response(schedule) -> dict:
        return {
            "user_id": schedule.user_id,
            "username": schedule.username,
            "cron_expression": schedule.cron_expression,
            "timezone": schedule.timezone,
            "is_active": schedule.is_active,
            "created_at": schedule.created_at.isoformat(),
            "last_fired_at": schedule.last_fired_at.isoformat() if schedule.last_fired_at else None,
            "next_fire_at": schedule.next_fire_at.isoformat(),
        }

    @router.get("/account/reflection-schedule")
    async def get_reflection_schedule(
        authorization: str = Header(default=""),
    ):
        """Return the current user's reflection schedule, or null."""
        current_user = await ctx.auth.get_current_user(authorization)
        schedule = await ctx.reflection_schedule_store.get_by_user(current_user.id)
        if schedule is None:
            return None
        return _to_response(schedule)

    @router.put("/account/reflection-schedule")
    async def set_reflection_schedule(
        cron_expression: str = Body(..., embed=True),
        is_active: bool = Body(True, embed=True),
        timezone: str = Body("UTC", embed=True),
        authorization: str = Header(default=""),
    ):
        """Upsert the user's reflection schedule.

        Reflect fires when ``cron_expression`` boundary is crossed; the agent's
        reflect skill distills new lessons and audits the existing wiki in the
        same turn. ``timezone`` (IANA name) is the zone the cron is evaluated
        in.
        """
        current_user = await ctx.auth.get_current_user(authorization)
        if not validate_cron_expression(cron_expression):
            raise HTTPException(400, f"Invalid cron expression: {cron_expression!r}")
        if not validate_timezone(timezone):
            raise HTTPException(400, f"Invalid timezone: {timezone!r}")
        schedule = await ctx.reflection_schedule_store.upsert(
            user_id=current_user.id,
            username=current_user.username,
            cron_expression=cron_expression,
            is_active=is_active,
            timezone=timezone,
        )
        logger.info(
            f"Reflection schedule upserted for user={current_user.username!r} "
            f"cron={cron_expression!r} tz={timezone!r} active={is_active}"
        )
        return _to_response(schedule)

    @router.delete("/account/reflection-schedule")
    async def delete_reflection_schedule(
        authorization: str = Header(default=""),
    ):
        """Deactivate the user's reflection schedule."""
        current_user = await ctx.auth.get_current_user(authorization)
        ok = await ctx.reflection_schedule_store.deactivate(current_user.id)
        return {"deactivated": ok}

    return router
