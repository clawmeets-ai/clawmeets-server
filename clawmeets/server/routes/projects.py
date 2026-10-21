# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/projects.py
Project management routes.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import uuid

import anyio.to_thread
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, BackgroundTasks, Body, Header, HTTPException, Request, Response

from clawmeets.api.control import (
    AgentSettingsChangePayload,
    ChangelogUpdatePayload,
    ControlEnvelope,
    ControlMessageType,
    ProjectDeletedPayload,
)
from clawmeets.api.responses import ParticipantProjectResponse
from clawmeets.models.agent import Agent
from clawmeets.models.participant import Participant, ParticipantRole
from clawmeets.models.project import (
    Project,
    ProjectStatus,
    counterpart_of,
    is_untrusted_source,
    normalize_thread_display_name,
    scope_key,
)
from clawmeets.server.channels.hub_store import HubStore
from clawmeets.server.isolation_gate import check_project_read
from clawmeets.server.hub.views import bridge_project_ids, project_hub_target
from clawmeets.models.project_plan import (
    SEED_TEMPLATE,
    create_plan,
    publish_plan_state,
    seed_go_note,
)
from clawmeets.models.share_token import revoke_all_for_project, viewer_project_ids
from clawmeets.server.desk_todo_notify import (
    MIRROR_ERROR_HEADER,
    MIRRORED_HEADER,
    mirror_plate_to_spawned_project,
    notify_plate_of_project_change,
)
from clawmeets.server.routes._batch import can_complete_project, can_rename_project
from clawmeets.server.routes.project_plans import plan_summary_for
from clawmeets.sync.changelog import (
    ChangelogEntryType,
    DisplayNameChangedPayload,
    read_tip_version,
    ProjectAllowlistUpdatedPayload,
    ProjectCreatedPayload,
    ProjectCompletedPayload,
    RoomCreatedPayload,
    RoomCreatedParticipant,
    RoomDeletedPayload,
)
from clawmeets.models.user import User
from clawmeets.utils.email import queue_notification
from clawmeets.server.email import APP_BASE_URL, ClawMeetsEmailMessage
from clawmeets.server.notification_assets import (
    gather_project_response_attachments,
    report_url_if_available,
)
from clawmeets.utils.file_io import FileUtil

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


def _mirror_reason(exc: Exception) -> str:
    """A mirror failure, squeezed into something an HTTP header may carry.

    Three constraints, all of them hard rather than tidy: a header value must
    be ONE LINE (a newline would split the response), must be latin-1
    encodable (starlette encodes it and raises otherwise — a sanitizer that
    raised here would turn a swallowed miss into a failed create, which is the
    one thing this path must never do), and must be short enough not to trip a
    proxy's header cap.

    The exception TYPE leads, because the message is the part most likely to be
    empty or to be someone else's prose.
    """
    detail = " ".join(str(exc).split())[:160]
    label = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
    return label.encode("ascii", "replace").decode("ascii")


def _pressed_own_done(completed_by: "User | None", project: Project) -> bool:
    """Whether the completion's own author is the person it would be mailed to.

    The "X is complete" email goes to ``project.created_by`` and exists to
    reach someone who is NOT in the app. That makes it worth sending in
    exactly one case — the recipient does not already know — and the recipient
    knows precisely when they are the one who caused it. ``completed_by`` is
    ``None`` for the coordinator agent finishing autonomously, which is the
    case the mail was written for.

    THE RULE IS "RECIPIENT IS THE ACTOR", not "the caller was a human", and
    the difference is not hypothetical. ``can_complete_project`` admits a
    person who is not the owner: a **front-desk requester** — on a
    ``frontdesk`` thread ``created_by`` is the HOST while the requester is
    somebody else entirely, so their press is news to the host and still
    mails. Gating on "an agent did it" would have swallowed that.

    Args:
        completed_by: The authenticated user who completed it, or ``None`` when
            the project's own coordinator agent did.
        project: The project being completed.

    Returns:
        True if the email would only tell its recipient about their own click.
    """
    return completed_by is not None and completed_by.id == project.created_by


def generate_plan_file(
    project_name: str,
    project_request: str,
    plan_body: str | None = None,
) -> str:
    """The document a new project starts with (D18, §5.1, B2).

    Two cases and no third: **the coordinator's v1, or the seed template.**
    ``plan_body`` is the optional passthrough a caller supplies when it already
    knows what the plan should say; with none, the template is what the file
    contains. There is no ``plan_mode`` — the project *shape* is the
    discriminator and it already ships (§3.5).

    **The template is ``project_plan.SEED_TEMPLATE`` and not a second copy of
    it.** §5.1's sections — Goal, Not Authorized, Acceptance Criteria,
    Milestones, M1 — are
    pinned byte-for-byte against ``tests/fixtures/plan_documents.json``, and a
    template that lived in two files would be pinned in one of them.

    **A supplied ``plan_body`` is now taken exactly as given.** It used to have
    ``## Approval`` appended when it carried none, because the confirm note was
    a proposal against that section and a proposal is located by heading — a
    body without it left the project gated from its first turn with nothing to
    ungate it. That note carries no diff and names no section now
    (``project_plan.GO_NOTE_COMMENT``), so there is nothing for the server to
    append and a caller's document reaches disk unedited.

    **Two sections this no longer emits.** ``## Current Status`` and
    ``## Learnings`` are gone (N4): status belongs to the project record and
    learnings to reflection, and both were annotations on a document whose whole
    contract is *"plain Markdown a human wrote"*. Documents that already carry
    them keep them and are **never rewritten** —
    ``scripts/migrate_rerun_to_sops.py`` still reads ``## Learnings`` out of
    PLAN.md files that exist, and that reader is history and stays.

    ``project_request`` is no longer interpolated. It was a truncated first
    sentence of the request, and the request itself is on the project record and
    in the opening message — the plan is where someone writes what is being
    built, not where the server guesses.

    Args:
        project_name: Human-readable project name, the template's ``<title>``
        project_request: The user's request. Kept for signature compatibility.
        plan_body: A coordinator-supplied v1. When given, it IS the file.

    Returns:
        PLAN.md content string
    """
    if plan_body:
        return plan_body
    return SEED_TEMPLATE.format(title=project_name)


async def init_plan_sidecar(
    project: Project,
    ctx: "ServerContext",
    *,
    plan_body: str | None = None,
) -> None:
    """Write ``PLAN.md`` and its sidecar at ``POST /projects``, in-process (D18).

    **This replaces a raw ``FilePayload`` that carried no author.** The seed used
    to be appended inline with no ``from_participant_id`` /
    ``from_participant_name``, which is why ``plan_revisions`` shows an empty
    proposer on the seed row of every project that exists. Going through
    ``create_plan`` attributes it to the coordinator — the keeper — like every
    other write, and makes ``POST /projects`` the third caller of the one funnel
    rather than a fourth writer nobody listed (AC-2.8).

    Creating the sidecar here is also **the whole migration story**: a project
    created from now on has one, a pre-feature project does not, and *"has a
    sidecar"* is what distinguishes a seeded plan from a plan a human wrote by
    hand (§3.5 property 3). Phase 7 stamps ``plan_seeded_at`` beside it; until
    then the sidecar's presence is that field.

    Best-effort: a project must exist even if its plan does not get written, so a
    failure here is logged and does not fail ``POST /projects``. The plan routes
    all tolerate a missing document — that is the pre-feature case they already
    answer.

    **Best-effort has a consequence here it did not used to have**: a project
    whose seed fails has no go-note, so it is *unblocked* as well as planless.
    That is the same answer a pre-feature project gets and it is the right
    direction to fail in — a project that cannot be worked on at all is worse
    than one that starts without a gate — but it is a change in what the failure
    costs, so it is written down rather than left to be discovered.
    """
    runloop = await ctx.runloop_manager.get_or_create(project.id, project.name)
    body = generate_plan_file(
        project.display_name or project.name, project.request, plan_body
    )
    try:
        await create_plan(
            project,
            ctx.model_ctx,
            runloop,
            body=body,
            by=project.coordinator_name,
            seeded=True,
        )
        # **THE GO-NOTE, AND IT IS SEEDED BEFORE THE PROJECTION.** The order is
        # the whole correctness argument, in the same shape `submit_review`'s
        # prelude uses.
        #
        # `publish_plan_state` is the only channel that carries the note count
        # to a runner, and the runner primes its gate memo off the FIRST
        # `PROJECT_PLAN_STATE` it sees (`Agent.on_plan_gate_prime`). Seed the
        # note after the publish and that memo records "not blocked" at
        # creation — and then a user accepting through `POST
        # /plan/notes/{id}/resolve`, which posts no message at all, closes the
        # note with nothing left on any surface to wake the coordinator. A
        # brand-new project would stall permanently and silently. Note first,
        # publish second, and one projection carries both facts.
        #
        # It is also why the gate is server-enforced rather than asked of the
        # coordinator: the block exists before the coordinator has taken a
        # single turn.
        await seed_go_note(project, ctx.model_ctx)
        # `seeded=True` above is what stamps `plan_seeded_at`, and this fans it
        # (plus the open-note count the line above just made 1) onto the
        # changelog so every runner's `Project.phase` reads `spec-ing` and its
        # execution gate reads "blocked" from its own meta.json. **This call is
        # the whole of the migration story**: a project created from now on has
        # the stamp, a project that predates the feature never gets one and
        # therefore reads `executing`, and nothing is backfilled or scanned.
        await publish_plan_state(project, ctx.model_ctx, runloop)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            f"Could not seed PLAN.md for project {project.id[:8]}: "
            f"{type(e).__name__}: {e}"
        )


def account_requester_key(user_id: str) -> str:
    """``requester_key`` of a conversation that serves a same-server user."""
    return f"account:{user_id}"


def project_requester_key(project_id: str) -> str:
    """``requester_key`` of a host project whose requester is unknown: it is
    isolated alone (its turns see only itself)."""
    return f"project:{project_id}"


async def _ensure_dm_shaped_project(
    ctx: "ServerContext",
    requester_name_prefix: str,
    agent_full_name: str,
    requester_owner_id: str,
    separator: str,
    request_label: str,
    name_suffix: Optional[str] = None,
    display_name: Optional[str] = None,
) -> Project:
    """Idempotent get-or-create of a DM-shaped project for (requester, target agent).

    ``separator`` distinguishes the two callers: ``"fd"`` for cross-user FD
    tunnels (the responder is owned by a different user; the project mirrors
    a local room via TunnelBinding), ``"dm"`` for own-user direct messages
    (same user owns both ends; no tunneling). Project name:
    ``{requester_name_prefix}-{separator}-{agent_short_name}``.

    ``display_name`` (optional) is the row's label. These threads are durable
    CHANNELS, not per-topic conversations: one per (requester, agent) forever,
    resolved by name, carrying whatever the reflection cron, ``dm send``, voice
    and the desk clock put in them. So a caller seeds a fixed purpose label
    ("Direct messages", "Scheduled messages") instead of the ``"New chat"``
    placeholder the per-conversation creators use. Two things follow: the row
    never renders the frontend's literal "New chat" fallback, and the DM
    auto-titler — latched on that exact placeholder — stays off, so a
    ``<!-- clawmeets:*-trigger -->`` marker can never become the title. Left
    ``None``, the label is unset (the front-desk ends, which re-title through
    the reverse tunnel mirror).

    ``name_suffix`` (optional) appends ``-{name_suffix}`` to the project name,
    so a caller can mint a deterministic, dedicated *sibling* of the plain DM
    project (e.g. ``-schedule`` for recurring messages). It is durable by name
    — the get-or-create name-scan below reuses it across restarts.

    Returns the existing project with this name if present; otherwise creates
    it (PROJECT_CREATED + ROOM_CREATED for ``user-communication``) and
    broadcasts the changelog update. DM-shaped projects deliberately omit
    ``shared-context`` — the DM prompt variant drops PLAN.md / cross-room
    framing, so nothing reads it.

    Auth gate: private agents (``not is_discoverable``) are only addressable
    by their owner.
    """
    agent = Agent.get_by_name(agent_full_name, ctx.model_ctx)
    if agent is None:
        raise HTTPException(404, f"Agent {agent_full_name!r} not found")
    if not agent.registered_by:
        raise HTTPException(400, f"Agent {agent_full_name!r} has no owner")
    owner = User.get(agent.registered_by, ctx.model_ctx)
    if owner is None:
        raise HTTPException(404, f"Agent owner not found")
    if not agent.is_discoverable and requester_owner_id != owner.id:
        raise HTTPException(404, f"Agent {agent_full_name!r} not found")

    prefix = f"{owner.username}-"
    if not agent.name.startswith(prefix):
        raise HTTPException(
            500,
            f"Agent name {agent.name!r} does not match owner prefix {prefix!r}",
        )
    agent_short_name = agent.name[len(prefix):]
    project_name = f"{requester_name_prefix}-{separator}-{agent_short_name}"
    if name_suffix:
        project_name = f"{project_name}-{name_suffix}"

    for existing in Project.list_all(ctx.model_ctx):
        if existing.name == project_name:
            return existing

    project_id = str(uuid.uuid4())
    runloop = await ctx.runloop_manager.get_or_create(project_id, project_name)

    # Own-DM is a 1:1 channel — the assistant must not invite anyone else.
    # FD-DM keeps "owned" so the foreign coordinator may delegate to its
    # own owner's peers.
    agent_pool = "self" if separator == "dm" else "owned"
    # Same normalization a typed rename goes through, so a seeded label cannot
    # be a shape the rename route would have rejected.
    seeded_display_name = (
        normalize_thread_display_name(display_name) if display_name else None
    )
    await runloop.append(
        ChangelogEntryType.PROJECT_CREATED,
        ProjectCreatedPayload(
            project_id=project_id,
            project_name=project_name,
            coordinator_id=agent.id,
            coordinator_name=agent.name,
            request=request_label,
            created_by=owner.id,
            agent_pool=agent_pool,
            # Seed the per-project allowlist from the responder agent's
            # defaults. Editing the defaults afterward does NOT rewrite
            # this project — the per-project lists below are the source
            # of truth for the coordinator's invitable filter from now on.
            agent_names=list(agent.default_invitable_agents),
            agent_teams=list(agent.default_invitable_teams),
            surface="dm",
            display_name=seeded_display_name,
            # A Front Desk channel serves someone other than the owner: its
            # turns are requester-scoped (plan-agent-access 4.3).
            requester_key=account_requester_key(requester_owner_id) if separator == "fd" else None,
        ),
    )
    room_entry = await runloop.append(
        ChangelogEntryType.ROOM_CREATED,
        RoomCreatedPayload(
            chatroom_name="user-communication",
            participants=[RoomCreatedParticipant(id=agent.id, name=agent.name)],
        ),
    )

    project = Project.get(project_id, ctx.model_ctx)
    if project is None:
        raise HTTPException(500, f"Project {project_id!r} creation failed")

    envelope = ControlEnvelope(
        type=ControlMessageType.CHANGELOG_UPDATE,
        payload=ChangelogUpdatePayload(
            project_id=project_id,
            project_name=project_name,
            new_version=room_entry.version,
            coordinator_id=agent.id,
        ),
    )
    await ctx.ws_hub.broadcast_to_project(envelope, project)
    return project


async def _ensure_fd_project_for_user(
    ctx: "ServerContext",
    requester: User,
    agent_full_name: str,
) -> Project:
    """Wrapper for the user-as-requester FD ensure path.

    Project name: ``{user.username}-fd-{agent_short}``.
    """
    return await _ensure_dm_shaped_project(
        ctx,
        requester_name_prefix=requester.username,
        agent_full_name=agent_full_name,
        requester_owner_id=requester.id,
        separator="fd",
        request_label="Front Desk channel",
    )


async def _ensure_fd_project_for_agent(
    ctx: "ServerContext",
    requester_agent: Agent,
    agent_full_name: str,
) -> Project:
    """Wrapper for agent-as-requester FD ensure (cross-agent delegation).

    Project name: ``{requester_agent.name}-fd-{responder_agent_short}`` —
    where ``requester_agent.name`` is the requester's full registry name
    (owner_username-short_name).
    """
    if not requester_agent.registered_by:
        raise HTTPException(400, "Requester agent has no owner")
    return await _ensure_dm_shaped_project(
        ctx,
        requester_name_prefix=requester_agent.name,
        agent_full_name=agent_full_name,
        requester_owner_id=requester_agent.registered_by,
        separator="fd",
        request_label="Front Desk channel",
    )


async def _ensure_own_dm_project(
    ctx: "ServerContext",
    user: User,
    agent_full_name: str,
) -> Project:
    """Wrapper for own-user direct message ensure path.

    Project name: ``{user.username}-dm-{agent_short}``. The single
    ``user-communication`` chatroom IS the DM thread; there are no
    ``dm-*`` sub-chatrooms here. Coordinator is the DM partner agent
    itself.
    """
    agent = Agent.get_by_name(agent_full_name, ctx.model_ctx)
    if agent is None:
        raise HTTPException(404, f"Agent {agent_full_name!r} not found")
    if agent.registered_by != user.id:
        raise HTTPException(
            403,
            f"Agent {agent_full_name!r} is not owned by you; "
            f"use the front-desk path for foreign agents",
        )
    return await _ensure_dm_shaped_project(
        ctx,
        requester_name_prefix=user.username,
        agent_full_name=agent_full_name,
        requester_owner_id=user.id,
        separator="dm",
        request_label="Direct message",
        display_name="Direct messages",
    )


async def _ensure_schedule_dm_thread(
    ctx: "ServerContext",
    user: User,
    agent_full_name: str,
) -> Project:
    """Idempotent get-or-create of the caller's dedicated *schedule* DM thread.

    Project name: ``{user.username}-dm-{agent_short}-schedule`` — a durable,
    deterministic sibling of the plain own-DM project, dedicated to recurring
    (cron) messages so they don't interleave with the live conversation.
    Because it is resolved by name via ``Project.list_all`` (not the in-memory
    thread-key cache, which is non-cross-restart), it survives server restarts,
    so a re-scheduled fire always lands in the SAME thread ("create if not
    exist"). Own-agent only, mirroring ``_ensure_own_dm_project``'s gate.
    """
    agent = Agent.get_by_name(agent_full_name, ctx.model_ctx)
    if agent is None:
        raise HTTPException(404, f"Agent {agent_full_name!r} not found")
    if agent.registered_by != user.id:
        raise HTTPException(
            403,
            f"Agent {agent_full_name!r} is not owned by you; "
            f"scheduled DM threads are supported for your own agents only",
        )
    return await _ensure_dm_shaped_project(
        ctx,
        requester_name_prefix=user.username,
        agent_full_name=agent_full_name,
        requester_owner_id=user.id,
        separator="dm",
        request_label="Scheduled messages",
        name_suffix="schedule",
        display_name="Scheduled messages",
    )


async def _create_own_dm_thread_project(
    ctx: "ServerContext",
    user: User,
    agent_full_name: str,
) -> Project:
    """Create a BRAND-NEW own-user DM-thread project (ChatGPT/Claude model).

    Unlike ``_ensure_own_dm_project`` (idempotent get-or-create of ONE project
    per agent), this mints a fresh ``surface="dm"`` project on every call —
    N threads per agent. The project carries ``display_name="New chat"`` (the
    placeholder until the runloop auto-titles after the first exchange) and a
    unique slug (so N same-agent threads never collide on the ``{name}-{id}``
    directory). Stable thread identity is the project ``id`` (UUID); the slug is
    display-adjacent only.

    The single ``user-communication`` chatroom IS the thread; the frontend
    sends the first message into it separately (via the user-message route)
    right after this create resolves — that first send is what materializes the
    conversation. No message is appended here.

    Auth: the agent must be owned by ``user`` (own-DM only). Foreign agents keep
    the idempotent ``/me/fd/{agent}/ensure`` path.
    """
    agent = Agent.get_by_name(agent_full_name, ctx.model_ctx)
    if agent is None:
        raise HTTPException(404, f"Agent {agent_full_name!r} not found")
    if agent.registered_by != user.id:
        raise HTTPException(
            403,
            f"Agent {agent_full_name!r} is not owned by you; "
            f"use the front-desk path for foreign agents",
        )

    prefix = f"{user.username}-"
    if not agent.name.startswith(prefix):
        raise HTTPException(
            500,
            f"Agent name {agent.name!r} does not match owner prefix {prefix!r}",
        )
    agent_short_name = agent.name[len(prefix):]

    project_id = str(uuid.uuid4())
    # Unique slug: N threads per agent must not collide on the {name}-{id} dir.
    # The short id suffix disambiguates; identity is the UUID, not the slug.
    project_name = f"{user.username}-dm-{agent_short_name}-{uuid.uuid4().hex[:8]}"

    runloop = await ctx.runloop_manager.get_or_create(project_id, project_name)
    await runloop.append(
        ChangelogEntryType.PROJECT_CREATED,
        ProjectCreatedPayload(
            project_id=project_id,
            project_name=project_name,
            coordinator_id=agent.id,
            coordinator_name=agent.name,
            request="Direct message",
            created_by=user.id,
            # Own-DM is a 1:1 channel — the agent must not invite anyone else.
            agent_pool="self",
            agent_names=list(agent.default_invitable_agents),
            agent_teams=list(agent.default_invitable_teams),
            surface="dm",
            display_name="New chat",
        ),
    )
    room_entry = await runloop.append(
        ChangelogEntryType.ROOM_CREATED,
        RoomCreatedPayload(
            chatroom_name="user-communication",
            participants=[RoomCreatedParticipant(id=agent.id, name=agent.name)],
        ),
    )

    project = Project.get(project_id, ctx.model_ctx)
    if project is None:
        raise HTTPException(500, f"Project {project_id!r} creation failed")

    envelope = ControlEnvelope(
        type=ControlMessageType.CHANGELOG_UPDATE,
        payload=ChangelogUpdatePayload(
            project_id=project_id,
            project_name=project_name,
            new_version=room_entry.version,
            coordinator_id=agent.id,
        ),
    )
    await ctx.ws_hub.broadcast_to_project(envelope, project)
    return project


async def _create_fd_host_project(
    ctx: "ServerContext",
    foreign_agent: Agent,
    requester_label: str,
    sender_project_id: str | None = None,
    requester_user_id: str | None = None,
) -> Project:
    """Create a FRESH host-side Front Desk project for a cross-account thread.

    This is the responder end of the split two-project model (DD1/DD2). Unlike
    the legacy name-keyed ``_ensure_fd_project_for_user`` (get-or-create ONE
    shared row per requester+agent), this mints a **distinct** project on every
    call (fresh UUID + unique slug) — idempotency now lives entirely in the
    ``TunnelBinding`` lookup keyed on ``local_project_id`` (see
    ``ensure_fd_routing_for_foreign_agents``), so two different local projects
    reaching the same foreign agent get two distinct host threads (fixes the
    N->1 collapse, defect ①).

    Shape:
      * ``surface = "frontdesk"`` (host end);
      * ``created_by`` = the foreign agent's OWNER (the host);
      * ``coordinator`` = the foreign agent as a REAL participant (its runloop
        runs here and answers);
      * ``agent_pool = "owned"`` (the foreign coordinator may delegate to its
        owner's peers to build its FD workspace);
      * ``display_name = "New chat"`` so the host runloop auto-titles it.

    Slug shape ``{requester}-fd-{agent_short}-{suffix}`` (opaque identity is the
    project UUID) — the ``-fd-`` marker is a harmless transition convenience;
    the authoritative discriminator is now ``surface`` + coordinator ownership,
    not the name. ``suffix`` is the requester's originating (sender) project id
    when supplied — so an agent-initiated thread reads as
    ``{agent}-fd-{short}-{sender_project_id}`` and is legible per-conversation —
    else a random ``hex8`` (the direct-user path). The binding, not the name,
    is the idempotency key either way.
    """
    if not foreign_agent.registered_by:
        raise HTTPException(400, f"Agent {foreign_agent.name!r} has no owner")
    if not foreign_agent.is_discoverable:
        # A private agent is addressable by its owner only; a host thread is
        # by definition for someone else, so it is never minted for one.
        raise HTTPException(404, f"Agent {foreign_agent.name!r} not found")
    owner = User.get(foreign_agent.registered_by, ctx.model_ctx)
    if owner is None:
        raise HTTPException(404, "Agent owner not found")

    prefix = f"{owner.username}-"
    if not foreign_agent.name.startswith(prefix):
        raise HTTPException(
            500,
            f"Agent name {foreign_agent.name!r} does not match owner prefix {prefix!r}",
        )
    agent_short_name = foreign_agent.name[len(prefix):]

    project_id = str(uuid.uuid4())
    # Unique slug: N host threads per (requester, agent) must not collide on the
    # {name}-{id} dir. Identity is the UUID, not the slug (and the TunnelBinding is
    # the authoritative dedup key), so the slug is purely cosmetic. When the
    # requester's sender project id is known, key the slug by its first 8 hex chars
    # (one legible host thread per sender conversation); otherwise a random hex8.
    # NB: never embed the FULL 36-char UUID — with a real foreign short-name it
    # pushes {requester}-fd-{short}-{uuid} past MAX_FS_NAME_LENGTH and
    # ProjectState.create raises before the project/binding exist (silent
    # routing failure — see _fd_routing's swallow).
    slug_suffix = (
        sender_project_id.replace("-", "")[:8]
        if sender_project_id
        else uuid.uuid4().hex[:8]
    )
    project_name = f"{requester_label}-fd-{agent_short_name}-{slug_suffix}"
    # Defensive clamp: requester_label is a user/agent name of unbounded length;
    # identity is the UUID, so truncating the cosmetic slug is safe.
    project_name = project_name[: FileUtil.MAX_FS_NAME_LENGTH]

    runloop = await ctx.runloop_manager.get_or_create(project_id, project_name)
    await runloop.append(
        ChangelogEntryType.PROJECT_CREATED,
        ProjectCreatedPayload(
            project_id=project_id,
            project_name=project_name,
            coordinator_id=foreign_agent.id,
            coordinator_name=foreign_agent.name,
            request="Front Desk channel",
            created_by=owner.id,
            agent_pool="owned",
            agent_names=list(foreign_agent.default_invitable_agents),
            agent_teams=list(foreign_agent.default_invitable_teams),
            surface="frontdesk",
            display_name="New chat",
            # The host thread serves the requester (a person: a requesting
            # agent counts as its owner). Without a known requester the
            # project is isolated on its own.
            requester_key=(
                account_requester_key(requester_user_id) if requester_user_id
                else project_requester_key(project_id)
            ),
        ),
    )
    room_entry = await runloop.append(
        ChangelogEntryType.ROOM_CREATED,
        RoomCreatedPayload(
            chatroom_name="user-communication",
            participants=[
                RoomCreatedParticipant(id=foreign_agent.id, name=foreign_agent.name)
            ],
        ),
    )

    project = Project.get(project_id, ctx.model_ctx)
    if project is None:
        raise HTTPException(500, f"Project {project_id!r} creation failed")

    envelope = ControlEnvelope(
        type=ControlMessageType.CHANGELOG_UPDATE,
        payload=ChangelogUpdatePayload(
            project_id=project_id,
            project_name=project_name,
            new_version=room_entry.version,
            coordinator_id=foreign_agent.id,
        ),
    )
    await ctx.ws_hub.broadcast_to_project(envelope, project)
    return project


async def _create_front_desk_requester_thread(
    ctx: "ServerContext",
    requester: User,
    agent_full_name: str,
) -> Project:
    """Create a BRAND-NEW requester-side Front Desk thread (path A, DD1).

    Mirror of ``_create_own_dm_thread_project`` but for a FOREIGN agent: each
    call mints a fresh ``surface="frontdesk"`` project owned by the REQUESTER,
    with the foreign agent as coordinator added ``external=true`` to the sole
    ``user-communication`` room. Because it is ``external``, the foreign agent's
    runner skips processing this project (``participant_notifier._is_external_in``)
    — so the host never double-answers on the local end; the tunnel carries the
    message to the host end where the agent actually runs.

    ``display_name = "New chat"`` (the local row re-titles via the reverse tunnel
    mirror once the host composes the title — DD-title). N-per-agent: a fresh
    thread every call; follow-ups reuse the returned project.

    Auth gate (inverse of ``_create_own_dm_thread_project``'s own-agent gate):
      * agent owned by the requester -> 403 (use ``/me/dms/{agent}/threads``);
      * private agent not owned by the requester -> 404 (discoverability).
    """
    agent = Agent.get_by_name(agent_full_name, ctx.model_ctx)
    if agent is None:
        raise HTTPException(404, f"Agent {agent_full_name!r} not found")
    if not agent.registered_by:
        raise HTTPException(400, f"Agent {agent_full_name!r} has no owner")
    if agent.registered_by == requester.id:
        raise HTTPException(
            403,
            f"Agent {agent_full_name!r} is your own; "
            f"use /me/dms/{{agent}}/threads for owned DMs",
        )
    if not agent.is_discoverable:
        # Private foreign agent — not addressable by non-owners (discoverability).
        raise HTTPException(404, f"Agent {agent_full_name!r} not found")

    owner = User.get(agent.registered_by, ctx.model_ctx)
    if owner is None:
        raise HTTPException(404, "Agent owner not found")
    prefix = f"{owner.username}-"
    if not agent.name.startswith(prefix):
        raise HTTPException(
            500,
            f"Agent name {agent.name!r} does not match owner prefix {prefix!r}",
        )
    agent_short_name = agent.name[len(prefix):]

    project_id = str(uuid.uuid4())
    project_name = f"{requester.username}-fd-{agent_short_name}-{uuid.uuid4().hex[:8]}"

    runloop = await ctx.runloop_manager.get_or_create(project_id, project_name)
    await runloop.append(
        ChangelogEntryType.PROJECT_CREATED,
        ProjectCreatedPayload(
            project_id=project_id,
            project_name=project_name,
            # The own-coordinator rule (plan-owner-isolation section 4): the
            # requester coordinates their own end; the foreign agent is its
            # counterpart, still an external room member reached by the tunnel.
            coordinator_id=requester.id,
            coordinator_name=requester.username,
            counterpart_id=agent.id,
            counterpart_name=agent.name,
            request="Direct message",
            created_by=requester.id,
            # 1:1 on the local end — the foreign ghost never runs here, and the
            # requester's own assistant is not a participant.
            agent_pool="self",
            agent_names=list(agent.default_invitable_agents),
            agent_teams=list(agent.default_invitable_teams),
            surface="frontdesk",
            display_name="New chat",
        ),
    )
    room_entry = await runloop.append(
        ChangelogEntryType.ROOM_CREATED,
        RoomCreatedPayload(
            chatroom_name="user-communication",
            participants=[
                # external=true: the foreign agent is a ghost on the local end;
                # its runner skips this membership (delivery is via the tunnel).
                RoomCreatedParticipant(id=agent.id, name=agent.name, external=True)
            ],
        ),
    )

    project = Project.get(project_id, ctx.model_ctx)
    if project is None:
        raise HTTPException(500, f"Project {project_id!r} creation failed")

    envelope = ControlEnvelope(
        type=ControlMessageType.CHANGELOG_UPDATE,
        payload=ChangelogUpdatePayload(
            project_id=project_id,
            project_name=project_name,
            new_version=room_entry.version,
            coordinator_id=agent.id,
        ),
    )
    await ctx.ws_hub.broadcast_to_project(envelope, project)
    return project


def create_projects_router(ctx: "ServerContext") -> APIRouter:
    """Create the projects router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["projects"])

    # Idempotency guard for create-on-first-send DM threads (rev-4 Q3). Maps
    # (user_id, client_thread_key) -> the project id that key already minted, so
    # a rapid double-send / retry of the SAME send returns the one thread rather
    # than racing two creates. Distinct sends intentionally make distinct threads
    # (N-per-agent), so only retries carrying the same token dedupe. In-memory is
    # sufficient: the race window is a sub-second double-submit, not cross-restart.
    _dm_thread_keys: dict[tuple[str, str], str] = {}
    _dm_thread_lock = asyncio.Lock()

    @router.post("/projects", response_model=Project)
    async def create_project(
        name: str = Body(..., embed=True),
        coordinator_id: str = Body(..., embed=True),
        request: str = Body(..., embed=True),
        agent_pool: str = Body("verified", embed=True),
        agent_teams: list[str] = Body([], embed=True),
        agent_names: list[str] = Body([], embed=True),
        display_name: Optional[str] = Body(None, embed=True),
        post_initial_message: bool = Body(False, embed=True),
        # §5.1 / B2 — the coordinator's v1 of PLAN.md, if it already has one.
        # There is NO `plan_mode` param: the project SHAPE is the discriminator
        # and it already ships as `surface` (§3.5). That field does not exist.
        plan_body: Optional[str] = Body(None, embed=True),
        # The context this project was spawned FROM — a project id, a DM-thread
        # id, or the `{name}-{id}` slug an agent sees as its synced directory.
        # Optional and inert: omitted, the mirror below is a `None` check.
        spawned_from: Optional[str] = Body(None, embed=True),
        response: Response = None,  # noqa: B008 - FastAPI injects it
        authorization: str = Header(default=""),
        turn_grant_id: Optional[str] = Header(default=None, alias="X-Clawmeets-Turn-Grant"),
    ):
        """Create a new project.

        A project created during a restricted turn (the runner's action
        executor sends that turn's grant) is born remote-content: the mark
        is inherited, so a steered turn cannot launder outside text into an
        unmarked project.

        Authentication: Either the coordinator's agent token OR a user JWT token
        where the user's assistant is the coordinator.

        The `created_by` field is automatically derived from authentication:
        - Agent token: coordinator agent must be owned (registered_by) by a user
        - User JWT: uses the authenticated user's ID

        Uses changelog-first architecture: all disk writes happen via ModelContext
        as a ChangelogSubscriber processing the appended entries.
        """
        # Derive created_by from authentication
        created_by: str | None = None

        # Try agent token first
        try:
            await ctx.auth.check_agent_token(coordinator_id, authorization)
            # Agent auth succeeded — coordinator agent must be owned by a user
            # (i.e. the user's personal coordinator agent).
            coordinator_agent = Agent.get(coordinator_id, ctx.model_ctx)
            if coordinator_agent and coordinator_agent.registered_by:
                created_by = coordinator_agent.registered_by
            else:
                raise HTTPException(400, "Coordinator agent must be owned by a user")
        except HTTPException:
            # Fall back to user JWT. The caller may nominate any agent they own
            # as coordinator — not only their personal assistant. This supports
            # templates like `chess` where a specialist agent (e.g. gamemaster)
            # drives the project instead of the default assistant.
            user = await ctx.auth.get_current_user(authorization)
            coordinator_agent = Agent.get(coordinator_id, ctx.model_ctx)
            if coordinator_agent is None:
                raise HTTPException(400, f"Coordinator {coordinator_id} not found")
            if coordinator_agent.registered_by != user.id:
                from clawmeets.server.coordinator_rule import foreign_coordinator

                raise foreign_coordinator()
            created_by = user.id

        if not created_by:
            raise HTTPException(400, "Could not determine project creator")

        # Validate agent_pool
        if agent_pool not in ("self", "owned", "verified", "all"):
            raise HTTPException(400, f"Invalid agent_pool: {agent_pool}. Must be 'self', 'owned', 'verified', or 'all'")

        # Validate the project name at the boundary, BEFORE get_or_create below
        # mints a changelog dir for it. `name` becomes a filesystem dir name deep
        # in changelog processing (ProjectState.create -> validate_fs_name), where
        # a ValueError surfaces as an unhandled 500 — and by then `runloop.append`
        # has already written changelog.ndjson, so the failure leaks a
        # meta.json-less directory that GET /projects silently skips and DELETE
        # 404s on. Same guard, and same reasoning, as the chatroom-name check in
        # routes/chatrooms.py.
        #
        # The remediation clause is load-bearing, not decoration: the only place
        # a caller could put a human-readable title used to be `name` itself
        # (the CLI had no --display-name), so a bare "invalid name" reads as a
        # dead end. An agent that gets an opaque 500 here will bisect the OTHER
        # parameters and strew half-finished projects behind it — which is
        # exactly what happened.
        try:
            FileUtil.validate_fs_name(name)
        except ValueError as e:
            raise HTTPException(
                422,
                f"invalid project name {name!r}: {e}. Use a filesystem-safe slug "
                f"(letters, digits, - and _) and pass display_name for the "
                f"human-readable title.",
            )

        # Canonicalize the human-readable title through the same pipeline the
        # rename endpoint uses, so create and rename agree on the stored form of
        # one field. Without this, create could store a 200-char name that
        # PUT /projects/{id}/display-name would then reject.
        if display_name is not None:
            try:
                display_name = normalize_thread_display_name(display_name)
            except ValueError as e:
                raise HTTPException(422, str(e))

        # Generate project ID upfront
        project_id = str(uuid.uuid4())

        # Get coordinator name for the payload
        coordinator = Agent.get(coordinator_id, ctx.model_ctx)
        if coordinator is None:
            raise HTTPException(400, f"Coordinator {coordinator_id} not found")
        coordinator_name = coordinator.name

        from_scoped_turn = False
        inherited_key: Optional[str] = None
        if turn_grant_id:
            gate = getattr(ctx, "isolation_gate", None)
            grant = gate.turn_tokens.live_grant(turn_grant_id, coordinator_id) if gate else None
            if grant is None:
                raise HTTPException(403, {"code": "turn_scope",
                                          "message": "no live turn grant for this agent"})
            from_scoped_turn = True
            # A project a serving turn creates stays a serving project: it
            # inherits the turn's requester key, so outside text a visitor
            # steered into it never runs at full power. A grant whose project
            # has no key (an old runner's project turn) isolates it alone.
            try:
                source_key = scope_key(Project.get(grant.project_id, ctx.model_ctx))
            except ValueError:
                source_key = None
            inherited_key = source_key or f"project:{project_id}"
        if coordinator.owner_isolated and inherited_key is None:
            # An owner-isolated agent coordinates only its serving projects
            # (plan-owner-isolation 5d): never a new full-power project.
            from clawmeets.server.hub.browser import HubError

            raise HubError("serving_only_agent", "This agent runs without the ClawMeets sandbox, so it "
                                                 "cannot coordinate a new project.")

        # Get runloop for this project (reuse for all appends)
        runloop = await ctx.runloop_manager.get_or_create(project_id, name)

        # 1. Append PROJECT_CREATED entry (creates project directories and meta.json)
        await runloop.append(
            ChangelogEntryType.PROJECT_CREATED,
            ProjectCreatedPayload(
                project_id=project_id,
                project_name=name,
                coordinator_id=coordinator_id,
                coordinator_name=coordinator_name,
                request=request,
                created_by=created_by,
                agent_pool=agent_pool,
                agent_teams=agent_teams,
                agent_names=agent_names,
                display_name=display_name,
                requester_key=inherited_key,
                memory_excluded=from_scoped_turn,
            ),
        )

        # 2. Append ROOM_CREATED for shared-context
        await runloop.append(
            ChangelogEntryType.ROOM_CREATED,
            RoomCreatedPayload(
                chatroom_name="shared-context",
                participants=[RoomCreatedParticipant(id=coordinator_id, name=coordinator_name)],
            ),
        )

        # 3. Seed PLAN.md and its sidecar for the shared-context room (D18).
        # The agent pool / team / name filters are applied at runtime by
        # the runner-side prompt builder (per-turn) and enforced server-side
        # at chatroom-create — PLAN.md no longer carries a frozen agent list.
        # AGENTS.md (global, runner-side) remains the discovery surface.
        #
        # This used to be a raw FILE_CREATED with no from_participant_id /
        # from_participant_name, which is why `plan_revisions` shows an EMPTY
        # AUTHOR on the seed row of every project that exists. It now goes
        # through `create_plan` — the one funnel — attributed to the keeper, so
        # POST /projects is a caller of that function rather than a fourth
        # writer nobody listed (AC-2.8). The Project must be readable first:
        # `create_plan` needs the coordinator name and the shared-context room,
        # and both exist by this point.
        seeded = Project.get(project_id, ctx.model_ctx)
        if seeded is not None:
            await init_plan_sidecar(seeded, ctx, plan_body=plan_body)

        # 4. Append ROOM_CREATED for user-communication
        room_entry = await runloop.append(
            ChangelogEntryType.ROOM_CREATED,
            RoomCreatedPayload(
                chatroom_name="user-communication",
                participants=[RoomCreatedParticipant(id=coordinator_id, name=coordinator_name)],
            ),
        )

        # Read the created project to use for broadcast
        project = Project.get(project_id, ctx.model_ctx)
        if project is None:
            raise HTTPException(500, f"Project {project_id!r} creation failed")

        # Broadcast project creation to all participants
        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=name,
                new_version=room_entry.version,
                coordinator_id=coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        # 5. Optionally materialize the project request as the opening user
        # message in user-communication so the coordinator wakes up. The web UI
        # does this client-side after uploading files; CLI/agent callers ask the
        # server to do it atomically.
        if post_initial_message:
            from clawmeets.server.routes.messages import send_message_as_user

            author = User.get(created_by, ctx.model_ctx)
            if author is None:
                raise HTTPException(500, f"Project creator {created_by!r} not found")
            await send_message_as_user(
                ctx,
                author.id,
                author.username,
                project_id,
                "user-communication",
                f"@{coordinator_name} {request}",
            )

        # 6. Mirror the link, LAST. An agent that spawned this project from a
        # context one of its owner's to-dos already points at should leave that
        # to-do pointing at the work that actually continued.
        #
        # Last for two reasons: the project is readable and broadcast by this
        # point, so the desk refetch the mirror triggers finds it; and a mirror
        # problem cannot delay the thing the agent actually asked for.
        #
        # A FAILURE HERE NEVER FAILS THE CREATE. The project is what was
        # requested; the link is an inference on top of it. But the miss is not
        # swallowed either — it comes back as a header the CLI turns into a
        # stderr line, so it lands in what the agent reports rather than in a
        # log nobody opens. Same contract `notify_plate_of_project_change`
        # holds, and for the same reason.
        if spawned_from:
            try:
                mirrored = await mirror_plate_to_spawned_project(
                    ctx, spawned_from, project
                )
                if mirrored and response is not None:
                    response.headers[MIRRORED_HEADER] = str(mirrored)
            except Exception as e:
                logger.exception(
                    f"Failed to mirror to-do links onto project {project_id[:8]}"
                )
                if response is not None:
                    response.headers[MIRROR_ERROR_HEADER] = _mirror_reason(e)

        return project

    async def _with_plan(project: Project) -> dict:
        """One project, serialized, with its ``PlanSummary`` attached (D23, §6.2).

        The summary hangs on the **project record** because there is no desk
        feed: My Desk is composed client-side out of the project and DM lists.
        The exact precedent is one lane over — ``report_published_at`` is a
        project field the desk's list already carries, read with no per-card
        request — and this joins the same object. **No new route.**

        ``plan`` is absent (``None``) when the project has no plan at all: a DM,
        or a pre-feature project with no ``PLAN.md``. Absence is the signal, so
        nobody has to define a sentinel.
        """
        return {**project.model_dump(), "plan": await plan_summary_for(project, ctx),
                "hub_target": _hub_target(project)}

    def _hub_target(project: Project) -> Optional[dict]:
        """``hub_target`` (design section 5): set on a hub requester thread,
        None on every other project. Read from the hub tables only."""
        if not is_untrusted_source(project) or ctx.channel_store is None:
            return None
        runtime = ctx.hub_runtime
        hub = runtime.hub if runtime is not None else HubStore(ctx.channel_store)
        agent = runtime.directory.cached(counterpart_of(project)) if runtime is not None else None
        return project_hub_target(hub, project.id, agent=agent)

    async def _all_with_plan(projects: list[Project]) -> list[dict]:
        return [await _with_plan(p) for p in projects]

    def _scoped_projects_for_user(user: User) -> list[Project]:
        """Projects a user sees acting as themselves: their owned projects, the
        Front Desk requester ends they opened against foreign agents (keyed on
        the requester segment of the FD name), and projects shared to them as a
        read-only viewer. Mirrors the USER branch of ``get_participant_projects``
        without the ``ParticipantProjectResponse``/version wrapping — used by
        ``GET /projects``."""
        bridges = bridge_project_ids(ctx)
        all_projects = [p for p in Project.list_all(ctx.model_ctx) if p.id not in bridges]
        owned = [p for p in all_projects if p.created_by == user.id]
        owned_ids = {p.id for p in owned}
        shared_ids = viewer_project_ids(user.id, ctx.model_ctx.participants_dir)
        viewer = [
            p for p in all_projects
            if p.id not in owned_ids and p.id in shared_ids
        ]
        viewer_ids = {p.id for p in viewer}
        fd_requester = [
            p for p in all_projects
            if p.id not in owned_ids
            and p.id not in viewer_ids
            and p.fd_requester_name == user.username
        ]
        return owned + fd_requester + viewer

    @router.get("/projects")
    async def list_projects(
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """List the projects the caller may see.

        **Authentication is required and the list is scoped to the caller.**
        This route used to be unauthenticated and return ``Project.list_all`` —
        the whole server's projects — to anyone who asked.

        Scoping has to land in the same change as ``GET /me/chatrooms``, not
        before and not after: the sidebar takes its project ids from *here* and
        then asks the batch route for each one's rooms. If the two disagree about
        what a caller can see, every id this route emits and that one rejects
        becomes an ``errors[pid]`` on a row the user is already looking at. The
        two therefore evaluate the same predicate (see ``accessible_projects``).

        Who sees what:

        - **User** -> owned + Front Desk requester ends + share-token viewer
          (``_scoped_projects_for_user``).
        - **Agent bearer** (runners send ``Authorization`` + ``X-Agent-ID``) ->
          resolved to the agent's OWNER and scoped as that user, which is what
          ``resolve_viewer`` already does for ``GET /agents``. Without this a
          worker shelling ``clawmeets`` to resolve a project by name would 401.
        - **The owner's ``-assistant`` bearer with no** ``X-Agent-ID`` -> the
          owner, as ``resolve_user_from_credential`` maps it for every other
          owner door. This is what ``clawmeets plan resolve <name> --as-user``
          sends (it drops the agent header on purpose), and the list is what
          it resolves the project name against. It sees no more than the same
          token already sees with the header.
        - **No credentials** -> 401."""
        # Accepts a user JWT or an agent bearer + X-Agent-ID (mapped to the
        # agent's owner); raises 401 on a presented-but-invalid token, and
        # returns None only when nothing was presented at all.
        agent_header = (x_agent_id or "").strip() or None
        try:
            viewer_id = await ctx.auth.resolve_viewer(authorization, agent_header)
        except HTTPException:
            if agent_header:
                raise
            viewer_id = (await ctx.auth.resolve_user_from_credential(authorization)).id
        if viewer_id is None:
            raise HTTPException(401, "Missing bearer token")
        viewer = User.get(viewer_id, ctx.model_ctx)
        if viewer is None:
            raise HTTPException(401, "Invalid or expired credentials")
        projects = _scoped_projects_for_user(viewer)
        gate = getattr(ctx, "isolation_gate", None)
        if agent_header and gate is not None and not gate.is_user_jwt(authorization):
            projects = [p for p in projects if gate.visible_to_agent(agent_header, p)]
        return await _all_with_plan(projects)

    @router.get("/projects/{project_id}")
    async def get_project(
        request: Request,
        project_id: str,
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None, alias="X-Agent-ID"),
    ):
        """Get project by ID, with its plan summary (§6.2, D23).

        ``response_model=Project`` was dropped rather than subclassed: ``Project``
        is frozen and carries computed fields that re-read ``meta.json`` through
        a context a reconstructed copy would not have, so a response subclass
        cannot be built from a ``model_dump()``. The payload is byte-for-byte
        what it was plus one ``plan`` member.
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        await check_project_read(
            ctx, project, authorization=authorization, x_agent_id=x_agent_id,
            turn_grant=getattr(request.state, "turn_grant", None),
        )
        return await _with_plan(project)

    @router.post("/me/dms/{agent_full_name}/ensure", response_model=Project)
    async def ensure_own_dm_project(
        agent_full_name: str,
        authorization: str = Header(default=""),
    ):
        """Idempotent ensure of the caller's DM project with one of their own agents.

        DM-shaped project ``{username}-dm-{agent_short}``. The single
        ``user-communication`` chatroom IS the DM. Returns the existing
        project if already created. Foreign agents must use
        ``/me/fd/{agent_full_name}/ensure`` instead.

        Accepts a user JWT or the user's assistant-agent bearer token (so
        the assistant can DM the user's other agents on their behalf).
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        return await _ensure_own_dm_project(ctx, user, agent_full_name)

    @router.post("/me/dms/{agent_full_name}/schedule-thread", response_model=Project)
    async def ensure_schedule_dm_thread(
        agent_full_name: str,
        authorization: str = Header(default=""),
    ):
        """Idempotent ensure of the caller's dedicated schedule DM thread.

        DM-shaped project ``{username}-dm-{agent_short}-schedule`` — a durable,
        deterministic sibling of the plain own-DM project, dedicated to
        recurring (cron) messages so they don't interleave with the live
        conversation. Returns the existing thread if already created ("create
        if not exist"). Own agents only (foreign agents raise 403).

        Accepts a user JWT or the user's assistant-agent bearer token (so the
        assistant can schedule DMs to the user's other agents on their behalf).
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        return await _ensure_schedule_dm_thread(ctx, user, agent_full_name)

    @router.post("/me/dms/{agent_full_name}/threads", response_model=Project)
    async def create_dm_thread(
        agent_full_name: str,
        client_thread_key: Optional[str] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Create a NEW DM-thread project with one of the caller's own agents.

        ChatGPT/Claude thread model (rev-4): each call mints a fresh
        ``surface="dm"`` project (N threads per agent), returned carrying
        ``surface`` / ``display_name`` (``"New chat"`` placeholder) /
        ``last_modified``. The frontend opens a client-side draft on agent-click
        (no server row) and calls this only when the first message is sent, then
        posts that message into the returned project's ``user-communication``
        room — so a thread is ephemeral-until-first-send.

        Distinct from the idempotent ``/me/dms/{agent}/ensure`` (get-or-create
        ONE), which is retained for CLI callers.

        ``client_thread_key`` is an optional idempotency token: a retry of the
        SAME send carrying the same token returns the already-created thread
        instead of minting a second one (guards the double-submit race, Q3).

        Accepts a user JWT or the user's assistant-agent bearer token.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        async with _dm_thread_lock:
            if client_thread_key:
                cached_id = _dm_thread_keys.get((user.id, client_thread_key))
                if cached_id is not None:
                    try:
                        return Project.get(cached_id, ctx.model_ctx)
                    except ValueError:
                        # The cached thread vanished (e.g. deleted) — fall
                        # through and mint a fresh one for this token.
                        pass
            project = await _create_own_dm_thread_project(ctx, user, agent_full_name)
            if client_thread_key:
                _dm_thread_keys[(user.id, client_thread_key)] = project.id
            return project

    @router.post("/me/fd/{agent_full_name}/threads", response_model=Project)
    async def create_front_desk_thread(
        agent_full_name: str,
        client_thread_key: Optional[str] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Create a NEW Front Desk thread with a FOREIGN public agent (path A).

        Sibling of ``/me/dms/{agent}/threads`` but for a foreign agent: each call
        mints a fresh ``surface="frontdesk"`` project OWNED by the requester
        (N-per-agent), with the foreign agent as an ``external`` coordinator on
        ``user-communication``. The frontend opens a client-side "New chat" draft
        on agent-click (no server row) and calls this only on first send, then
        posts that first message into the returned project's ``user-communication``
        room under the requester's own auth (the requester OWNS it — no
        ``_is_fd_requester`` grant needed). That message routes through the tunnel
        to a distinct host-side project (see ``TunnelSubscriber``).

        ``client_thread_key`` reuses the shipped ``(user.id, key)`` idempotency
        cache (DD4): a retry of the SAME send returns the already-created thread.
        Distinct sends intentionally mint distinct threads.

        Accepts a user JWT or the user's assistant-agent bearer token. SF2: the
        subsequent first message MUST post under the requester's USER identity so
        ``from_participant_id`` is the requester's user id — the titling principal
        the host runloop resolves.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        async with _dm_thread_lock:
            if client_thread_key:
                cached_id = _dm_thread_keys.get((user.id, client_thread_key))
                if cached_id is not None:
                    try:
                        return Project.get(cached_id, ctx.model_ctx)
                    except ValueError:
                        pass
            project = await _create_front_desk_requester_thread(
                ctx, user, agent_full_name
            )
            if client_thread_key:
                _dm_thread_keys[(user.id, client_thread_key)] = project.id
            return project

    @router.post("/me/fd/{agent_full_name}/ensure", response_model=Project)
    async def ensure_fd_project(
        agent_full_name: str,
        authorization: str = Header(default=""),
    ):
        """Idempotent ensure of the caller's FD project with a foreign agent.

        DM-shaped project ``{username}-fd-{agent_short}``. The single
        ``user-communication`` chatroom IS the DM thread; ``TunnelSubscriber``
        lazily wires a binding to the responder side on the first send.
        Own agents must use ``/me/dms/{agent_full_name}/ensure`` instead.

        Accepts a user JWT or the user's assistant-agent bearer token.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        return await _ensure_fd_project_for_user(ctx, user, agent_full_name)

    @router.post("/projects/{project_id}/complete")
    async def complete_project(
        project_id: str,
        background: BackgroundTasks,
        authorization: str = Header(default=""),
        source_version: int | None = None,
    ):
        """Mark a project as complete.

        Uses changelog-first architecture: ModelContext updates project status
        when processing the PROJECT_COMPLETED entry.

        TWO CALLERS, ONE ROUTE. The coordinator agent finishing its work, and
        the OWNER pressing **Done** on the project's card on their desk. The
        desk button used to write only a read watermark — the card vanished
        while the project stayed ``active`` and the linked to-do's ticket chip
        stayed Working — so the two halves of "I'm finished with this" now go
        through here together. Both card kinds (``dm`` and ``project``) call
        it; a card maps to exactly one project, so there is nothing to
        disambiguate.

        Auth, in order, mirroring ``set_display_name`` — the agent branch runs
        FIRST so the shipped coordinator path is bit-for-bit unchanged:

        1. The project's OWN coordinator agent token.
        2. Otherwise a user JWT: absent/invalid credentials are a **401** from
           ``get_current_user``; an authenticated user who fails
           ``can_complete_project`` is a **403**. Never 401 for "not allowed" —
           the web client reads a 401 as an expired token and would log the
           user out instead of showing the inline error.

        THE COMPLETION EMAIL IS SUPPRESSED WHEN ITS RECIPIENT IS THE ONE WHO
        PRESSED DONE (``_pressed_own_done``). The notification exists to reach
        someone who is NOT looking at the app — a coordinator finishing a
        long-running project autonomously is often the only signal that it
        landed — and the owner pressing Done is the opposite case: the 200
        refreshes the card in front of them, so the mail only describes their
        own click. Anyone ELSE who may press it (a front-desk
        requester on a thread the host owns) is still news to the recipient
        and still mails. Which branch of the auth ladder matched is what
        identifies the presser, so it is captured there.

        ALREADY COMPLETED IS A NO-OP, and that guard is load-bearing rather
        than tidy. A card in the report lane exists *because* a completion
        report exists, which means its project is already COMPLETED; without
        the guard, pressing Done there would append a second
        ``PROJECT_COMPLETED`` to the changelog for work that was already
        finished (and, back when the owner press still mailed, a second "is
        complete" email). The response distinguishes the two outcomes with
        ``changed`` so a caller can tell a real transition from a no-op, but
        the status field is the same either way — the project IS completed in
        both cases, which is what the caller asked for.

        Completing is not terminal in practice: posting into the thread's
        ``user-communication`` room appends ``PROJECT_REACTIVATED`` and flips
        the status back to ``active`` (``routes/messages.py``), so Done is
        undone by simply typing again — and pressing Done after that is a real
        transition: changelog entry and broadcast, and mail on the same rule as
        the first one (silent for the owner's own press).
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")

        # WHO pressed it, kept for the email decision below. ``None`` means the
        # coordinator agent: the auth ladder is the only place that knows which
        # caller this is, and it knows for free.
        completed_by: User | None = None
        try:
            await ctx.auth.check_agent_token(project.coordinator_id, authorization)
        except HTTPException:
            # Not this project's coordinator — fall back to the owner path.
            completed_by = await ctx.auth.get_current_user(authorization)
            if not can_complete_project(project, completed_by):
                raise HTTPException(
                    403, "You do not have permission to complete this thread"
                )

        # Idempotent: no append, no broadcast, no second email. Checked AFTER
        # auth so an unauthorized caller cannot probe a project's status.
        if project.status == ProjectStatus.COMPLETED:
            return {"status": "completed", "changed": False}

        # Append PROJECT_COMPLETED to changelog (ModelContext updates project status)
        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)
        entry = await runloop.append(
            ChangelogEntryType.PROJECT_COMPLETED,
            ProjectCompletedPayload(),
            source_version=source_version,
        )

        # Broadcast to all project participants
        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        # The owner's desk, if one of their to-dos points at this project. THE
        # TRIGGER IS THE ROUTE, NOT THE STATE TRANSITION: the status flip is
        # applied by the changelog subscriber above, in a context with no socket
        # hub, so the broadcast has to be added here and at every other route
        # that causes one. Addressed to the to-do's OWNER, not to this project's
        # participants — the event happens in this project's context and must
        # still reach a desk somewhere else (AC-2.4).
        await notify_plate_of_project_change(ctx, project)

        # Send email notification to the project creator — UNLESS THEY ARE THE
        # ONE WHO PRESSED DONE, and QUEUED, NOT AWAITED. An owner who pressed
        # it already knows: the 200 is what tells the browser the project is
        # completed, and the plate refreshes off it, so the mail would be noise
        # about their own click. Skipping the branch skips the attachment
        # gather and the report-link lookup with it.
        # Awaiting SendGrid here put a third-party round trip between the
        # transition and the confirmation of it, and (before the mailer moved
        # off the loop) between the transition and the `desk_todo_sync` frame
        # queued eight lines above. Nothing in the response depends on the
        # email, so nothing in the response should wait for it.
        try:
            if project.created_by and not _pressed_own_done(completed_by, project):
                user = User.get(project.created_by, ctx.model_ctx)
                if user:
                    if user.email:
                        # Attach any deliverables the coordinator produced in
                        # its completing turn (files sharing this completion's
                        # source_version) + the report link. Gather must never
                        # block the email.
                        attachments: list = []
                        skipped: list[str] = []
                        report_link = None
                        try:
                            attachments, skipped = gather_project_response_attachments(
                                project,
                                ctx.model_ctx,
                                source_version=source_version,
                                author_id=project.coordinator_id,
                            )
                            report_link = report_url_if_available(
                                project, ctx.model_ctx, APP_BASE_URL
                            )
                        except Exception:
                            logger.exception(
                                "Failed to gather completion notification assets"
                            )
                        msg = ClawMeetsEmailMessage.project_completed(
                            to_email=user.email,
                            username=user.username,
                            project=project,
                            app_base_url=APP_BASE_URL,
                            attachments=attachments,
                            attachments_skipped=skipped,
                            report_url=report_link,
                        )
                        queue_notification(background, msg)
        except Exception:
            logger.exception("Failed to send project completion notification")

        return {"status": "completed", "changed": True}

    @router.post("/projects/{project_id}/display-name", response_model=Project)
    async def set_display_name(
        project_id: str,
        display_name: str = Body(..., embed=True),
        expected_current: Optional[str] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Set a project's ``display_name`` — the auto-title AND manual rename.

        ONE endpoint for both thread kinds: a project thread and a DM thread are
        both ``Project`` rows, distinguished only by ``surface``. There is no
        manual-rename sibling route, deliberately — a second route would
        duplicate the changelog append, the broadcast and the replay path, and
        let the two writers drift apart on validation.

        Changelog-first: appends ``DISPLAY_NAME_CHANGED`` (ModelContext applies
        it to meta.json via ``set_thread_title``) and broadcasts the existing
        ``CHANGELOG_UPDATE`` so a live sidebar re-renders the row label.

        Applies to every surface: dm/frontdesk threads auto-title from the first
        message, and regular projects auto-title from their request (both driven
        by the project's own coordinator on its first turn).

        Auth, in order — the agent branch runs FIRST so the shipped auto-title
        path is bit-for-bit unchanged:

        1. The project's OWN coordinator agent token (MF4:
           ``check_agent_token(project.coordinator_id, …)`` binds
           token→coordinator, so an arbitrary agent or a different project's
           coordinator fails to verify).
        2. Otherwise a user JWT: absent/invalid credentials are a **401** from
           ``get_current_user``; an authenticated user who fails
           ``can_rename_project`` is a **403**. Never 401 for "not allowed" —
           the web client treats 401 as an expired token and would log the user
           out instead of showing the inline error.

        Then ``normalize_thread_display_name`` runs and a ``ValueError`` becomes
        a 400. Ordering is load-bearing: 404 → auth → validation → append →
        broadcast, so a rejected rename writes no changelog entry and fires no
        WebSocket broadcast. "No server write on rejection" holds at the
        transport level, not by convention.

        The value PERSISTED is the normalized one, so the response's
        ``display_name`` is canonical and clients must render from the response
        rather than from their local input (``"Trip   plan"`` stores as
        ``"Trip plan"``).

        Concurrency is last-write-wins: no etag, no version, no 409.
        ``runloop.append`` locks internally and has no conditional variant, and
        the contention window is two humans renaming one thread in the same
        second — the loser sees the winner's name arrive over
        ``CHANGELOG_UPDATE`` a moment later, which is the correct outcome.

        ``expected_current`` is a best-effort defensive re-check, NOT an atomic
        compare-and-set (MF2): ``runloop.append`` locks internally with no
        conditional variant, so this narrows but does not fully close a
        sub-turn double-fire window. The auto path passes the literal
        ``"New chat"`` sentinel (never the agent's last-observed title). If it
        is set and no longer matches, the rename is a no-op. A **manual** rename
        must omit it: on mismatch this returns 200 with the *unchanged* project,
        which would show the user success next to the old name.
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")

        # Bind authority to THIS project's coordinator (mirrors the create_project
        # ownership checks). A token for any other agent fails verification here.
        # No surface gate: dm/frontdesk auto-title from the first message, and
        # regular projects auto-title from their request — both are driven by the
        # project's OWN coordinator, which is exactly what the token binds to.
        try:
            await ctx.auth.check_agent_token(project.coordinator_id, authorization)
        except HTTPException:
            # Not this project's coordinator — fall back to the manual-rename
            # path. `get_current_user` raises 401 for absent/invalid/expired
            # credentials; everything past it is an authenticated caller, so the
            # only correct rejection is 403 (see can_rename_project).
            user = await ctx.auth.get_current_user(authorization)
            if not can_rename_project(project, user):
                raise HTTPException(403, "You do not have permission to rename this thread")

        # BEFORE any write: a rejection here produces no changelog entry and no
        # broadcast. The message is user-facing verbatim.
        try:
            display_name = normalize_thread_display_name(display_name)
        except ValueError as e:
            raise HTTPException(400, str(e))

        # Defensive re-check (MF2, not a CAS): skip if the caller pinned an
        # expected current title and it no longer holds (someone already titled).
        if expected_current is not None and project.display_name != expected_current:
            return project  # no-op; latch already flipped

        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)
        entry = await runloop.append(
            ChangelogEntryType.DISPLAY_NAME_CHANGED,
            DisplayNameChangedPayload(project_id=project_id, display_name=display_name),
        )

        # Broadcast the existing CHANGELOG_UPDATE (invalidate-all-caches). The
        # sidebar re-renders the row label from the project/LIST query (SF4).
        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        # Re-read so the response carries the freshly-applied display_name.
        return Project.get(project_id, ctx.model_ctx)

    @router.put("/projects/{project_id}/allowlist", response_model=Project)
    async def update_project_allowlist(
        project_id: str,
        add_agents: list[str] = Body([], embed=True),
        add_teams: list[str] = Body([], embed=True),
        remove_agents: list[str] = Body([], embed=True),
        remove_teams: list[str] = Body([], embed=True),
        replace: bool = Body(False, embed=True),
        authorization: str = Header(default=""),
    ):
        """Update a project's invitable allowlist (agent_names / agent_teams).

        The allowlist (`agent_names`, `agent_teams`) is fixed at project
        creation; this is the only post-creation producer for it. Emits a
        ``PROJECT_ALLOWLIST_UPDATED`` changelog entry whose replay overwrites
        the snapshot in ``meta.json`` server-side AND fans out to the
        coordinator's runner, so the next-turn invitable resolution + prompt
        pick up the change.

        Semantics (all lists optional):
        - default: MERGE — union the current snapshot with ``add_*``, then
          drop any ``remove_*`` entries.
        - ``replace=True``: SET the snapshot to exactly ``add_agents`` /
          ``add_teams`` (``remove_*`` ignored).

        Auth: coordinator agent token OR project owner's user JWT.
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        if project is None:
            raise HTTPException(404, f"Project {project_id!r} not found")

        try:
            await ctx.auth.check_agent_token(project.coordinator_id, authorization)
        except HTTPException:
            user = await ctx.auth.get_current_user(authorization)
            if user.id != project.created_by:
                raise HTTPException(
                    403, "Only the coordinator agent or project owner can edit the allowlist"
                )

        if replace:
            new_names = list(dict.fromkeys(add_agents))
            new_teams = list(dict.fromkeys(add_teams))
        else:
            remove_name_set = set(remove_agents)
            remove_team_set = set(remove_teams)
            new_names = [
                n for n in dict.fromkeys([*project.agent_names, *add_agents])
                if n not in remove_name_set
            ]
            new_teams = [
                t for t in dict.fromkeys([*project.agent_teams, *add_teams])
                if t not in remove_team_set
            ]

        # No-op short-circuit — don't append a redundant entry.
        if new_names == project.agent_names and new_teams == project.agent_teams:
            return project

        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)
        entry = await runloop.append(
            ChangelogEntryType.PROJECT_ALLOWLIST_UPDATED,
            ProjectAllowlistUpdatedPayload(
                agent_names=new_names,
                agent_teams=new_teams,
            ),
        )

        # Fan out so connected clients + the coordinator's runner refresh.
        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        return Project.get(project_id, ctx.model_ctx)

    async def _delete_project_in_place(project: Project) -> None:
        """Tear down a project's WS broadcasts, in-memory state, and on-disk dirs.

        Mirrors the post-auth body of `delete_project`. Used by both the
        per-project DELETE endpoint and the bulk Front-Desk-disable flow.
        Auth + lookup are caller responsibilities.

        Deletion bypasses the changelog (it destroys the changelog itself), so
        the `TunnelSubscriber` never sees a PROJECT_DELETED entry — binding
        teardown is handled here instead. Idempotent: safe to re-run after a
        partial failure.
        """
        # Local import to avoid a module cycle at registration time.
        from clawmeets.models.tunnel_binding import (
            delete_binding,
            find_bindings_for_project,
        )

        # FIRST, before anything is torn down: `project.created_by` and the
        # plate scan are both unreadable once the directory is gone, and a
        # deleted project stops contributing to its to-dos' derived state — so
        # a row linked only to this one flips back to New and the desk has to
        # be told. Lives in the shared teardown rather than in the DELETE route
        # so the bulk Front-Desk-disable flow gets it too.
        await notify_plate_of_project_change(ctx, project)

        envelope = ControlEnvelope(
            type=ControlMessageType.PROJECT_DELETED,
            payload=ProjectDeletedPayload(
                project_id=project.id,
                project_name=project.name,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        # Tear down every cross-user tunnel binding that references this project
        # on EITHER end. Without this the binding dangles: a later mirror calls
        # Project.get() on the now-gone project and 500s, and the requester keeps
        # seeing a dead DM channel routed at a deleted Front Desk project.
        for binding in find_bindings_for_project(project.id, ctx.model_ctx):
            # When this project is the responder (FD) end, also delete the
            # requester-side DM room so it stops showing in their sidebar. Skip
            # self-bindings (local end IS this project — its rooms die with it);
            # ROOM_DELETED refuses system rooms, so user-communication is safe.
            if (
                binding.fd_project_id == project.id
                and binding.local_project_id != project.id
            ):
                try:
                    local_proj = Project.get(binding.local_project_id, ctx.model_ctx)
                except ValueError:
                    local_proj = None
                if local_proj is not None and binding.local_room in local_proj.chatrooms:
                    local_runloop = await ctx.runloop_manager.get_or_create(
                        local_proj.id, local_proj.name
                    )
                    await local_runloop.append(
                        ChangelogEntryType.ROOM_DELETED,
                        RoomDeletedPayload(chatroom_name=binding.local_room),
                    )
            delete_binding(binding.binding_id, ctx.model_ctx)

        await revoke_all_for_project(project.id, ctx.model_ctx.participants_dir)

        await ctx.work_tracker.clear_project(project.id)
        await ctx.runloop_manager.remove(project.id)

        # Deletion bypasses the changelog, so the search subscriber never sees
        # it. Without this line the project's messages stay searchable forever
        # — a permission leak, not just staleness.
        ctx.chat_search_index.drop_project(project.id)

        # A channel thread whose connection was removed keeps a history record
        # (channel, contact name) for the sidebar; it goes with the project.
        channel_store = getattr(ctx, "channel_store", None)
        if channel_store is not None:
            channel_store.forget_removed_thread(project.id)

        data_dir = ctx.model_ctx.project_dir(project.id, project.name)
        meta_dir = ctx.model_ctx.changelog_dir(project.id, project.name)
        for dir_path in [data_dir, meta_dir]:
            if dir_path.exists():
                try:
                    shutil.rmtree(dir_path)
                    logger.info(f"Deleted directory: {dir_path}")
                except OSError:
                    # Don't leave the system in a half-deleted state silently —
                    # surface the failure so the orphan dir is visible.
                    logger.exception(f"Failed to remove project dir {dir_path}")

    @router.delete("/projects/{project_id}")
    async def delete_project(
        project_id: str,
        authorization: str = Header(default=""),
    ):
        """Delete a project and all its data.

        Authentication, in order:

        1. A user credential — the owner's JWT or the owner's ``-assistant``
           agent token (``resolve_user_from_credential``) — for the project
           owner.
        2. Failing that, the project's OWN coordinator agent token, and only
           for a project that coordinator created for its own owner
           (``project.created_by == coordinator.registered_by``).

        Rung 2 exists so an agent can clean up after itself. Without it an
        agent that creates a project it then wants to retract can only mark it
        ``completed`` and ask its owner to finish the job by hand, which leaves
        dead projects on the user's desk. It is deliberately narrow: not any
        participating agent, and not a project someone else created.

        Bypasses the changelog system because deletion destroys all state
        including the changelog itself.
        """
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")

        user: User | None = None
        try:
            user = await ctx.auth.resolve_user_from_credential(authorization)
        except HTTPException:
            user = None

        if user is not None:
            if project.created_by != user.id:
                raise HTTPException(403, "Only the project owner can delete a project")
        else:
            # Not a user credential. The one remaining acceptable caller is the
            # project's own coordinator, acting on its owner's behalf.
            token = authorization[7:] if authorization.startswith("Bearer ") else ""
            if not token or not Agent.verify_token(project.coordinator_id, token, ctx.model_ctx):
                raise HTTPException(
                    401,
                    "Deleting a project requires the owner's JWT, the owner's assistant "
                    "token, or the project coordinator's own agent token",
                )
            coordinator = Agent.get(project.coordinator_id, ctx.model_ctx)
            if (
                coordinator is None
                or not coordinator.registered_by
                or project.created_by != coordinator.registered_by
            ):
                raise HTTPException(
                    403,
                    "An agent can only delete a project it coordinates and created for its own owner",
                )

        await _delete_project_in_place(project)
        return {"status": "deleted"}

    @router.get("/participants/{participant_id}/projects", response_model=list[ParticipantProjectResponse])
    async def get_participant_projects(
        participant_id: str,
        authorization: str = Header(default=""),
    ):
        """Get all projects for a participant (user, agent, or assistant).

        - For users: returns projects they created (created_by == participant_id),
          plus Front Desk channels they opened against another user's agent
          (matched on the FD-name requester segment; created_by stays the host),
          plus projects they were shared into as a read-only viewer.
        - For agents/assistants: returns projects where participant_id is in participating_agents

        Returns projects with current_version for efficient delta sync.
        """
        # Determine participant type
        participant = Participant.get(participant_id, ctx.model_ctx)

        if participant is None:
            raise HTTPException(404, f"Participant {participant_id!r} not found")

        if participant.role == ParticipantRole.USER:
            # User sees projects they created
            # Check auth - users can only see their own projects.
            current_user = await ctx.auth.get_current_user(authorization)
            if current_user.id != participant_id:
                raise HTTPException(403, "Cannot access other user's projects")

            # **Off the loop.** Even through the stat-checked cache this is one
            # `stat` per project on the box (1303 here) — pure, side-effect-free
            # work that has no business blocking a WebSocket handshake on a
            # single-process server.
            def _gather() -> tuple[list, list]:
                # One share-token read for the whole list, not one per project.
                viewer_ids = viewer_project_ids(participant_id, ctx.model_ctx.participants_dir)
                # Cheap pre-filter over the cached meta dicts so only candidate
                # projects are validated into models. DM-shaped projects pass
                # it so the exact Front Desk requester test below stays on the
                # model (`fd_requester_name`).
                candidates = Project.list_where(
                    ctx.model_ctx,
                    lambda meta: meta.get("created_by") == participant_id
                    or meta.get("id") in viewer_ids
                    or meta.get("surface") == "dm",
                )
                owned = [p for p in candidates if p.created_by == participant_id]
                viewers = [
                    p for p in candidates
                    if p.created_by != participant_id and p.id in viewer_ids
                ]
                # Front Desk channels this user opened against another user's
                # public agent are owned by the HOST (created_by = the agent's
                # owner), so they fall into neither bucket above. But the
                # requester reads and writes their own user-communication room
                # (messages._is_fd_requester) and the sidebar lists them under
                # Public Agents — surface them here, keyed on the requester
                # segment of the FD name. created_by stays the host; this does
                # NOT grant the requester ownership (delete).
                owned_ids = {p.id for p in owned}
                viewer_only = {p.id for p in viewers}
                fd_requester = [
                    p for p in candidates
                    if p.id not in owned_ids
                    and p.id not in viewer_only
                    and p.fd_requester_name == current_user.username
                ]
                return owned + fd_requester, viewers

            owned_projects, viewer_projects = await anyio.to_thread.run_sync(_gather)
            # Room-bridge threads are plumbing: never in a project list.
            bridges = bridge_project_ids(ctx)
            owned_projects = [p for p in owned_projects if p.id not in bridges]
        else:
            # Agent/assistant sees projects they participate in — a cached scan
            # plus a filter, so it goes to a thread for the same reason as the
            # user branch above.
            owned_projects = await anyio.to_thread.run_sync(
                Project.get_projects_for_agent, participant_id, ctx.model_ctx
            )
            viewer_projects = []
            # Isolated projects are absent from an incapable agent's list (the
            # runner syncs from it); a browser asking with a user JWT sees all.
            gate = getattr(ctx, "isolation_gate", None)
            if gate is not None and not gate.is_user_jwt(authorization):
                owned_projects = [
                    p for p in owned_projects if gate.visible_to_agent(participant_id, p)
                ]

        # Build response with current_version
        #
        # **`read_tip_version`, NOT `runloop_manager.get_or_create`.** This is a
        # read path, and instantiating a runloop per project did three expensive
        # things for a single integer: `load_state()` read `runloop_state.json`,
        # `_load_pending_entries` parsed the WHOLE changelog, and the manager
        # retained the instance for ever — so one request from the user who owns
        # 1001 of 1303 projects read ~2.2 GB synchronously and permanently held
        # 1001 runloops. With `content_b64` inline that is minutes of blocked
        # event loop, which is why no WebSocket handshake could be serviced and
        # 147 of 228 runners could not connect.
        #
        # Safe server-side: the only subscriber implementing `on_state_loaded` is
        # the RUNNER's (`runner/participant_notifier.py`); none of the server
        # subscribers wired in `server/app.py` do, so nothing here depended on
        # the runloop being warmed. `changelog_dir` is the same path the
        # manager's own factory passes to `ChangelogRunloop`.
        def _tip(proj) -> int:
            return read_tip_version(
                ctx.model_ctx.changelog_dir(proj.id, proj.name) / "changelog.ndjson"
            )

        result = []
        # `plan_summary_for` cannot move off the loop — `get_plan_sidecar` takes a
        # module-level asyncio.Lock — so yield periodically instead, or a
        # thousand-project list still starves the handshake it is racing.
        for i, (proj, viewer) in enumerate(
            [(p, False) for p in owned_projects] + [(p, True) for p in viewer_projects]
        ):
            if i and i % 25 == 0:
                await asyncio.sleep(0)
            result.append(ParticipantProjectResponse(
                id=proj.id,
                name=proj.name,
                status=proj.status.value,
                current_version=_tip(proj),
                coordinator_id=proj.coordinator_id,
                counterpart_id=proj.counterpart_id,
                counterpart_name=proj.counterpart_name,
                created_by=proj.created_by,
                surface=proj.surface,
                display_name=proj.display_name,
                last_modified=proj.last_modified,
                report_published_at=proj.report_published_at,  # from meta.json — no extra read
                plan_updated_at=proj.plan_updated_at,          # from meta.json — no extra read
                plan=await plan_summary_for(proj, ctx),        # D23 — one sidecar read per project
                is_viewer=viewer,
                hub_target=_hub_target(proj),
            ))
        return result

    return router
