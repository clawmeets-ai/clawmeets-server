# SPDX-License-Identifier: BUSL-1.1
"""What an agent's runners can currently do, keyed on the agent.

A runner advertises optional abilities in its socket auth frame
(``capabilities``). For most of them the question is "can the socket I am
about to use answer this frame", and the home-folder relay asks exactly that
of one socket. Isolation is a different question: "may this AGENT be handed a
stranger's conversation". Any of its live runners may pick the work up (the
changelog fan-out goes to every socket, and every runner pulls on reconnect),
so the answer is the intersection across all of them: one old runner makes
the agent incapable.

A settings change that touches the provider, model or login withdraws the
capability until the runner has re-run its canaries and advertised again on a
new socket (``clear``). Nothing here persists: a capability not backed by a
live socket does not exist.
"""
from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING, Iterable, Optional

if TYPE_CHECKING:
    from clawmeets.server.ws_hub import Hub

#: The ability to run a sandboxed, scoped turn. Mirrors the runner's constant
#: (``clawmeets.api.turn_protocol.ISOLATED_TURNS_CAPABILITY``); kept as a literal
#: here so the server never depends on a runner module for a wire string.
ISOLATED_TURNS = "isolated_turns.v1"

#: ``local_settings`` keys whose change invalidates the canaries.
CAPABILITY_RESET_KEYS = frozenset({
    "llm_provider", "llm_model", "llm_api_key", "llm_base_url", "model_configs",
    "default_model_config_name",
})


def settings_fingerprint(card: dict) -> str:
    """A digest of what decides which model, through which provider and
    login, a turn runs on: the mirrored provider/model/endpoint in
    ``local_settings`` and the default model config's key. A change
    invalidates the canaries the runner ran for the old one; any other
    settings write (knowledge dir, storage, MCP configs) leaves it alone."""
    settings = card.get("local_settings") or {}
    default_name = card.get("default_model_config_name")
    default_cfg = next(
        (c for c in card.get("model_configs") or [] if isinstance(c, dict) and c.get("name") == default_name),
        None,
    )
    key = (default_cfg or {}).get("api_key") or settings.get("llm_api_key")
    material = {
        "provider": settings.get("llm_provider"),
        "model": settings.get("llm_model"),
        "base_url": settings.get("llm_base_url"),
        "key": hashlib.sha256(str(key).encode()).hexdigest() if key else None,
    }
    return hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()


class AgentCapabilityRegistry:
    """Current capability set per agent: the intersection over its live sockets."""

    def __init__(self, hub: "Hub") -> None:
        self._hub = hub
        # agent_id -> connect sequence at the time of the last clear. Sockets
        # connected at or before it count as advertising nothing.
        self._cleared_at_seq: dict[str, int] = {}
        # agent_id -> settings_fingerprint last seen
        self._fingerprints: dict[str, str] = {}

    def _live_infos(self, agent_id: str) -> list[dict]:
        conns = getattr(self._hub, "_conns", {}).get(agent_id) or ()
        info = getattr(self._hub, "_conn_info", {})
        return [info[q] for q in conns if q in info]

    def current(self, agent_id: str) -> frozenset[str]:
        """The capabilities every live socket of this agent advertises, minus
        anything advertised before the last ``clear``. Empty when offline."""
        infos = self._live_infos(agent_id)
        if not infos:
            return frozenset()
        floor = self._cleared_at_seq.get(agent_id)
        sets = []
        for info in infos:
            if floor is not None and info.get("seq", -1) <= floor:
                return frozenset()
            sets.append(frozenset(info.get("capabilities") or ()))
        return frozenset.intersection(*sets)

    def has(self, agent_id: str, capability: str) -> bool:
        return capability in self.current(agent_id)

    def clear(self, agent_id: str) -> None:
        """Withdraw every capability of the agent's current sockets until a
        newer socket advertises again."""
        seqs = [info.get("seq", -1) for info in self._live_infos(agent_id)]
        self._cleared_at_seq[agent_id] = max(seqs, default=-1)

    def observe_card(self, agent_id: str, card: Optional[dict]) -> bool:
        """Record the card's provider/model/login fingerprint; clear the
        agent's capability when it differs from the last one seen. Called on
        connect and after every settings write. True when cleared."""
        if card is None:
            return False
        fp = settings_fingerprint(card)
        previous = self._fingerprints.get(agent_id)
        self._fingerprints[agent_id] = fp
        if previous is not None and previous != fp:
            self.clear(agent_id)
            return True
        return False

    def settings_changed(self, agent_id: str, changed_keys: Iterable[str]) -> bool:
        """Clear on a provider, model or login change. True when cleared."""
        if CAPABILITY_RESET_KEYS.intersection(changed_keys):
            self.clear(agent_id)
            return True
        return False
