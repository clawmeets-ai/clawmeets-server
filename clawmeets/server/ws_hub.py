# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/ws_hub.py

WebSocket hub for managing agent and user connections.

``Hub`` is the interface the rest of core uses to reach a socket; ``WSHub`` is
its in-process implementation, where a socket is the ``asyncio.Queue`` its
endpoint's send task drains. What happens when a socket opens or closes is not
the hub's business — that is ``server/socket_events.py``.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Hashable, Optional, Protocol

from clawmeets.api.control import (
    ActiveWorkChangePayload,
    AgentStatusChangePayload,
    ControlEnvelope,
    ControlMessageType,
)

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.models.project import Project

logger = logging.getLogger("clawmeets.server")

# One live socket, as the hub names it. In-process that is the socket's
# outbound ``asyncio.Queue``; callers only compare and pass it back, never
# look inside.
ConnId = Hashable


class Hub(Protocol):
    """What core may ask of the socket layer — every call site goes through
    these names and nothing else, so a hub living in another process can stand
    in for ``WSHub`` without touching them."""

    async def send_to(self, participant_id: str, envelope: ControlEnvelope) -> bool: ...
    async def send_to_many(self, participant_ids: list[str], envelope: ControlEnvelope) -> int: ...
    async def send_frame(self, conn: ConnId, frame: dict) -> bool: ...
    async def broadcast_status_change(
        self, agent_id: str, agent_name: str, new_status: str, recipient_ids: list[str],
    ) -> None: ...
    async def broadcast_active_work_change(
        self, project: "Project", chatroom_name: str, active_participants: list[str],
    ) -> int: ...
    async def broadcast_to_project(self, envelope: ControlEnvelope, project: "Project") -> int: ...
    async def close_connection(self, agent_id: str) -> bool: ...
    async def connected_agents(self) -> list[str]: ...
    def is_connected(self, agent_id: str) -> bool: ...
    def get_connection_info(self, agent_id: str) -> Optional[dict]: ...
    def newest_connection(self, agent_id: str) -> Optional[tuple[ConnId, dict]]: ...
    def runners_for_owner(self, owner_id: str) -> list[dict]: ...
    def recipients_for_project(self, project: "Project") -> set[str]: ...
    async def send_to_host(self, host_id: str, frame: dict) -> bool: ...
    async def close_host_connection(self, host_id: str) -> bool: ...
    def is_host_connected(self, host_id: str) -> bool: ...


class WSHub:
    """
    In-memory WebSocket hub for managing agent, user, and host connections.
    Lives only for the lifetime of the server process.

    A single participant (agent or user) may hold **multiple** live
    connections at once — e.g. a user with two browsers open, or a runner
    that briefly overlaps an old and new socket during a reconnect. The hub
    therefore keeps a *set of queues* per participant and every delivery
    primitive (``send_to``, ``close_connection``, the ``broadcast_*``
    methods) fans out to all of that participant's live sessions. This is
    what makes desk events (``desk_read_state_sync`` / ``desk_todo_sync`` /
    ``brief_tab_sync``) reach every open device live, not just the
    most-recently-connected one.
    """

    #: Set by create_app (server/isolation_gate.py). Filters every project
    #: broadcast so an isolated project's changelog notices reach only agents
    #: whose runners can run an isolated turn. None in hand-built test hubs.
    isolation_gate = None

    def __init__(
        self,
        data_dir: Optional[Path] = None,
        model_ctx: Optional["ModelContext"] = None,
    ) -> None:
        # participant_id -> set of live outbound queues (one per open socket)
        self._conns: dict[str, set[asyncio.Queue]] = {}
        # per-connection metadata (ip, connected_since, clawmeets_version,
        # owner_id, agent_name), keyed by queue identity
        self._conn_info: dict[asyncio.Queue, dict] = {}
        # host_id -> set of live outbound queues, for /ws/host/{host_id}.
        # A SEPARATE dict from `_conns`, not a second kind of entry in it:
        # `connected_agents`, `runners_for_owner`, `broadcast_to_project` and
        # every recipient list in the app read `_conns`, and a machine is not a
        # participant of anything. Keeping the two apart is what makes "a host
        # id can never turn up in a project broadcast" structural rather than a
        # filter someone has to remember to write. Host queues carry plain
        # dicts, not ControlEnvelopes: the other end is the `clawmeets-daemon`
        # distribution, which ships without pydantic.
        self._host_conns: dict[str, set[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()
        # Connect order, recorded per socket. ``newest_connection`` picks by
        # this rather than by ``connected_since``: two sockets can share a
        # timestamp, they can never share a sequence number.
        self._conn_seq = itertools.count()
        self._data_dir = data_dir
        self._model_ctx = model_ctx

    async def connect(
        self,
        agent_id: str,
        queue: asyncio.Queue,
        client_ip: Optional[str] = None,
        *,
        clawmeets_version: Optional[str] = None,
        owner_id: Optional[str] = None,
        agent_name: Optional[str] = None,
        capabilities: Optional[frozenset[str]] = None,
    ) -> None:
        """Register a live socket.

        ``clawmeets_version`` is the runner's self-reported clawmeets version
        (``str``), or ``None`` when the runner sent no version field at all
        (an older release) or could not determine its own version. Keyword-only
        with a ``None`` default so every existing call site — the
        ``/ws/user/{id}`` browser socket and the tests — keeps working
        unchanged.

        ``owner_id`` (``participant.registered_by``) and ``agent_name``
        (``participant.name``) are the same shape and for the same reason:
        keyword-only, ``None`` by default, and passed ONLY by the ``/ws/{id}``
        agent endpoint. That is what makes ``runners_for_owner`` able to answer
        "which runners does this user own" from memory alone — with no owner
        recorded, a browser socket can never appear in anyone's list, so there
        is nothing to filter out by id afterwards.

        ``capabilities`` is the set of optional frames the runner said it
        answers (``api/fs_protocol.FS_CAPABILITY`` today); empty for an older
        runner and for every browser socket. Same per-socket, never-persisted
        rule as the version: it describes the code on the other end of THIS
        socket.

        All of these are stored in the same per-queue ``_conn_info`` dict that
        already holds ``{ip, connected_since}``: that dict is already
        per-connection, already dies with the socket, and already handles the
        multi-session case. Nothing persists any of it — a version that is not
        backed by a live socket does not exist, by design.
        """
        async with self._lock:
            self._conns.setdefault(agent_id, set()).add(queue)
            self._conn_info[queue] = {
                "ip": client_ip,
                "connected_since": datetime.now(UTC).isoformat(),
                "clawmeets_version": clawmeets_version,
                "owner_id": owner_id,
                "agent_name": agent_name,
                "capabilities": frozenset(capabilities or ()),
                "seq": next(self._conn_seq),
            }

    async def disconnect(
        self,
        agent_id: str,
        queue: Optional[asyncio.Queue] = None,
    ) -> None:
        """Remove a participant's connection(s).

        With ``queue`` given, only that specific socket is removed — the
        correct behavior when one of several sessions closes (closing device
        A must not drop device B's queue). With ``queue`` omitted, every
        session for the participant is removed (legacy "remove all"; used by
        tests and hard resets). When the last session goes, the participant
        key is deleted so ``is_connected`` stays accurate and empty sets do
        not leak.
        """
        async with self._lock:
            conns = self._conns.get(agent_id)
            if conns is None:
                return
            if queue is None:
                for q in conns:
                    self._conn_info.pop(q, None)
                del self._conns[agent_id]
            else:
                conns.discard(queue)
                self._conn_info.pop(queue, None)
                if not conns:
                    del self._conns[agent_id]

    async def close_connection(self, agent_id: str) -> bool:
        """Ask the participant's send task(s) to close the WebSocket.

        Enqueues a `None` sentinel on EVERY live session; the endpoint's
        `send_from_queue` coroutine reads it and issues
        `websocket.close(code=4004)`. Used by delete_agent so the runner
        reconnects immediately, gets the 4004 close code, and self-destructs
        — instead of waiting for the next heartbeat-driven reconnect. All of
        a participant's sockets are signalled, not just one.

        Returns True if at least one connection was present to signal.
        """
        conns = list(self._conns.get(agent_id, ()))
        if not conns:
            return False
        for q in conns:
            await q.put(None)
        return True

    async def connected_agents(self) -> list[str]:
        return list(self._conns.keys())

    def is_connected(self, agent_id: str) -> bool:
        return agent_id in self._conns

    def get_connection_info(self, agent_id: str) -> Optional[dict]:
        """Get connection metadata for a participant.

        A participant may have several live sessions; return the metadata of
        the most-recently-connected one (max ``connected_since``) so callers
        that expect a single ``{ip, connected_since, clawmeets_version}`` dict
        keep working.
        """
        conns = self._conns.get(agent_id)
        if not conns:
            return None
        infos = [self._conn_info[q] for q in conns if q in self._conn_info]
        if not infos:
            return None
        return max(infos, key=lambda i: i.get("connected_since") or "")

    def newest_connection(
        self, agent_id: str
    ) -> Optional[tuple[ConnId, dict]]:
        """``(conn, info)`` of the participant's most recently connected
        socket, or None when it holds none.

        For request/reply traffic that must run exactly once (the home-folder
        relay): ``send_to`` fans out to every session, which is right for a
        notification and wrong for "write this file". Picks by connect order
        (``seq``), so of two overlapping sockets during a reconnect the new one
        wins. ``info`` is the live dict; callers read it, never write it.
        """
        conns = self._conns.get(agent_id)
        if not conns:
            return None
        live = [(q, self._conn_info[q]) for q in conns if q in self._conn_info]
        if not live:
            return None
        return max(live, key=lambda item: item[1].get("seq", -1))

    async def send_frame(self, conn: ConnId, frame: dict) -> bool:
        """Queue one plain-dict frame for exactly ONE socket. False if that
        socket is no longer registered.

        For request/reply traffic (the home-folder relay), where the caller has
        already picked the socket with ``newest_connection`` and a fan-out
        would run the request twice. The agent endpoint's send task writes a
        dict as compact JSON, untouched.
        """
        if conn not in self._conn_info:
            return False
        await conn.put(frame)
        return True

    def runners_for_owner(self, owner_id: str) -> list[dict]:
        """``[{id, name, version}, …]`` for every live runner registered by
        ``owner_id``.

        **Pure read of in-memory state — no ``Agent.list_all_cards``, no disk,
        no lock.** This is the whole efficiency win of the redesign: the push
        that calls this fires on machine events (every runner connect and
        disconnect, every browser connect), and the version it needs is
        already sitting in ``_conn_info``. Do not reintroduce a roster scan
        here — the previous design read one ``card.json`` per agent across the
        ENTIRE deployment on each of those events.

        Only *live* connections appear. A runner that has disconnected is
        absent entirely, which is the mechanism behind "offline runners do not
        count": there is no persistence path, so the reported version dies
        with the socket. Browser sockets carry no ``owner_id`` at all (see
        ``connect``), so they can never appear in any owner's list.

        Multi-session: when one agent id holds several sockets (two machines,
        or an overlapping reconnect), the newest by ``connected_since`` wins —
        the same tie-break ``get_connection_info`` uses, so the two can never
        disagree. Name and version are both taken from that ONE winning info
        dict, so they cannot end up sourced from different sockets.

        Sorted by ``(name, id)`` so two browser tabs and two consecutive
        pushes render in the same order.
        """
        # A falsy owner would otherwise collide with the ``None`` recorded on
        # every browser socket and return them as if they were runners. Call
        # sites already guard on ``participant.registered_by``; this is the
        # backstop that keeps the guarantee local to the method.
        if not owner_id:
            return []

        runners: list[dict] = []
        for participant_id, conns in self._conns.items():
            infos = [
                self._conn_info[q]
                for q in conns
                if q in self._conn_info and self._conn_info[q].get("owner_id") == owner_id
            ]
            if not infos:
                continue
            newest = max(infos, key=lambda i: i.get("connected_since") or "")
            runners.append({
                "id": participant_id,
                "name": newest.get("agent_name"),
                "version": newest.get("clawmeets_version"),
            })
        runners.sort(key=lambda r: (r["name"] or "", r["id"]))
        return runners

    # --- host sockets (one user's computer) ---

    async def connect_host(self, host_id: str, queue: asyncio.Queue) -> None:
        """Register a live host socket.

        No metadata is recorded alongside it. Everything the UI shows about a
        machine — its name, its software version, which of its agents are
        running — is on the persisted ``HostRecord``, and the ONE thing the hub
        knows that the record cannot is whether a socket exists right now.
        Duplicating any of the rest here would create a second source of truth
        that dies on server restart.
        """
        async with self._lock:
            self._host_conns.setdefault(host_id, set()).add(queue)

    async def disconnect_host(
        self, host_id: str, queue: Optional[asyncio.Queue] = None
    ) -> None:
        """Remove one host socket, or all of them when ``queue`` is omitted.

        Same per-queue discipline as :meth:`disconnect`: a machine can briefly
        hold two sockets across a reconnect, and dropping both when one closes
        would report it offline while it is talking to us.
        """
        async with self._lock:
            conns = self._host_conns.get(host_id)
            if conns is None:
                return
            if queue is None:
                del self._host_conns[host_id]
                return
            conns.discard(queue)
            if not conns:
                del self._host_conns[host_id]

    def is_host_connected(self, host_id: str) -> bool:
        """The live-socket half of ``models.host.derive_status``.

        Pure read of in-memory state, like ``runners_for_owner``: nothing
        persists a host connection, so a machine that is not connected right now
        cannot be reported as online — including across a server restart, when
        every machine is correctly offline until it reconnects.
        """
        return host_id in self._host_conns

    async def send_to_host(self, host_id: str, frame: dict) -> bool:
        """Queue one frame for a machine. False if it holds no live socket.

        The False is the whole point at the call site: it is how a route answers
        "your computer is not reachable right now" instead of accepting a
        command that will never run.
        """
        conns = list(self._host_conns.get(host_id, ()))
        for q in conns:
            await q.put(frame)
        return bool(conns)

    async def close_host_connection(self, host_id: str) -> bool:
        """Ask a machine's send task(s) to close the socket.

        Used by "Disconnect this computer": the revocation has already
        destroyed the credential, and this is what makes the machine let go
        immediately instead of at its next reconnect. The ``None`` sentinel is
        read by the endpoint's send loop, which closes with
        ``CLOSE_NO_HOST`` so the daemon self-destructs rather than
        reconnect-looping against a token that will never work again.
        """
        conns = list(self._host_conns.get(host_id, ()))
        for q in conns:
            await q.put(None)
        return bool(conns)

    async def send_to(self, participant_id: str, envelope: "ControlEnvelope") -> bool:
        """Send a control envelope to a connected participant.

        Fans out to every live session the participant holds. Returns True if
        the participant had at least one connection and the message was
        queued (preserves the prior bool contract).
        """
        conns = list(self._conns.get(participant_id, ()))
        delivered = False
        for q in conns:
            await q.put(envelope)
            delivered = True
        return delivered

    async def send_to_many(
        self,
        participant_ids: list[str],
        envelope: "ControlEnvelope",
    ) -> int:
        """Queue the same envelope for every connected participant in ``participant_ids``.

        Returns the number of participants that received the message (each
        counted once, regardless of how many sessions they hold). Caller is
        responsible for assembling the recipient list (e.g. enumerating peers
        owned by a user); WSHub stays a pure delivery primitive and does not
        know about agent-ownership semantics.
        """
        count = 0
        for pid in participant_ids:
            if await self.send_to(pid, envelope):
                count += 1
        return count

    # --- Broadcast methods ---

    async def broadcast_status_change(
        self,
        agent_id: str,
        agent_name: str,
        new_status: str,
        recipient_ids: list[str],
    ) -> None:
        """Broadcast agent status change to multiple recipients.

        Args:
            agent_id: ID of the agent whose status changed
            agent_name: Name of the agent
            new_status: New status ("online" or "offline")
            recipient_ids: List of participant IDs (agents, assistants, or users)
        """
        envelope = ControlEnvelope(
            type=ControlMessageType.AGENT_STATUS_CHANGE,
            payload=AgentStatusChangePayload(
                agent_id=agent_id,
                agent_name=agent_name,
                new_status=new_status,
            ),
        )

        for recipient_id in recipient_ids:
            if recipient_id == agent_id:
                continue  # Don't notify self

            for q in list(self._conns.get(recipient_id, ())):
                await q.put(envelope)

    async def broadcast_active_work_change(
        self,
        project: "Project",
        chatroom_name: str,
        active_participants: list[str],
    ) -> int:
        envelope = ControlEnvelope(
            type=ControlMessageType.ACTIVE_WORK_CHANGE,
            payload=ActiveWorkChangePayload(
                project_id=project.id,
                project_name=project.name,
                chatroom_name=chatroom_name,
                active_participants=list(active_participants),
            ),
        )
        return await self.broadcast_to_project(envelope, project)

    def recipients_for_project(self, project: "Project") -> set[str]:
        """Everyone a project broadcast is for, connected or not.

        - All participating agents
        - The coordinator (assistant)
        - The project owner (user)
        - Users the project is shared with read-only
        - The cross-user Front Desk requester of a DM project

        Sends nothing; ``broadcast_to_project`` delivers to whichever of these
        hold a live socket.
        """
        recipients: set[str] = set(project.participating_agents)
        recipients.add(project.coordinator_id)
        recipients.add(project.created_by)

        if self._data_dir:
            from clawmeets.models.share_token import get_viewers_for_project
            for viewer_id in get_viewers_for_project(project.id, self._data_dir):
                recipients.add(viewer_id)

        # Cross-user Front Desk: the requester reads/writes this DM channel via
        # the fd_requester_name predicate (messages.py:_is_fd_requester) but is
        # neither owner, participant, nor viewer — so add them, or they never
        # get the ACTIVE_WORK_CHANGE push and the "processing" indicator never
        # appears (and reply pushes fall back to the 5s poll).
        if self._model_ctx is not None and project.is_dm_project and project.fd_requester_name:
            from clawmeets.models.user import User
            requester = User.get_by_username(project.fd_requester_name, self._model_ctx)
            if requester is not None:
                recipients.add(requester.id)
        return recipients

    def deliverable_recipients(self, project: "Project") -> set[str]:
        """``recipients_for_project`` minus the agents the isolation gate
        withholds this project from (incapable runners, isolated project)."""
        recipients = self.recipients_for_project(project)
        gate = self.isolation_gate
        if gate is None:
            return recipients
        return {r for r in recipients if gate.may_deliver(r, project)}

    async def broadcast_to_project(
        self,
        envelope: ControlEnvelope,
        project: "Project",
    ) -> int:
        """Broadcast envelope to all participants of a project.

        Sends the same envelope to every live session of everyone in
        ``recipients_for_project``.

        Args:
            envelope: The control envelope to broadcast (no 'to' field needed)
            project: The project whose participants should receive the message

        Returns:
            Number of recipients notified (each counted once, regardless of
            how many live sessions they hold)
        """
        count = 0
        recipients = self.deliverable_recipients(project)

        logger.info(f"Broadcasting to project {project.id[:8]}: {len(recipients)} recipients")

        # Send same envelope to each connected recipient (fanning out across
        # all of a recipient's live sessions)
        for recipient_id in recipients:
            conns = list(self._conns.get(recipient_id, ()))
            logger.debug(f"  Participant {recipient_id[:8]}: sessions={len(conns)}")

            if conns:
                for q in conns:
                    await q.put(envelope)
                count += 1

        logger.info(f"Broadcast complete: {count} recipients notified")
        return count
