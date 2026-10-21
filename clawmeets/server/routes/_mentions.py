# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/_mentions.py
Shared @mention resolution for message routes.

Both the coordinator/agent post path (``post_message``) and the
user-communication path (``send_message_as_user``) resolve @mentions the same
way: parse the names out of the content and resolve each against the room's
namespace. Only names that resolve to a real agent participant of THIS room
become addressed recipients (a batch opens for them). Every other ``@token`` —
an unknown name, a typo, an agent outside the room, or a bare code/prose token
like ``@property`` — is simply left as plain text and ignored. There is no
valid-agent-name validation and no rejection: a message with unresolvable
mentions still posts, addressing only whoever actually resolved.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from clawmeets.models.agent import Agent

if TYPE_CHECKING:
    from clawmeets.models.chatroom import Chatroom
    from clawmeets.models.context import ModelContext


def resolve_room_mentions(
    room: "Chatroom",
    content: Optional[str],
    ctx: "ModelContext",
) -> list[str]:
    """Resolve every @mention in ``content`` to addressable room participants.

    Returns the deduped, membership-checked participant IDs — the agents in
    THIS room that were @mentioned. Names that don't resolve to any agent, or
    resolve to an agent that isn't a participant of this room, are skipped
    silently (treated as plain text). Self-exclusion (dropping a sender that
    @mentions itself) is left to the caller. When ``content`` has no mentions
    this short-circuits to ``[]``.
    """
    from clawmeets.models.chatroom import parse_mentions

    mentions = parse_mentions(content)
    names = mentions.local  # deduped, order-preserving
    if not names and not mentions.qualified:
        return []

    members = set(room.participants)
    resolved: list[str] = []
    seen_ids: set[str] = set()
    # ``@name@deployment``: a retained hub agent's stand-in member of this
    # room (its bridge active), so the batch waits for its relayed reply.
    if mentions.qualified:
        rows = room.participant_rows()
        for name, deployment in mentions.qualified:
            pid = room.stand_in_member(name, deployment)
            if pid is not None and pid not in seen_ids and (rows.get(pid) or {}).get("bridge_state") == "active":
                seen_ids.add(pid)
                resolved.append(pid)
    for name in names:
        agent = room.resolve_mention(name)
        if agent is None:
            # Fall back to treating the mention as a raw agent id (@agent-id).
            agent = Agent.get(name, ctx)
        # Only agents that are actually participants of this room can answer;
        # anything else (unknown name / out-of-room agent) is ignored.
        if agent is not None and agent.id in members and agent.id not in seen_ids:
            seen_ids.add(agent.id)
            resolved.append(agent.id)
    return resolved
