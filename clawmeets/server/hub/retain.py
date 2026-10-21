# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/retain.py
Retained hub agents: a user pins a remote agent so it can later be invited
into a workroom (the room bridge, ``room_bridge.py``). Design section 4.2.

**Storage** is ``hub_retained`` (``HubStore``), one row per (user, stand-in)
with a state: ``active``, ``unlisted`` or ``identity_changed``.

**Retain** (user JWT only; the route refuses every agent token with
``user_only``) checks the agent's listing with the hub
(``HubDirectory.agent``), pins its deployment's key chain and upserts its
stand-in (``RemoteAgent``) exactly as starting a conversation does, then
writes the row ``active``. Idempotent. Refused for a root whose identity
changed.

**Agents of this server** (the directory's ``is_local``) are retained too,
as a pin in ``local_retained`` by local agent id: no stand-in, no hub
thread, no hub round trip; messaging one opens the ordinary DM. One must be
public and another account's (``own_agent`` for the user's own). The
list shows a local agent that is no longer public as ``unlisted`` and drops
one that was deleted. A local agent's id in these routes is its hub form
(``{genesis}~{name}``) or, with no registration to give it one,
``local:{agent_id}`` (:func:`local_hub_id`). ``migrate_local_retains`` (once,
at start) retains every same-server agent a user already had a Front Desk
conversation with.

**Statements never revive.** ``mark`` moves rows away from ``active`` when
the hub sends a signed ``agent_delisted`` (``unlisted``) or a key of the
agent's root is revoked (``identity_changed``). Nothing else writes the
state: a later search result or listing is not a signed statement, so it
never sets a row back to ``active``; only a new retain does.

**Roster feed.** Retain, unretain and every mark fan out
``AGENT_REGISTRY_CHANGE`` to the affected user's runners, whose peer sync
reads ``GET /api/hub/retained``.

**Unretain** deletes the row in one transaction with
``unretain_effects``, the hook the room bridge extends (participant rows
inactive, queued bridge envelopes cancelled).
"""
from __future__ import annotations

import logging
import sqlite3
from typing import TYPE_CHECKING, Optional

from clawmeets.api.control import AgentRegistryChangePayload, ControlEnvelope, ControlMessageType
from clawmeets.hub_protocol.ids import parse_agent_ref
from clawmeets.models.agent import Agent
from clawmeets.server.channels.hub_store import (
    RETAIN_IDENTITY_CHANGED,
    RETAIN_UNLISTED,
    HubStore,
    RetainedRow,
)

from . import keys
from .browser import HubError, RetainedAgent

if TYPE_CHECKING:
    from pathlib import Path

    from clawmeets.models.user import User
    from clawmeets.server.context import ServerContext

    from .runtime import HubRuntime

logger = logging.getLogger(__name__)

#: The id of a local agent in the retain routes when this server has no hub
#: registration to give it a hub id.
LOCAL_ID_PREFIX = "local:"

#: ``AgentRegistryChangePayload.action`` values sent for retained agents.
ACTION_RETAIN = "retain"
ACTION_UNRETAIN = "unretain"
ACTION_RETAIN_STATE = "retain_state"


def retained_out(row: RetainedRow, live_rooms: int = 0) -> RetainedAgent:
    return RetainedAgent(
        hub_agent_id=row.stand_in_id, name=row.agent_name, deployment_name=row.deployment_name,
        deployment_fingerprint=row.genesis_fp, description=row.description,
        capabilities=list(row.capabilities), retained_at=row.retained_at, state=row.state,
        live_rooms=live_rooms,
    )


def local_hub_id(agent: Agent, genesis_fp: Optional[str]) -> str:
    """A local agent's id in the retain routes and lists."""
    return f"{genesis_fp}~{agent.name}" if genesis_fp else f"{LOCAL_ID_PREFIX}{agent.id}"


def local_retained_out(agent: Agent, retained_at: float, *, genesis_fp: Optional[str],
                       deployment_name: str) -> RetainedAgent:
    return RetainedAgent(
        hub_agent_id=local_hub_id(agent, genesis_fp), name=agent.name, deployment_name=deployment_name,
        deployment_fingerprint=genesis_fp or "", description=agent.description or "",
        capabilities=[c for c in (agent.capabilities or []) if isinstance(c, str)],
        retained_at=retained_at, state="active" if agent.is_discoverable else RETAIN_UNLISTED,
        live_rooms=0, is_local=True, agent_id=agent.id,
    )


class RetainStore:
    def __init__(self, ctx: "ServerContext", hub: HubStore, runtime: Optional["HubRuntime"] = None) -> None:
        self._ctx = ctx
        self.hub = hub
        self.runtime = runtime

    # ── retain / unretain ────────────────────────────────────────────────

    async def retain(self, user: "User", hub_agent_id: str) -> RetainedAgent:
        """Pin, upsert the stand-in, write the row active; idempotent."""
        local = self._local_agent(hub_agent_id)
        if local is not None:
            return await self.retain_local(user, local)
        runtime = self.runtime
        if runtime is None:
            raise HubError("hub_off_on_server", "the hub is off on this server")
        try:
            ref = parse_agent_ref(hub_agent_id)
        except ValueError:
            raise HubError("invalid_agent_id", "not a hub agent id") from None
        reg = runtime.registration()
        if reg is not None and ref.deployment_fingerprint == reg.genesis_fp:
            raise HubError("agent_not_found", "no such agent on this server")
        await runtime.require_live(send=False)
        try:
            lookup = await runtime.directory.agent(user.id, hub_agent_id)
        except HubError as exc:
            if exc.code == "agent_unlisted":
                exc.status = 410
            raise
        detail = lookup.detail
        client = runtime.client
        if client is None:
            raise HubError("hub_unreachable", "the hub cannot be reached")
        now = runtime._now()
        try:
            pin = await keys.look_up_and_pin(
                client.request, self.hub, runtime.config, now=now, deployment_id=lookup.deployment_id,
                fingerprint=ref.deployment_fingerprint, deployment_name=detail.deployment_name,
            )
        except (keys.ChainUnverified, ConnectionError) as exc:
            logger.warning("Hub retain: the target's key chain does not check out: %s", exc)
            raise HubError("hub_unreachable", "the agent's server could not be verified") from None
        if pin.genesis_fp != ref.deployment_fingerprint:
            raise HubError("invalid_agent_id", "the id is not the deployment's root")
        if pin.identity_changed_at is not None:
            raise HubError("identity_changed", "that server's identity changed")
        head = self.hub.chain(pin.genesis_fp)[-1]
        stand_in = self.hub.upsert_remote_agent(
            genesis_fp=pin.genesis_fp, agent_name=ref.agent_name,
            deployment_name=detail.deployment_name or pin.deployment_name or pin.deployment_id or pin.genesis_fp,
            current_fp=head.fingerprint, deployment_id=pin.deployment_id, now=now,
        )
        row = self.hub.retain(user_id=user.id, stand_in_id=stand_in.id, description=detail.description,
                              capabilities=list(detail.capabilities), now=now)
        await self.fan_out([user.id], stand_in.id, stand_in.display, ACTION_RETAIN)
        return retained_out(row)

    async def unretain(self, user: "User", hub_agent_id: str) -> None:
        """Delete the row and run ``unretain_effects`` in one transaction;
        ``not_retained`` when there is no row."""
        local = self._local_agent(hub_agent_id)
        if local is not None:
            if not self.hub.delete_local_retained(user.id, local.id):
                raise HubError("not_retained", "this agent is not retained")
            await self.fan_out([user.id], local.id, local.name, ACTION_UNRETAIN)
            return
        stand_in = self.hub.remote_agent(hub_agent_id)
        deleted = self.hub.delete_retained(
            user.id, hub_agent_id, also=lambda db: self.unretain_effects(db, user.id, hub_agent_id))
        if not deleted:
            raise HubError("not_retained", "this agent is not retained")
        name = stand_in.display if stand_in is not None else hub_agent_id
        if self.runtime is not None:
            # The row is gone (bridge_allowed is false from here on): then the
            # rooms see it — participant rows inactive, slots closed, notes.
            await self._bridge_rows_changed(self._cancelled)
            await self.runtime.bridge.deactivate([user.id], hub_agent_id, "unretained")
        await self.fan_out([user.id], hub_agent_id, name, ACTION_UNRETAIN)

    def unretain_effects(self, db: sqlite3.Connection, user_id: str, stand_in_id: str) -> None:
        """What else an unretain changes, inside its transaction: every
        not-yet-sent bridge envelope of the user with this stand-in is
        cancelled (``cancelled_unretained``); the drain's re-check of
        ``bridge_allowed`` catches a send racing it."""
        self._cancelled = self.hub.cancel_bridge_sends(db, user_id, stand_in_id, now=self._now())

    _cancelled: list[str] = []

    def _now(self) -> float:
        import time

        return self.runtime._now() if self.runtime is not None else time.time()

    async def _bridge_rows_changed(self, row_ids: list[str]) -> None:
        gateway = getattr(self.runtime, "gateway", None) if self.runtime is not None else None
        for row_id in row_ids:
            try:
                await gateway._hub_row_changed(row_id)
            except Exception as exc:  # noqa: BLE001 — a push never undoes the cancel
                logger.warning("Bridge cancel push failed: %s", type(exc).__name__)
        self._cancelled = []

    def list_for(self, user_id: str) -> list[RetainedAgent]:
        """Both kinds, oldest first: remote agents, then this server's."""
        remote = [retained_out(r, self.hub.live_bridge_rooms(user_id, r.stand_in_id))
                  for r in self.hub.retained_for(user_id)]
        genesis, deployment_name = self._own_identity()
        model_ctx = self._ctx.model_ctx
        local = []
        for agent_id, retained_at in self.hub.local_retained_for(user_id):
            agent = Agent.get(agent_id, model_ctx)
            if agent is not None:                    # a deleted agent drops out
                local.append(local_retained_out(agent, retained_at, genesis_fp=genesis,
                                                deployment_name=deployment_name))
        return remote + local

    def local_retained_ids(self, user_id: str) -> set[str]:
        """The local agent ids the user retained (any state)."""
        return {agent_id for agent_id, _ in self.hub.local_retained_for(user_id)}

    def retained_hub_ids(self, user_id: str, hub_agent_ids: list[str]) -> set[str]:
        """Which of ``hub_agent_ids`` (directory ids, either kind) the user
        retained: remote rows ``active``, local agents still public."""
        found = self.hub.active_retained_ids(user_id, hub_agent_ids)
        wanted = set(hub_agent_ids) - found
        if wanted:
            genesis, _ = self._own_identity()
            model_ctx = self._ctx.model_ctx
            for agent_id in self.local_retained_ids(user_id):
                agent = Agent.get(agent_id, model_ctx)
                if agent is not None and agent.is_discoverable and local_hub_id(agent, genesis) in wanted:
                    found.add(local_hub_id(agent, genesis))
        return found

    async def retain_local(self, user: "User", agent: Agent) -> RetainedAgent:
        """Pin another account's public agent of this server; idempotent."""
        if agent.registered_by == user.id:
            raise HubError("own_agent", "this agent is already yours")
        if not agent.is_discoverable:
            raise HubError("agent_not_found", "no such agent on this server")
        retained_at = self.hub.retain_local(user.id, agent.id, now=self._now())
        await self.fan_out([user.id], agent.id, agent.name, ACTION_RETAIN)
        genesis, deployment_name = self._own_identity()
        return local_retained_out(agent, retained_at, genesis_fp=genesis, deployment_name=deployment_name)

    def _own_identity(self) -> tuple[Optional[str], str]:
        """This server's genesis fingerprint (None with no registration) and
        the name others see it under."""
        reg = self.runtime.registration() if self.runtime is not None else None
        genesis = reg.genesis_fp if reg is not None and reg.genesis_fp else None
        name = (reg.name if reg is not None else None) or "this server"
        return genesis, name

    def _local_agent(self, hub_agent_id: str) -> Optional[Agent]:
        """The local agent ``hub_agent_id`` names, or None when it names a
        remote one (or nothing)."""
        model_ctx = self._ctx.model_ctx
        if hub_agent_id.startswith(LOCAL_ID_PREFIX):
            agent = Agent.get(hub_agent_id[len(LOCAL_ID_PREFIX):], model_ctx)
            if agent is None:
                raise HubError("agent_not_found", "no such agent on this server")
            return agent
        genesis, _ = self._own_identity()
        try:
            ref = parse_agent_ref(hub_agent_id)
        except ValueError:
            return None
        if genesis is None or ref.deployment_fingerprint != genesis:
            return None
        agent = Agent.get_by_name(ref.agent_name, model_ctx)
        if agent is None:
            raise HubError("agent_not_found", "no such agent on this server")
        return agent

    # ── statement hooks ──────────────────────────────────────────────────

    def mark(self, stand_in_id: str, state: str) -> list[str]:
        """Move one stand-in's rows to ``state`` (never back to active);
        returns the affected user ids."""
        return self.hub.mark_retained(state, stand_in_id=stand_in_id)

    def mark_root(self, genesis_fp: str, state: str) -> list[str]:
        """``mark`` for every agent of the root ``genesis_fp``."""
        return self.hub.mark_retained(state, genesis_fp=genesis_fp)

    async def agent_delisted(self, stand_in_id: str) -> None:
        """A verified agent_delisted statement: rows go ``unlisted``."""
        users = self.mark(stand_in_id, RETAIN_UNLISTED)
        if self.runtime is not None and users:
            await self.runtime.bridge.deactivate(users, stand_in_id, "agent_unlisted")
        stand_in = self.hub.remote_agent(stand_in_id)
        await self.fan_out(users, stand_in_id, stand_in.display if stand_in else stand_in_id,
                           ACTION_RETAIN_STATE)

    async def identity_changed(self, genesis_fp: str) -> None:
        """A verified key revoke of this root: every agent's rows go ``identity_changed``."""
        users = self.mark_root(genesis_fp, RETAIN_IDENTITY_CHANGED)
        if self.runtime is not None and users:
            for agent in self.hub.remote_agents_of_root(genesis_fp):
                await self.runtime.bridge.deactivate(users, agent.id, "identity_changed")
        await self.fan_out(users, genesis_fp, genesis_fp, ACTION_RETAIN_STATE)

    # ── roster fan-out ───────────────────────────────────────────────────

    async def fan_out(self, user_ids: list[str], changed_id: str, changed_name: str, action: str) -> None:
        """AGENT_REGISTRY_CHANGE to every runner of these users, so their peer
        sync reads the retained roster again. Never undoes the change."""
        if not user_ids:
            return
        try:
            wanted = set(user_ids)
            runners = [a.id for a in Agent.list_all(self._ctx.model_ctx, include_private=True)
                       if a.registered_by in wanted]
            if not runners:
                return
            envelope = ControlEnvelope(
                type=ControlMessageType.AGENT_REGISTRY_CHANGE,
                payload=AgentRegistryChangePayload(
                    changed_agent_id=changed_id, changed_agent_name=changed_name, action=action),
            )
            await self._ctx.ws_hub.send_to_many(runners, envelope)
        except Exception as exc:  # noqa: BLE001 — the next full sync catches up
            logger.warning("Retained-agent roster fan-out failed: %s", type(exc).__name__)


LOCAL_RETAIN_MARKER = "local_retains.done"


async def migrate_local_retains(server_ctx: "ServerContext", marker_dir: "Path") -> int:
    """One-time: every user keeps reaching the same-server public agents they
    already talk to once Cmd-K and the agents' rosters list only retained
    agents. Each requester end of a Front Desk conversation with another
    account's agent that is still public retains that agent for its owner.
    Returns how many pins were written (an existing pin is kept as it was)."""
    from clawmeets.server.agent_visibility import front_desk_requester_threads

    marker = marker_dir / LOCAL_RETAIN_MARKER
    store = getattr(server_ctx, "channel_store", None)
    if marker.exists() or store is None:
        return 0
    hub = HubStore(store)
    model_ctx = server_ctx.model_ctx
    count = 0
    for project in front_desk_requester_threads(model_ctx):
        agent = Agent.get(project.counterpart_id, model_ctx)
        if agent is None or not agent.is_discoverable or agent.registered_by == project.created_by:
            continue
        created = project.created_at.timestamp()
        before = {agent_id for agent_id, _ in hub.local_retained_for(project.created_by)}
        hub.retain_local(project.created_by, agent.id, now=created)
        count += agent.id not in before
    marker_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"{count}\n", encoding="utf-8")
    logger.info("Retained %d same-server agent(s) users already had conversations with", count)
    return count
