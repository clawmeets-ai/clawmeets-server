# SPDX-License-Identifier: BUSL-1.1
"""One-time pass: give every existing host-side conversation its
``requester_key``, so its turns are requester-scoped like new ones.

New conversations get the key at creation (plan-agent-access 4.3, commit 3).
Projects created before that have none, which would leave them unscoped. This
pass finds them and appends one PROJECT_FLAGS_CHANGED (reason
``requester_key_migration``) to each, so the server's meta.json and every
runner's copy agree:

* a channel conversation (a ``threads`` row of the channel store):
  ``channel:{connection_id}/{contact_id}``; a hub conversation:
  ``hub:{root_fp}/{user_id}``, and kept out of memory;
* a Front Desk host thread bound by a ``TunnelBinding``: ``account:{user}``,
  the requesting user, or the requesting agent's owner;
* a legacy name-keyed Front Desk channel (``surface="dm"`` with a requester
  segment): ``account:{requester}``;
* any other host project, one whose coordinator belongs to its creator and
  that serves someone else but has no binding left: ``project:{id}``
  (isolated alone).

Idempotent: a project that already has a key is skipped, and a marker file
stops the scan after one complete pass.

A requester's message into a keyless host conversation is held
(``requester_key_pending``) until the key is there. Nothing else lifts that
hold, so once a project is keyed here its held messages are released
(``OutsideIngress.release_project``).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from clawmeets.models.agent import Agent
from clawmeets.models.project import Project, is_untrusted_source
from clawmeets.models.tunnel_binding import list_bindings
from clawmeets.models.user import User
from clawmeets.server.channels.gateway import requester_scope
from clawmeets.sync.changelog import ChangelogEntryType, ProjectFlagsChangedPayload

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server.requester_key_migration")

REASON = "requester_key_migration"
MARKER = "requester_key_migration.done"


def requester_scope_for(project: Project, server_ctx: "ServerContext",
                        bound: dict[str, str]) -> Optional[dict]:
    """``{"requester_key": …[, "memory_excluded": True]}`` for an existing
    project, or None when it serves its owner (an ordinary project, the
    owner's own DM, a requester-side thread)."""
    store = server_ctx.channel_store
    if store is not None and store.exists():
        thread = store.thread_for_project(project.id)
        if thread is not None:
            return requester_scope(store, thread)
    key = requester_key_for(project, server_ctx, bound)
    return {"requester_key": key} if key else None


def requester_key_for(project: Project, server_ctx: "ServerContext",
                      bound: dict[str, str]) -> Optional[str]:
    """The key of an existing project that is not a channel conversation."""
    model_ctx = server_ctx.model_ctx
    if project.id in bound:
        return bound[project.id]
    if project.surface == "dm" and project.fd_requester_name:
        requester = User.get_by_username(project.fd_requester_name, model_ctx)
        if requester is not None and requester.id != project.created_by:
            return f"account:{requester.id}"
        return f"project:{project.id}"
    if project.surface == "frontdesk" and not is_untrusted_source(project):
        coordinator = Agent.get(project.coordinator_id, model_ctx)
        if coordinator is not None and coordinator.registered_by == project.created_by:
            # A host thread whose binding is gone: isolated alone.
            return f"project:{project.id}"
    return None


def _bound_keys(server_ctx: "ServerContext") -> dict[str, str]:
    out: dict[str, str] = {}
    for b in list_bindings(server_ctx.model_ctx):
        if b.requester_kind == "user":
            user_id: Optional[str] = b.requester_id
        else:
            agent = Agent.get(b.requester_id, server_ctx.model_ctx)
            user_id = agent.registered_by if agent is not None else None
        out[b.fd_project_id] = f"account:{user_id}" if user_id else f"project:{b.fd_project_id}"
    return out


async def _broadcast_changelog(server_ctx, project, version) -> None:
    from clawmeets.server.routes.messages import _broadcast_changelog as broadcast

    await broadcast(server_ctx, project, version)


async def _release_held(server_ctx: "ServerContext", project_id: str) -> None:
    """Deliver what waited for this project's key. A failure leaves the
    messages held (a reopen retries them) and never stops the migration."""
    ingress = getattr(server_ctx, "outside_ingress", None)
    if ingress is None:
        return
    try:
        released = await ingress.release_project(project_id)
    except Exception:  # noqa: BLE001 — still held; the migration goes on
        logger.warning("Releasing held messages of %s after keying failed", project_id[:8], exc_info=True)
        return
    if released:
        logger.info("requester_key migration: %d held message(s) of %s delivered", released, project_id[:8])


async def migrate_requester_keys(server_ctx: "ServerContext", marker_dir: Path) -> int:
    """Run the pass once. Returns how many projects were given a key."""
    marker = marker_dir / MARKER
    if marker.exists():
        return 0
    bound = _bound_keys(server_ctx)
    count = 0
    for project in Project.list_all(server_ctx.model_ctx):
        if project.requester_key is not None:
            continue
        scope = requester_scope_for(project, server_ctx, bound)
        if scope is None:
            continue
        runloop = await server_ctx.runloop_manager.get_or_create(project.id, project.name)
        entry = await runloop.append(
            ChangelogEntryType.PROJECT_FLAGS_CHANGED,
            ProjectFlagsChangedPayload(
                requester_key=scope["requester_key"],
                memory_excluded=True if scope.get("memory_excluded") else None,
                reason=REASON,
            ),
        )
        await _broadcast_changelog(server_ctx, Project.get(project.id, server_ctx.model_ctx),
                                   entry.version)
        count += 1
        await _release_held(server_ctx, project.id)
    marker_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"{count}\n", encoding="utf-8")
    if count:
        logger.info("requester_key migration: %d host project(s) scoped", count)
    return count


HUB_THREAD_MARKER = "hub_thread_marks.done"


async def migrate_hub_thread_marks(server_ctx: "ServerContext", marker_dir: Path) -> int:
    """One-time: hub DM threads created before the remote-content mark get it
    (PROJECT_FLAGS_CHANGED, reason ``hub_thread``), so their turns are
    project-scoped and they never feed memory. New threads are born marked."""
    marker = marker_dir / HUB_THREAD_MARKER
    if marker.exists():
        return 0
    count = 0
    for project in Project.list_all(server_ctx.model_ctx):
        if not is_untrusted_source(project) or project.remote_content:
            continue
        runloop = await server_ctx.runloop_manager.get_or_create(project.id, project.name)
        entry = await runloop.append(
            ChangelogEntryType.PROJECT_FLAGS_CHANGED,
            ProjectFlagsChangedPayload(remote_content=True, memory_excluded=True, reason="hub_thread"),
        )
        await _broadcast_changelog(server_ctx, Project.get(project.id, server_ctx.model_ctx),
                                   entry.version)
        count += 1
    marker_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"{count}\n", encoding="utf-8")
    return count


SCOPED_TURN_MARKER = "scoped_turn_projects.done"


async def migrate_scoped_turn_projects(server_ctx: "ServerContext", marker_dir: Path) -> int:
    """One-time: every project a scoped turn created (``remote_content``, not
    a hub thread, no key yet) gets the requester key ``project:{its id}``,
    before the classifiers stop reading ``remote_content``. The key the
    creating turn held was never recorded, so each project is isolated
    alone, which is exactly the scope it had (plan-owner-isolation section
    3). Hub threads are skipped: the user chose full power for them.
    Returns how many projects were keyed; logs each one."""
    marker = marker_dir / SCOPED_TURN_MARKER
    if marker.exists():
        return 0
    count = 0
    for project in Project.list_all(server_ctx.model_ctx):
        if not project.remote_content or project.requester_key is not None or is_untrusted_source(project):
            continue
        runloop = await server_ctx.runloop_manager.get_or_create(project.id, project.name)
        entry = await runloop.append(
            ChangelogEntryType.PROJECT_FLAGS_CHANGED,
            ProjectFlagsChangedPayload(requester_key=f"project:{project.id}", reason="scoped_turn_project"),
        )
        await _broadcast_changelog(server_ctx, Project.get(project.id, server_ctx.model_ctx),
                                   entry.version)
        logger.info("scoped-turn migration: project %s (%s) keyed project:%s",
                    project.id[:8], project.surface, project.id[:8])
        count += 1
    marker_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"{count}\n", encoding="utf-8")
    logger.info("scoped-turn migration: %d project(s) keyed", count)
    return count


OWNER_COORDINATORS_MARKER = "owner_coordinators.done"


async def migrate_owner_coordinators(server_ctx: "ServerContext", marker_dir: Path) -> int:
    """One-time, before the coordinator append guard is armed: every
    requester end whose coordinator breaks the own-coordinator rule (a hub or
    room-bridge thread coordinated by a stand-in, a same-server Front Desk
    requester thread coordinated by another account's agent) is reassigned to
    its owning user, the old coordinator becoming its counterpart
    (PROJECT_COORDINATOR_REASSIGNED, plan-owner-isolation section 4). A
    violator of any other shape is logged loudly and left alone. Returns how
    many projects were reassigned; logs each one."""
    from clawmeets.models.project import STAND_IN_SEPARATOR
    from clawmeets.server.coordinator_rule import is_own_coordinator
    from clawmeets.sync.changelog import ProjectCoordinatorReassignedPayload

    marker = marker_dir / OWNER_COORDINATORS_MARKER
    if marker.exists():
        return 0
    model_ctx = server_ctx.model_ctx
    count = 0
    for project in Project.list_all(model_ctx):
        old = project.coordinator_id
        if is_own_coordinator(model_ctx, project_owner_id=project.created_by, coordinator_id=old):
            continue
        owner = User.get(project.created_by, model_ctx) if project.created_by else None
        stand_in = STAND_IN_SEPARATOR in (old or "")
        foreign = Agent.get(old, model_ctx) if old and not stand_in else None
        if owner is None or project.surface != "frontdesk" or not (stand_in or foreign is not None):
            logger.error("own-coordinator migration: project %s (%s) has coordinator %s that is neither "
                         "a stand-in nor another account's agent; left alone",
                         project.id[:8], project.surface, (old or "")[:12])
            continue
        runloop = await server_ctx.runloop_manager.get_or_create(project.id, project.name)
        entry = await runloop.append(
            ChangelogEntryType.PROJECT_COORDINATOR_REASSIGNED,
            ProjectCoordinatorReassignedPayload(
                coordinator_id=owner.id, coordinator_name=owner.username,
                counterpart_id=old, counterpart_name=project.coordinator_name,
                reason="own_coordinator_rule",
            ),
        )
        await _broadcast_changelog(server_ctx, Project.get(project.id, model_ctx), entry.version)
        logger.info("own-coordinator migration: project %s / %s / old coordinator %s",
                    project.id[:8], project.surface, "stand-in" if stand_in else "other account's agent")
        count += 1
    marker_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"{count}\n", encoding="utf-8")
    logger.info("own-coordinator migration: %d project(s) reassigned", count)
    return count
