# SPDX-License-Identifier: BUSL-1.1
"""The own-coordinator rule (plan-owner-isolation section 4).

A project's coordinator is either its owner (``coordinator_id ==
created_by``, a user) or an agent the owner registered. A hub stand-in (an id
with ``~``), another account's agent and an unknown id never are. Requester
ends name their outside party as ``counterpart_id`` instead.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from clawmeets.models.agent import Agent
from clawmeets.models.project import STAND_IN_SEPARATOR

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext

CODE = "foreign_coordinator"
MESSAGE = "Only this account's own agents can coordinate its projects."


def is_own_coordinator(model_ctx: "ModelContext", *, project_owner_id: Optional[str],
                       coordinator_id: Optional[str]) -> bool:
    """True iff the coordinator is the project's owner or an agent the owner
    registered. Pure over the registry."""
    if not project_owner_id or not coordinator_id or STAND_IN_SEPARATOR in coordinator_id:
        return False
    if coordinator_id == project_owner_id:
        return True
    agent = Agent.get(coordinator_id, model_ctx)
    return agent is not None and agent.registered_by == project_owner_id


class ForeignCoordinator(Exception):
    """An append that would make a stand-in, another account's agent or an
    unknown id the coordinator of a project. Rendered ``foreign_coordinator``
    [403] by the app's exception handler."""


def foreign_coordinator(message: str = MESSAGE):
    from clawmeets.server.hub.browser import HubError

    return HubError(CODE, message)


def coordinator_guard(model_ctx: "ModelContext"):
    """The append-guard half the server installs on its runloops (never the
    shared runloop class, so a runner replica replaying old entries never
    raises): PROJECT_CREATED and PROJECT_COORDINATOR_REASSIGNED are refused
    unless their coordinator is the project's owner or the owner's agent.
    Covers ``append`` and ``append_batch`` (the tunnel's path) alike."""
    from clawmeets.sync.changelog import ChangelogEntryType

    def guard(project_id: str, entries, _ticket) -> None:
        owner: Optional[str] = None
        for entry_type, payload in entries:
            if entry_type == ChangelogEntryType.PROJECT_CREATED:
                owner = payload.created_by
            elif entry_type == ChangelogEntryType.PROJECT_COORDINATOR_REASSIGNED:
                from clawmeets.models.project import Project

                try:
                    owner = Project.get(project_id, model_ctx).created_by
                except ValueError:
                    owner = None
            else:
                continue
            if not is_own_coordinator(model_ctx, project_owner_id=owner, coordinator_id=payload.coordinator_id):
                raise ForeignCoordinator(
                    f"{entry_type.value} in {project_id[:8]}: coordinator "
                    f"{(payload.coordinator_id or '')[:12]!r} is not the owner or the owner's agent"
                )

    return guard


def compose_guards(*guards):
    """One append guard running each in turn (the ingress guard, then this)."""
    def guard(project_id, entries, ticket) -> None:
        for g in guards:
            g(project_id, entries, ticket)
    return guard


def require_own_actor(model_ctx: "ModelContext", project) -> None:
    """Room create and invite: the coordinator token's holder must also be
    the owner's agent (defence in depth: after the start-up migration and
    with the append guard armed, no project has a foreign coordinator)."""
    if not is_own_coordinator(model_ctx, project_owner_id=project.created_by,
                              coordinator_id=project.coordinator_id):
        raise foreign_coordinator()


def clamp_foreign_expects(model_ctx: "ModelContext", project, author_id: str, expects: list[str], *,
                          reply_to_author: Optional[str] = None) -> list[str]:
    """``expects_response_from`` on a row whose author is outside (another
    account, a stand-in, a requester): it may name only the project's
    coordinator, or ``reply_to_author`` (the own agent whose message this
    replies to; on the tunnel, the binding's responder, which is the host
    coordinator). The rest is dropped and logged. An inside author's list is
    returned unchanged."""
    import logging

    from clawmeets.models.provenance import outside_author

    if outside_author(project, author_id, model_ctx) is None:
        return list(expects)
    allowed = {project.coordinator_id, reply_to_author} - {None}
    kept = [pid for pid in expects if pid in allowed]
    if len(kept) != len(expects):
        logging.getLogger("clawmeets.server.coordinator_rule").info(
            "clamped expects of outside author %s in %s: dropped %d",
            author_id[:12], project.id[:8], len(expects) - len(kept))
    return kept
