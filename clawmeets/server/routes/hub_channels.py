# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/hub_channels.py
An agent owner's Hub channel (``/me/channels/hub/{agent_full_name}``), as
written in design section 5 and frozen in ``server/hub/browser.py``:

- ``GET``: the card (``HubChannel``), masked: the only key material shown is
  ``key_last4``, the tail of the agent key's fingerprint.
- ``POST …/enable`` ``{client_request_id}``: makes the agent public (the
  Hub switch is the one sharing control in the web app; a refused enable
  leaves a private agent private) and answers ``enabling`` at once
  (idempotent per agent and request id); the hub's answer arrives as a
  ``hub_channel_status`` push. On an enabled channel this is "Reconnect":
  the certificate is renewed if under 7 days are left and the agent is
  registered again. Hub-state errors come from ``HubRuntime.require``.
- ``POST …/disable`` ``{confirm: true, stop_now?}``: local and immediate in
  every mode and registration state, with the hub off too; never a hub-state
  error. Makes the agent private (which clears owner isolation). ``agent_unregister`` goes now or on the next connect.
- ``GET · POST · DELETE …/blocked_deployments``: deployments blocked from
  this agent, by GENESIS fingerprint (a current fingerprint is resolved
  through the pins), so a block survives the blocked deployment's rotation.
  DELETE takes ``?deployment_fingerprint=``.

``not_owner`` [403] for another user's agent, ``agent_not_found`` [404] for
no such agent.

The caller as an agent OWNER on the hub (``server/hub/enroll.py``), user JWT
only (accepting the hub terms, and perhaps becoming this server's hub contact,
is the user's own act; any agent token is ``user_only`` [403]):

- ``GET /me/channels/hub/enrollment``: ``HubEnrollment``.
- ``POST /me/channels/hub/enrollment`` ``{accept_tos_version}``: registers this
  server (one code does both) or starts the owner check; the hub mails a code.
- ``POST /me/channels/hub/enrollment/confirm`` ``{code}``.

Declared before the ``{agent_full_name}`` routes, so "enrollment" never
reaches them as an agent name.
"""
from __future__ import annotations

import time
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Header, HTTPException, Query

from clawmeets.hub_protocol.ids import FINGERPRINT_RE
from clawmeets.models.agent import Agent
from clawmeets.server.agent_visibility import local_conversation_count, set_agent_public
from clawmeets.server.channels.config import HUB_OFF
from clawmeets.server.channels.hub_store import HubStore
from clawmeets.server.hub.adapter import disable_locally, next_local_midnight
from clawmeets.server.hub.browser import (
    BlockedList,
    BlockRequest,
    DisableRequest,
    EnableRequest,
    EnrollConfirm,
    EnrollRequest,
    HubChannel,
    HubEnrollment,
    HubError,
)
from clawmeets.server.hub.views import blocked_out, channel_out

if TYPE_CHECKING:
    from clawmeets.models.user import User
    from clawmeets.server.context import ServerContext


def create_hub_channels_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["hub"])

    async def _owned_agent(agent_full_name: str, authorization: str) -> tuple["User", Agent]:
        try:
            user = await ctx.auth.resolve_user_from_credential(authorization)
        except HTTPException as exc:
            if exc.status_code == 401:
                raise HubError("unauthorized", "sign in first") from None
            raise
        agent = Agent.get_by_name(agent_full_name, ctx.model_ctx)
        if agent is None:
            raise HubError("agent_not_found", "no such agent")
        if agent.registered_by != user.id:
            raise HubError("not_owner", "this agent is someone else's")
        return user, agent

    def _hub() -> Optional[HubStore]:
        if ctx.hub_runtime is not None:
            return ctx.hub_runtime.hub
        return HubStore(ctx.channel_store) if ctx.channel_store is not None else None

    def _now() -> float:
        return ctx.channel_gateway._now() if ctx.channel_gateway is not None else time.time()

    def _view(agent: Agent) -> HubChannel:
        if ctx.hub_runtime is not None:
            return ctx.hub_runtime.channel_view(agent)
        hub = _hub()                                            # the hub is off: from the store alone
        state = hub.channel_state(agent.id) if hub is not None else None
        threads, rows = hub.channel_counts(state.connection_id if state else None) if hub else (0, 0)
        now = _now()
        return channel_out(HUB_OFF, None, link="off", agent=agent, state=state, open_conversations=threads,
                           in_flight_messages=rows, next_midnight=next_local_midnight(now), now=now,
                           local_conversations=local_conversation_count(ctx.model_ctx, agent))

    def _genesis(hub: HubStore, fingerprint: str) -> str:
        if not FINGERPRINT_RE.fullmatch(fingerprint or ""):
            raise HTTPException(422, "deployment_fingerprint is not a fingerprint")
        return hub.genesis_of(fingerprint) or fingerprint

    async def _enrolling_user(authorization: str) -> "User":
        try:
            return await ctx.auth.get_current_user(authorization)
        except HTTPException as exc:
            if exc.status_code != 401:
                raise
        try:
            await ctx.auth.resolve_credential(authorization)
        except HTTPException:
            raise HubError("unauthorized", "sign in first") from None
        raise HubError("user_only", "only the user can set up hub access, never an agent")

    def _enrollment():
        runtime = ctx.hub_runtime
        if runtime is None:
            raise HubError("hub_off_on_server", "the hub is off on this server")
        return runtime.enrollment

    @router.get("/me/channels/hub/enrollment", response_model=HubEnrollment)
    async def get_enrollment(authorization: str = Header(default="")):
        user = await _enrolling_user(authorization)
        return _enrollment().view(user)

    @router.post("/me/channels/hub/enrollment", response_model=HubEnrollment)
    async def start_enrollment(body: EnrollRequest, authorization: str = Header(default="")):
        user = await _enrolling_user(authorization)
        return await _enrollment().start(user, body.accept_tos_version)

    @router.post("/me/channels/hub/enrollment/confirm", response_model=HubEnrollment)
    async def confirm_enrollment(body: EnrollConfirm, authorization: str = Header(default="")):
        user = await _enrolling_user(authorization)
        return await _enrollment().confirm(user, body.code)

    @router.get("/me/channels/hub/{agent_full_name}", response_model=HubChannel)
    async def get_hub_channel(agent_full_name: str, authorization: str = Header(default="")):
        _user, agent = await _owned_agent(agent_full_name, authorization)
        return _view(agent)

    @router.post("/me/channels/hub/{agent_full_name}/enable", response_model=HubChannel)
    async def enable_hub_channel(agent_full_name: str, body: EnableRequest,
                                 authorization: str = Header(default="")):
        _user, agent = await _owned_agent(agent_full_name, authorization)
        runtime = ctx.hub_runtime
        if runtime is None:
            raise HubError("hub_off_on_server", "the hub is off on this server")
        state = runtime.hub.channel_state(agent.id)
        if state is not None and state.enabled and state.enable_request_id == body.client_request_id:
            return runtime.channel_view(agent)                 # the same click again
        gate = getattr(ctx, "isolation_gate", None)
        if gate is not None and not gate.agent_capable(agent.id):
            # Hub conversations are requester-scoped; an agent whose runners
            # cannot run an isolated turn cannot serve them.
            raise HubError("isolation_unavailable",
                           "this agent's computer cannot run conversations from strangers safely")
        # The switch is the one sharing control: on makes the agent public,
        # only once the hub and the owner check out, and a refused enable
        # leaves a private agent private again.
        await runtime.adapter.check_can_enable(agent)
        published = await set_agent_public(ctx, agent, True)
        try:
            await runtime.adapter.enable(agent, client_request_id=body.client_request_id, register=False)
        except BaseException:
            if published:
                await set_agent_public(ctx, agent, False)
            raise
        view = runtime.channel_view(agent)
        runtime.adapter.track(runtime.adapter.register(agent.id))
        return view

    @router.post("/me/channels/hub/{agent_full_name}/disable", response_model=HubChannel)
    async def disable_hub_channel(agent_full_name: str, body: DisableRequest,
                                  authorization: str = Header(default="")):
        _user, agent = await _owned_agent(agent_full_name, authorization)
        if not body.confirm:
            raise HubError("confirm_required", "confirm turning the Hub channel off")
        if ctx.hub_runtime is not None:
            await ctx.hub_runtime.adapter.disable(agent, stop_now=body.stop_now)
        else:
            hub = _hub()
            if hub is not None:
                disable_locally(hub, agent, stop_now=body.stop_now, now=_now())
        # Off is private: nobody else can message it any more, and owner
        # isolation (which needs a public agent) is turned off with it.
        await set_agent_public(ctx, agent, False)
        return _view(agent)

    @router.get("/me/channels/hub/{agent_full_name}/blocked_deployments", response_model=BlockedList)
    async def list_blocked(agent_full_name: str, authorization: str = Header(default="")):
        _user, agent = await _owned_agent(agent_full_name, authorization)
        hub = _hub()
        state = hub.channel_state(agent.id) if hub is not None else None
        return BlockedList(blocked=blocked_out(hub, state.connection_id if state else None) if hub else [])

    @router.post("/me/channels/hub/{agent_full_name}/blocked_deployments", response_model=BlockedList)
    async def block_deployment(agent_full_name: str, body: BlockRequest,
                               authorization: str = Header(default="")):
        _user, agent = await _owned_agent(agent_full_name, authorization)
        runtime = ctx.hub_runtime
        hub = _hub()
        if hub is None:
            raise HubError("hub_off_on_server", "the hub is off on this server")
        genesis = _genesis(hub, body.deployment_fingerprint)   # validated before anything is written
        state = hub.channel_state(agent.id)
        if state is None or state.connection_id is None:
            if runtime is None:
                raise HubError("hub_off_on_server", "the hub is off on this server")
            state = runtime.adapter.ensure_connection(agent)     # the block hangs on the agent's connection
        pin = hub.pin_for(genesis)
        name = (pin.deployment_name if pin is not None else None) or genesis[:16]
        hub.block_deployment(state.connection_id, genesis, deployment_name=name, now=_now())
        return BlockedList(blocked=blocked_out(hub, state.connection_id))

    @router.delete("/me/channels/hub/{agent_full_name}/blocked_deployments", response_model=BlockedList)
    async def unblock_deployment(agent_full_name: str, deployment_fingerprint: str = Query(...),
                                 authorization: str = Header(default="")):
        _user, agent = await _owned_agent(agent_full_name, authorization)
        hub = _hub()
        state = hub.channel_state(agent.id) if hub is not None else None
        if state is None or state.connection_id is None:
            return BlockedList(blocked=[])
        hub.unblock_deployment(state.connection_id, _genesis(hub, deployment_fingerprint))
        return BlockedList(blocked=blocked_out(hub, state.connection_id))

    return router
