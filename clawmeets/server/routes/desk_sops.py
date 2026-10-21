# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/desk_sops.py

HTTP surface for the My Desk SOP library — stored, reusable prompts with
typed ``{{blanks}}`` (see ``clawmeets/models/desk_sop.py``).

- ``GET    /me/desk/sops``          — the owner's library.
- ``POST   /me/desk/sops``          — store one ``{title, body, agent_id?,
  agent_name?}``.
- ``PATCH  /me/desk/sops/{id}``     — partial update.
- ``DELETE /me/desk/sops/{id}``     — remove one.

Who may do what:

- **Create** is open to every agent the owner has registered (agent bearer +
  ``X-Agent-ID``, mapped to the agent's owner — the same rule
  ``POST /me/desk/todos`` publishes by), so any of the owner's agents can
  store a procedure it just worked out as a reusable SOP. Another user's
  agent resolves to *its* owner, so it can only ever write into its own
  owner's library.
- **Read, edit and delete** stay narrow: the owner's browser JWT or the
  owner's own ``{username}-assistant`` bearer, resolved via
  ``AuthService.resolve_user_from_credential``. Any other agent's token gets
  401 there — a worker can add to the library but cannot browse it or rewrite
  what the owner curated.

Every mutation fans out ``DESK_SOP_SYNC`` to the owner. ``WSHub.send_to``
delivers to *every* live session the user holds, so an SOP created, edited or
deleted in one browser tab shows up in all their other tabs and devices
without a reload.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Body, Header, HTTPException, Request

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    DeskSopSyncPayload,
)
from clawmeets.models.agent import Agent
from clawmeets.models.desk_sop import (
    create_sop,
    delete_sop,
    list_sops,
    patch_sop,
)
from clawmeets.models.user import User

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def create_desk_sops_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["desk-sops"])

    def _dir():
        return ctx.model_ctx.participants_dir

    async def _principal(authorization: str) -> User:
        """Resolve the SOP library's owner from a credential.

        Accepts the owner's browser JWT or the owner's assistant bearer; every
        other agent token raises 401. This one call IS the whole narrowing for
        read / edit / delete, so "who may curate the library" cannot drift
        between those handlers. Create deliberately does not use it.
        """
        return await ctx.auth.resolve_user_from_credential(authorization)

    def _resolve_target_agent(
        owner_user_id: str,
        agent_id: str | None,
        agent_name: str | None,
    ) -> tuple[str | None, str | None]:
        """Normalize the dispatch-target agent for a create/update.

        ``agent_id`` wins when the caller supplied one — that's the browser,
        which picked from a live roster. A bare ``agent_name`` is the CLI, which
        knows names, so it resolves in the owner's namespace (short or full).
        An unresolved name is stored as a label with a null id, matching how
        ``--suggest`` degrades on the to-do plate: the rail still shows who this
        was meant for even after that agent is gone.
        """
        if agent_id or not agent_name:
            return agent_id, agent_name
        resolved = Agent.get_by_name_for_owner(agent_name, owner_user_id, ctx.model_ctx)
        if resolved is None:
            return None, agent_name
        return resolved.id, resolved.name

    async def _broadcast(owner_user_id: str, action: str, sop_id: str | None) -> None:
        """Tell every live session this owner holds that the library moved.

        ``WSHub.send_to`` fans out to all of the participant's connections, so
        one call covers every open tab and device. The session that made the
        change gets it too; its refetch is idempotent.
        """
        envelope = ControlEnvelope(
            type=ControlMessageType.DESK_SOP_SYNC,
            payload=DeskSopSyncPayload(action=action, id=sop_id),
        )
        delivered = await ctx.ws_hub.send_to(owner_user_id, envelope)
        if delivered:
            logger.info(f"Sent DESK_SOP_SYNC({action}) to user {owner_user_id[:8]}")

    @router.get("/me/desk/sops")
    async def list_my_sops(
        authorization: str = Header(default=""),
    ):
        """List the owner's SOP library, newest first.

        The plain credential rule applies, so the owner's assistant can read
        the library it is allowed to write."""
        owner_id = (await _principal(authorization)).id
        return [s.model_dump() for s in list_sops(_dir(), owner_id)]

    @router.post("/me/desk/sops")
    async def create_my_sop(
        title: str = Body(..., embed=True),
        body: str = Body(..., embed=True),
        agent_id: str | None = Body(default=None, embed=True),
        agent_name: str | None = Body(default=None, embed=True),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Store one SOP. Owner JWT, or ANY of the owner's agents (bearer +
        ``X-Agent-ID``) — the write lands in that agent's owner's library."""
        owner_id = await ctx.auth.resolve_viewer(authorization, x_agent_id)
        if owner_id is None:
            raise HTTPException(401, "Authentication required")
        agent_id, agent_name = _resolve_target_agent(owner_id, agent_id, agent_name)
        try:
            sop = await create_sop(
                _dir(),
                owner_id,
                title=title,
                body=body,
                agent_id=agent_id,
                agent_name=agent_name,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        await _broadcast(owner_id, "add", sop.id)
        return sop.model_dump()

    @router.patch("/me/desk/sops/{sop_id}")
    async def patch_my_sop(
        sop_id: str,
        request: Request,
        title: str | None = Body(default=None, embed=True),
        body: str | None = Body(default=None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Partially update one SOP. Owner JWT or the owner's assistant bearer."""
        user = await _principal(authorization)
        # agent_id / agent_name are three-way (absent → untouched, null →
        # clear, string → set), so we detect key *presence* off the raw body
        # rather than a Body default — FastAPI can't carry a non-serializable
        # sentinel default, and a plain None default can't tell absent from
        # null. Same trick as patch_my_todo.
        try:
            raw = await request.json()
        except Exception:
            raw = {}
        agent_fields: dict[str, str | None] = {}
        if isinstance(raw, dict):
            for key in ("agent_id", "agent_name"):
                if key in raw:
                    val = raw[key]
                    agent_fields[key] = val if isinstance(val, str) else None
        # A name-only reassignment (the CLI's `--agent ops`) has to resolve to an
        # id, or the rail would show the label while the send path had nobody to
        # send to. Only when BOTH keys are in play as a set — a lone `agent_id`
        # is the browser, and a lone null is a clear.
        if agent_fields.get("agent_name") and not agent_fields.get("agent_id"):
            resolved_id, resolved_name = _resolve_target_agent(
                user.id, None, agent_fields["agent_name"]
            )
            agent_fields["agent_id"] = resolved_id
            agent_fields["agent_name"] = resolved_name
        try:
            sop = await patch_sop(
                _dir(),
                user.id,
                sop_id,
                title=title,
                body=body,
                **agent_fields,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        if sop is None:
            raise HTTPException(404, f"SOP {sop_id!r} not found")
        await _broadcast(user.id, "patch", sop.id)
        return sop.model_dump()

    @router.delete("/me/desk/sops/{sop_id}")
    async def delete_my_sop(
        sop_id: str,
        authorization: str = Header(default=""),
    ):
        """Remove one SOP. Owner JWT or the owner's assistant bearer."""
        user = await _principal(authorization)
        existed = await delete_sop(_dir(), user.id, sop_id)
        if not existed:
            raise HTTPException(404, f"SOP {sop_id!r} not found")
        await _broadcast(user.id, "delete", sop_id)
        return {"status": "deleted", "id": sop_id}

    return router
