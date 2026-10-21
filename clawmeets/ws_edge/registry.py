# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/ws_edge/registry.py

Every public socket the edge holds, by connection id.

The edge is content-blind, so a connection here is only an address: who is on
the other end (``info``, as core decided at auth time) and the queue its send
loop drains. Core addresses sockets by participant (``deliver``, ``close``),
by connection (``deliver_conn``, ``close_conn``) or by computer
(``host_send``, ``host_close``); this module turns each of those into the set
of queues to put the frame on.

A queue item is either the frame's text, already serialized, or a
``(code, reason)`` tuple meaning "close the socket with this".

The registry is also what a SNAPSHOT is built from, which is how a core that
just (re)linked learns about every socket opened while it was away.
"""
from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Optional, Union

from clawmeets.api.edge_protocol import frame_text

# What a public socket's send loop takes off its queue.
QueueItem = Union[str, tuple[int, str]]

# Exactly the ConnInfo keys core rebuilds its mirror from
# (api/edge_protocol.py); a key that does not apply is None.
INFO_KEYS = (
    "kind", "pid", "ip", "clawmeets_version", "owner_id", "agent_name",
    "capabilities", "connected_since", "seq",
)


def new_conn_id() -> str:
    """An opaque connection id. Core only stores it and hands it back."""
    return secrets.token_urlsafe(12)


@dataclass
class Conn:
    """One runner or browser socket."""
    conn_id: str
    kind: str  # "agent" | "user"
    pid: str
    info: dict
    queue: asyncio.Queue


@dataclass
class HostMeta:
    """One computer, across however many sockets it holds right now.

    A computer briefly holds two across a reconnect; the meta lives until the
    last one closes.
    """
    owner_id: Optional[str]
    hello: dict  # the host_hello frame, token removed
    last_state: Optional[dict] = None
    conns: dict[str, asyncio.Queue] = field(default_factory=dict)


class ConnRegistry:
    """conn id -> socket, participant -> sockets, computer -> sockets."""

    def __init__(self) -> None:
        self._conns: dict[str, Conn] = {}
        self._by_pid: dict[str, set[str]] = {}
        self._hosts: dict[str, HostMeta] = {}
        self._host_of_conn: dict[str, str] = {}
        self._seq = 0

    # ------------------------------------------------------- runners/browsers

    def register(
        self, conn_id: str, kind: str, pid: str, info: dict, queue: asyncio.Queue,
    ) -> dict:
        """Add one socket; returns its full ConnInfo.

        ``kind`` and ``pid`` are the edge's own (they decide routing), the rest
        is whatever core or the endpoint supplied, normalized to INFO_KEYS.
        ``seq`` and ``connected_since`` are stamped here.
        """
        self._seq += 1
        caps = info.get("capabilities")
        if not isinstance(caps, (list, tuple, set, frozenset)):
            caps = ()
        full = {k: info.get(k) for k in INFO_KEYS}
        full.update(
            kind=kind,
            pid=pid,
            capabilities=[c for c in caps if isinstance(c, str)],
            connected_since=datetime.now(UTC).isoformat(),
            seq=self._seq,
        )
        self._conns[conn_id] = Conn(conn_id, kind, pid, full, queue)
        self._by_pid.setdefault(pid, set()).add(conn_id)
        return full

    def unregister(self, conn_id: str) -> Optional[Conn]:
        """Remove THIS socket only; the participant's others stay."""
        conn = self._conns.pop(conn_id, None)
        if conn is None:
            return None
        ids = self._by_pid.get(conn.pid)
        if ids is not None:
            ids.discard(conn_id)
            if not ids:
                del self._by_pid[conn.pid]
        return conn

    def queues_for_pid(self, pid: str) -> list[asyncio.Queue]:
        return [self._conns[c].queue for c in self._by_pid.get(pid, ())]

    def queue_for_conn(self, conn_id: str) -> Optional[asyncio.Queue]:
        conn = self._conns.get(conn_id)
        return conn.queue if conn is not None else None

    # -------------------------------------------------------------- computers

    def register_host(
        self, conn_id: str, host_id: str, owner_id: Optional[str], hello: dict,
        queue: asyncio.Queue,
    ) -> int:
        """Add one computer socket; returns how many that computer now holds.

        The newest socket's hello and owner win: it is the one the machine
        opened last, so it describes the machine as it is now.
        """
        meta = self._hosts.get(host_id)
        clean = {k: v for k, v in hello.items() if k != "token"}
        if meta is None:
            meta = self._hosts[host_id] = HostMeta(owner_id=owner_id, hello=clean)
        else:
            meta.owner_id, meta.hello = owner_id, clean
        meta.conns[conn_id] = queue
        self._host_of_conn[conn_id] = host_id
        return len(meta.conns)

    def unregister_host(self, conn_id: str) -> tuple[Optional[str], int]:
        """Remove one computer socket; ``(host_id, sockets remaining)``.

        The computer's meta (and its last state) goes with its last socket.
        """
        host_id = self._host_of_conn.pop(conn_id, None)
        if host_id is None:
            return None, 0
        meta = self._hosts.get(host_id)
        if meta is None:
            return host_id, 0
        meta.conns.pop(conn_id, None)
        if not meta.conns:
            del self._hosts[host_id]
            return host_id, 0
        return host_id, len(meta.conns)

    def set_host_state(self, host_id: str, frame: dict) -> None:
        meta = self._hosts.get(host_id)
        if meta is not None:
            meta.last_state = frame

    def host_queues(self, host_id: str) -> list[asyncio.Queue]:
        meta = self._hosts.get(host_id)
        return list(meta.conns.values()) if meta is not None else []

    def host_connected(self, host_id: str) -> bool:
        return host_id in self._hosts

    async def send_to_host(self, host_id: str, frame: dict) -> bool:
        """Queue ``frame`` to every socket of ``host_id``; False if it has none.

        The terminal relay's ``HostSender``. Serialized here exactly as
        ``send_json`` would, so the machine cannot tell the edge from core.
        """
        queues = self.host_queues(host_id)
        if not queues:
            return False
        text = frame_text(frame)
        for q in queues:
            q.put_nowait(text)
        return True

    # --------------------------------------------------------------- snapshot

    def snapshot(self) -> tuple[list[dict], dict[str, dict]]:
        """The SNAPSHOT ``conns`` and ``hosts`` values, in connect order."""
        conns = [
            {"conn": c.conn_id, **c.info}
            for c in sorted(self._conns.values(), key=lambda c: c.info["seq"])
        ]
        hosts = {
            host_id: {
                "owner_id": meta.owner_id,
                "hello": meta.hello,
                "last_state": meta.last_state,
                "conns": len(meta.conns),
            }
            for host_id, meta in self._hosts.items()
        }
        return conns, hosts
