# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/_batch.py

Shared pieces of the ``/me/*`` project-ids multi-get surface: request parsing
and the authorization boundary. Both live here rather than inside a router
because ``accessible_projects`` IS the authorization boundary and deserves a
home where it can be unit-tested and reviewed on its own, and because the next
``/me/*`` batch will want the same two functions.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from clawmeets.models.share_token import viewer_project_ids

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.models.project import Project
    from clawmeets.models.user import User


# Max ids per batch request. **The binding constraint is URL length, not read
# cost**: 50 ids x 37 chars is ~1,850 B of query string, under a conservative
# 2,048 B budget, where 60 would exceed it. On cost grounds alone this could be
# 200 (a 50-id batch measures 10.2 ms), so the number is NOT negotiable by
# measurement and client-side chunking is main-path, not defensive — a large
# sidebar renders 500+ projects (~11 chunks) and the Front Desk rail 130 (3).
MAX_PROJECT_IDS = 50


class BatchRequestError(Exception):
    """A whole-request rejection carrying the exact response body to emit.

    Raised instead of ``HTTPException`` because the contract pins the wire format
    as ``{"error": "...", ...}``; ``HTTPException`` would nest it under
    ``detail``. The route converts this to a ``JSONResponse`` verbatim.
    """

    def __init__(self, status_code: int, body: dict) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(str(body))


def parse_project_ids(raw: list[str]) -> list[str]:
    """Normalize the ``project_ids`` query param into deduped ids.

    Accepts both wire forms and any mix of them: ``?project_ids=a,b,c`` and
    ``?project_ids=a&project_ids=b``. FastAPI hands us ``list[str]``; each
    element is comma-split, stripped, and empty pieces dropped.

    Dedupes preserving first-seen order, and applies the cap **after** dedupe so
    a client that repeats an id is not punished for it.

    Raises:
        BatchRequestError: 400 ``missing_project_ids`` when no usable id remains
            (an empty batch is a client bug, and failing loudly beats returning
            an empty 200 the client renders as "no rooms"); 400
            ``too_many_project_ids`` above :data:`MAX_PROJECT_IDS`.
    """
    ids: list[str] = []
    seen: set[str] = set()
    for element in raw:
        for piece in (element or "").split(","):
            pid = piece.strip()
            if not pid or pid in seen:
                continue
            seen.add(pid)
            ids.append(pid)

    if not ids:
        raise BatchRequestError(400, {"error": "missing_project_ids"})
    if len(ids) > MAX_PROJECT_IDS:
        raise BatchRequestError(
            400, {"error": "too_many_project_ids", "max": MAX_PROJECT_IDS}
        )
    return ids


def accessible_projects(
    projects: dict[str, "Project"],
    user: "User",
    ctx: "ModelContext",
) -> dict[str, "Project"]:
    """Filter resolved projects down to the ones ``user`` may read.

    The same four-clause predicate the sidebar's own project list evaluates
    (the USER branch of ``get_participant_projects``, and
    ``_scoped_projects_for_user``), applied to the <=50 already-resolved projects
    instead of to ``Project.list_all``. Sharing the predicate is the point: a pid
    the client renders but this function rejects would drop a row out of a
    sidebar the user is looking at, and that is the one failure mode this design
    must not have.

    Deliberately does **not** call ``Project.list_all`` — that full-disk sweep is
    the amplifier this whole route was built to route around (22 ms at P=536,
    ~984 ms at P=20,000).

    The three clauses:

    1. ``created_by == user.id`` (owner). **Front Desk host projects pass here** —
       ``_create_fd_host_project`` writes ``created_by = owner.id`` where owner is
       ``foreign_agent.registered_by``, which is the same value the client's
       ``frontDeskSide`` tests to return ``'host'``, so ``host => created_by ==
       you`` holds by construction. No FD clause is needed and none is added.
    2. share-token viewer.
    3. legacy FD requester (``fd_requester_name``). A **migration-window clause
       only**: ``fd_requester_name`` gates on ``surface == "dm"``, explicitly not
       ``"frontdesk"``, and is ``None`` for every live project. Free to keep; it
       is not what admits Front Desk.

    A filename pattern cannot express any of these, which is why resolution is
    keyed on the id and authorization is a separate, explicit step.

    Args:
        projects: ``{requested_id: Project}`` from ``Project.get_many``.
        user: The authenticated caller.
        ctx: ModelContext (for the share-token file location).

    Returns:
        The subset of ``projects`` the caller may read.
    """
    allowed: dict[str, Project] = {}
    # Loaded ONCE for the whole batch. `is_viewer` re-reads the share-token file
    # on every call, so the per-id form would cost one read per non-owned id.
    viewer_ids: set[str] | None = None

    for pid, project in projects.items():
        if project.created_by == user.id:
            allowed[pid] = project
            continue
        if viewer_ids is None:
            viewer_ids = viewer_project_ids(user.id, ctx.participants_dir)
        if project.id in viewer_ids:
            allowed[pid] = project
            continue
        if project.fd_requester_name == user.username:
            allowed[pid] = project
    return allowed


def can_rename_project(project: "Project", user: "User") -> bool:
    """Whether ``user`` may RENAME ``project`` (set its ``display_name``).

    The write-side sibling of :func:`accessible_projects`, and deliberately
    co-located with it: the rename rule is exactly "``accessible_projects``
    minus share-token viewers", and that one divergence is only auditable if the
    two predicates sit where a reader sees both at once. Split across files they
    drift, and the drift is silent.

    True when ANY of:

    1. ``project.created_by == user.id`` — the owner. One clause covers regular
       projects, the user's own DM threads, and the Front Desk *host* end (see
       clause 1 of ``accessible_projects`` for why host implies ``created_by``).
    2. ``project.fd_requester_name == user.username`` — the Front Desk
       *requester* end. The requester owns their side of the conversation but is
       not ``created_by``, which stays the host.

    Otherwise False, and the caller raises **403** — never 401. An authenticated
    user who simply may not rename this thread is not an authentication failure,
    and the web client (``api/client.ts:fetchWithAuth``) reads a 401 as an
    expired token: it refreshes, replays once, and logs the user out on the
    second 401. A 401 here would eject the user to the login screen instead of
    showing an inline error.

    Takes no ``ModelContext``, unlike the read predicate, because it never
    consults the share-token file: viewer status can only ever *deny* here, and
    a viewer already fails both clauses. Share links are read-only
    everywhere in the app (``post_user_message`` 403s viewers too) and a rename
    is a write.

    Args:
        project: The project being renamed.
        user: The authenticated caller.

    Returns:
        True if the rename is authorized.
    """
    if project.created_by == user.id:
        return True
    return project.fd_requester_name == user.username


def can_complete_project(project: "Project", user: "User") -> bool:
    """Whether ``user`` may MARK ``project`` DONE (``POST /projects/{id}/complete``).

    The caller is the desk card's **Done** button. Pressing it now does two
    things — clears the card from the owner's desk *and* moves the project to
    COMPLETED — so a route that only ever accepted the coordinator's agent
    token needs a user branch, and this is the predicate behind it.

    **The rule is DEFINED to be the rename rule**, and it delegates instead of
    restating it so the two cannot drift:

    * Both are writes on the thread *as a whole*, not on its contents.
    * Both must admit the Front Desk *requester*. Their end of the conversation
      carries an ordinary desk card with an ordinary Done button on it, and
      ``created_by`` is the host, so the ``fd_requester_name`` clause is the
      only thing that lets them clear their own card.
    * Both must exclude share-token viewers. Share links are read-only
      everywhere in the app, and a completion is a write.

    It stays a separate NAMED predicate anyway: ``can_rename_project(...)``
    guarding a completion reads as a copy-paste bug at the call site, and if
    the two rules ever do diverge, this is the one line that changes.

    Args:
        project: The project being completed.
        user: The authenticated caller.

    Returns:
        True if the completion is authorized. Otherwise the caller raises
        **403** — never 401, for the reason spelled out in
        :func:`can_rename_project`.
    """
    return can_rename_project(project, user)
