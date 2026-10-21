# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/desk_todo_notify.py

A project event moves this owner's to-dos.

Two halves, and the module header says so rather than leaving the next reader
to infer the remit from whatever happens to be in the file:

* **The notify half** (:func:`notify_plate_of_project_change`) — a project's
  status moved or it was deleted, so the rows pointing at it derive a new
  ticket state and the desk must refetch.
* **The write half** (:func:`mirror_plate_to_spawned_project`) — a project was
  SPAWNED from a context a to-do already points at, so the to-do gains the new
  project and keeps reading Working against the work that actually continued.

They share the one scan (``todos_referencing_project``), the one owner-addressed
envelope, and the rule that neither may ever fail the project event that caused
it.

**THE TRIGGER IS THE ROUTE, NOT THE STATE TRANSITION.** This paragraph is the
deliverable, not decoration. A project's status is flipped by the CHANGELOG —
``models/context.py::_handle_project_completed`` and
``_handle_project_reactivated`` — and that context has **no socket hub**. So the
broadcast cannot live where the status actually changes; it is added at each of
the ROUTES that cause the change instead.

The consequence is real and it is accepted rather than designed around: a
future non-HTTP producer of a completion or a reactivation silently misses this
sync, and the owner's desk holds a stale chip until something else makes it
refetch. Every producer known today is wired (see the call sites below), and
anyone adding a fourth must add a fifth line here — there is no hook that will
catch it for them.

**Addressed to the TO-DO'S OWNER, never** ``broadcast_to_project``. That is
AC-2.4 exactly: the triggering event happens inside *another* project's context
— a project the owner may not even be a participant of — and must still reach
their desk. ``broadcast_to_project`` would fan out to that project's
participants, which is the wrong set in both directions.

**Cheap by construction.** One plate read for the project's creator, an
in-memory scan, and at most one envelope. The overwhelmingly common case is an
owner whose plate does not reference the project at all, and that case sends
nothing and costs one small JSON read.

Never raises. A project event must not fail because a desk notification could
not be built — the completion already happened, and the owner's recourse for a
missed envelope is a page refresh.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    DeskTodoSyncPayload,
)
from clawmeets.models.desk_todo import associate_todo
from clawmeets.models.desk_todo_link import (
    AssociationRefused,
    check_association_target,
    plate_references_project,
    todos_referencing_project,
)
from clawmeets.models.project import Project

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# The action every project event carries. One member for all three events —
# completing, reactivating, deleting — because the desk ignores the payload and
# refetches the whole plate either way, so three actions would be three names
# for one behaviour.
PROJECT_ACTION = "project"

# The action a mirrored link carries. It is the SAME word
# ``POST /me/desk/todos/{id}/projects`` emits, and deliberately so: a to-do that
# gains a project this way must move on the owner's open plate exactly as one
# linked from the composer does, which means the same channel and the same
# action, not a second vocabulary the client would have to learn. That the two
# agree is asserted end to end rather than by reading this comment.
ASSOCIATE_ACTION = "associate"

# How a mirror reports itself on the create response. Two headers and no third,
# because there are only two things worth saying: it linked N to-dos, or it
# tried and could not.
#
# NEITHER IS EMITTED WHEN NOTHING MATCHED. That is what keeps the common path
# silent, and it is also what keeps the cross-owner decline indistinguishable
# from the not-matched case — see :func:`mirror_plate_to_spawned_project`.
#
# ``clawmeets/cli_client.py`` reads both off the response by literal string; it
# is MIT and ships in the runner wheel, which does not carry ``server/``, so it
# CANNOT import these names. A test asserts the two copies are equal rather than
# leaving the pair to drift.
MIRRORED_HEADER = "X-Desk-Todo-Mirrored"
MIRROR_ERROR_HEADER = "X-Desk-Todo-Mirror-Error"


async def notify_plate_of_project_change(
    ctx: "ServerContext | None", project: "Project | None"
) -> None:
    """Push ``DESK_TODO_SYNC(action="project", id=None)`` to a project's creator
    when their plate references it.

    Called from the routes that cause a project's status to move, or that
    destroy the project outright:

    * ``routes/projects.py :: complete_project`` — after the changelog append.
    * ``routes/projects.py :: _delete_project_in_place`` — **before** the
      teardown, because ``project.created_by`` is unreadable once the directory
      is gone.
    * ``routes/messages.py`` — both ``PROJECT_REACTIVATED`` appends
      (``send_message_as_user`` and the addressed-batch door).
    * ``server/tunnel_subscriber.py :: _mirror`` — the auto-reactivate on the
      far end of a cross-account tunnel.

    ``id`` is deliberately ``None``: one project event can move several rows at
    once (an owner may have linked the same project to three to-dos), and the
    desk's refetch is whole-plate regardless. A single row id would be a lie
    about scope that the client would then have to ignore.

    Args:
        ctx: The server context. Accepts ``None`` so a caller holding a
            late-bound context — the tunnel subscriber does — can pass it
            straight through without a guard of its own.
        project: The project whose status moved, or which is about to be
            deleted. ``None`` and a project with no ``created_by`` are both
            no-ops.
    """
    if ctx is None or project is None or not project.created_by:
        return
    try:
        if not plate_references_project(
            ctx.model_ctx.participants_dir, project.created_by, project.id
        ):
            return
        envelope = ControlEnvelope(
            type=ControlMessageType.DESK_TODO_SYNC,
            payload=DeskTodoSyncPayload(action=PROJECT_ACTION, id=None),
        )
        delivered = await ctx.ws_hub.send_to(project.created_by, envelope)
        if delivered:
            logger.info(
                f"Sent DESK_TODO_SYNC(project) to user "
                f"{project.created_by[:8]} for project {project.id[:8]}"
            )
    except Exception:
        # A desk notification must never fail the project event that caused it.
        logger.exception(
            f"Failed to notify desk of project change for {project.id[:8]}"
        )


async def mirror_plate_to_spawned_project(
    ctx: "ServerContext", spawned_from: str, project: "Project"
) -> int:
    """A project was spawned from a context some to-do already points at — give
    the to-do the new project too. Returns HOW MANY to-dos were linked.

    The case this exists for: an agent running in a DM thread the owner's
    **command** button spawned is asked to turn that conversation into a real
    project. Without this, the to-do keeps pointing at the thread alone, and the
    moment the thread is archived or the work moves on the row falls back to
    **New** — which is the one state it is certainly not in. Mirroring keeps it
    reading Working against the work that actually continued.

    **It goes through the association write, not into storage.** The sequence is
    ``check_association_target`` -> ``associate_todo`` -> the ``associate``
    envelope, which is the same sequence
    ``POST /me/desk/todos/{id}/projects`` runs. The scoping predicate therefore
    keeps exactly ONE implementation and this path cannot drift from the route
    — the check passes trivially here (see below) and is made anyway for that
    reason, not because it is in doubt.

    **Why the scoping holds by construction.** ``create_project`` derives
    ``created_by`` from the credential: on the agent-token path it is
    ``coordinator_agent.registered_by``, and a coordinator with no owner is
    refused outright. So a project an agent spawns is owned by *that agent's
    owner*, which satisfies the rename predicate (``created_by == user.id``)
    the same way ``_create_own_dm_thread_project`` satisfies it for the
    composer's threads. A worker, a coordinator and an assistant all produce the
    same ``created_by`` when the same user owns them, so this works for every
    same-owner shape rather than for one of them.

    **THE THREE SILENT RETURNS ARE ONE ANSWER ON PURPOSE, AND IT IS A SECURITY
    PROPERTY.** An unresolvable ``spawned_from``, a cross-owner ``spawned_from``
    and a resolvable one no to-do points at all return ``0`` and are
    indistinguishable from outside — no header, no stderr line, nothing. If
    declining were distinguishable from not-matching, an agent owned by A could
    feed ids at ``spawned_from`` and learn which of them are real projects
    belonging to someone else: the same existence oracle the association route's
    404 refuses, arriving through a different door.

    The cross-owner case is doubly closed, which is worth knowing because it is
    what makes the indistinguishability structural rather than careful: a
    project belonging to someone else could never be on this owner's plate in
    the first place, because ``check_association_target`` would have refused the
    link that put it there. The guard below and the empty scan reach ``0``
    independently.

    Cross-account threads therefore do not mirror, and that is the designed
    outcome rather than a gap: an agent owned by A running in B's Front Desk
    thread would otherwise put a link to *A's* project on *B's* plate, which B
    could never have made themselves.

    **Zero costs one small JSON read and says nothing.** That is the budget
    :func:`notify_plate_of_project_change` already spends one lane over for the
    same overwhelmingly-common shape, not a new one.

    **N matches produce N envelopes**, one per to-do, each carrying its own
    to-do id. Deliberately not one ``project``-with-``id: null``: the to-do
    contract publishes ``associate`` as ALWAYS carrying a to-do id, and blurring
    that to save an envelope in a case where N is almost always 1 or 2 trades a
    contract for nothing. Two to-dos pointing at the same originating thread are
    two real intentions and there is no principled way to pick between them, so
    both are mirrored — "whichever the scan hit first" is a non-answer.

    Idempotent, because ``associate_todo`` is: a to-do that already carries the
    new id counts as mirrored and still broadcasts, matching the route's own
    200 no-op.

    Raises rather than swallowing. The CALLER owns the "never fail the create"
    rule and holds the response it has to report the miss on; a failure
    swallowed here would be a miss nobody could see.

    Args:
        ctx: The server context.
        spawned_from: The originating context's id, as the agent typed it —
            the bare id or the ``{name}-{id}`` slug it sees as its synced
            project directory. Both resolve; ``Project.get`` owns that.
        project: The project just created.

    Returns:
        The number of to-dos linked. ``0`` for all three silent cases.
    """
    origin_id = (spawned_from or "").strip()
    if not origin_id or project is None or not project.created_by:
        return 0
    try:
        origin = Project.get(origin_id, ctx.model_ctx)
    except (ValueError, OSError):
        # Unresolvable. Silent, and NOT an error the caller may report — see
        # the oracle paragraph above.
        #
        # ``OSError`` and not just ``ValueError``: ``Project.get`` documents
        # the ValueError, but its fallback ``(metadata_dir / project_id)
        # .is_dir()`` is a bare ``stat()``, so an id longer than NAME_MAX
        # raises ``OSError(ENAMETOOLONG)`` straight through. Uncaught, that
        # reaches the caller's ``except Exception`` and comes back as
        # ``X-Desk-Todo-Mirror-Error: OSError: [Errno 63] File name too long:
        # /…/metadata/projects/…`` — which both publishes the server's
        # absolute data directory to any agent that can create a project, and
        # makes one unresolvable id distinguishable from another when the
        # whole point of this arm is that they are not. An id that cannot name
        # a directory cannot name a project; it is unresolvable, which is what
        # this branch already means.
        return 0
    if origin.created_by != project.created_by:
        return 0

    owner = project.created_by
    data_dir = ctx.model_ctx.participants_dir
    # `origin.id` and not `origin_id`: the slug form resolved above, and the
    # plate stores bare ids.
    todo_ids = todos_referencing_project(data_dir, owner, origin.id)
    if not todo_ids:
        return 0

    try:
        check_association_target(project, owner, project.id)
    except AssociationRefused:
        # Unreachable while `created_by` is derived from the credential. Kept
        # so the predicate has one implementation rather than a copy here that
        # could silently come to disagree with the route's.
        return 0

    mirrored = 0
    for todo_id in todo_ids:
        todo = await associate_todo(data_dir, owner, todo_id, project.id)
        if todo is None:
            # Deleted between the scan and the write. Nothing to link and
            # nothing to say.
            continue
        envelope = ControlEnvelope(
            type=ControlMessageType.DESK_TODO_SYNC,
            payload=DeskTodoSyncPayload(action=ASSOCIATE_ACTION, id=todo.id),
        )
        await ctx.ws_hub.send_to(owner, envelope)
        mirrored += 1
    if mirrored:
        logger.info(
            f"Mirrored project {project.id[:8]} onto {mirrored} to-do(s) of "
            f"user {owner[:8]} spawned from {origin.id[:8]}"
        )
    return mirrored
