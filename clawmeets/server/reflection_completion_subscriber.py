# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/reflection_completion_subscriber.py

Detect reflection trigger replies and update the agent's last-reflection timestamp.

Lives **server-side only** — registered as a ``ChangelogSubscriber`` on every
project's runloop (see ``server/app.py``). The reflection scheduler posts trigger
messages tagged with ``REFLECT_TRIGGER_MARKER``. When an agent replies to one
(its reply's ``source_version`` points at the trigger), this subscriber loads
the source message from the chatroom's ``CHATS.ndjson``, bumps
``Agent.last_reflected_at`` on the server's agent card, and broadcasts a narrow
``AGENT_CARD_UPDATE`` envelope to the agent's owner so the web UI's "Memory &
Reflection" panel live-refreshes without a page reload:

The marker is duplicated here (rather than imported from
``clawmeets.server.reflection_scheduler``) to
keep the subscriber's module boundary small and prevent import cycles.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from clawmeets.api.control import (
    AgentCardUpdatePayload,
    ControlEnvelope,
    ControlMessageType,
)
from clawmeets.models.chat_message import ChatMessage
from clawmeets.sync.changelog import ChangelogEntryType, MessagePayload
from clawmeets.sync.subscriber import ChangelogSubscriber

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.ws_hub import WSHub
    from clawmeets.sync.changelog import ChangelogEntry

logger = logging.getLogger("clawmeets.server.reflection_completion")

# Must match clawmeets.server.reflection_scheduler.REFLECT_TRIGGER_MARKER.
REFLECT_TRIGGER_MARKER = "<!-- clawmeets:reflect-trigger -->"


class ReflectionCompletionSubscriber(ChangelogSubscriber):
    """Update Agent.last_reflected_at on reflect-trigger
    replies and push an AGENT_CARD_UPDATE to the owner.

    Cheap path: only inspects MESSAGE entries that
      (a) live in a `user-communication` room (where DM threads run in
          per-agent DM-shaped projects),
      (b) carry a `source_version` (i.e., are a reply), and
      (c) are not ack messages.
    For those, the source message is loaded from the chatroom's CHATS.ndjson
    and matched against the trigger markers. If a marker matches, the sending
    agent's card.json is updated on the corresponding cursor and an
    ``AGENT_CARD_UPDATE`` envelope is broadcast to ``agent.registered_by``
    (owner-only — the runner does not read these cursors).
    """

    def __init__(self, model_ctx: "ModelContext") -> None:
        self._model_ctx = model_ctx
        self._ws_hub: "WSHub | None" = None

    def bind_ws_hub(self, ws_hub: "WSHub") -> None:
        """Late-bind the WS hub (used for AGENT_CARD_UPDATE on cursor bump)."""
        self._ws_hub = ws_hub

    async def on_entry(
        self,
        entry: "ChangelogEntry",
        project_id: str,
        project_name: str,
    ) -> None:
        if entry.entry_type != ChangelogEntryType.MESSAGE:
            return
        payload = entry.payload
        if not isinstance(payload, MessagePayload):
            return
        if payload.is_ack:
            return
        if entry.source_version is None:
            return
        if payload.chatroom_name != "user-communication":
            return
        if not payload.from_participant_id:
            return

        # Lazy imports to keep the module boundary small.
        from clawmeets.models.chatroom import Chatroom
        from clawmeets.models.agent import Agent

        chatroom = Chatroom.get(project_id, payload.chatroom_name, self._model_ctx)
        if chatroom is None:
            return

        source_msg = _find_message_by_version(chatroom, entry.source_version)
        if source_msg is None:
            return

        if REFLECT_TRIGGER_MARKER not in source_msg.content:
            return

        agent = Agent.get(payload.from_participant_id, self._model_ctx)
        if agent is None:
            logger.warning(
                f"Reflect reply from unknown "
                f"agent_id={payload.from_participant_id[:8]}; skipping cursor update"
            )
            return

        ts_iso = payload.ts.isoformat()
        agent.update_last_reflected_at(payload.ts)
        logger.info(
            f"Updated last_reflected_at for agent={agent.name!r} to {ts_iso}"
        )

        await self._broadcast_card_update(agent, ts_iso)

    async def _broadcast_card_update(self, agent, ts_iso: str) -> None:
        """Push the cursor bump to the agent's owner UI.

        Owner-only delivery — the runner does not read these cursors. If a
        runner-side consumer ever appears, extend this to
        ``send_to_many([agent.id, agent.registered_by], envelope)``.
        """
        if self._ws_hub is None or not agent.registered_by:
            return
        envelope = ControlEnvelope(
            type=ControlMessageType.AGENT_CARD_UPDATE,
            payload=AgentCardUpdatePayload(
                agent_id=agent.id,
                agent_name=agent.name,
                last_reflected_at=ts_iso,
            ),
        )
        try:
            await self._ws_hub.send_to(agent.registered_by, envelope)
        except Exception:
            logger.exception(
                "reflection_completion: WS push failed for agent=%s",
                agent.name,
            )


def _find_message_by_version(chatroom, version: int) -> ChatMessage | None:
    """Locate a ChatMessage in CHATS.ndjson by changelog version. None if not found."""
    for log_entry in chatroom.get_log_entries():
        if isinstance(log_entry, ChatMessage) and log_entry.version == version:
            return log_entry
    return None
