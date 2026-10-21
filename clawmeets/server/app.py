# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/app.py
FastAPI application factory.

This module creates the FastAPI app and registers all route modules.
Business logic has been extracted to:
- routes/ - HTTP and WebSocket route handlers
- services/ - Shared services and context
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Mapping, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse

from clawmeets.models.work_tracker import WorkTracker
from clawmeets.models.managed_job import ManagedJobStore
from clawmeets.models.user import User
from .ws_hub import WSHub
from .edge_hub import EdgeWSHub
from clawmeets.server.agent_capabilities import AgentCapabilityRegistry
from clawmeets.server.signup_policy import load_signup_policy, warn_if_exposed
from clawmeets.server.config import public_app_url
from clawmeets.server.isolation_gate import HeldWorkStore, IsolationGate, IsolationHeaderMiddleware
from clawmeets.server.isolation_notice import IsolationNotice
from clawmeets.server.coordinator_rule import ForeignCoordinator, compose_guards, coordinator_guard
from clawmeets.server.owner_isolation import OwnerIsolationService, OwnerIsolationStore
from clawmeets.server.serving_only import ServingOnlyMiddleware
from clawmeets.server.turn_tokens import TurnGrantStore, TurnTokenMiddleware, TurnTokenService
from clawmeets.server.routes.owner_isolation import create_owner_isolation_router
from clawmeets.server.routes.turn_tokens import create_turn_tokens_router
from clawmeets.server.hub.retain import migrate_local_retains
from clawmeets.server.requester_key_migration import (
    migrate_hub_thread_marks, migrate_owner_coordinators, migrate_requester_keys, migrate_scoped_turn_projects,
)
from .auth import JWT_SECRET, AuthService
from .idempotency import IdempotencyMiddleware, IdempotencyStore
from .managed_job_events import restore_active_jobs
from .timeout_checker import BatchTimeoutChecker
from .message_scheduler import MessageScheduler
from .reflection_scheduler import ReflectionScheduler
from clawmeets.models.context import ModelContext
from clawmeets.models.project_report import backfill_report_published_at
from clawmeets.models.scheduled_message import ScheduledMessageStore
from clawmeets.models.reflection_schedule import ReflectionScheduleStore
from .reflection_completion_subscriber import ReflectionCompletionSubscriber
from .tunnel_subscriber import TunnelSubscriber
from .hub.room_bridge import RoomBridgeSubscriber
from .chat_search_index import ChatSearchIndex, ChatSearchIndexSubscriber
from clawmeets.utils.notification_center import NotificationCenter
from clawmeets.sync.runloop_manager import ChangelogRunloopManager
from .context import ServerContext
from .config import cors_allow_origins
from .routes.agents import create_agents_router
from .routes.public_agents import create_public_agents_router
from .routes.agent_env import create_agent_env_router
from .routes.isolation_check import create_isolation_check_router
from .routes.agent_fs import create_agent_fs_router
from .routes.auth import create_auth_router
from .routes.projects import create_projects_router
from .routes.chatrooms import create_chatrooms_router
from .routes.files import create_files_router
from .routes.messages import create_messages_router
from .routes.changelog import create_changelog_router
from .inspection import build_outside_ingress
from .room_flow import RoomFlowSwitch
from .routes.websocket import create_websocket_router
from .routes.announcements import create_announcements_router
from .routes.scheduled_messages import create_scheduled_messages_router
from .routes.managed_jobs import create_managed_jobs_router
from .routes.reflection import create_reflection_router
from .routes.model_defaults import create_model_defaults_router
from .routes.sharing import create_sharing_router
from .routes.skills import create_skills_router
from .routes.knowledge_packs import create_knowledge_packs_router
from .routes.brief_tabs import (
    BriefBodyLimitMiddleware,
    create_brief_tabs_router,
)
from .routes.hosts import create_hosts_router
from .routes.install import create_install_router
from .routes.desk_todos import create_desk_todos_router
from .routes.desk_sops import create_desk_sops_router
from .routes.desk_labels import create_desk_labels_router
from .routes.desk_read_state import create_desk_read_state_router
from .routes.desk_tour import create_desk_tour_router
from .routes.desk_sign_off import create_desk_sign_off_router
from .routes.desk_latest_messages import create_desk_latest_messages_router
from .routes.project_reports import create_project_reports_router
from .routes.project_plans import create_project_plans_router
from .routes.mcps import create_mcps_router
from .routes.oauth import create_oauth_router
from .routes.oauth_login import create_oauth_login_router
from .routes.templates import create_templates_router
from .routes.inbox import create_inbox_router
from clawmeets.ws_edge.terminal_relay import TerminalRelay
from .home_fs_relay import HomeFsRelay
from .socket_events import SocketEvents
from .routes.search import create_search_router
from .routes.channels import create_channels_router
from .routes.hub import create_hub_router, hub_error_response
from .routes.hub_channels import create_hub_channels_router
from .hub.browser import HubError
from .routes.webchat import create_webchat_router
from .channels.adapter import ChannelAdapter
from .channels.gateway import GatewayOptions, build_channel_gateway
from .hub.runtime import HubRuntime, HubRuntimeOptions
from .channels.store import ChannelStore
from .skill_registry import SkillRegistry
from .mcp_registry import McpRegistry
from .oauth_state import OAuthStateStore
from .oauth_login.handoff import LoginHandoffStore
from .oauth_login.cli_state import CliOAuthStateStore

logger = logging.getLogger("clawmeets.server")


def _serve_spa_file(base_dir: Path, path: str, fallback: Path) -> FileResponse:
    """Serve a real static file under ``base_dir`` for an SPA catch-all route,
    falling back to the SPA entry (``fallback``) for client-side routing.

    ``path`` comes straight from a ``{path:path}`` URL segment, so it is
    untrusted: a URL-encoded ``..`` would otherwise let ``base_dir / path``
    escape the served directory and read arbitrary files the server process can
    reach. We resolve the candidate and confirm it stays within ``base_dir``
    before serving it; anything that escapes (or isn't a real file) falls back
    to the SPA entry.
    """
    base_resolved = base_dir.resolve()
    try:
        candidate = (base_dir / path).resolve()
        candidate.relative_to(base_resolved)  # ValueError if it escapes base_dir
    except ValueError:
        return FileResponse(fallback)
    if candidate.is_file():
        return FileResponse(candidate)
    return FileResponse(fallback)


def create_app(
    data_dir: Path,
    batch_timeout: int = 1800,
    skills_dir: Path | None = None,
    mcps_dir: Path | None = None,
    agent_pool_dir: Path | None = None,
    announcements_path: Path | None = None,
    channel_env: Optional[Mapping[str, str]] = None,
    channel_adapters: Optional[Mapping[str, ChannelAdapter]] = None,
    channel_options: Optional[GatewayOptions] = None,
    ws_mode: Optional[str] = None,
    edge_link_url: Optional[str] = None,
    edge_link_secret: Optional[str] = None,
    hub_options: Optional[HubRuntimeOptions] = None,
) -> FastAPI:
    """Create and configure the FastAPI application.

    Args:
        data_dir: Base directory for all server data
        batch_timeout: Batch timeout in seconds (default: 1800)
        skills_dir: Directory containing skills registry (optional)
        mcps_dir: Directory containing MCP servers registry (optional)
        agent_pool_dir: A clawmeets-agents checkout: the agent catalog (optional)
        announcements_path: Path to announcements.json (optional; defaults to
            the repo-root file resolved by clawmeets/server/announcements.py)
        channel_env: Environment the channel kill switch, channel settings and
            hub settings are read from (default ``os.environ``; tests pass a dict).
        channel_adapters: Channel name -> adapter. No real provider ships yet;
            tests pass a fake one.
        channel_options: Gateway clock, burst window, crash hooks (tests).
        hub_options: The hub runtime's injection points: the socket's
            connect, the reclaim's HTTP transport, the registration poll
            (tests; production uses the defaults).
        ws_mode: ``inprocess`` (default; this process holds the sockets) or
            ``edge`` (the websocket edge holds them and this process dials it).
            Defaults to ``$CLAWMEETS_WS_MODE``.
        edge_link_url / edge_link_secret: where to dial the edge and the
            shared secret, in edge mode. Default to
            ``$CLAWMEETS_EDGE_LINK_URL`` / ``$CLAWMEETS_EDGE_LINK_SECRET``.

    Returns:
        Configured FastAPI application

    Raises:
        HubConfigError: ``CLAWMEETS_HUB_MODE`` is not ``off`` and the hub
            settings are invalid (the message names each setting at fault).
            The server must not start; a broken CHANNEL configuration, by
            contrast, only keeps the channel gateway off.
    """
    data_dir.mkdir(parents=True, exist_ok=True)

    # Create shared ModelContext for file and message I/O
    # This is the server-wide context used by UnifiedChangelog
    model_ctx = ModelContext(base_dir=data_dir, notification_center=NotificationCenter())

    # Initialize services
    ws_mode = (ws_mode or os.environ.get("CLAWMEETS_WS_MODE") or "inprocess").strip().lower()
    if ws_mode not in ("inprocess", "edge"):
        raise RuntimeError(f"CLAWMEETS_WS_MODE must be 'inprocess' or 'edge', not {ws_mode!r}")
    if ws_mode == "edge":
        link_url = edge_link_url or os.environ.get("CLAWMEETS_EDGE_LINK_URL") or "ws://127.0.0.1:8091/link"
        link_secret = edge_link_secret or os.environ.get("CLAWMEETS_EDGE_LINK_SECRET")
        if not link_secret:
            raise RuntimeError("CLAWMEETS_WS_MODE=edge needs CLAWMEETS_EDGE_LINK_SECRET")
        if "CLAWMEETS_JWT_SECRET" not in os.environ:
            # The edge checks user tokens itself; with a per-process random
            # secret no browser could ever connect.
            logger.warning("CLAWMEETS_WS_MODE=edge without CLAWMEETS_JWT_SECRET: browsers cannot connect")
        ws_hub: WSHub = EdgeWSHub(link_url, link_secret, data_dir=data_dir, model_ctx=model_ctx)
    else:
        ws_hub = WSHub(data_dir=data_dir, model_ctx=model_ctx)

    # Bridge WorkTracker state transitions to a WebSocket push so the frontend
    # sidebar's active-work indicators and in-room typing indicators both read
    # from the same signal (no polling).
    from clawmeets.models.project import Project

    async def _on_work_change(
        project_id: str, chatroom_name: str, active_participants: list[str]
    ) -> None:
        project = Project.get(project_id, model_ctx)
        if project is None:
            return
        await ws_hub.broadcast_active_work_change(
            project, chatroom_name, active_participants
        )

    work_tracker = WorkTracker(on_change=_on_work_change)
    managed_job_store = ManagedJobStore(data_dir)

    # Initialize auth service
    auth = AuthService(model_ctx)

    # Create runloop manager for per-project changelog processing
    reflection_completion_subscriber = ReflectionCompletionSubscriber(model_ctx)
    reflection_completion_subscriber.bind_ws_hub(ws_hub)
    # TunnelSubscriber needs a back-reference to the runloop manager so it can
    # append mirrored entries onto the other end of a binding. Construct it
    # first (without the manager), then bind after the manager exists.
    tunnel_subscriber = TunnelSubscriber(model_ctx)
    # The room bridge: relays addressed workroom messages to retained hub
    # agents (server/hub/room_bridge.py). Bound to the context below.
    room_bridge_subscriber = RoomBridgeSubscriber()
    # Derived FTS5 chat-message index. Registered immediately AFTER the
    # subscriber that writes CHATS.ndjson, so it indexes a row that is already
    # durable rather than racing the write.
    chat_search_index = ChatSearchIndex(model_ctx)
    chat_search_subscriber = ChatSearchIndexSubscriber(chat_search_index, model_ctx)
    runloop_manager = ChangelogRunloopManager(
        runloop_factory=lambda pid, pname, cid: (
            model_ctx.changelog_dir(pid, pname),
            [
                model_ctx.changelog_subscriber(pid, pname),
                chat_search_subscriber,
                reflection_completion_subscriber,
                tunnel_subscriber,
                room_bridge_subscriber,
            ],
        ),
    )
    tunnel_subscriber.bind_runloop_manager(runloop_manager)
    tunnel_subscriber.bind_ws_hub(ws_hub)
    tunnel_subscriber.bind_work_tracker(work_tracker, batch_timeout)

    # Create timeout checker for batch completion enforcement
    timeout_checker = BatchTimeoutChecker(
        work_tracker=work_tracker,
        runloop_manager=runloop_manager,
        ws_hub=ws_hub,
        model_ctx=model_ctx,
        batch_timeout=batch_timeout,
    )
    timeout_checker.bind_managed_job_store(managed_job_store)

    # Create scheduled message store and scheduler
    scheduled_message_store = ScheduledMessageStore(model_ctx)
    message_scheduler = MessageScheduler(
        store=scheduled_message_store,
        runloop_manager=runloop_manager,
        ws_hub=ws_hub,
        model_ctx=model_ctx,
        work_tracker=work_tracker,
        batch_timeout=batch_timeout,
    )

    # Create reflection schedule store and scheduler
    reflection_schedule_store = ReflectionScheduleStore(model_ctx)
    reflection_scheduler = ReflectionScheduler(
        store=reflection_schedule_store,
        runloop_manager=runloop_manager,
        ws_hub=ws_hub,
        model_ctx=model_ctx,
    )

    # Who may sign up. A bad value stops boot here, like a bad hub config.
    signup_policy = load_signup_policy()
    warn_if_exposed(signup_policy, public_app_url())

    # In-memory state store for the MCP OAuth relay flow
    oauth_state_store = OAuthStateStore()

    # In-memory single-use store for OAuth-login exchange handoff codes
    login_handoff_store = LoginHandoffStore()

    # In-memory single-use store for CLI OAuth pending states + PKCE bindings
    cli_oauth_state_store = CliOAuthStateStore()

    # Create server context
    ctx = ServerContext(
        model_ctx=model_ctx,
        ws_hub=ws_hub,
        work_tracker=work_tracker,
        auth=auth,
        runloop_manager=runloop_manager,
        timeout_checker=timeout_checker,
        scheduled_message_store=scheduled_message_store,
        message_scheduler=message_scheduler,
        reflection_schedule_store=reflection_schedule_store,
        reflection_scheduler=reflection_scheduler,
        managed_job_store=managed_job_store,
        oauth_state_store=oauth_state_store,
        login_handoff_store=login_handoff_store,
        cli_oauth_state_store=cli_oauth_state_store,
        chat_search_index=chat_search_index,
        # In edge mode terminal sessions live in the edge, next to both sockets.
        terminal_relay=(
            TerminalRelay(ws_hub, model_ctx.participants_dir, JWT_SECRET)
            if ws_mode == "inprocess" else None
        ),
        home_fs_relay=HomeFsRelay(ws_hub, model_ctx.participants_dir),
        batch_timeout=batch_timeout,
        skills_dir=skills_dir,
        mcps_dir=mcps_dir,
        agent_pool_dir=agent_pool_dir,
        announcements_path=announcements_path,
        signup_policy=signup_policy,
    )

    ctx.socket_events = SocketEvents(ctx)
    turn_token_service = TurnTokenService(
        TurnGrantStore(data_dir / "isolation" / "turn_grants.sqlite3"), JWT_SECRET,
    )
    ctx.isolation_gate = IsolationGate(
        model_ctx,
        AgentCapabilityRegistry(ws_hub),
        turn_token_service,
        HeldWorkStore(data_dir / "isolation" / "held_work.sqlite3"),
        JWT_SECRET,
    )
    ctx.isolation_gate.bind(ctx)
    # Held because the agent cannot isolate: tell its owner and the requester.
    ctx.isolation_gate.notice = IsolationNotice(ctx)
    ctx.owner_isolation = OwnerIsolationService(
        model_ctx, ws_hub, OwnerIsolationStore(data_dir / "isolation" / "owner_isolation.sqlite3"),
    )
    ctx.owner_isolation.capabilities = ctx.isolation_gate.capabilities
    ctx.owner_isolation.load_enabled()
    # Every outside message passes the inspection hook before it is stored;
    # the append guard refuses one that did not (server/inspection.py).
    ctx.outside_ingress = build_outside_ingress(
        data_dir, model_ctx, env=channel_env if channel_env is not None else os.environ,
    )
    ctx.outside_ingress.bind(ctx)
    ctx.room_flow = RoomFlowSwitch(ctx)
    # Plus the own-coordinator rule (plan-owner-isolation section 4): no
    # append may make a stand-in or another account's agent a coordinator.
    runloop_manager.set_append_guard(compose_guards(ctx.outside_ingress.guard, coordinator_guard(model_ctx)))
    ws_hub.isolation_gate = ctx.isolation_gate
    if isinstance(ws_hub, EdgeWSHub):
        ws_hub.bind(ctx)

    # Channel gateway. The store opens either way; the gateway exists when the
    # channel kill switch is on and its configuration is valid, when the hub is
    # on, or while open hub rows remain to be swept (build_channel_gateway).
    # Raises only HubConfigError, which must stop the server.
    ctx.channel_store = ChannelStore(data_dir)
    ctx.channel_gateway = build_channel_gateway(
        ctx, ctx.channel_store, env=channel_env,
        adapters=channel_adapters, options=channel_options,
    )
    # The hub runtime rides on the gateway (it exists whenever the hub is
    # configured, or open hub rows remain); in mode off it builds no client.
    if ctx.channel_gateway is not None:
        ctx.hub_runtime = HubRuntime(ctx, ctx.channel_gateway, options=hub_options)

    # TunnelSubscriber's detect-and-route path needs the full ServerContext to
    # call `ensure_fd_routing_for_foreign_agents`. Bind after the context is
    # constructed (chicken-and-egg with runloop_manager handled above).
    tunnel_subscriber.bind_server_context(ctx)
    room_bridge_subscriber.bind_server_context(ctx)
    ctx.room_bridge_subscriber = room_bridge_subscriber

    # What re-delivers a held outside message when its room reopens: each
    # path's own append (server/inspection.py release_held).
    from .inspection import OutsidePath

    ingress = ctx.outside_ingress
    ingress.register_deliverer(OutsidePath.CROSS_ACCOUNT_RELAY, tunnel_subscriber.deliver_held)
    ingress.register_deliverer(OutsidePath.FRONT_DESK_REQUESTER, tunnel_subscriber.deliver_held)
    # ...and what tells the sender side when one expires instead (expire_held).
    ingress.register_closer(OutsidePath.CROSS_ACCOUNT_RELAY, tunnel_subscriber.close_held)
    ingress.register_closer(OutsidePath.FRONT_DESK_REQUESTER, tunnel_subscriber.close_held)
    # ...and what a block on release does beyond the audit and room note:
    # the path's own live-block effects (release_held).
    ingress.register_blocker(OutsidePath.CROSS_ACCOUNT_RELAY, tunnel_subscriber.block_held)
    ingress.register_blocker(OutsidePath.FRONT_DESK_REQUESTER, tunnel_subscriber.block_held)
    if ctx.channel_gateway is not None:
        ingress.register_deliverer(OutsidePath.CHANNEL_INBOUND, ctx.channel_gateway.deliver_held)
        ingress.register_deliverer(OutsidePath.HUB_INBOUND, ctx.channel_gateway.deliver_held)
        ingress.register_blocker(OutsidePath.CHANNEL_INBOUND, ctx.channel_gateway.block_held)
        ingress.register_blocker(OutsidePath.HUB_INBOUND, ctx.channel_gateway.block_held)
    if ctx.hub_runtime is not None:
        ingress.register_deliverer(OutsidePath.HUB_REPLY_DM, ctx.hub_runtime.mirror.deliver_held_reply)
        ingress.register_deliverer(OutsidePath.HUB_REPLY_BRIDGE, ctx.hub_runtime.bridge.deliver_reply)
        ingress.register_deliverer(OutsidePath.BRIDGE_OUTBOUND, ctx.hub_runtime.bridge.send_relay)
        ingress.register_closer(OutsidePath.BRIDGE_OUTBOUND, ctx.hub_runtime.bridge.close_held_relay)
        ingress.register_blocker(OutsidePath.HUB_REPLY_DM, ctx.hub_runtime.mirror.block_held_reply)
        ingress.register_blocker(OutsidePath.HUB_REPLY_BRIDGE, ctx.hub_runtime.bridge.block_reply)
        ingress.register_blocker(OutsidePath.BRIDGE_OUTBOUND, ctx.hub_runtime.bridge.block_held_relay)
    from .routes.messages import FD_REQUESTER_POST, deliver_held_fd_requester_post

    ingress.register_deliverer(
        FD_REQUESTER_POST, lambda replay, ticket: deliver_held_fd_requester_post(ctx, replay, ticket),
    )

    # A direct post was answered "delivered on reopen": when it is blocked
    # or expires instead, the requester's room (the one it was posted into)
    # is told. Never quotes the message.
    async def _tell_fd_requester(replay, tail: str) -> None:
        await ingress.post_note(replay["project_id"], replay["chatroom"],
                                f"A message from {replay.get('author_name') or 'the requester'} {tail}")

    ingress.register_blocker(
        FD_REQUESTER_POST, lambda replay: _tell_fd_requester(replay, "was blocked; it was not delivered."),
    )
    ingress.register_closer(
        FD_REQUESTER_POST,
        lambda replay: _tell_fd_requester(replay, "was held for review and expired; it was not delivered."),
    )

    # Create skill registry (if skills_dir provided)
    skill_registry: SkillRegistry | None = None
    if skills_dir and skills_dir.exists():
        skill_registry = SkillRegistry(skills_dir)
        logger.info(f"Skill registry loaded from {skills_dir}")

    # Create MCP registry (if mcps_dir provided)
    mcp_registry: McpRegistry | None = None
    if mcps_dir and mcps_dir.exists():
        mcp_registry = McpRegistry(mcps_dir)
        logger.info(f"MCP registry loaded from {mcps_dir}")

    # Create FastAPI app
    app = FastAPI(title="ClawMeets", version="0.1.0")
    # The context behind every route; tests reach the channel gateway through it.
    app.state.server_ctx = ctx

    # Answers a retried write from the record of its first attempt. Added
    # BEFORE CORS so CORS stays outermost and decorates replays too.
    idempotency_store = IdempotencyStore(data_dir / "idempotency")
    app.add_middleware(IdempotencyMiddleware, store=idempotency_store)

    # CORS middleware — explicit allowlist (CLAWMEETS_CORS_ORIGINS +
    # CLAWMEETS_APP_URL), env-configurable. Falls back to ["*"] only when
    # nothing is configured (dev/test).
    cors_origins = cors_allow_origins()
    if cors_origins == ["*"]:
        logger.info("CORS: no allowlist configured, allowing all origins (dev)")
    else:
        logger.info(f"CORS allowlist: {cors_origins}")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
    )

    # Rejects an oversized PUT /me/brief/tabs/{slug} on Content-Length
    # BEFORE FastAPI buffers the body — the in-handler check runs after
    # that buffering and so is a status code, not a mitigation. Scoped to
    # that one path; every other request passes straight through.
    app.add_middleware(BriefBodyLimitMiddleware)

    # A turn token (a scoped turn's credential) reaches only the read routes
    # of its grant's projects; anything else is answered turn_scope [403]
    # before a route runs (server/turn_tokens.py).
    app.add_middleware(
        TurnTokenMiddleware,
        service_getter=lambda: ctx.isolation_gate.turn_tokens if ctx.isolation_gate else None,
    )

    # Records X-Clawmeets-Isolation for the isolation gate's read check.
    app.add_middleware(IsolationHeaderMiddleware)
    # An owner-isolated agent's own token reaches only the serving-only
    # allowlist (plan-owner-isolation 5d).
    app.add_middleware(ServingOnlyMiddleware, ctx_getter=lambda: ctx)

    # Register route modules
    app.include_router(create_auth_router(ctx))
    app.include_router(create_agents_router(ctx))
    app.include_router(create_turn_tokens_router(ctx))
    app.include_router(create_owner_isolation_router(ctx))
    app.include_router(create_agent_env_router(ctx))
    app.include_router(create_isolation_check_router(ctx))
    app.include_router(create_agent_fs_router(ctx))
    app.include_router(create_projects_router(ctx))
    app.include_router(create_chatrooms_router(ctx))
    app.include_router(create_files_router(ctx))
    app.include_router(create_messages_router(ctx))
    app.include_router(create_changelog_router(ctx))
    if ws_mode == "inprocess":
        app.include_router(create_websocket_router(ctx))

    @app.get("/healthz/ready", include_in_schema=False)
    async def healthz_ready():
        """200 once this process can serve sockets' traffic: always in
        in-process mode, only while the edge link is up in edge mode."""
        from fastapi.responses import JSONResponse
        if isinstance(ws_hub, EdgeWSHub):
            up = ws_hub.ready
            return JSONResponse(
                {"ws_mode": ws_mode, "edge_link": "up" if up else "down"},
                status_code=200 if up else 503,
            )
        return {"ws_mode": ws_mode, "edge_link": "n/a"}
    app.include_router(create_announcements_router(ctx))
    app.include_router(create_scheduled_messages_router(ctx))
    app.include_router(create_managed_jobs_router(ctx))
    app.include_router(create_reflection_router(ctx))
    app.include_router(create_model_defaults_router(ctx))
    app.include_router(create_sharing_router(ctx))
    app.include_router(create_knowledge_packs_router(ctx))
    app.include_router(create_brief_tabs_router(ctx))
    app.include_router(create_hosts_router(ctx))
    app.include_router(create_install_router(ctx))
    app.include_router(create_desk_todos_router(ctx))
    app.include_router(create_desk_sops_router(ctx))
    app.include_router(create_desk_labels_router(ctx))
    app.include_router(create_desk_read_state_router(ctx))
    app.include_router(create_desk_tour_router(ctx))
    app.include_router(create_desk_sign_off_router(ctx))
    app.include_router(create_desk_latest_messages_router(ctx))
    app.include_router(create_project_reports_router(ctx))
    app.include_router(create_project_plans_router(ctx))
    app.include_router(create_inbox_router(ctx))
    app.include_router(create_search_router(ctx))
    app.include_router(create_channels_router(ctx))
    app.include_router(create_hub_router(ctx))
    app.include_router(create_hub_channels_router(ctx))
    app.add_exception_handler(HubError, hub_error_response)

    async def foreign_coordinator_response(_request, exc):
        from fastapi.responses import JSONResponse

        from clawmeets.server.coordinator_rule import CODE, MESSAGE
        logger.warning("foreign_coordinator: %s", exc)
        return JSONResponse(status_code=403, content={"detail": {"code": CODE, "message": MESSAGE}})

    app.add_exception_handler(ForeignCoordinator, foreign_coordinator_response)
    app.include_router(create_webchat_router(ctx))
    app.include_router(create_public_agents_router(
        ctx, Path(__file__).parent.parent / "web" / "frontend" / "dist" / "public.html",
    ))
    app.include_router(create_oauth_router(ctx))
    # OAuth invite-login (Google/GitHub) — mounted only when the four namespaced
    # provider creds + CLAWMEETS_APP_URL are configured. Fail-fast from_env()
    # raises when unset; we degrade to "feature off" rather than crash startup,
    # mirroring the optional skill/mcp routers above.
    try:
        app.include_router(create_oauth_login_router(ctx))
        logger.info("OAuth invite-login routes mounted (/auth/oauth/*)")
    except RuntimeError as e:
        logger.warning(f"OAuth invite-login not configured, routes not mounted: {e}")
    if skill_registry:
        app.include_router(create_skills_router(ctx, skill_registry))
    if mcp_registry:
        app.include_router(create_mcps_router(ctx, mcp_registry))
    # The agent catalog: always routed, empty without a pool directory.
    pool_dir = agent_pool_dir if agent_pool_dir and agent_pool_dir.exists() else None
    app.include_router(create_templates_router(ctx, pool_dir))
    if pool_dir:
        logger.info(f"Agent pool loaded from {pool_dir}")

    # Serve frontend static files
    frontend_dist = Path(__file__).parent.parent / "web" / "frontend" / "dist"

    if frontend_dist.exists():
        logger.info(f"Frontend served from {frontend_dist}")

        # Serve static assets at /app/assets/* (matches Vite build output)
        @app.get("/app/assets/{file_path:path}", include_in_schema=False)
        async def serve_static(file_path: str):
            """Serve static assets (JS, CSS, etc.)."""
            asset_file = frontend_dist / "assets" / file_path
            if asset_file.exists() and asset_file.is_file():
                return FileResponse(asset_file)
            return FileResponse(frontend_dist / "index.html", status_code=404)

        # Serve landing page at root
        @app.get("/", include_in_schema=False)
        async def serve_root():
            landing_file = frontend_dist / "landing.html"
            if landing_file.exists():
                return FileResponse(landing_file)
            return RedirectResponse(url="/app")

        # Serve TOS and Privacy pages
        @app.get("/tos", include_in_schema=False)
        async def serve_tos():
            return FileResponse(frontend_dist / "tos.html")

        @app.get("/privacy", include_in_schema=False)
        async def serve_privacy():
            return FileResponse(frontend_dist / "privacy.html")

        # The hub operator terms (`clawmeets server hub register --accept-tos`).
        @app.get("/hub/terms", include_in_schema=False)
        async def serve_hub_terms():
            return FileResponse(frontend_dist / "hub-terms.html")

        @app.get("/private-beta-announcement", include_in_schema=False)
        async def serve_private_beta_announcement():
            return FileResponse(frontend_dist / "private-beta-announcement.html")

        # Serve brand images for landing page
        @app.get("/brand-hero.png", include_in_schema=False)
        async def serve_brand_hero():
            return FileResponse(frontend_dist / "brand-hero.png")

        @app.get("/brand-hero-banner.png", include_in_schema=False)
        async def serve_brand_hero_banner():
            return FileResponse(frontend_dist / "brand-hero-banner.png")

        @app.get("/icon.png", include_in_schema=False)
        async def serve_icon():
            return FileResponse(frontend_dist / "icon.png")

        # Icons at the bare root. The HTML entries reference these through Vite's
        # base ('/app/…'), so these routes are the fallback for the
        # requests that never pass through our HTML: a bookmark/scraper hitting
        # /favicon.svg, or iOS asking for /apple-touch-icon.png on "Add to Home
        # Screen". Without them those paths fall to the 404 JSON handler.
        @app.get("/favicon.png", include_in_schema=False)
        async def serve_favicon():
            return FileResponse(frontend_dist / "favicon.png")

        @app.get("/favicon.svg", include_in_schema=False)
        async def serve_favicon_svg():
            return FileResponse(frontend_dist / "favicon.svg")

        @app.get("/apple-touch-icon.png", include_in_schema=False)
        async def serve_apple_touch_icon():
            return FileResponse(frontend_dist / "apple-touch-icon.png")

        # Serve landing page assets (CSS/JS built by Vite for the landing entry).
        @app.get("/assets/{file_path:path}", include_in_schema=False)
        async def serve_landing_assets(file_path: str):
            asset_file = frontend_dist / "assets" / file_path
            if asset_file.exists() and asset_file.is_file():
                return FileResponse(asset_file)
            return FileResponse(frontend_dist / "index.html", status_code=404)

        # SPA base route
        @app.get("/app", include_in_schema=False)
        async def serve_app():
            """Serve SPA at /app."""
            return FileResponse(frontend_dist / "index.html")

        # SPA catch-all - serves static files if they exist, otherwise index.html for SPA routing
        @app.get("/app/{path:path}", include_in_schema=False)
        async def serve_spa(path: str):
            """Serve static files or SPA for /app/* routes."""
            return _serve_spa_file(frontend_dist, path, frontend_dist / "index.html")
    else:
        @app.get("/", include_in_schema=False)
        async def serve_root_fallback():
            return {"message": "ClawMeets API", "frontend": "Not built. Run: cd clawmeets/web/frontend && npm run build"}

        logger.warning(f"Frontend not found at {frontend_dist}. Run: cd clawmeets/web/frontend && npm run build")

    background_tasks: list[asyncio.Task] = []

    async def _sweep_idempotency_hourly() -> None:
        while True:
            try:
                removed = await asyncio.to_thread(idempotency_store.sweep)
                if removed:
                    logger.info(f"Swept {removed} expired idempotency hour dir(s)")
            except Exception:
                logger.warning("Idempotency sweep failed", exc_info=True)
            await asyncio.sleep(3600)

    # Startup event
    @app.on_event("startup")
    async def startup():
        await User.initialize(model_ctx)
        if isinstance(ws_hub, EdgeWSHub):
            # Before the port binds: the snapshot settles every agent's status
            # first, so the first request already sees the right one.
            await ws_hub.start()
        # One-shot idempotent reconcile of report_published_at against report.json
        # for every project, so the denormalized field is correct from first
        # deploy (projects with a pre-existing report predate the meta key). Only
        # writes on a real delta, so re-running on every boot is cheap.
        stamped = backfill_report_published_at(model_ctx)
        if stamped:
            logger.info(f"Backfilled report_published_at for {stamped} project(s)")
        # One-time passes (server/requester_key_migration.py), each under its
        # own guard so one failing never skips the others; each runs again at
        # the next start. A failed scoped-turn pass fails closed: a project it
        # had not keyed yet is still scoped by models/project.scope_key.
        for migrate in (
            # First: projects a scoped turn created keep their scope once
            # remote_content stops isolating (plan-owner-isolation section 3).
            migrate_scoped_turn_projects,
            # Requester ends coordinated by a stand-in or another account's
            # agent are reassigned to their owner (plan-owner-isolation 4).
            migrate_owner_coordinators,
            # Existing host conversations get their requester_key, so they
            # are requester-scoped like new ones.
            migrate_requester_keys,
            migrate_hub_thread_marks,
            # Same-server agents users already talk to are retained, so they
            # stay in Cmd-K and the agents' rosters (server/hub/retain.py).
            migrate_local_retains,
        ):
            try:
                await migrate(ctx, data_dir / "isolation")
            except Exception:
                logger.exception("%s failed; it will run again at next start", migrate.__name__)
        # Managed jobs outlive the in-memory WorkTracker: rebuild their open
        # requests before the checker's first pass, so a job whose process
        # died while the server was down is reported as stalled.
        try:
            await restore_active_jobs(
                managed_job_store, work_tracker, default_timeout=ctx.batch_timeout,
            )
        except Exception:
            logger.exception("Managed job restore failed")
        await timeout_checker.start()
        background_tasks.append(asyncio.create_task(_sweep_idempotency_hourly()))
        # Held outside messages past their ceiling go, with their closing notes.
        background_tasks.append(asyncio.create_task(ctx.outside_ingress.run_expiry_sweep()))
        # Work held for an agent that cannot isolate: closed at its ceiling,
        # and the owner reminded at most daily.
        background_tasks.append(asyncio.create_task(ctx.isolation_gate.notice.run_sweep()))
        await message_scheduler.start()
        await reflection_scheduler.start()
        # Schema + FTS5 probe is synchronous and cheap; the reconcile that
        # backfills existing history (and repairs any drift) runs as a
        # background task so it never blocks boot. The endpoint answers while
        # it runs, with `indexing: true`.
        chat_search_index.open()
        if chat_search_index.available:
            asyncio.create_task(chat_search_index.reconcile_all())
        if ctx.channel_gateway is not None:
            try:
                await ctx.channel_gateway.start()
            except Exception as exc:  # noqa: BLE001 — never stop the server booting
                logger.error(
                    "Channel gateway OFF: unexpected %s during startup",
                    type(exc).__name__,
                )
                ctx.channel_gateway = None
                ctx.hub_runtime = None
        if ctx.hub_runtime is not None:
            # After the gateway: reopen paused work, purge withdrawn hub
            # keys, then (registered and mode not off) the first connect.
            try:
                await ctx.hub_runtime.start()
            except Exception as exc:  # noqa: BLE001 — never stop the server booting
                logger.error("Hub runtime OFF: unexpected %s during startup", type(exc).__name__)
                ctx.hub_runtime = None
        logger.info(f"Server started with data_dir={data_dir}")

    # Shutdown event
    @app.on_event("shutdown")
    async def shutdown():
        for task in background_tasks:
            task.cancel()
        await reflection_scheduler.stop()
        await message_scheduler.stop()
        await timeout_checker.stop()
        if ctx.hub_runtime is not None:
            await ctx.hub_runtime.stop()
        if ctx.channel_gateway is not None:
            await ctx.channel_gateway.stop()
        await ctx.socket_events.close()
        if isinstance(ws_hub, EdgeWSHub):
            await ws_hub.stop()
        await runloop_manager.shutdown()
        chat_search_index.close()
        if ctx.channel_store is not None:
            ctx.channel_store.close()
        logger.info("Server shutdown complete")

    return app
