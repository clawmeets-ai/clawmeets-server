# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/hub.py
The requester's browser routes on the ClawMeets Hub (``/api/hub/*``), as
written in design section 5 and frozen in ``server/hub/browser.py``:

- ``GET /api/hub/config``: the hub settings and this server's registration
  and link state. Read-only: never a hub-state error.
- ``GET /api/hub/agents``: search; ``GET /api/hub/agents/{hub_agent_id}``:
  one agent; both served from the 24-hour cache while the hub is unreachable.
- ``GET /api/hub/agents/{hub_agent_id}/avatar``: the re-encoded PNG
  (``server/hub/avatar.py``), from its cache. Read-only: never a mode or
  registration error.
- ``POST /api/hub/agents/{hub_agent_id}/report``: 202 {}.
- ``POST /api/hub/conversations``: the user's thread with a remote agent (a
  Front Desk project whose coordinator is the agent's stand-in), deduped on
  ``client_thread_key``; plus ``target``, what the browser shows before the
  first message.
- ``POST /api/hub/conversations/{project_id}/messages``: one message; a
  repeated ``client_message_id`` returns the original with 200. Without
  ``confirm_offline``, an away target answers
  ``target_offline_confirm_required`` [409] with ``send_warning`` first.
- ``GET /api/hub/conversations/{project_id}/deliveries``: every message's
  delivery, from local state. Read-only: never a hub-state error.
- ``POST`` / ``DELETE /api/hub/agents/{hub_agent_id}/retain``: retain or
  unretain a remote agent (``server/hub/retain.py``); user JWT only, any
  agent token is ``user_only`` [403]. ``GET /api/hub/retained``: the user's
  retained agents (user JWT or an owned agent's full token: the roster feed).
- ``GET /.well-known/clawmeets-deployment.json``: this deployment's signed
  ``DeploymentDocument``, which the hub fetches to verify ``public_url``.
  Unauthenticated (the hub has no session here); 404 when the hub is off, no
  registration names a public URL, or the key is revoked.

Every error is ``{"detail": {"code", "message", ...}}`` (``HubError``, turned
into a response by the app's handler). The hub-state errors come only from
``HubRuntime.require`` (search, agent detail, report, start, send, retain and
enable); config, deliveries, avatar, unretain, the retained list and disable
never call it, and a test walks the
route table to keep it so.
"""
from __future__ import annotations

import mimetypes
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from clawmeets.hub_protocol.http import DEPLOYMENT_DOC_PATH
from clawmeets.hub_protocol.ids import parse_agent_ref
from clawmeets.models.agent import Agent
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project
from clawmeets.models.user import User
from clawmeets.server.channels.config import HUB_OFF
from clawmeets.server.channels.hub_store import HubStore
from clawmeets.models.provenance import fence_untrusted
from clawmeets.server.hub.browser import (
    AgentUsage,
    ConversationTarget,
    Delivery,
    HubAgentDetail,
    HubAgentPage,
    HubAgentSearch,
    HubConfigOut,
    HubError,
    HubMessage,
    HubMessagePage,
    ReportRequest,
    RetainedAgent,
    RetainedList,
    SendMessageRequest,
    SendMessageResponse,
    StartConversationRequest,
    StartConversationResponse,
    UsageWindowOut,
)
from clawmeets.server.hub.adapter import file_name_ok
from clawmeets.server.hub.agent_send_guard import AgentSendGuard, via_agent_name
from clawmeets.server.hub.mirror import UC, OutgoingFile
from clawmeets.models.user import User

from clawmeets.server.hub.retain import RetainStore
from clawmeets.server.hub.browser import BridgeDeliveryList
from clawmeets.server.hub.views import config_out, delivery_out, project_hub_target

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext
    from clawmeets.server.hub.runtime import HubRuntime

#: The avatar's fixed headers (design section 5). ``no-cache`` with an ETag
#: of the listing refresh: the browser revalidates (304 when unchanged)
#: rather than hold a stale image for an hour.
AVATAR_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-cache",
}


def _avatar_response(png: bytes, refreshed_at: int, if_none_match: Optional[str]) -> Response:
    """The PNG, or 304 when the browser already holds this refresh."""
    etag = f'"{int(refreshed_at)}"'
    headers = {**AVATAR_HEADERS, "ETag": etag}
    if if_none_match is not None and etag in {t.strip() for t in if_none_match.split(",")}:
        return Response(status_code=304, headers=headers)
    return Response(png, media_type="image/png", headers=headers)


def hub_error_response(_request: Request, exc: HubError) -> JSONResponse:
    """The app's handler for :class:`HubError`."""
    return JSONResponse(jsonable_encoder(exc.body()), status_code=exc.status)


def create_hub_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["hub"])

    async def _user(authorization: str) -> "User":
        try:
            return await ctx.auth.resolve_user_from_credential(authorization)
        except HTTPException as exc:
            if exc.status_code == 401:
                raise HubError("unauthorized", "sign in first") from None
            raise

    async def _owner(authorization: str, x_agent_id: Optional[str]) -> tuple["User", Optional[Agent]]:
        """The user and, for an owned agent's FULL token, the acting agent
        (agent send). A turn token never gets here (turn_scope)."""
        try:
            return await ctx.auth.resolve_owner_credential(authorization, x_agent_id)
        except HTTPException as exc:
            if exc.status_code == 401:
                raise HubError("unauthorized", "sign in first") from None
            raise

    def _guard() -> AgentSendGuard:
        guard = getattr(ctx, "hub_send_guard", None)
        if guard is None:
            guard = AgentSendGuard(ctx.channel_store)
            ctx.hub_send_guard = guard
        return guard

    def _runtime() -> "HubRuntime":
        """The hub runtime, for the routes that call the hub. None exists
        when the hub is off and nothing hub-related is left to sweep."""
        runtime = ctx.hub_runtime
        if runtime is None:
            raise HubError("hub_off_on_server", "the hub is off on this server")
        return runtime

    def _hub() -> Optional[HubStore]:
        """The hub tables, for the read-only routes (whatever the mode)."""
        if ctx.hub_runtime is not None:
            return ctx.hub_runtime.hub
        return HubStore(ctx.channel_store) if ctx.channel_store is not None else None

    def _own_thread(hub: Optional[HubStore], project_id: str, user: "User",
                    agent: Optional[Agent] = None):
        thread = hub.thread_for_project(project_id) if hub is not None else None
        if thread is None:
            raise HubError("project_not_found", "no such hub conversation")
        if thread.user_id != user.id:
            raise HubError("not_owner", "this conversation is someone else's")
        if agent is not None and thread.started_by_agent_id != agent.id:
            # An agent reaches only the threads it started, never the user's
            # browser conversations (answered as if absent).
            raise HubError("project_not_found", "no such hub conversation")
        return thread

    # ── the deployment document (for the hub, unauthenticated) ───────────

    @router.get(DEPLOYMENT_DOC_PATH, include_in_schema=False)
    async def deployment_document():
        doc = ctx.hub_runtime.deployment_document() if ctx.hub_runtime is not None else None
        if doc is None:
            raise HTTPException(404, "not found")
        return JSONResponse(doc, headers={"Cache-Control": "no-store"})

    # ── config ───────────────────────────────────────────────────────────

    @router.get("/api/hub/config", response_model=HubConfigOut)
    async def hub_config(authorization: str = Header(default="")):
        user = await _user(authorization)
        runtime = ctx.hub_runtime
        gateway = ctx.channel_gateway
        channels_enabled = bool(gateway is not None and gateway.config.providers_enabled)
        if runtime is None:
            return config_out(HUB_OFF, None, link="off", username=user.username,
                              channels_enabled=channels_enabled)
        return config_out(runtime.config, runtime.registration(), link=runtime.link(),
                          username=user.username, channels_enabled=channels_enabled)

    # ── the directory ────────────────────────────────────────────────────

    @router.get("/api/hub/agents", response_model=HubAgentPage)
    async def search_agents(
        q: str = "", capabilities: list[str] = Query(default=[]), online_only: bool = False,
        cursor: Optional[str] = None, limit: int = 20, authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        user, _agent = await _owner(authorization, x_agent_id)
        try:
            params = HubAgentSearch(q=q, capabilities=capabilities, online_only=online_only,
                                    cursor=cursor, limit=limit)
        except ValidationError:
            raise HTTPException(422, "invalid search") from None
        return await _runtime().directory.search(user.id, params)

    @router.get("/api/hub/agents/{hub_agent_id}", response_model=HubAgentDetail)
    async def get_agent(hub_agent_id: str, authorization: str = Header(default=""),
                        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID")):
        user, _agent = await _owner(authorization, x_agent_id)
        return (await _runtime().directory.agent(user.id, hub_agent_id)).detail

    @router.get("/api/hub/agents/{hub_agent_id}/avatar")
    async def get_avatar(hub_agent_id: str, authorization: str = Header(default=""),
                         if_none_match: Optional[str] = Header(default=None)):
        """Read-only: from the re-encode cache, whatever the hub mode or
        registration; fetched and re-encoded (``HubAvatars``) only when the
        agent's listing has a newer refresh. ``hub_unreachable`` only when
        nothing is cached. ETag = the listing refresh; 304 when it matches."""
        user = await _user(authorization)
        try:
            ref = parse_agent_ref(hub_agent_id)
        except ValueError:
            raise HubError("invalid_agent_id", "not a hub agent id") from None
        if ctx.hub_runtime is not None:
            png, refreshed_at = await ctx.hub_runtime.avatars.get(user.id, hub_agent_id, ref)
            return _avatar_response(png, refreshed_at, if_none_match)
        hub = _hub()
        cached = hub.latest_avatar(hub_agent_id) if hub is not None else None
        if cached is None:
            raise HubError("hub_unreachable", "the hub cannot be reached")
        if cached.png is None:
            raise HubError("avatar_unavailable", "the avatar cannot be shown")
        return _avatar_response(cached.png, cached.refreshed_at, if_none_match)

    @router.post("/api/hub/agents/{hub_agent_id}/report", status_code=202)
    async def report_agent(hub_agent_id: str, body: ReportRequest, authorization: str = Header(default="")):
        user = await _user(authorization)
        await _runtime().directory.report(user.id, hub_agent_id, body)
        return {}

    # ── conversations ────────────────────────────────────────────────────

    def _local_agent(runtime: "HubRuntime", hub_agent_id: str, user: "User") -> None:
        """An agent of THIS deployment keeps the in-process path."""
        ref = parse_agent_ref(hub_agent_id)
        reg = runtime.registration()
        if reg is None or ref.deployment_fingerprint != reg.genesis_fp:
            return
        agent = Agent.get_by_name(ref.agent_name, ctx.model_ctx)
        if agent is None or not agent.is_discoverable:
            raise HubError("agent_not_found", "no such agent")
        if agent.registered_by == user.id:
            raise HubError("own_agent", "this is your own agent")
        raise HubError("local_agent", "this agent is on this server",
                       use_path=f"/dm/{agent.name}", agent_name=agent.name)

    @router.post("/api/hub/conversations")
    async def start_conversation(body: StartConversationRequest, authorization: str = Header(default=""),
                                 x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID")):
        user, acting = await _owner(authorization, x_agent_id)
        runtime = _runtime()
        await runtime.require_live(send=True)
        try:
            parse_agent_ref(body.hub_agent_id)
        except ValueError:
            raise HubError("invalid_agent_id", "not a hub agent id") from None
        existing = runtime.hub.thread_for_key(user.id, body.client_thread_key)
        if acting is not None and existing is not None and existing.started_by_agent_id != acting.id:
            raise HubError("project_not_found", "no such hub conversation")
        # The browser's retry key names ONE conversation: a repeat returns that
        # conversation with ITS agent, whatever agent the repeat names (like a
        # repeated client_message_id on send), never a mix of the two.
        target_id = existing.stand_in_id if existing is not None else body.hub_agent_id
        if existing is None:
            _local_agent(runtime, body.hub_agent_id, user)
        try:
            lookup = await runtime.directory.agent(user.id, target_id, charge=False)
        except HubError as exc:
            if exc.code == "agent_unlisted":
                exc.status = 410
            raise
        agent = lookup.detail
        if existing is None and acting is not None:
            _guard().charge_new_conversation(acting.id)
        thread = existing or await runtime.mirror.start_conversation(
            user, body.hub_agent_id, body.client_thread_key, deployment_name=agent.deployment_name,
            started_by=acting,
        )
        project = Project.get(thread.project_id, ctx.model_ctx)
        warning = None if agent.agent_online else (
            "agent_offline" if agent.deployment_connected else "deployment_offline")
        answer = StartConversationResponse.model_validate({
            **jsonable_encoder(project.model_dump()),
            "hub_target": project_hub_target(runtime.hub, project.id, agent=agent),
            "target": ConversationTarget(
                agent_online=agent.agent_online, deployment_connected=agent.deployment_connected,
                send_warning=warning, deployment_name=agent.deployment_name,
                deployment_fingerprint=agent.deployment_fingerprint,
                current_fingerprint=agent.current_fingerprint, deployment_url=agent.deployment_url,
                deployment_url_verified=agent.deployment_url_verified, first_contact=agent.first_contact,
            ),
        })
        return JSONResponse(jsonable_encoder(answer.model_dump(mode="json")))

    def _files(project_id: str, file_ids: list[str]) -> list[OutgoingFile]:
        """The files the browser uploaded to the thread first, by name."""
        room = Chatroom.get(project_id, UC, ctx.model_ctx)
        out = []
        for name in file_ids:
            # A name outside the thread's own files (``..``, absolute, hidden)
            # is answered exactly like a missing one: nothing about it leaks.
            data = room.get_file(name) if room is not None and file_name_ok(name) else None
            if data is None:
                raise HubError("file_not_found", "no such file in this conversation", file_id=name)
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            out.append(OutgoingFile(name, mime, data, stored=True))
        return out

    @router.post("/api/hub/conversations/{project_id}/messages", response_model=SendMessageResponse)
    async def send_message(project_id: str, body: SendMessageRequest, authorization: str = Header(default=""),
                           x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID")):
        user, acting = await _owner(authorization, x_agent_id)
        runtime = _runtime()
        thread = _own_thread(runtime.hub, project_id, user, acting)
        claimed = runtime.hub.claimed_send(user.id, project_id, body.client_message_id)
        row = runtime.hub.request_row(project_id, claimed) if claimed is not None else None
        if row is not None:                                 # a retry: the original, sent once
            return SendMessageResponse(message_id=row.message_id, delivery=delivery_out(row))
        flow = getattr(ctx, "room_flow", None)
        if flow is not None and not flow.is_open(project_id, "user-communication"):
            raise HubError("room_flow_stopped", "this conversation's inbound flow is stopped; reopen it first")
        try:
            await runtime.require_live(send=True)
        except HubError as exc:
            if exc.code == "hub_unreachable":
                reg = runtime.registration()
                exc.extra["last_connected_at"] = reg.last_connected_at if reg is not None else None
            raise
        files = _files(project_id, body.file_ids)
        if thread.closed_at is None and not body.confirm_offline:
            try:
                agent = (await runtime.directory.agent(user.id, thread.stand_in_id, charge=False,
                                                         live=True)).detail
            except HubError as exc:
                if exc.code == "agent_unlisted":
                    exc.status = 410
                raise
            if not (agent.agent_online and agent.deployment_connected):
                warning = "agent_offline" if agent.deployment_connected else "deployment_offline"
                raise HubError("target_offline_confirm_required", "the agent is away", send_warning=warning)
        via_agent = via_agent_name(acting, ctx.model_ctx)
        _guard().charge(user_id=user.id, agent_id=acting.id if acting else None,
                        target=thread.stand_in_id)
        sent = await runtime.mirror.send(user, project_id, text=body.text,
                                         client_message_id=body.client_message_id, files=files,
                                         via_agent=via_agent, author=acting)
        row = runtime.hub.request_row(project_id, sent.message_id)
        assert row is not None
        return SendMessageResponse(message_id=sent.message_id, delivery=delivery_out(row))

    @router.get("/api/hub/conversations/{project_id}/deliveries", response_model=list[Delivery])
    async def list_deliveries(project_id: str, since_message_id: Optional[str] = None,
                              authorization: str = Header(default=""),
                              x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID")):
        """Read-only: from local state, whatever the hub mode or registration."""
        user, acting = await _owner(authorization, x_agent_id)
        hub = _hub()
        _own_thread(hub, project_id, user, acting)
        rows = hub.request_rows(project_id)
        if since_message_id is not None:
            ids = [r.message_id for r in rows]
            if since_message_id in ids:
                rows = rows[ids.index(since_message_id) + 1:]
        return [delivery_out(r) for r in rows]

    @router.get("/api/hub/bridges/{project_id}/{chatroom_name}/deliveries", response_model=BridgeDeliveryList)
    async def list_bridge_deliveries(project_id: str, chatroom_name: str, message_ids: Optional[str] = None,
                                     authorization: str = Header(default="")):
        """The room bridge's delivery lines for a workroom (user JWT, the
        project's owner). Read-only, from local state."""
        user = await _user(authorization)
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            project = None
        if project is None or project.created_by != user.id:
            raise HubError("project_not_found", "no such project")
        runtime = ctx.hub_runtime
        if runtime is None:
            return BridgeDeliveryList(deliveries=[])
        wanted = {m for m in (message_ids or "").split(",") if m} or None
        return BridgeDeliveryList(deliveries=runtime.bridge.deliveries(project_id, chatroom_name, wanted))

    @router.get("/api/hub/conversations/{project_id}/messages", response_model=HubMessagePage)
    async def list_messages(request: Request, project_id: str, before: Optional[float] = None,
                            limit: int = Query(50, ge=1, le=200),
                            authorization: str = Header(default=""),
                            x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID")):
        """A hub conversation's messages. The user's browser sees text. An
        owned agent's FULL token sees only threads it started, and never the
        text (``text_withheld``): remote words do not enter a full-power turn.
        A turn token scoped to that thread sees the text, fenced."""
        hub = _hub()
        grant = getattr(request.state, "turn_grant", None)
        if grant is not None:
            thread = hub.thread_for_project(project_id) if hub is not None else None
            if thread is None or thread.started_by_agent_id != grant.agent_id:
                raise HubError("project_not_found", "no such hub conversation")
            show, fence = True, True
        else:
            user, acting = await _owner(authorization, x_agent_id)
            thread = _own_thread(hub, project_id, user, acting)
            show, fence = acting is None, False
        project = Project.get(project_id, ctx.model_ctx)
        room = Chatroom.get(project_id, UC, ctx.model_ctx)
        rows = hub.request_rows(project_id) if hub is not None else []
        states = {r.message_id: delivery_out(r).state for r in rows}
        messages = []
        for m in (room.get_messages() if room is not None else []):
            if m.is_ack:
                continue
            ts = m.ts.timestamp()
            if before is not None and ts >= before:
                continue
            if m.from_participant_id == thread.stand_in_id:
                kind = "remote"
            elif m.from_participant_id == thread.started_by_agent_id:
                kind = "agent"
            else:
                kind = "user"
            text = None
            if show:
                text = m.content
                if fence and kind == "remote":
                    text = fence_untrusted(m.content, source_label=m.from_participant_name,
                                           fingerprint=thread.genesis_fp)
            messages.append(HubMessage(id=m.id, author_kind=kind, ts=ts, state=states.get(m.id), text=text))
        del project
        return HubMessagePage(messages=messages[-limit:], text_withheld=not show)

    @router.get("/api/hub/agents-usage/{agent_id}", response_model=AgentUsage)
    async def agent_usage(agent_id: str, authorization: str = Header(default="")):
        """An owned agent's hub send windows, for its owner's settings page."""
        try:
            user = await ctx.auth.get_current_user(authorization)
        except HTTPException:
            raise HubError("unauthorized", "sign in first") from None
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None or agent.registered_by != user.id:
            raise HubError("not_owner", "not your agent")
        return AgentUsage(windows=[
            UsageWindowOut(name=w.name, used=w.used, limit=w.limit, resets_at=w.resets_at)
            for w in _guard().usage(agent_id)
        ])

    # ── retained agents (design section 4.2) ─────────────────────────────
    # Retain and unretain take a user JWT only: any agent token, the
    # assistant's included, is user_only [403]. The roster feed also takes
    # the full token of an agent the user owns (its runner's peer sync).

    def _agent_for_token(authorization: str, x_agent_id: Optional[str]) -> Optional[Agent]:
        """The agent whose full token this is, or None."""
        if not authorization.startswith("Bearer "):
            return None
        token = authorization[7:]
        if x_agent_id and Agent.verify_token(x_agent_id, token, ctx.model_ctx):
            return Agent.get(x_agent_id, ctx.model_ctx)
        for agent in Agent.list_all(ctx.model_ctx, discoverable_only=False, include_private=True):
            if Agent.verify_token(agent.id, token, ctx.model_ctx):
                return agent
        return None

    async def _user_jwt_only(authorization: str, x_agent_id: Optional[str]) -> "User":
        try:
            return await ctx.auth.get_current_user(authorization)
        except HTTPException as exc:
            if exc.status_code != 401:
                raise
        if _agent_for_token(authorization, x_agent_id) is not None:
            raise HubError("user_only", "only the user can retain or unretain, never an agent")
        raise HubError("unauthorized", "sign in first")

    async def _roster_reader(authorization: str, x_agent_id: Optional[str]) -> "User":
        try:
            return await ctx.auth.get_current_user(authorization)
        except HTTPException as exc:
            if exc.status_code != 401:
                raise
        agent = _agent_for_token(authorization, x_agent_id)
        owner = User.get(agent.registered_by, ctx.model_ctx) if agent and agent.registered_by else None
        if owner is None:
            raise HubError("unauthorized", "sign in first")
        return owner

    def _retain_store() -> RetainStore:
        """The runtime's, or (hub off) one over the stored rows: unretain and
        the list work whatever the mode."""
        if ctx.hub_runtime is not None:
            return ctx.hub_runtime.retained
        hub = _hub()
        if hub is None:
            raise HubError("hub_off_on_server", "the hub is off on this server")
        return RetainStore(ctx, hub)

    @router.post("/api/hub/agents/{hub_agent_id}/retain", response_model=RetainedAgent)
    async def retain_agent(hub_agent_id: str, authorization: str = Header(default=""),
                           x_agent_id: Optional[str] = Header(default=None)):
        user = await _user_jwt_only(authorization, x_agent_id)
        return await _runtime().retained.retain(user, hub_agent_id)

    @router.delete("/api/hub/agents/{hub_agent_id}/retain")
    async def unretain_agent(hub_agent_id: str, authorization: str = Header(default=""),
                             x_agent_id: Optional[str] = Header(default=None)):
        """Never a hub-state error: only local rows change."""
        user = await _user_jwt_only(authorization, x_agent_id)
        await _retain_store().unretain(user, hub_agent_id)
        return {}

    @router.get("/api/hub/retained", response_model=RetainedList)
    async def list_retained(authorization: str = Header(default=""),
                            x_agent_id: Optional[str] = Header(default=None)):
        """The roster feed. Read-only: never a hub-state error."""
        user = await _roster_reader(authorization, x_agent_id)
        hub = _hub()
        if hub is None:
            return RetainedList(agents=[])
        return RetainedList(agents=_retain_store().list_for(user.id))

    return router
