# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/agents.py
Agent management routes.
"""
from __future__ import annotations

import hashlib
import json
import logging
import shutil
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from fastapi.responses import JSONResponse, Response

from fastapi import Query as QueryParam

from clawmeets.api.control import (
    AgentSettingsChangePayload,
    ChangelogUpdatePayload,
    ControlEnvelope,
    ControlMessageType,
)
from clawmeets.api.responses import (
    AgentRegistrationResponse,
    AgentResponse,
    AgentSearchResponse,
    AgentStatus,
    ModelConfig,
    ModelConfigCreate,
    ModelConfigList,
    ModelConfigOrderBody,
    ModelConfigPatch,
    SetDefaultBody,
    SmartRoutingPatch,
)
from clawmeets.models import model_config as _model_config
from clawmeets.models import model_defaults as _model_defaults
from clawmeets.models.agent import Agent
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.persistable import DELETED_DIR_PREFIX
from clawmeets.models.project import Project
from clawmeets.server.agent_visibility import (
    AGENT_WRITE_LOCK, fan_out_registry_change, retainers_of, visibility_fields,
)
from clawmeets.server.recent_activity import (
    collect_recent_activity,
    render_text_transcript,
)
from clawmeets.server.in_flight_restore import (
    parse_in_flight_turns,
    restore_in_flight_turns,
)
from clawmeets.server.routes.projects import _ensure_own_dm_project
from clawmeets.sync.changelog import (
    ChangelogEntryType,
    ParticipantAddedPayload,
    ProjectAllowlistUpdatedPayload,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# Route-level lock for agent write operations (shared with the Hub switch,
# which makes an agent public or private through agent_visibility).
_agent_write_lock = AGENT_WRITE_LOCK


async def emit_model_config_change(ctx: "ServerContext", agent: Agent, card: dict) -> None:
    """Broadcast AGENT_SETTINGS_CHANGE carrying the mirrored local_settings
    AND the full model_configs list so the runner mirrors them onto its
    self-card (needed to resolve a per-request override). Shared by the
    per-agent model-config routes and "apply my default to all my agents"
    (``routes/model_defaults.py``).

    NOTE: model_configs here are the RAW stored dicts — they still carry each
    entry's write-only ``api_key``. This is intentional and safe: the envelope
    is delivered only to the agent's own runner (``ws_hub.send_to(agent.id)``),
    which needs the raw key to invoke a keyed provider. It is NEVER forwarded
    to browser/user connections — those read redacted configs over HTTP
    (``AgentResponse``/``ModelConfigList`` via ``redact_model_configs``)."""
    if getattr(ctx, "isolation_gate", None) is not None:
        getattr(ctx, "isolation_gate", None).capabilities.observe_card(agent.id, card)
    envelope = ControlEnvelope(
        type=ControlMessageType.AGENT_SETTINGS_CHANGE,
        payload=AgentSettingsChangePayload(
            agent_id=agent.id,
            agent_name=agent.name,
            local_settings=card.get("local_settings") or {},
            model_configs=card.get("model_configs") or [],
            default_model_config_name=card.get("default_model_config_name"),
        ),
    )
    await ctx.ws_hub.send_to(agent.id, envelope)


def _for_viewer(resp: AgentResponse, viewer_user_id: Optional[str]) -> AgentResponse:
    """``resp`` with its viewer-relative fields: ``home_folder_browsable`` is
    true only for the agent's owner (the home-folder routes refuse everyone
    else, and a hub stand-in is never in this roster). ``owner_isolated`` and
    ``blocked_by_exposed_host`` are the owner's only: they would tell anyone
    which public agents run without the sandbox."""
    owner = bool(viewer_user_id) and resp.registered_by == viewer_user_id
    if owner:
        return resp.model_copy(update={"home_folder_browsable": True})
    return resp.model_copy(update={"home_folder_browsable": False, "owner_isolated": False,
                                   "blocked_by_exposed_host": None})


def _with_live_status(resp: AgentResponse, connected: bool) -> AgentResponse:
    """Return ``resp`` with ``status`` reconciled against the live WebSocket hub.

    ``card.json``'s ``status`` is a persisted MIRROR of the hub, written on WS
    connect/disconnect and never swept at boot, so it lies in both directions:
    it reads ``online`` for every runner that happened to be connected when the
    process last died, and ``offline`` for an agent that closed one of several
    live sessions (``ws_hub.disconnect`` removes one socket; the disconnect path
    flips the card unconditionally). The hub cannot go stale for the opposite
    reason — it dies with the process — and one route already treats it as
    authoritative (``GET /agents/{id}/connection``).

    Three cases, and the third is why this is not ``ONLINE if connected else
    OFFLINE``:

    - not connected              → ``OFFLINE``, whatever the card says
    - connected, card ``OFFLINE``→ ``ONLINE``
    - connected, anything else   → **untouched**. ``BUSY`` and ``RATE_LIMITED``
      are real states a live agent reports about itself and must survive this
      function, so all four ``AgentStatus`` members stay reachable on the wire.

    Read-path only — it writes nothing, so the two write-path bugs above stay
    exactly as they are (followup) and this cannot make them worse. O(1) per
    agent: a set-membership test, on a route that already does a file read per
    agent. Correct only because the server is single-process; the hub is
    per-process in-memory, so multi-worker is already unsupported.
    """
    if not connected:
        resp.status = AgentStatus.OFFLINE
    elif resp.status == AgentStatus.OFFLINE:
        resp.status = AgentStatus.ONLINE
    return resp


def _roster_etag(body: list[dict]) -> str:
    """Strong ETag for a ``GET /agents`` body: a hash of everything in it except
    ``last_heartbeat``.

    The body already carries live status, visibility and every card field, so
    any change a runner cares about changes the hash. ``last_heartbeat`` is left
    out because every connected runner stamps it every 30 s: with it, the roster
    would change every few seconds and a 304 would almost never happen. Runners
    don't read peers' heartbeats, and the route sends ``Cache-Control: no-store``
    so browsers never revalidate against this tag and always get the full body.
    """
    stable = [{k: v for k, v in item.items() if k != "last_heartbeat"} for item in body]
    digest = hashlib.sha256(
        json.dumps(stable, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return f'"{digest[:16]}"'


def _etag_matches(if_none_match: str, etag: str) -> bool:
    """Whether an ``If-None-Match`` header names ``etag`` (weak forms accepted)."""
    candidates = (c.strip() for c in if_none_match.split(","))
    return any(c == "*" or c.removeprefix("W/") == etag for c in candidates)


def create_agents_router(ctx: "ServerContext") -> APIRouter:
    """Create the agents router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["agents"])

    async def _fan_out_registry_change(
        changed_agent_id: str,
        changed_agent_name: str,
        owner_user_id: Optional[str],
        action: str,
    ) -> None:
        """Tell the owner's other runners, and those of every user who
        retained the agent, that the registry changed
        (``agent_visibility.fan_out_registry_change``)."""
        await fan_out_registry_change(
            ctx, changed_agent_id=changed_agent_id, changed_agent_name=changed_agent_name,
            owner_user_id=owner_user_id, action=action, also_users=retainers_of(ctx, changed_agent_id),
        )

    def _find_deleted_predecessor_ids(name: str) -> set[str]:
        """Return ids of DELETED-* dirs whose short name matches ``name``.

        Soft-deleted agents live at ``{participants_dir}/agents/DELETED-{name}-{id}``;
        their old ids are what's still nailed into stale ``PARTICIPANTS.ndjson``
        and ``participating_agents`` entries. Used to identify which existing
        memberships need to swap to a freshly-registered same-name agent.
        """
        result: set[str] = set()
        agents_dir = ctx.model_ctx.participants_dir / "agents"
        if not agents_dir.exists():
            return result
        prefix = f"{DELETED_DIR_PREFIX}{name}-"
        for d in agents_dir.iterdir():
            if not d.is_dir() or not d.name.startswith(prefix):
                continue
            id_part = d.name[len(prefix):]
            if id_part:
                result.add(id_part)
        return result

    async def _ensure_membership_continuity(agent: Agent, owner_user_id: str) -> None:
        """Heal stale chatroom memberships when ``agent`` replaces a deleted
        same-name predecessor.

        Agent delete is a soft rename to ``DELETED-{name}-{id}``; it never
        prunes that id from ``Project.participating_agents`` or any chatroom's
        ``PARTICIPANTS.ndjson``. When the user later re-registers an agent
        with the same short name (typically via ``clawmeets init``), the new
        id is invisible to ``GET /participants/{id}/projects`` and
        ``broadcast_to_project`` for every chatroom the predecessor was in —
        including DM chatrooms (where there's no UI affordance to repair) and
        regular project rooms (where ``messages.py:906-911`` silently drops
        @mentions that resolve to a non-member id, so the user gets no signal).

        Walks every project owned by ``owner_user_id``, finds chatrooms whose
        member list contains a DELETED predecessor of this agent's name, and
        emits ``PARTICIPANT_ADDED`` for the new id. Also remaps any pending
        ``WorkTracker`` batch in those chatrooms so the new agent's eventual
        reply advances the batch instead of being silently ignored.

        Owner-scoped — cross-owner FD recovery is its own routing layer.
        Idempotent: skips chatrooms already containing the new id.
        """
        if not owner_user_id:
            return
        predecessor_ids = _find_deleted_predecessor_ids(agent.name)
        if not predecessor_ids:
            return
        for project in Project.list_all(ctx.model_ctx):
            if project.created_by != owner_user_id:
                continue
            stitched_any = False
            last_version: Optional[int] = None
            for chatroom_name in project.chatrooms:
                chatroom = Chatroom.get(project.id, chatroom_name, ctx.model_ctx)
                if chatroom is None:
                    continue
                members = set(chatroom.participants)
                stale = predecessor_ids & members
                if not stale or agent.id in members:
                    continue
                runloop = await ctx.runloop_manager.get_or_create(project.id, project.name)
                entry = await runloop.append(
                    ChangelogEntryType.PARTICIPANT_ADDED,
                    ParticipantAddedPayload(
                        chatroom_name=chatroom_name,
                        participant_id=agent.id,
                        participant_name=agent.name,
                        external=False,
                    ),
                )
                last_version = entry.version
                stitched_any = True
                # Patch any pending batch in this chatroom so the new agent's
                # reply lands on ``record_response`` and advances the batch
                # (otherwise it'd be a no-op against a stale expected id and
                # the batch would silently BATCH_TIMEOUT).
                mapping = {stale_id: agent.id for stale_id in stale}
                await ctx.work_tracker.remap_expected(
                    project.id, chatroom_name, mapping
                )
                logger.info(
                    f"Membership stitch: added {agent.name} ({agent.id[:8]}) "
                    f"to {chatroom_name} in {project.id[:8]} "
                    f"(replacing {len(stale)} stale id(s))"
                )
            if stitched_any and last_version is not None:
                # Reload project so participating_agents reflects the new id
                # before broadcast (PARTICIPANT_ADDED handler updated it).
                reloaded = Project.get(project.id, ctx.model_ctx)
                envelope = ControlEnvelope(
                    type=ControlMessageType.CHANGELOG_UPDATE,
                    payload=ChangelogUpdatePayload(
                        project_id=reloaded.id,
                        project_name=reloaded.name,
                        new_version=last_version,
                        coordinator_id=reloaded.coordinator_id,
                    ),
                )
                await ctx.ws_hub.broadcast_to_project(envelope, reloaded)

    def _normalize_user_teams(raw: Optional[list[str]]) -> Optional[list[str]]:
        """Strip/dedupe an incoming user_teams list. Returns None if the
        caller did not send the field, [] if they sent an explicit empty
        list, and a cleaned list otherwise."""
        if raw is None:
            return None
        seen: set[str] = set()
        out: list[str] = []
        for value in raw:
            if not isinstance(value, str):
                continue
            stripped = value.strip()
            if not stripped or stripped in seen:
                continue
            seen.add(stripped)
            out.append(stripped)
        return out

    @router.post("/agents/register", response_model=AgentRegistrationResponse)
    async def register_agent(
        name: str = Body(..., embed=True),
        description: str = Body(..., embed=True),
        capabilities: list[str] = Body([], embed=True),
        discoverable_through_registry: bool = Body(False, embed=True),
        user_teams: Optional[list[str]] = Body(None, embed=True),
        seed_model_default: bool = Body(True, embed=True),
        authorization: str = Header(default=""),
    ):
        """Register a new agent (any authenticated user).

        Agent names are automatically prefixed with the registering user's
        username (e.g. user 'alice' registering 'researcher' → 'alice-researcher').
        This provides namespace isolation since hyphens are disallowed in usernames.

        Accepts the owner's JWT or assistant_token (so the user's
        ``-assistant`` agent can extend the team via the ``register-agent``
        system skill).
        """
        current_user = await ctx.auth.resolve_user_from_credential(authorization)
        # Reject hyphens in user-provided agent name
        if "-" in name:
            raise HTTPException(400, "Agent name cannot contain hyphens (-). Use underscores (_) instead.")
        # Prefix agent name with username for namespace isolation.
        # If already prefixed (e.g. re-registration), don't double-prefix.
        prefix = f"{current_user.username}-"
        if not name.startswith(prefix):
            name = f"{prefix}{name}"

        normalized_teams = _normalize_user_teams(user_teams)

        try:
            async with _agent_write_lock:
                agent, token = Agent.register(
                    name=name,
                    description=description,
                    ctx=ctx.model_ctx,
                    capabilities=capabilities,
                    discoverable=discoverable_through_registry,
                    registered_by=current_user.id,
                )
                if normalized_teams:
                    agent.update_card(user_teams=normalized_teams)
                # A new agent starts with a COPY of its owner's default model
                # config. A caller that brings its own model (a model agent,
                # `--llm-provider`) passes seed_model_default=false and sets it
                # right after. Owners with no default yet keep the old probe of
                # the CLIs installed on THIS box — kept one release so their new
                # agents still get a model; delete it after. Non-fatal: a
                # failure leaves the list empty ("Setup Model" empty state).
                if seed_model_default:
                    try:
                        card = agent._load_card()
                        default = _model_defaults.load(
                            ctx.model_ctx.base_dir, current_user.id,
                        )
                        if _model_defaults.is_configured(default):
                            _model_defaults.seed_card_from_default(card, default)
                        else:
                            _model_config.seed_probed_configs(card)
                        agent.update_card(
                            model_configs=card.get("model_configs") or [],
                            default_model_config_name=card.get("default_model_config_name"),
                            local_settings=card.get("local_settings") or {},
                        )
                    except Exception:  # noqa: BLE001 — seeding is best-effort
                        logger.warning(
                            "model-config seed failed for %s", agent.name,
                            exc_info=True,
                        )
            # First-time registration of the user's `{username}-assistant`
            # agent: link it to the user record + materialize the DM project
            # so frontend `user.assistant_agent_id` lookups and the DM
            # chatroom both work without a separate server roundtrip.
            if (
                not discoverable_through_registry
                and agent.name == f"{current_user.username}-assistant"
            ):
                await current_user.link_assistant(agent.id)
                dm_project = await _ensure_own_dm_project(ctx, current_user, agent.name)
                logger.info(
                    f"Linked assistant {agent.name} to user {current_user.username} "
                    f"and created DM project {dm_project.name} ({dm_project.id[:8]})"
                )
            await _fan_out_registry_change(
                changed_agent_id=agent.id,
                changed_agent_name=agent.name,
                owner_user_id=current_user.id,
                action="register",
            )
            await _ensure_membership_continuity(agent, current_user.id)
            return AgentRegistrationResponse(
                agent_id=agent.id,
                agent_name=agent.name,
                registered_by=agent.registered_by,
                token=token,
                description=agent.description,
                status=agent.status,
                registered_at=agent.registered_at or datetime.now(UTC),
                discoverable_through_registry=agent.is_discoverable,
                user_teams=list(agent.user_teams or []),
            )
        except ValueError:
            # Agent already exists — upsert: update card and regenerate token
            # Only allow if requester is the original registrant
            existing = Agent.get_by_name(name, ctx.model_ctx)
            if existing is None:
                raise HTTPException(409, f"Name '{name}' already registered")

            if existing.registered_by != current_user.id:
                raise HTTPException(403, "Only the original registrant can re-register this agent")

            update_fields = {
                "description": description,
                "capabilities": capabilities,
                **visibility_fields(discoverable_through_registry),
            }
            if normalized_teams is not None:
                # Re-register is additive — union existing + incoming, preserving
                # order (existing first, then new entries appended). An explicit
                # empty list in setup.json is a no-op here, not a "clear all".
                # Clearing teams is the PUT /agents/{id} endpoint's job (and the
                # Web UI / `clawmeets team remove`).
                existing_teams = list(existing.user_teams or [])
                seen = set(existing_teams)
                merged_teams = list(existing_teams)
                for t in normalized_teams:
                    if t not in seen:
                        merged_teams.append(t)
                        seen.add(t)
                update_fields["user_teams"] = merged_teams
            existing.update_card(**update_fields)
            # Re-register is idempotent for the token. Rotating here would
            # silently invalidate the in-memory credential of any already-
            # running runner — exactly what `clawmeets init` re-runs do.
            # Token rotation is a deliberate op: delete + register-fresh.
            logger.info(f"Re-registered agent {name} (updated by {current_user.username})")
            await _fan_out_registry_change(
                changed_agent_id=existing.id,
                changed_agent_name=existing.name,
                owner_user_id=existing.registered_by,
                action="update",
            )
            await _ensure_membership_continuity(existing, existing.registered_by)
            return AgentRegistrationResponse(
                agent_id=existing.id,
                agent_name=existing.name,
                registered_by=existing.registered_by,
                token=None,
                description=existing.description,
                status=existing.status,
                registered_at=existing.registered_at or datetime.now(UTC),
                discoverable_through_registry=existing.is_discoverable,
                user_teams=list(existing.user_teams or []),
            )

    @router.get("/auth/me", response_model=AgentResponse)
    async def get_current_agent(authorization: str = Header(default="")):
        """Validate bearer token and return associated agent info."""
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        token = authorization[7:]
        # Find agent by token (must search all agents, bypass user-scoping)
        agents = Agent.list_all(ctx.model_ctx, discoverable_only=False, include_private=True)
        for agent in agents:
            if Agent.verify_token(agent.id, token, ctx.model_ctx):
                # An agent token speaks for the agent's owner.
                return _for_viewer(agent.to_response(), agent.registered_by)
        raise HTTPException(401, "Invalid token")

    @router.get("/agents/search", response_model=AgentSearchResponse)
    async def search_agents(
        q: str = QueryParam("", description="Search name and description"),
        capabilities: str = QueryParam("", description="Comma-separated capabilities filter"),
        status: str = QueryParam("", description="Filter by status (e.g., online)"),
        offset: int = QueryParam(0, ge=0),
        limit: int = QueryParam(20, ge=1, le=50),
        sort: str = QueryParam("status_first", pattern="^(status_first|name)$"),
        discoverable_only: bool = QueryParam(False, description="Return only public (discoverable) agents; excludes viewer's private agents"),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Search agents with filtering and pagination."""
        viewer_user_id = await ctx.auth.resolve_viewer(
            authorization, x_agent_id or None
        )
        caps = [c.strip() for c in capabilities.split(",") if c.strip()] if capabilities else None
        agents, total = Agent.search(
            ctx.model_ctx,
            query=q,
            capabilities=caps,
            status=status or None,
            offset=offset,
            limit=limit,
            sort=sort,
            viewer_user_id=viewer_user_id,
            discoverable_only=discoverable_only,
        )
        return AgentSearchResponse(
            agents=[_for_viewer(a.to_response(), viewer_user_id) for a in agents],
            total=total,
            offset=offset,
            limit=limit,
        )

    @router.get("/agents/capabilities")
    async def list_capabilities():
        """Return distinct capabilities across all discoverable agents."""
        return Agent.list_capabilities(ctx.model_ctx)

    @router.get("/agents", response_model=list[AgentResponse])
    async def list_agents(
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
        if_none_match: str = Header(default=""),
    ):
        """List agents visible to the current viewer.

        Discoverable agents are visible to everyone. Non-discoverable agents are
        visible to their registrant only. Agent-token auth (with
        ``X-Agent-ID``) resolves the viewer to the agent's owner, so runners see
        their owner's full team — including non-discoverable owned agents that
        need to be resolvable at prompt-build time (e.g. Front Desk invitable
        allowlist).

        ``status`` is reconciled against the live WebSocket hub rather than
        served from the persisted card mirror — see :func:`_with_live_status`.
        This is the roster the agent picker renders, so a card that says
        ``online`` for a runner that died with the last server process must not
        reach it as a green dot.
        """
        viewer_user_id = await ctx.auth.resolve_viewer(
            authorization, x_agent_id or None
        )
        agents = Agent.list_all(ctx.model_ctx, viewer_user_id=viewer_user_id)
        body = [
            _for_viewer(
                _with_live_status(a.to_response(), ctx.ws_hub.is_connected(a.id)), viewer_user_id,
            ).model_dump(mode="json")
            for a in agents
        ]
        # Runner catch-up sends back the tag it last saw; an unchanged roster
        # answers 304 and the runner skips rewriting every peer card + AGENTS.md.
        etag = _roster_etag(body)
        headers = {"ETag": etag, "Cache-Control": "no-store"}
        if if_none_match and _etag_matches(if_none_match, etag):
            return Response(status_code=304, headers=headers)
        return JSONResponse(body, headers=headers)

    @router.get("/agents/{agent_id}", response_model=AgentResponse)
    async def get_agent(
        agent_id: str,
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Get agent by ID. Non-discoverable agents require owner auth.

        Agent-token auth (with ``X-Agent-ID``) resolves the viewer to the
        agent's owner, so a runner can fetch any of its owner's other agents
        (including non-discoverable ones) — needed for prompt-side resolution
        of Front Desk invitable allowlist members.
        """
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        try:
            viewer_user_id = await ctx.auth.resolve_viewer(
                authorization, x_agent_id or None
            )
        except HTTPException:
            # A public agent stays readable with a stale token; only the
            # viewer-relative fields (and private agents) need a viewer.
            if not agent.is_discoverable:
                raise
            viewer_user_id = None
        # Visibility check for non-discoverable agents.
        if not agent.is_discoverable and agent.registered_by != viewer_user_id:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        return _for_viewer(agent.to_response(), viewer_user_id)

    @router.put("/agents/{agent_id}", response_model=AgentResponse)
    async def update_agent(
        agent_id: str,
        description: Optional[str] = Body(None, embed=True),
        capabilities: Optional[list[str]] = Body(None, embed=True),
        discoverable_through_registry: Optional[bool] = Body(None, embed=True),
        local_settings: Optional[dict] = Body(None, embed=True),
        user_teams: Optional[list[str]] = Body(None, embed=True),
        default_invitable_agents: Optional[list[str]] = Body(None, embed=True),
        default_invitable_teams: Optional[list[str]] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Update agent card fields (registrant only)."""
        current_user = await ctx.auth.get_current_user(authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if agent.registered_by != current_user.id:
            raise HTTPException(403, "Only the agent owner can update this agent")

        fields = {}
        if description is not None:
            fields["description"] = description
        if capabilities is not None:
            fields["capabilities"] = capabilities
        if discoverable_through_registry is not None:
            # Unpublishing clears owner isolation (agent_visibility).
            fields.update(visibility_fields(discoverable_through_registry))
        if local_settings is not None:
            fields["local_settings"] = local_settings
        if user_teams is not None:
            # Explicit empty list clears all teams. There's no per-user
            # allowlist to validate against — team names are free-form and
            # the sidebar derives the section list from agent state.
            fields["user_teams"] = _normalize_user_teams(user_teams) or []
        if default_invitable_agents is not None:
            fields["default_invitable_agents"] = _normalize_user_teams(default_invitable_agents) or []
        if default_invitable_teams is not None:
            fields["default_invitable_teams"] = _normalize_user_teams(default_invitable_teams) or []

        # When local_settings sets an llm_provider (legacy provider control),
        # keep the named-config default consistent: ensure a config exists for
        # that provider and is the default, then re-mirror. Carries the
        # reconciled model_configs on the broadcast so the runner stays in sync.
        synced_configs: Optional[dict] = None
        if fields:
            async with _agent_write_lock:
                # A wholesale PUT replaces local_settings. There is no longer an
                # agent-level API key to preserve (keys live per model config), so
                # local_settings is applied as-is. Any legacy llm_api_key is
                # stripped on every read path, never surfaced back to the client.
                agent.update_card(**fields)
                if local_settings is not None:
                    card = agent._load_card()
                    _model_config.reconcile_default_with_local_settings(card)
                    # A wholesale PUT without llm_provider would otherwise drop
                    # the mirrored llm_* / smart_routes of the agent's configs.
                    if _model_config._get_list(card):
                        _model_config.apply_mirror(card)
                    agent.update_card(
                        model_configs=card.get("model_configs") or [],
                        default_model_config_name=card.get("default_model_config_name"),
                        local_settings=card.get("local_settings") or {},
                    )
                    synced_configs = card

        # A provider, model or login change withdraws the isolated-turn
        # capability until the runner re-runs its canaries (agent_capabilities).
        if getattr(ctx, "isolation_gate", None) is not None:
            getattr(ctx, "isolation_gate", None).capabilities.observe_card(agent_id, agent._load_card())

        # Notify the running agent of local_settings changes via WebSocket so
        # `knowledge_dir`/`llm_provider`/`llm_model` take effect on the next
        # LLM invocation without a restart.
        if local_settings is not None:
            envelope = ControlEnvelope(
                type=ControlMessageType.AGENT_SETTINGS_CHANGE,
                payload=AgentSettingsChangePayload(
                    agent_id=agent_id,
                    agent_name=agent.name,
                    local_settings=(
                        (synced_configs or {}).get("local_settings") or local_settings
                    ),
                    model_configs=(
                        (synced_configs or {}).get("model_configs") or []
                        if synced_configs is not None else None
                    ),
                    default_model_config_name=(
                        (synced_configs or {}).get("default_model_config_name")
                        if synced_configs is not None else None
                    ),
                ),
            )
            await ctx.ws_hub.send_to(agent_id, envelope)

        # Fan out peer-visible registry edits to other runners owned by the
        # same user so their local peer-card cache (Agent.list_all) refreshes
        # without a restart. Triggers when fields visible to peers change —
        # user_teams (drives the project invitable filter), description /
        # capabilities (rendered in AGENTS.md), or discoverable_through_registry
        # (toggles AGENTS.md visibility). Sibling to AGENT_SETTINGS_CHANGE
        # above, which stays runner-local for the changed agent itself.
        peer_visible_changed = (
            user_teams is not None
            or description is not None
            or capabilities is not None
            or discoverable_through_registry is not None
        )
        if peer_visible_changed:
            await _fan_out_registry_change(
                changed_agent_id=agent.id,
                changed_agent_name=agent.name,
                owner_user_id=agent.registered_by,
                action="update",
            )

        # Only the owner (or the owner's own agent) gets this far.
        return _for_viewer(agent.to_response(), agent.registered_by)

    @router.put("/agents/{agent_id}/user_teams", response_model=AgentResponse)
    async def update_agent_user_teams(
        agent_id: str,
        user_teams: Optional[list[str]] = Body(None, embed=True),
        add: Optional[str] = Body(None, embed=True),
        remove: Optional[str] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Mutate an agent's user_teams labels via one atomic op.

        Exactly one of:
          - ``user_teams`` — replace the full list (``[]`` clears).
          - ``add`` — append a team (no-op if already present).
          - ``remove`` — drop a team (no-op if absent).

        Auth: agent self-token (self-tag), owner JWT, the user's
        ``-assistant`` token (assistant-on-peer). Narrow per-field
        endpoint that complements the broader owner-only
        ``PUT /agents/{id}`` so workers/coordinators can shell
        ``clawmeets team add self <team>`` from inside their runner subprocess.
        """
        ops = [x is not None for x in (user_teams, add, remove)]
        if sum(ops) != 1:
            raise HTTPException(
                400, "Provide exactly one of: user_teams, add, remove"
            )
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        async with _agent_write_lock:
            current = list(agent.user_teams or [])
            if user_teams is not None:
                new_teams = _normalize_user_teams(user_teams) or []
            elif add is not None:
                stripped = add.strip()
                if not stripped:
                    raise HTTPException(400, "add team name cannot be empty")
                new_teams = current if stripped in current else [*current, stripped]
            else:
                stripped = (remove or "").strip()
                if not stripped:
                    raise HTTPException(400, "remove team name cannot be empty")
                new_teams = [t for t in current if t != stripped]
            if new_teams != current:
                agent.update_card(user_teams=new_teams)

        await _fan_out_registry_change(
            changed_agent_id=agent.id,
            changed_agent_name=agent.name,
            owner_user_id=agent.registered_by,
            action="update",
        )
        # Only the owner (or the owner's own agent) gets this far.
        return _for_viewer(agent.to_response(), agent.registered_by)

    @router.patch("/agents/{agent_id}/local-settings", response_model=AgentResponse)
    async def patch_agent_local_settings(
        agent_id: str,
        local_settings: dict = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Merge a partial ``local_settings`` patch into an agent's card.

        Narrow per-field endpoint that complements the broader owner-only
        ``PUT /agents/{id}`` (which also edits description/capabilities and
        stays owner-only). Auth: agent self-token (self-reconfigure), owner
        JWT, or the user's ``-assistant`` token (assistant-on-peer) —
        so a worker can shell ``clawmeets agent reconfigure self ...`` and the
        assistant can reconfigure any owned peer, both without a user JWT. The
        self-token is server-scoped to the calling agent only.

        Merge semantics (so a DM can change one key without wiping the rest):
          - key present, non-null/non-empty  → set
          - key present, null or empty string → unset
          - key absent                        → unchanged
        Emits AGENT_SETTINGS_CHANGE so the change hot-applies on the runner's
        next LLM invocation.
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        async with _agent_write_lock:
            card = agent._load_card()
            merged = dict(card.get("local_settings") or {})
            for key, value in local_settings.items():
                if value is None or value == "":
                    merged.pop(key, None)
                else:
                    merged[key] = value
            card["local_settings"] = merged
            # Keep the named-config default consistent when a provider change
            # rides this legacy path, then re-mirror (may adjust local_settings).
            _model_config.reconcile_default_with_local_settings(card)
            merged = card.get("local_settings") or merged
            agent.update_card(
                local_settings=merged,
                model_configs=card.get("model_configs") or [],
                default_model_config_name=card.get("default_model_config_name"),
            )

        if getattr(ctx, "isolation_gate", None) is not None:
            getattr(ctx, "isolation_gate", None).capabilities.observe_card(agent_id, agent._load_card())
        envelope = ControlEnvelope(
            type=ControlMessageType.AGENT_SETTINGS_CHANGE,
            payload=AgentSettingsChangePayload(
                agent_id=agent_id,
                agent_name=agent.name,
                local_settings=merged,
                model_configs=card.get("model_configs") or [],
                default_model_config_name=card.get("default_model_config_name"),
            ),
        )
        await ctx.ws_hub.send_to(agent_id, envelope)
        # Only the owner (or the owner's own agent) gets this far.
        return _for_viewer(agent.to_response(), agent.registered_by)

    @router.get("/agents/{agent_id}/connection")
    async def get_agent_connection(
        agent_id: str,
        authorization: str = Header(default=""),
    ):
        """Get agent connection info (IP, uptime). Registrant only."""
        current_user = await ctx.auth.get_current_user(authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if agent.registered_by != current_user.id:
            raise HTTPException(403, "Only the agent owner can view connection info")

        info = ctx.ws_hub.get_connection_info(agent_id)
        if info:
            connected_since = info.get("connected_since")
            uptime_seconds = None
            if connected_since:
                try:
                    since_dt = datetime.fromisoformat(connected_since)
                    uptime_seconds = int((datetime.now(UTC) - since_dt).total_seconds())
                except (ValueError, TypeError):
                    pass
            return {
                "connected": True,
                "ip": info.get("ip"),
                "connected_since": connected_since,
                "uptime_seconds": uptime_seconds,
                # Self-reported by the runner in its WS handshake. None when
                # the runner predates version reporting or could not determine
                # its own version. Always None while disconnected — the value
                # lives only in live-connection state and is never persisted.
                "clawmeets_version": info.get("clawmeets_version"),
            }
        return {
            "connected": False,
            "ip": None,
            "connected_since": None,
            "uptime_seconds": None,
            "clawmeets_version": None,
        }

    @router.get("/agents/{agent_id}/recent-activity")
    async def get_agent_recent_activity(
        agent_id: str,
        since: str = QueryParam(...),
        limit: int = QueryParam(800, ge=1, le=2000),
        format: str = QueryParam("text", pattern="^(text|json)$"),
        authorization: str = Header(default=""),
    ):
        """Reflection-shaped view of an agent's recent participation.

        Returns rows from chatrooms the agent participates in, filtered by
        `since` (ISO 8601). Auth: agent's owner.

        format=text → pre-rendered markdown transcript (default).
        format=json → structured rows for programmatic consumers.
        """
        current_user = await ctx.auth.get_current_user(authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if agent.registered_by != current_user.id:
            raise HTTPException(403, "Only the agent owner can view recent activity")

        try:
            since_dt = datetime.fromisoformat(since)
        except ValueError:
            raise HTTPException(400, f"Invalid 'since' (must be ISO 8601): {since!r}")
        if since_dt.tzinfo is None:
            since_dt = since_dt.replace(tzinfo=UTC)

        rows = collect_recent_activity(agent_id, since_dt, ctx.model_ctx)

        if format == "json":
            return {
                "agent_id": agent_id,
                "agent_name": agent.name,
                "since": since_dt.isoformat(),
                "rows": [r.to_dict() for r in rows[:limit]],
                "total": len(rows),
                "truncated": len(rows) > limit,
            }

        # format=text
        agent_short = agent.short_name_for(current_user.username)
        transcript = render_text_transcript(
            rows,
            agent_short_name=agent_short,
            since=since_dt,
            line_limit=limit,
        )
        return {"agent_id": agent_id, "agent_name": agent.name, "transcript": transcript}

    @router.post("/agents/{agent_id}/heartbeat")
    async def agent_heartbeat(agent_id: str, authorization: str = Header(default="")):
        """Update agent heartbeat timestamp."""
        await ctx.auth.check_agent_token(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(500, f"Authenticated agent {agent_id} not found in registry")
        async with _agent_write_lock:
            agent.heartbeat()

    @router.post("/agents/{agent_id}/status")
    async def update_agent_status(
        agent_id: str,
        status: AgentStatus = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Update agent status (online/offline/busy)."""
        await ctx.auth.check_agent_token(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(500, f"Authenticated agent {agent_id} not found in registry")
        async with _agent_write_lock:
            agent.update_status(status)

    @router.put("/agents/{agent_id}/in-flight-turns")
    async def put_in_flight_turns(
        agent_id: str,
        turns: Any = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Rebuild the pending batches of the LLM turns this runner reports.

        The HTTP twin of the WS auth frame's ``in_flight_turns``: a runner
        behind the websocket edge keeps its socket across a core restart, so
        it reports here when RESYNC asks. Agent self-token only — the report
        is the runner's own word about its own turns. Parsed leniently like
        the auth frame (a bad entry is dropped, never a 400) and idempotent
        (``WorkTracker.restore_in_flight`` no-ops on a turn it already has).
        """
        await ctx.auth.check_agent_token(agent_id, authorization)
        restored = await restore_in_flight_turns(
            agent_id, parse_in_flight_turns(turns), ctx
        )
        return {"restored": restored}

    @router.delete("/agents/{agent_id}")
    async def delete_agent(
        agent_id: str,
        authorization: str = Header(default=""),
    ):
        """Delete an agent and all its data.

        Authentication: User JWT only (agent creator).
        """
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        try:
            user = await ctx.auth.get_current_user(authorization)
        except HTTPException:
            raise HTTPException(401, "User JWT token required to delete agents")
        if agent.registered_by != user.id:
            raise HTTPException(403, "Only the agent creator can delete an agent")

        async with _agent_write_lock:
            agent_dir = Agent._get_dir(ctx.model_ctx, agent.name, agent_id)
            if agent_dir.exists():
                # Soft delete: rename with DELETED- prefix so an operator can
                # restore it manually (just rename back). Scans in
                # PersistableParticipant skip DELETED-* dirs, so the agent is
                # invisible to Agent.get / list_all / verify_token and the
                # name becomes available again.
                target = agent_dir.parent / f"{DELETED_DIR_PREFIX}{agent_dir.name}"
                if target.exists():
                    # Extremely unlikely (agent_id is already unique), but keep
                    # the prior tombstone intact and blow away the new one.
                    shutil.rmtree(agent_dir)
                else:
                    agent_dir.rename(target)

        # Fan out to peer runners owned by the same user so they prune the
        # stale peer card before the deleted agent's own WS gets closed. The
        # AGENT_REGISTRY_CHANGE(action="delete") envelope is delivered to
        # every other runner the user owns; recipients hard-delete the local
        # peer dir (sync_from_server is upsert-only and won't clean it up).
        await _fan_out_registry_change(
            changed_agent_id=agent.id,
            changed_agent_name=agent.name,
            owner_user_id=agent.registered_by,
            action="delete",
        )

        # Kick the runner off its WebSocket (if connected) so it reconnects
        # immediately, receives 4004, and self-destructs. No-op when no
        # runner is online — it'll pick up the close on its next reconnect.
        await ctx.ws_hub.close_connection(agent_id)

        logger.info(f"Soft-deleted agent {agent.name} ({agent_id}) by user {user.username}")
        return {"status": "deleted", "agent_id": agent_id, "agent_name": agent.name}

    # ─────────────────────────────────────────────────────────────────────
    # Named model configs (model-selector revamp)
    # ─────────────────────────────────────────────────────────────────────

    async def _emit_model_config_change(agent: Agent, card: dict) -> None:
        await emit_model_config_change(ctx, agent, card)

    async def _mutate_model_configs(agent_id: str, authorization: str, mutate):
        """Authorize, run a card mutation under the write lock, persist
        model_configs + mirrored local_settings, and emit AGENT_SETTINGS_CHANGE.

        ``mutate(card)`` may raise DuplicateConfigError (→409),
        ConfigNotFoundError (→404), or ValueError (→422). Returns
        ``(agent, card, result)``.
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        try:
            async with _agent_write_lock:
                card = agent._load_card()
                result = mutate(card)
                _model_config.apply_mirror(card)
                agent.update_card(
                    model_configs=card.get("model_configs") or [],
                    default_model_config_name=card.get("default_model_config_name"),
                    local_settings=card.get("local_settings") or {},
                )
        except _model_config.DuplicateConfigError as e:
            raise HTTPException(409, str(e))
        except _model_config.ConfigNotFoundError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(422, str(e))

        await _emit_model_config_change(agent, card)
        return agent, card, result

    def _list_response(card: dict) -> ModelConfigList:
        configs, default = _model_config.list_configs(card)
        return ModelConfigList(
            configs=configs,
            default=default,
            routing=_model_config.routing_settings(card),
        )

    @router.get(
        "/agents/{agent_id}/model-configs", response_model=ModelConfigList
    )
    async def list_model_configs(
        agent_id: str,
        authorization: str = Header(default=""),
    ):
        """List an agent's named model configs plus the default (read-only)."""
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        return _list_response(agent._load_card())

    @router.post(
        "/agents/{agent_id}/model-configs",
        response_model=ModelConfig,
        status_code=201,
    )
    async def create_model_config(
        agent_id: str,
        body: ModelConfigCreate = Body(...),
        authorization: str = Header(default=""),
    ):
        """Create a named config (201). 409 on a duplicate name, 422 on a bad
        name/provider."""
        _, _, created = await _mutate_model_configs(
            agent_id,
            authorization,
            lambda card: _model_config.add_config(
                card, body.model_dump(), source="manual"
            ),
        )
        return created

    @router.patch(
        "/agents/{agent_id}/model-configs/{name}", response_model=ModelConfig
    )
    async def update_model_config(
        agent_id: str,
        name: str,
        body: ModelConfigPatch = Body(...),
        authorization: str = Header(default=""),
    ):
        """Partially update a config (rename allowed). 404 unknown, 409 rename
        collision, 422 bad value."""
        patch = body.model_dump(exclude_unset=True)
        _, _, updated = await _mutate_model_configs(
            agent_id,
            authorization,
            lambda card: _model_config.update_config(card, name, patch),
        )
        return updated

    @router.delete(
        "/agents/{agent_id}/model-configs/{name}", status_code=204
    )
    async def delete_model_config(
        agent_id: str,
        name: str,
        authorization: str = Header(default=""),
    ):
        """Delete a config (204, no body). ALWAYS allowed — never 409. Deleting
        the default auto-promotes the first remaining config; deleting the last
        sets ``default=null``. 404 only when the name is absent."""
        await _mutate_model_configs(
            agent_id,
            authorization,
            lambda card: _model_config.remove_config(card, name),
        )
        return None

    @router.put(
        "/agents/{agent_id}/model-configs/default", response_model=ModelConfigList
    )
    async def set_default_model_config(
        agent_id: str,
        body: SetDefaultBody = Body(...),
        authorization: str = Header(default=""),
    ):
        """Set the default config by name (re-mirrors local_settings). 404 on an
        unknown name."""
        _, card, _ = await _mutate_model_configs(
            agent_id,
            authorization,
            lambda card: _model_config.set_default(card, body.name),
        )
        return _list_response(card)

    @router.put(
        "/agents/{agent_id}/model-configs/order", response_model=ModelConfigList
    )
    async def reorder_model_configs(
        agent_id: str,
        body: ModelConfigOrderBody = Body(...),
        authorization: str = Header(default=""),
    ):
        """Persist the config order, which is the smart-routing priority.
        ``names`` must list every config exactly once (422 otherwise)."""
        _, card, _ = await _mutate_model_configs(
            agent_id,
            authorization,
            lambda card: _model_config.reorder_configs(card, body.names),
        )
        return _list_response(card)

    @router.put(
        "/agents/{agent_id}/model-configs/routing", response_model=ModelConfigList
    )
    async def set_smart_routing(
        agent_id: str,
        body: SmartRoutingPatch = Body(...),
        authorization: str = Header(default=""),
    ):
        """Set smart-routing max attempts / cooldown (422 when out of range)."""
        _, card, _ = await _mutate_model_configs(
            agent_id,
            authorization,
            lambda card: _model_config.set_routing_settings(
                card,
                max_attempts=body.max_attempts,
                cooldown_seconds=body.cooldown_seconds,
            ),
        )
        return _list_response(card)

    return router
