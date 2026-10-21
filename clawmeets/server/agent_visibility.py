# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/agent_visibility.py
Making an agent public or private, and telling the runners that care.

Public (``discoverable_through_registry``) is still its own setting on the
card, separate from a Hub listing. In the web app the Hub switch is the one
control that changes it (``routes/hub_channels.py``: turning the switch on
makes the agent public, turning it off makes it private); ``PUT
/agents/{id}`` and the CLI change it directly. Both go through
:func:`set_agent_public`, so the side effects are the same either way:

- Making an agent private clears owner isolation (it needs a public agent;
  republishing needs a fresh confirm, plan-owner-isolation section 2).
- Every other runner of the owner gets ``AGENT_REGISTRY_CHANGE`` so its
  AGENTS.md roster is rewritten.

``AGENT_WRITE_LOCK`` serializes every read-modify-write of a card made by a
route, so two edits never lose one another's fields.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Iterable, Optional

from clawmeets.api.control import AgentRegistryChangePayload, ControlEnvelope, ControlMessageType
from clawmeets.models.agent import Agent
from clawmeets.models.project import STAND_IN_SEPARATOR, Project

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

AGENT_WRITE_LOCK = asyncio.Lock()


def visibility_fields(public: bool) -> dict:
    """The card fields one public/private change writes."""
    fields: dict = {"discoverable_through_registry": public}
    if not public:
        fields["owner_isolated"] = False
    return fields


async def fan_out_registry_change(
    ctx: "ServerContext",
    *,
    changed_agent_id: str,
    changed_agent_name: str,
    owner_user_id: Optional[str],
    action: str,
    also_users: Iterable[str] = (),
) -> None:
    """``AGENT_REGISTRY_CHANGE`` to every runner of ``owner_user_id`` (and of
    ``also_users``) except the changed agent's own, so their peer-card cache
    and AGENTS.md refresh. No other account's runners are told."""
    users = {u for u in (owner_user_id, *also_users) if u}
    if not users:
        return
    peers = [
        a.id for a in Agent.list_all(ctx.model_ctx, include_private=True)
        if a.registered_by in users and a.id != changed_agent_id
    ]
    if not peers:
        return
    envelope = ControlEnvelope(
        type=ControlMessageType.AGENT_REGISTRY_CHANGE,
        payload=AgentRegistryChangePayload(
            changed_agent_id=changed_agent_id, changed_agent_name=changed_agent_name, action=action),
    )
    delivered = await ctx.ws_hub.send_to_many(peers, envelope)
    logger.debug("AGENT_REGISTRY_CHANGE(%s) for %s delivered to %s/%s peer runner(s)",
                 action, changed_agent_name, delivered, len(peers))


async def set_agent_public(ctx: "ServerContext", agent: Agent, public: bool) -> bool:
    """Make ``agent`` public or private. True if the setting changed (only
    then are the runners told: the owner's, and those of every user who
    retained it, whose rosters list it only while it is public)."""
    async with AGENT_WRITE_LOCK:
        if agent.is_discoverable == public:
            return False
        agent.update_card(**visibility_fields(public))
    await fan_out_registry_change(
        ctx, changed_agent_id=agent.id, changed_agent_name=agent.name,
        owner_user_id=agent.registered_by, action="update", also_users=retainers_of(ctx, agent.id),
    )
    return True


def retainers_of(ctx: "ServerContext", agent_id: str) -> list[str]:
    """The users who retained this local agent (``local_retained``)."""
    from clawmeets.server.channels.hub_store import HubStore

    store = getattr(ctx, "channel_store", None)
    return HubStore(store).local_retainers(agent_id) if store is not None else []


def front_desk_requester_threads(model_ctx: "ModelContext") -> list[Project]:
    """Every requester end of a same-server Front Desk conversation: a
    project another user owns whose counterpart is a LOCAL agent (a hub
    thread's counterpart is a stand-in, ``STAND_IN_SEPARATOR`` in its id)."""
    return [
        p for p in Project.list_all(model_ctx)
        if p.surface == "frontdesk" and p.created_by and p.counterpart_id
        and STAND_IN_SEPARATOR not in p.counterpart_id
    ]


def local_conversation_count(model_ctx: "ModelContext", agent: Agent) -> int:
    """How many people on this server have a conversation with ``agent``
    (its owner excluded): what making it private cuts off."""
    return len({
        p.created_by for p in front_desk_requester_threads(model_ctx)
        if p.counterpart_id == agent.id and p.created_by != agent.registered_by
    })
