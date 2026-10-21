# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/_fd_routing.py

Server-side shared helper for "user-initiated cross-agent routing" (Primitive 4).

Two callers:

- ``server/routes/chatrooms.py``: when a coordinator's ``create_room`` action
  invites a foreign agent (different owner) into a non-FD project, the chatroom
  is created with the foreign agent marked ``external=true`` AND this helper
  is called to ensure an FD project + tunnel binding so messages mirror via FD.
- ``server/routes/messages.py``: when a user types ``@foreign-agent`` in the
  ``user-communication`` room of a regular project, this helper is called to
  ensure the same FD + binding pair so the typed message mirrors via FD.

The actual mirroring is done by ``TunnelSubscriber`` (`clawmeets/server/tunnel_subscriber.py`)
which reads the binding store on every MESSAGE append. This helper only
creates the binding — it does NOT itself mirror.

Idempotent: re-runs are no-ops once the binding exists.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import HTTPException

from clawmeets.models.tunnel_binding import (
    TunnelBinding,
    find_bindings_for_project,
    save_binding,
)

if TYPE_CHECKING:
    from clawmeets.models.agent import Agent
    from clawmeets.models.project import Project
    from clawmeets.models.user import User
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


async def ensure_fd_routing_for_foreign_agents(
    ctx: "ServerContext",
    *,
    local_project: "Project",
    local_room: str,
    foreign_agents: list["Agent"],
    local_user: "User | None" = None,
    local_agent: "Agent | None" = None,
) -> None:
    """For each already-resolved foreign agent, ensure (FD project, tunnel binding).

    Exactly one of ``local_user`` or ``local_agent`` must be set; that one is
    the **requester principal** for any newly-created host project and binding.

    Idempotency lives entirely in the binding, keyed on
    ``(local_project.id, local_room, foreign.id)`` (DD2). The lookup runs BEFORE
    any host-project creation (must-fix ordering): if a binding already exists
    for this local project + room + foreign agent, follow-ups stay in that
    host thread; otherwise a BRAND-NEW host-side project is minted (fresh UUID,
    unique slug — ``_create_fd_host_project``) and bound. Two different local
    projects reaching the same foreign agent therefore get two distinct host
    threads (fixes the N->1 collapse, defect ①) — the requester's originating
    ``local_project_id`` is folded into the key.

    Caller is responsible for the "foreign" filter and the requester-side gate.
    Errors are logged + swallowed per-agent (e.g. a non-discoverable agent
    yields a 404 from the host-create helper — we skip that agent and continue).
    The caller's primary path is never blocked by routing failures.
    """
    if (local_user is None) == (local_agent is None):
        raise ValueError(
            "ensure_fd_routing_for_foreign_agents requires exactly one of "
            "local_user or local_agent"
        )

    # Local import to avoid a cycle: projects.py imports this module's
    # neighbors at registration time.
    from clawmeets.server.routes.projects import _create_fd_host_project

    if local_user is not None:
        requester_id = local_user.id
        requester_kind = "user"
        requester_label = local_user.username
    else:
        assert local_agent is not None  # for type-checker
        requester_id = local_agent.id
        requester_kind = "agent"
        requester_label = local_agent.name

    for foreign in foreign_agents:
        # Binding lookup FIRST (idempotency key = local project + room +
        # foreign agent). If it exists, the thread is already wired -> reuse it.
        existing = next(
            (
                b
                for b in find_bindings_for_project(local_project.id, ctx.model_ctx)
                if b.local_room == local_room and b.foreign_agent_id == foreign.id
            ),
            None,
        )
        if existing is not None:
            continue

        # No binding yet -> mint a FRESH, distinct host-side project and bind.
        # Key the host slug by the requester's originating (sender) project so
        # the host thread reads as {requester}-fd-{short}-{sender_project_id}
        # and is 1:1 with this sender conversation (the binding, keyed on the
        # same local_project.id, is the authoritative dedup).
        try:
            fd_project = await _create_fd_host_project(
                ctx, foreign, requester_label, sender_project_id=local_project.id,
                requester_user_id=(
                    local_user.id if local_user is not None else local_agent.registered_by
                ),
            )
        except HTTPException as e:
            logger.warning(
                "fd_routing: host-project create for @%s failed (%s); skipping",
                foreign.name,
                getattr(e, "detail", str(e)),
            )
            continue
        except Exception:
            logger.exception(
                "fd_routing: unexpected error creating host project for @%s",
                foreign.name,
            )
            continue

        save_binding(
            TunnelBinding(
                local_project_id=local_project.id,
                local_room=local_room,
                fd_project_id=fd_project.id,
                fd_project_name=fd_project.name,
                foreign_agent_id=foreign.id,
                foreign_agent_name=foreign.name,
                requester_id=requester_id,
                requester_kind=requester_kind,
            ),
            ctx.model_ctx,
        )
        logger.info(
            "fd_routing: bound %s/%s ↔ host FD %s (foreign=%s, requester=%s/%s)",
            local_project.id,
            local_room,
            fd_project.id,
            foreign.name,
            requester_kind,
            requester_label,
        )
