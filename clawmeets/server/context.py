# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/context.py
Server context holding shared dependencies.

The ServerContext provides access to all stores, services, and utilities
needed by route handlers. It's created once at app startup and passed
to route registration functions.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from clawmeets.server.signup_policy import SignupPolicy

if TYPE_CHECKING:
    from clawmeets.server.isolation_gate import IsolationGate
    from clawmeets.models.work_tracker import WorkTracker
    from clawmeets.server.hub.runtime import HubRuntime
    from clawmeets.server.ws_hub import Hub
    from clawmeets.server.socket_events import SocketEvents
    from clawmeets.server.auth import AuthService
    from clawmeets.server.timeout_checker import BatchTimeoutChecker
    from clawmeets.server.message_scheduler import MessageScheduler
    from clawmeets.server.oauth_state import OAuthStateStore
    from clawmeets.server.oauth_login.handoff import LoginHandoffStore
    from clawmeets.server.oauth_login.cli_state import CliOAuthStateStore
    from clawmeets.sync.runloop_manager import ChangelogRunloopManager
    from clawmeets.models.context import ModelContext
    from clawmeets.models.scheduled_message import ScheduledMessageStore
    from clawmeets.models.reflection_schedule import ReflectionScheduleStore
    from clawmeets.models.managed_job import ManagedJobStore
    from clawmeets.server.reflection_scheduler import ReflectionScheduler
    from clawmeets.server.chat_search_index import ChatSearchIndex
    from clawmeets.ws_edge.terminal_relay import TerminalRelay
    from clawmeets.server.home_fs_relay import HomeFsRelay
    from clawmeets.server.channels.store import ChannelStore
    from clawmeets.server.channels.gateway import ChannelGateway
    from clawmeets.server.inspection import OutsideIngress
    from clawmeets.server.room_flow import RoomFlowSwitch
    from pathlib import Path


@dataclass
class ServerContext:
    """
    Shared server context holding all dependencies.

    This replaces the closure-based approach in create_app, making
    dependencies explicit and enabling easier route module splitting.
    """
    # Stores
    model_ctx: "ModelContext"  # Server-wide file I/O layer

    # Services
    ws_hub: "Hub"
    work_tracker: "WorkTracker"
    auth: "AuthService"
    runloop_manager: "ChangelogRunloopManager"  # Per-project changelog handling
    timeout_checker: "BatchTimeoutChecker"  # Background batch timeout enforcement
    scheduled_message_store: "ScheduledMessageStore"  # Scheduled message persistence
    message_scheduler: "MessageScheduler"  # Background scheduled message firing
    reflection_schedule_store: "ReflectionScheduleStore"  # Per-user reflection schedule
    reflection_scheduler: "ReflectionScheduler"  # Background reflection fan-out
    managed_job_store: "ManagedJobStore"  # Durable background-job lifecycle state
    oauth_state_store: "OAuthStateStore"  # In-memory state store for the MCP OAuth relay flow
    login_handoff_store: "LoginHandoffStore"  # In-memory single-use OAuth-login exchange codes
    cli_oauth_state_store: "CliOAuthStateStore"  # In-memory single-use CLI OAuth pending-state + PKCE bindings
    chat_search_index: "ChatSearchIndex"  # Derived FTS5 index behind GET /me/search/messages
    # Browser <-> computer terminal sessions. Optional so contexts built by
    # hand in tests keep working; create_app always sets it.
    terminal_relay: "TerminalRelay | None" = None
    # Home-folder requests to agents' runners (server/home_fs_relay.py).
    # Optional for the same reason; create_app always sets it.
    home_fs_relay: "HomeFsRelay | None" = None
    # What core does when a socket opens, closes or reports in
    # (server/socket_events.py). Optional for the same reason; create_app
    # always sets it, and the socket routes build one on first use otherwise.
    socket_events: "SocketEvents | None" = None
    # Channel records (server/channels/store.py). Open whether or not the
    # gateway is on: the message write paths ask it whether a project is a
    # channel thread. Optional so hand-built test contexts keep working.
    channel_store: "ChannelStore | None" = None
    # The channel gateway, or None while the kill switch is off
    # (CLAWMEETS_CHANNELS_ENABLED) or its configuration is invalid.
    channel_gateway: "ChannelGateway | None" = None
    # The hub's one owner of "is it live" (server/hub/runtime.py): built
    # whenever the gateway is, idle in hub mode off.
    hub_runtime: "HubRuntime | None" = None
    # Isolated projects reach only sandbox-capable runners, and are written to
    # only under a live turn grant (server/isolation_gate.py). Optional so
    # hand-built test contexts keep working; create_app always sets it.
    isolation_gate: "IsolationGate | None" = None
    #: The owner-isolation setting's server half (server/owner_isolation.py).
    owner_isolation: object = None
    # The message inspection hook every outside message passes before it is
    # stored (server/inspection.py), and the per-room flow switch it checks
    # first (server/room_flow.py). Optional so hand-built test contexts keep
    # working; create_app always sets both and installs the append guard.
    outside_ingress: "OutsideIngress | None" = None
    room_flow: "RoomFlowSwitch | None" = None
    # Hub send caps for agents and the per-user target cap (server/hub/agent_send_guard.py);
    # built on first use from the channel store.
    hub_send_guard: object = None
    room_bridge_subscriber: object = None

    # Who may create an account (CLAWMEETS_SIGNUP_MODE / _TRUSTED_DOMAINS),
    # read once at boot. The default is invite-only, as before the setting.
    signup_policy: "SignupPolicy" = field(default_factory=SignupPolicy)

    # Config
    batch_timeout: int = 1800  # Default 30 minutes
    skills_dir: "Path | None" = None  # Skills registry directory
    mcps_dir: "Path | None" = None  # MCP server registry directory
    agent_pool_dir: "Path | None" = None  # clawmeets-agents checkout (the agent catalog)
    # announcements.json (optional). None => the repo-root default resolved by
    # clawmeets/server/announcements.py. The config has no write surface — it
    # stays a file on disk — so this override is how a test or a deployment
    # points at a different one.
    announcements_path: "Path | None" = None
