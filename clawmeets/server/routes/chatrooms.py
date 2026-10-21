# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/chatrooms.py
Chatroom management routes.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
import uuid
from typing import TYPE_CHECKING, Literal, Optional

import anyio.to_thread
from fastapi import APIRouter, Body, Header, HTTPException, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, TypeAdapter

from clawmeets.api.control import ChangelogUpdatePayload, ControlEnvelope, ControlMessageType
from clawmeets.models.chatroom import Chatroom, RoomFlow
from clawmeets.models.agent import Agent
from clawmeets.models.participant import Participant
from clawmeets.models.project import Project
from clawmeets.server.coordinator_rule import require_own_actor
from clawmeets.server.batch_timeout import resolve_batch_timeout
from clawmeets.server.isolation_gate import check_project_read
from clawmeets.server.routes._batch import (
    BatchRequestError,
    accessible_projects,
    parse_project_ids,
)
from clawmeets.server.routes._mentions import resolve_room_mentions
from clawmeets.sync.changelog import (
    ChangelogEntryType,
    MessagePayload,
    ParticipantAddedPayload,
    ParticipantUpdatedPayload,
    RoomCreatedPayload,
    RoomCreatedParticipant,
)
from clawmeets.utils.file_io import FileUtil

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# The exact serializer FastAPI applies for `response_model=list[Chatroom]`, so a
# per-project payload in the batch response is byte-identical to the body of
# `GET /projects/{pid}/chatrooms` **by construction** rather than by convention.
# Pinned by a test that compares the two HTTP bodies.
_ROOMS_ADAPTER = TypeAdapter(list[Chatroom])


class RoomFlowBody(BaseModel):
    state: Literal["open", "stopped"]
    reason: Optional[str] = Field(default=None, max_length=200)


def _with_held(ctx: "ServerContext", rooms):
    """Fill each room's ``flow.held_count`` from the server's held store."""
    switch = getattr(ctx, "room_flow", None)
    if switch is None:
        return rooms
    return [switch.with_held_count(r) for r in rooms]


def _user_only() -> JSONResponse:
    return JSONResponse(status_code=403, content={"detail": {
        "code": "user_only", "message": "only the project owner's browser login can change a room's flow",
    }})


async def _refuse_blocked_dispatch(
    project: Project, name: str, ctx: "ServerContext"
) -> None:
    """**§7.4's gate, live, at the one moment it can still refuse.** Raise, or
    return.

    The gate is not new and this is not a second copy of it: the rule is
    ``project_plan.execution_blocked`` and both readers call that one function.
    What is new is *where* it is asked. It used to be asked ONLY in the agent
    process, off a state snapshot frozen once before the turn's retry loop, and
    that placement is blind to the exact shape it exists to stop — a coordinator
    that files the blocking notes and emits ``create_room`` inside one turn.
    ``execution_blocked``'s docstring carries the measurement.

    **The timing works because the notes always arrive first**, and that is the
    whole of why the server can answer what the runner could not. Plan notes
    reach the server over HTTP *during* the coordinator's turn (``POST
    …/plan/notes``); the turn's action block is dispatched *after* it. So when
    this POST lands, ``plan.json`` already holds the notes the same turn filed,
    with no changelog round-trip in between and no runloop lock to wait on.

    **A ``403`` rather than a silent drop, and that difference is half the
    repair.** The agent-side refusal is a ``NO_OP`` the model is never told
    about — its own comment concedes *"the exposure is one turn of possible
    over-claiming"* — so a coordinator narrates the room it did not get. A 4xx
    is caught by ``ActionBlockExecutor`` and turned into a self-correcting
    failure note, so the coordinator reads why.

    **Blast radius is the mid-turn window and nothing else.** On an ordinary
    turn the agent-side gate refuses first, so this one only ever fires where
    the gate is currently open. ``invite_participants`` is deliberately NOT
    gated, mirroring ``_check_invite_agent``: a user whose plan is waiting on
    them often wants another agent's opinion in order to decide, and
    ``ensure_consultation_roster`` seats specialists by appending
    ``PARTICIPANT_ADDED`` straight through the runloop rather than through this
    route — so a blocked coordinator keeps its consultation channel either way.

    A project with no ``PLAN.md`` has no plan and no gate (``PlanNotFoundError``
    — every project predating the feature, §3.5). A corrupt sidecar is NOT
    swallowed with it: ``_load`` raises ``PlanCorruptError`` precisely so a
    human looks at the bytes, and treating it as *"no plan"* here would turn the
    one unreadable case into an open gate.
    """
    from clawmeets.models.project_plan import (
        PlanNotFoundError,
        execution_blocked,
        get_plan_sidecar,
        open_notes_for_you,
    )

    try:
        plan = await get_plan_sidecar(project, ctx.model_ctx)
    except PlanNotFoundError:
        return
    blocked = execution_blocked(project.surface, open_notes_for_you(plan))
    if not blocked:
        return
    raise HTTPException(
        403,
        f"create_room `{name}` refused: {blocked} plan note"
        f"{'s are' if blocked != 1 else ' is'} addressed to the user and still "
        f"open, so this project's work is on hold until they decide. The act "
        f"you are waiting on is the one that starts the work. Nothing else is "
        f"blocked — you can still reply, write files, and seat specialists in "
        f"`shared-context` (`clawmeets plan consult`) while the gate is up.",
    )


def resolve_invitee(
    project: Project, ref: str, ctx: "ServerContext", room: Optional[str] = None,
) -> Optional[RoomCreatedParticipant]:
    """A ``name@deployment`` or hub agent id resolves to a retained hub
    agent's stand-in (``RoomBridge.resolve_invitee``: ``not_retained`` [409],
    the allowlist, ``room_flow_stopped`` [409]); None for every other ref,
    which resolves as a local agent. A ref that names a local agent wins."""
    from clawmeets.server.hub.room_bridge import looks_like_hub_ref

    if not looks_like_hub_ref(ref):
        return None
    if Agent.resolve_with_namespace(ref, project, ctx.model_ctx) is not None:
        return None
    runtime = getattr(ctx, "hub_runtime", None)
    if runtime is None:
        raise HTTPException(409, detail={"code": "not_retained", "message": "the hub is off on this server"})
    return runtime.bridge.resolve_invitee(project, ref, room)


def _resolve_invitees(
    project: Project,
    participant_names: list[str],
    ctx: "ServerContext",
    room: Optional[str] = None,
) -> list[RoomCreatedParticipant]:
    """Resolve invite names to participants, enforcing the invitable allowlist.

    The single copy of the allowlist gate: both ``create_chatroom`` (membership
    at room creation) and ``invite_participants`` (membership added later) route
    through here, so the two can never drift apart on who may join a project.

    Resolution uses ``Agent.resolve_with_namespace`` — the same resolver
    ``Chatroom.resolve_mention`` uses for @mentions — which falls back to the
    project-owner's namespace when a literal name lookup misses. That lets the
    coordinator invite owned agents by short name (e.g. ``joyce``), matching how
    the Front Desk allowlist surfaces them in the prompt, while keeping a path
    for fully-qualified registry names (e.g. ``chuswine-joyce``).

    Raises:
        HTTPException: 404 when a name resolves to nothing (the message carries
            the project's real invitable short names, so the coordinator's
            failure note is self-correcting), or 403 when a resolved agent is
            outside the project's invitable allowlist.

    Returns:
        Deduplicated (by participant id, order-preserving) participants, with
        foreign invitees tagged ``external=True``.
    """
    resolved: list[RoomCreatedParticipant] = []
    seen_ids: set[str] = set()
    for participant_name in participant_names:
        stand_in = resolve_invitee(project, participant_name, ctx, room)
        if stand_in is not None:
            if stand_in.id not in seen_ids:
                seen_ids.add(stand_in.id)
                resolved.append(stand_in)
            continue
        agent = Agent.resolve_with_namespace(participant_name, project, ctx.model_ctx)
        participant = agent or Participant.get_by_name(participant_name, ctx.model_ctx)
        if participant is None:
            # Weak coordinators sometimes hallucinate a role-descriptive agent
            # name instead of reading the roster; list the real invitable
            # short-names so the failure note is self-correcting.
            valid = Agent.invitable_short_names_for_project(
                project, ctx.model_ctx,
                exclude_ids=frozenset({project.coordinator_id}),
            )
            hint = f"; valid agents: {', '.join(valid)}" if valid else ""
            raise HTTPException(
                404, f"Participant {participant_name!r} not found{hint}"
            )
        if participant.id in seen_ids:
            continue
        if (
            agent is not None
            and project.created_by
            and agent.registered_by != project.created_by
            and not agent.is_discoverable
        ):
            # Another account's private agent is not invitable, whatever the
            # allowlist says: answer as if it did not exist.
            raise HTTPException(404, f"Participant {participant_name!r} not found")
        seen_ids.add(participant.id)
        resolved.append(RoomCreatedParticipant(id=participant.id, name=participant.name))

    # Hard allowlist enforcement: Project.matches_invitable encapsulates the
    # unified (teams, names) policy.
    if project.enforces_invitable_allowlist:
        violation_hint = (
            "{name!r} is not in this project's invitable allowlist; "
            "expand the project's agent/team filter or add the agent to one of the listed teams"
        )
        for p in resolved:
            if p.id == project.coordinator_id or p.kind == "hub_stand_in":
                continue                  # a stand-in passed its own allowlist check
            invitee = Agent.get(p.id, ctx.model_ctx)
            if invitee is None or not project.matches_invitable(invitee, ctx.model_ctx):
                raise HTTPException(403, violation_hint.format(name=p.name))

    # Mark foreign invitees as `external` so their runner's notifier skips
    # processing this membership. Foreign = registered by a different user than
    # the project owner. Only applies in non-FD projects (an FD project is
    # itself a cross-user channel; further routing is meaningless there).
    if project.surface == "regular" and project.created_by:
        for idx, p in enumerate(resolved):
            if p.id == project.coordinator_id or p.kind == "hub_stand_in":
                continue
            invitee = Agent.get(p.id, ctx.model_ctx)
            if invitee is None or not invitee.registered_by:
                continue
            if invitee.registered_by == project.created_by:
                continue
            resolved[idx] = RoomCreatedParticipant(id=p.id, name=p.name, external=True)

    return resolved


async def _add_to_shared_context(
    ctx: "ServerContext",
    runloop,
    project_id: str,
    chatroom_name: str,
    participants: list[RoomCreatedParticipant],
) -> None:
    """Mirror ``participants`` into the project's ``shared-context`` room.

    Every agent that joins a project room also needs the project-wide files
    (PLAN.md, context files, AGENTS.md) that live in ``shared-context``, so both
    membership paths — room creation and a later invite — mirror there.

    Skipped when ``chatroom_name`` IS ``shared-context`` (nothing to mirror),
    and per-participant idempotent: an existing member is not re-appended.
    A project whose ``shared-context`` doesn't exist yet is a no-op.
    """
    if chatroom_name == "shared-context":
        return
    try:
        shared_context = Chatroom.get(project_id, "shared-context", ctx.model_ctx)
    except ValueError:
        return  # shared-context doesn't exist yet (shouldn't happen)
    if not shared_context:
        return
    existing_members = set(shared_context.participants)
    for p in participants:
        if p.id in existing_members:
            continue
        if p.kind == "hub_stand_in":
            # A retained hub agent sees only messages that address it:
            # never PLAN.md or the project's context files.
            continue
        await runloop.append(
            ChangelogEntryType.PARTICIPANT_ADDED,
            ParticipantAddedPayload(
                chatroom_name="shared-context",
                participant_id=p.id,
                participant_name=p.name,
                external=p.external,
            ),
        )


async def _post_coordinator_message(
    ctx: "ServerContext",
    runloop,
    project: Project,
    room: Chatroom,
    content: str,
    source_version: int | None,
) -> None:
    """Append one coordinator-authored MESSAGE to ``room`` and open its batch.

    Shared by ``create_chatroom``'s ``init_message`` and
    ``invite_participants``' ``message`` — the two ways a coordinator's HTTP
    call speaks into a room it just changed the membership of.

    @mentions are resolved through ``resolve_room_mentions``, which drops
    mentions of agents that aren't participants of ``room``: they can't see the
    message and would keep the batch open forever waiting for a reply that can
    never come.

    A no-op when ``content`` is empty — the caller's membership work has already
    landed and nothing needs saying.
    """
    if not content:
        return

    # Fail fast if the coordinator isn't in the registry — a message with no
    # author is not a recoverable state.
    coordinator = Agent.get(project.coordinator_id, ctx.model_ctx)
    if coordinator is None:
        raise HTTPException(
            500, f"Project coordinator {project.coordinator_id} not found in registry"
        )

    resolved_expects = resolve_room_mentions(room, content, ctx.model_ctx)

    msg_id = str(uuid.uuid4())
    msg_entry = await runloop.append(
        ChangelogEntryType.MESSAGE,
        MessagePayload(
            chatroom_name=room.name,
            id=msg_id,
            ts=datetime.now(UTC),
            from_participant_id=project.coordinator_id,
            from_participant_name=coordinator.name,
            content=content,
            expects_response_from=resolved_expects,
        ),
        source_version=source_version,
    )

    if resolved_expects:
        try:
            await ctx.work_tracker.create_pending_work(
                message_id=msg_id,
                message_version=msg_entry.version,
                project_id=project.id,
                project_name=project.name,
                chatroom_name=room.name,
                coordinator_id=project.coordinator_id,
                expected_participants=resolved_expects,
                timeout_seconds=resolve_batch_timeout(
                    resolved_expects, default=ctx.batch_timeout,
                    model_ctx=ctx.model_ctx,
                ),
            )
        except ValueError:
            logger.warning(f"Pending work already exists for chatroom {room.name}")

    await ctx.ws_hub.broadcast_to_project(
        ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project.id,
                project_name=project.name,
                new_version=msg_entry.version,
                coordinator_id=project.coordinator_id,
            ),
        ),
        project,
    )

    logger.info(
        f"Posted coordinator message to chatroom {room.name}, "
        f"addressed_agents={resolved_expects}"
    )


def create_chatrooms_router(ctx: "ServerContext") -> APIRouter:
    """Create the chatrooms router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["chatrooms"])

    @router.post("/projects/{project_id}/chatrooms", response_model=Chatroom)
    async def create_chatroom(
        project_id: str,
        name: str = Body(..., embed=True),
        participant_names: list[str] = Body(..., embed=True),
        init_message: str = Body(default="", embed=True),
        source_version: int | None = Body(default=None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Create a new chatroom in a project.

        Uses changelog-first architecture: all disk writes happen via ModelContext
        as a ChangelogSubscriber processing the appended entries.

        Addressing in init_message is done via @mentions:
        - "@agent-name" in content -> agent is addressed and should respond
        - "agent-name" (no @) -> reference only, not addressed

        Args:
            project_id: Project ID
            name: Chatroom name
            participant_names: List of agent names to invite
            init_message: Initial message with @mentions to address agents
            authorization: Auth token
        """
        project = Project.get(project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(404, f"Project {project_id!r} not found")

        # Chatroom create requires coordinator (agent) auth. DM-shaped
        # projects don't create chatrooms via this route — _ensure_dm_shaped_project
        # writes ROOM_CREATED directly via the runloop.
        await ctx.auth.check_agent_token(project.coordinator_id, authorization)
        require_own_actor(ctx.model_ctx, project)

        # Idempotent: a create_room for an existing chatroom returns the existing
        # room rather than 409. A coordinator (esp. a weaker model) sometimes
        # re-issues create_room for a room it already made; the first create
        # already appended ROOM_CREATED, posted the init_message, and triggered
        # the invitees, so the duplicate is a safe no-op success rather than a
        # wasted error turn.
        existing = Chatroom.get(project_id, name, ctx.model_ctx)
        if existing is not None:
            return existing
        # Chatroom doesn't exist, proceed with creation

        # Validate the room name at the boundary. It becomes a filesystem dir
        # name deep in changelog processing (Chatroom.create -> validate_fs_name),
        # where a ValueError surfaces as an unhandled 500 that kills the
        # coordinator's turn. A weaker model can emit a malformed name (run-on
        # words > 64 chars, embedded spaces, non-ASCII); reject it here with a 422
        # so the runner's executor turns it into a self-correcting failure note
        # (4xx is caught in ActionBlockExecutor; only 5xx crashes the dispatch).
        try:
            FileUtil.validate_fs_name(name)
        except ValueError as e:
            raise HTTPException(422, f"invalid chatroom name {name!r}: {e}")

        resolved_participants = _resolve_invitees(project, participant_names, ctx)

        # §7.4's execution gate, asked LIVE. **Third, and the precedence is
        # `_check_create_room`'s own** — invitees, then the existing-room
        # no-op (returned above), then the gate — so the server and the agent
        # classify the same call the same way. The gate is last for the reason
        # stated there: if the room already exists nothing new opens, so there
        # is nothing to prevent.
        await _refuse_blocked_dispatch(project, name, ctx)

        resolved_ids = {p.id for p in resolved_participants}

        # Ensure coordinator is included
        if project.coordinator_id not in resolved_ids:
            # Look up coordinator to get name
            coordinator = Participant.get(project.coordinator_id, ctx.model_ctx)
            if coordinator is None:
                raise HTTPException(500, f"Project coordinator {project.coordinator_id} not found")
            resolved_participants.insert(0, RoomCreatedParticipant(id=coordinator.id, name=coordinator.name))

        # Get runloop for this project (reuse for all appends)
        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)

        # Note: FD project + tunnel-binding creation is handled lazily by
        # TunnelSubscriber on the first MESSAGE that mentions a foreign agent.
        # No eager pre-route call is needed here — the `external=True` tagging
        # above is the only chatroom-create-time effect.

        # 1. Append ROOM_CREATED to changelog (ModelContext writes to disk)
        room_entry = await runloop.append(
            ChangelogEntryType.ROOM_CREATED,
            RoomCreatedPayload(
                chatroom_name=name,
                participants=resolved_participants,
            ),
            source_version=source_version,
        )

        # Reload project so the broadcasts below see the newly-added
        # participants in participating_agents. Without this, the in-memory
        # `project` from line 95 is stale and broadcast_to_project excludes
        # the just-invited members — they miss the ROOM_CREATED envelope and
        # any init_message, so their runner never discovers the new room.
        project = Project.get(project_id, ctx.model_ctx)

        # Auto-add new participants to shared-context so they can access
        # project-wide files (PLAN.md, context files, AGENTS.md)
        await _add_to_shared_context(
            ctx, runloop, project_id, name, resolved_participants
        )

        # Broadcast room creation to all project participants
        room_envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=room_entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(room_envelope, project)

        # 2. Post init_message only if provided
        if init_message:
            room = Chatroom.get(project_id, name, ctx.model_ctx)
            await _post_coordinator_message(
                ctx, runloop, project, room, init_message, source_version
            )

        # Return chatroom (reads what ModelContext just wrote)
        room = Chatroom.get(project_id, name, ctx.model_ctx)
        if room is None:
            raise HTTPException(500, f"Chatroom {name!r} creation failed")
        return room

    @router.post(
        "/projects/{project_id}/chatrooms/{chatroom_name}/participants",
        response_model=Chatroom,
    )
    async def invite_participants(
        project_id: str,
        chatroom_name: str,
        participant_names: list[str] = Body(..., embed=True),
        message: str = Body(default="", embed=True),
        source_version: int | None = Body(default=None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Add agents to an EXISTING chatroom, then address them.

        The counterpart to ``create_chatroom`` for a room that is already
        running: without it a coordinator that discovers mid-milestone it needs
        another specialist has to open a parallel room and hand-carry context
        between the two, because an @mention of a non-member is dropped by the
        mention resolver and the room just stalls.

        Coordinator (agent) auth, same as ``create_chatroom`` — the same
        invitable allowlist is the only gate on who may join.

        **And the only gate on this route at all**, which is where it now parts
        company with ``create_chatroom``: that one also asks §7.4's execution
        gate (:func:`_refuse_blocked_dispatch`) and this one deliberately does
        not. The reasoning is ``_check_invite_agent``'s, unchanged — a user
        whose plan is waiting on them often wants another agent's opinion *in
        order to* decide, so the gate stops a new **room**, not new **people**.

        Membership is idempotent: an invitee already in the room is skipped at
        the membership layer, but ``message`` still posts and still addresses
        them, so the same call doubles as "re-engage a member who went quiet".

        **An invitee already active elsewhere in this project joins seeing only
        messages from here forward.** The changelog read filter computes access
        live, so an agent NEW to the project fetches from cursor 0 and receives
        the room's full back-history; one whose cursor is already past those
        versions never re-fetches them. ``message`` is where the context they
        need has to be — that is why this route posts one rather than being a
        bare membership mutation.

        Args:
            project_id: Project ID
            chatroom_name: Name of the existing chatroom to add agents to
            participant_names: Agent names to add (short or fully-qualified)
            message: Message to post after the adds, @mentioning the invitees
                so they are actually triggered. Empty ⇒ membership only.
            source_version: Changelog version this call reacts to
            authorization: Coordinator's agent token
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")

        await ctx.auth.check_agent_token(project.coordinator_id, authorization)
        require_own_actor(ctx.model_ctx, project)

        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            # Name the rooms that DO exist, for the same reason _resolve_invitees
            # lists the valid invitees: the 4xx becomes a self-correcting failure
            # note instead of a dead end.
            existing = ", ".join(sorted(project.chatrooms))
            hint = f"; existing chatrooms: {existing}" if existing else ""
            raise HTTPException(
                404, f"Chatroom {chatroom_name!r} not found in project {project_id!r}{hint}"
            )

        invitees = _resolve_invitees(project, participant_names, ctx, room=chatroom_name)

        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)

        # Only agents not already in the room produce a membership entry. The
        # changelog handler is idempotent anyway, but skipping here keeps the
        # log free of no-op entries and gives the "was anything added?" answer
        # the broadcast below needs.
        added = [p for p in invitees if p.id not in set(room.participants)]
        last_entry = None
        for p in added:
            last_entry = await runloop.append(
                ChangelogEntryType.PARTICIPANT_ADDED,
                ParticipantAddedPayload(
                    chatroom_name=chatroom_name,
                    participant_id=p.id,
                    participant_name=p.name,
                    external=p.external,
                    kind=p.kind,
                    bridge_state=p.bridge_state,
                    inactive_reason=p.inactive_reason,
                    hub=p.hub,
                ),
                source_version=source_version,
            )

        # A stand-in already a member but inactive (unretained, then retained
        # again: resolving it just checked the active retained row) is
        # re-activated, so its bridge relays again.
        rows = room.participant_rows()
        for p in invitees:
            member = rows.get(p.id)
            if p.kind == "hub_stand_in" and member is not None and member.get("bridge_state") != "active":
                last_entry = await runloop.append(
                    ChangelogEntryType.PARTICIPANT_UPDATED,
                    ParticipantUpdatedPayload(
                        chatroom_name=chatroom_name, participant_id=p.id, bridge_state="active",
                    ),
                    source_version=source_version,
                )

        # Mirror into shared-context so a mid-flight invitee can read PLAN.md
        # and the project's context files, exactly as a room-creation invitee can.
        await _add_to_shared_context(ctx, runloop, project_id, chatroom_name, added)

        # Reload so the broadcast (and the message's mention resolution below)
        # see the widened membership — broadcast_to_project keys off
        # project.participating_agents, which PARTICIPANT_ADDED just extended.
        project = Project.get(project_id, ctx.model_ctx)
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)

        if last_entry is not None:
            await ctx.ws_hub.broadcast_to_project(
                ControlEnvelope(
                    type=ControlMessageType.CHANGELOG_UPDATE,
                    payload=ChangelogUpdatePayload(
                        project_id=project_id,
                        project_name=project.name,
                        new_version=last_entry.version,
                        coordinator_id=project.coordinator_id,
                    ),
                ),
                project,
            )
            logger.info(
                f"Added {[p.name for p in added]} to chatroom {chatroom_name} "
                f"in project {project_id}"
            )

        await _post_coordinator_message(
            ctx, runloop, project, room, message, source_version
        )

        return room

    async def _gate_read(project_id: str, authorization: str, x_agent_id: Optional[str]) -> Project:
        """The project, past the isolation gate (``check_project_read``)."""
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        await check_project_read(ctx, project, authorization=authorization, x_agent_id=x_agent_id)
        return project

    @router.get("/projects/{project_id}/chatrooms", response_model=list[Chatroom])
    async def list_chatrooms(
        project_id: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """List all chatrooms in a project."""
        project = await _gate_read(project_id, authorization, x_agent_id)
        return _with_held(ctx, project.list_chatrooms())

    @router.get("/me/chatrooms")
    async def list_chatrooms_batch(
        response: Response,
        project_ids: list[str] = Query(default_factory=list),
        authorization: str = Header(default=""),
    ):
        """List the chatrooms of up to 50 projects in ONE request.

        Replaces the per-project ``GET /projects/{pid}/chatrooms`` fan-out that
        the web client fires on every WebSocket reconnect and page refresh —
        the "thundering herd" this route exists to collapse. A reconnect on the
        Front Desk rail went from 136 requests to 9.

        Shape::

            GET /me/chatrooms?project_ids=<pid>,<pid>,...
            -> 200 {"results": {"<pid>": [Chatroom, ...]},
                    "errors":  {"<pid>": "unavailable" | "internal"}}

        Contract:

        - **Every requested id appears in exactly one of ``results`` or
          ``errors``.** An id in neither is a contract violation the client hard-
          rejects. ``results[pid] == []`` is a *valid* answer meaning "this
          project has no rooms" (8 of 544 projects on the reference box) and is
          deliberately distinguishable from "you may not see this project" —
          which is why there are two maps and not one. Omission-only error
          signalling is prohibited.
        - **Partial success is 200.** One bad id can never fail the batch: the
          per-id body is individually guarded. Note this is stricter than the
          single-project route, where an unknown id is a 500 today (``Project.get``
          raises rather than returning None, so its ``is None`` check is dead).
        - Per-project payloads are byte-identical to the single-project response
          (see ``_ROOMS_ADAPTER``). Nothing here opens ``CHATS.ndjson``.
        - Error codes are the opaque pair ``{unavailable, internal}``.
          ``unavailable`` deliberately collapses unknown / unauthorized /
          corrupt-metadata: a distinct ``forbidden`` would be a project-existence
          oracle, and a batch makes one 50x cheaper to operate.
        - ``Cache-Control: private, max-age=30``. No ETag / 304: with no
          message-derived field in the payload the conditional path saves ~7% at
          scale, and both paths pay the same directory scan.

        Args:
            project_ids: Up to 50 ids, as ``a,b,c`` and/or repeated params.
            authorization: User JWT or the user's assistant token (required).
        """
        # Auth first — this route is authenticated, unlike its single-project
        # neighbours. Accepts a user JWT or the user's `-assistant` bearer;
        # a plain agent bearer is a 401.
        user, acting = await ctx.auth.resolve_credential(authorization)
        # The assistant's bearer is an agent credential: an isolated project its
        # runners cannot run is "unavailable" to it, as in its project list.
        gate = getattr(ctx, "isolation_gate", None)

        try:
            ids = parse_project_ids(project_ids)
        except BatchRequestError as e:
            return JSONResponse(status_code=e.status_code, content=e.body)

        def _resolve_batch() -> tuple[dict, dict]:
            """The whole blocking body, run off the event loop.

            R6: this is ~20 ms of uninterruptible directory scan plus the per-room
            file reads, in a process that also serves WebSocket heartbeats. The
            `os.scandir` pass inside `get_many` is the largest single blocking
            span, so it has to be inside this function, not before it.
            """
            resolved = Project.get_many(ids, ctx.model_ctx)
            allowed = accessible_projects(resolved, user, ctx.model_ctx)
            results: dict[str, list[dict]] = {}
            errors: dict[str, str] = {}
            for pid in ids:
                project = allowed.get(pid)
                if project is None or (
                    acting is not None and gate is not None
                    and not gate.visible_to_agent(acting.id, project)
                ):
                    errors[pid] = "unavailable"
                    continue
                try:
                    results[pid] = _ROOMS_ADAPTER.dump_python(
                        _with_held(ctx, project.list_chatrooms()), mode="json"
                    )
                except Exception:
                    logger.error(
                        f"/me/chatrooms: failed to build payload for project {pid}",
                        exc_info=True,
                    )
                    errors[pid] = "internal"
            return results, errors

        results, errors = await anyio.to_thread.run_sync(_resolve_batch)

        response.headers["Cache-Control"] = "private, max-age=30"
        return {"results": results, "errors": errors}

    @router.get("/projects/{project_id}/chatrooms/{chatroom_name}", response_model=Chatroom)
    async def get_chatroom(
        project_id: str,
        chatroom_name: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """Get chatroom by name."""
        await _gate_read(project_id, authorization, x_agent_id)
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")
        return _with_held(ctx, [room])[0]

    @router.put("/projects/{project_id}/chatrooms/{chatroom_name}/flow", response_model=RoomFlow)
    async def put_chatroom_flow(
        project_id: str,
        chatroom_name: str,
        body: RoomFlowBody,
        authorization: str = Header(default=""),
    ):
        """Stop or reopen the room's inbound flow of outside messages (4.6).

        The project owner's browser login only: any agent token is refused
        ``user_only`` [403] (a steered agent must not reopen a room the owner
        or the monitor stopped); anyone else gets 404."""
        try:
            user = await ctx.auth.get_current_user(authorization)
        except HTTPException:
            token = authorization[7:] if authorization.startswith("Bearer ") else ""
            if token and any(
                Agent.verify_token(a.id, token, ctx.model_ctx)
                for a in Agent.list_all(ctx.model_ctx, discoverable_only=False, include_private=True)
            ):
                return _user_only()
            raise
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, "Chatroom not found") from None
        if project.created_by != user.id or Chatroom.get_in(project, chatroom_name) is None:
            raise HTTPException(404, "Chatroom not found")
        switch = ctx.room_flow
        if switch is None:
            raise HTTPException(503, "room flow is not available on this server")
        if body.state == "stopped":
            return await switch.stop(project_id, chatroom_name, by="owner", reason=body.reason)
        return await switch.reopen(project_id, chatroom_name, by_user=user)

    @router.get("/projects/{project_id}/user-communication-chatroom")
    async def get_user_communication_chatroom(
        project_id: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """Get the user-communication chatroom for a project."""
        project = await _gate_read(project_id, authorization, x_agent_id)

        room = project.get_user_communication_room()
        if room is None:
            raise HTTPException(404, "No user-communication chatroom found")
        return room

    @router.get("/projects/{project_id}/shared-context-chatroom")
    async def get_shared_context_chatroom(
        project_id: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """Get the shared-context chatroom for a project."""
        project = await _gate_read(project_id, authorization, x_agent_id)

        room = project.get_shared_context_room()
        if room is None:
            raise HTTPException(404, "No shared-context chatroom found")
        return room

    return router
