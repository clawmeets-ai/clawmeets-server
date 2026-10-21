# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/edge_hub.py

``EdgeWSHub``: the ``Hub`` core uses when the public sockets live in the
websocket edge (``clawmeets server ws-edge``, ``CLAWMEETS_WS_MODE=edge``)
instead of in this process.

It keeps a MIRROR of the edge's socket table — which participant holds which
connection ids, and what each socket said about itself — so every read core
makes (``is_connected``, ``runners_for_owner``, ``newest_connection``, …) is
answered from memory exactly as ``WSHub`` answers it; it subclasses ``WSHub``
for those reads and for ``recipients_for_project``. Every send is serialized
ONCE and handed to the link as one ``deliver`` naming all recipients; the edge
fans it out. Socket events arriving over the link are handed to
``SocketEvents``, the same calls the in-process endpoints make.

**Link down.** Sends go into a bounded outbox and reads keep answering from the
last mirror. When the outbox overflows, the oldest changelog-update or
active-work frame is dropped first (each is only a pointer that a catch-up
repairs), then the oldest of anything; the loss is recorded, never silent, and
the next link sends the matching RESYNC (``api/control.py``).

**Relink.** ``hello`` -> ``snapshot`` -> the mirror is replaced ->
``SocketEvents.reconcile`` squares statuses with what is really connected ->
the outbox is flushed -> RESYNC if anything was lost. The first link of this
process always sends a full RESYNC: the process that ran before it may have
saved writes it never announced, and the notices it had queued died with it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import uuid
from collections import deque
from typing import TYPE_CHECKING, Literal, Optional

from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import WebSocketException

from clawmeets.api import edge_protocol as ep
from clawmeets.api.control import (
    AgentStatusChangePayload,
    ControlEnvelope,
    ControlMessageType,
    RESYNC_CAPABILITY,
    ResyncPayload,
)
from clawmeets.api.host_protocol import CLOSE_NO_HOST, HostHelloFrame
from clawmeets.server.in_flight_restore import parse_in_flight_turns
from clawmeets.server.socket_events import (
    ConnInfo,
    SocketEvents,
    check_agent_socket,
    check_host_socket,
)
from clawmeets.server.ws_hub import ConnId, WSHub

if TYPE_CHECKING:
    from pathlib import Path

    from clawmeets.models.context import ModelContext
    from clawmeets.models.project import Project
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# Notices that are only a pointer to state a catch-up re-reads: the first to go
# when the outbox overflows.
_DROPPABLE = frozenset({
    ControlMessageType.CHANGELOG_UPDATE,
    ControlMessageType.ACTIVE_WORK_CHANGE,
})

OUTBOX_MAX_FRAMES = 10_000
OUTBOX_MAX_BYTES = 64 * 1024 * 1024

Lost = Optional[Literal["changelog", "full"]]


def _envelope_text(envelope: ControlEnvelope) -> str:
    return ep.frame_text(envelope.model_dump(mode="json", by_alias=True))


def _conn_info(raw: dict) -> ConnInfo:
    caps = raw.get("capabilities")
    return ConnInfo(
        kind="agent" if raw.get("kind") == "agent" else "user",
        pid=str(raw.get("pid") or ""),
        ip=raw.get("ip"),
        clawmeets_version=raw.get("clawmeets_version"),
        owner_id=raw.get("owner_id"),
        agent_name=raw.get("agent_name"),
        capabilities=frozenset(c for c in (caps or ()) if isinstance(c, str)),
    )


def _mirror_entry(raw: dict) -> tuple[dict, ConnInfo]:
    """The per-socket dict ``WSHub``'s reads expect, and the ConnInfo the
    events take, from a link ConnInfo."""
    info = _conn_info(raw)
    seq = raw.get("seq")
    return {
        "kind": info.kind,
        "ip": info.ip,
        "connected_since": raw.get("connected_since"),
        "clawmeets_version": info.clawmeets_version,
        "owner_id": info.owner_id,
        "agent_name": info.agent_name,
        "capabilities": info.capabilities,
        "seq": seq if isinstance(seq, int) else -1,
    }, info


class EdgeWSHub(WSHub):
    """Core's view of, and handle on, the sockets the edge holds."""

    def __init__(
        self,
        link_url: str,
        secret: str,
        *,
        data_dir: Optional["Path"] = None,
        model_ctx: Optional["ModelContext"] = None,
        outbox_max_frames: int = OUTBOX_MAX_FRAMES,
        outbox_max_bytes: int = OUTBOX_MAX_BYTES,
        backoff_min_s: float = 0.2,
        backoff_max_s: float = 5.0,
    ) -> None:
        super().__init__(data_dir=data_dir, model_ctx=model_ctx)
        self._link_url = link_url
        self._secret = secret
        self._ctx: Optional["ServerContext"] = None
        self._boot_id = uuid.uuid4().hex
        # host_id -> {"owner_id", "conns"}; ``_host_conns`` is unused here.
        self._hosts: dict[str, dict] = {}
        # conn -> ConnInfo, alongside WSHub's conn -> info dict
        self._conn_objs: dict[str, ConnInfo] = {}
        self._outbox: deque[tuple[str, bool, int]] = deque()
        self._outbox_bytes = 0
        # The head frame the writer is awaiting a send of; never shed.
        self._sending: Optional[tuple[str, bool, int]] = None
        self._outbox_max_frames = outbox_max_frames
        self._outbox_max_bytes = outbox_max_bytes
        self._wake = asyncio.Event()
        self._ready = asyncio.Event()
        self._lost: Lost = None
        self._linked_once = False
        self._backoff = (backoff_min_s, backoff_max_s)
        self._task: Optional[asyncio.Task] = None
        # key -> the last task run for it, so one socket's events stay in order
        self._chains: dict[str, asyncio.Task] = {}

    def bind(self, ctx: "ServerContext") -> None:
        """Late-bound: the context holds this hub, and the events need it."""
        self._ctx = ctx

    @property
    def _events(self) -> SocketEvents:
        assert self._ctx is not None, "EdgeWSHub.bind(ctx) was never called"
        return SocketEvents.of(self._ctx)

    # ------------------------------------------------------------- lifecycle

    @property
    def ready(self) -> bool:
        """A link is up and the mirror is current."""
        return self._ready.is_set()

    async def start(self, ready_timeout_s: float = 10.0) -> bool:
        """Start dialling the edge; True once linked within the timeout.

        False is not fatal: core serves HTTP, sends wait in the outbox, and the
        link keeps retrying in the background.
        """
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="edge-link")
        try:
            await asyncio.wait_for(self._ready.wait(), ready_timeout_s)
        except asyncio.TimeoutError:
            logger.warning(f"Websocket edge not reachable at {self._link_url} yet; retrying")
            return False
        return True

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        chains = list(self._chains.values())
        for t in chains:
            t.cancel()
        await asyncio.gather(*chains, return_exceptions=True)

    async def _run(self) -> None:
        delay = self._backoff[0]
        while True:
            try:
                async with ws_connect(
                    self._link_url,
                    additional_headers={"Authorization": f"Bearer {self._secret}"},
                    max_size=ep.LINK_MAX_FRAME_BYTES,
                    compression=None,
                    proxy=None,
                    open_timeout=5,
                ) as ws:
                    await ws.send(ep.encode(ep.HELLO, v=ep.PROTOCOL_VERSION, boot_id=self._boot_id))
                    snapshot = ep.decode(await asyncio.wait_for(ws.recv(), 10))
                    if snapshot is None or snapshot["op"] != ep.SNAPSHOT:
                        raise WebSocketException("edge did not answer hello with a snapshot")
                    await self._apply_snapshot(snapshot)
                    resync = self._resync_scope()
                    self._linked_once = True
                    if resync is not None:
                        self._send_resync(*resync)
                    writer = asyncio.create_task(self._writer(ws), name="edge-link-writer")
                    self._ready.set()
                    delay = self._backoff[0]
                    logger.info(
                        f"Linked to websocket edge ({len(self._conn_info)} sockets, "
                        f"{len(self._hosts)} computers)"
                    )
                    try:
                        async for raw in ws:
                            msg = ep.decode(raw)
                            if msg is None:
                                logger.warning("Malformed link message from edge; ignored")
                                continue
                            self._on_message(msg)
                    finally:
                        writer.cancel()
                        self._ready.clear()
                        self._link_lost()
                logger.warning("Websocket edge link closed; relinking")
            except asyncio.CancelledError:
                self._ready.clear()
                raise
            except (OSError, WebSocketException, asyncio.TimeoutError) as e:
                logger.warning(f"Websocket edge link failed ({type(e).__name__}); retrying")
            except Exception:
                logger.error("Websocket edge link crashed; retrying", exc_info=True)
            await asyncio.sleep(random.uniform(self._backoff[0], delay))
            delay = min(delay * 2, self._backoff[1])

    def _link_lost(self) -> None:
        # Replies to home-folder requests ride the link, and any in transit
        # are gone. Their sockets may well be fine, so they are not marked
        # gone; the requests are (a write may have happened: result_unknown).
        fs_relay = getattr(self._ctx, "home_fs_relay", None)
        if fs_relay is not None:
            fs_relay.link_lost()

    def _resync_scope(self) -> Optional[tuple[str, str]]:
        if not self._linked_once:
            return ("full", "core_restart")
        if self._lost == "full":
            return ("full", "outbox_overflow")
        if self._lost == "changelog":
            return ("changelog", "outbox_overflow")
        return None

    def _send_resync(self, scope: str, reason: str) -> None:
        """RESYNC to every runner / browser / listener that can act on it; a
        1012 close to the rest, so they reconnect and catch up as they always
        have. Computers never get it: reconcile replays their state."""
        self._lost = None
        text = _envelope_text(ControlEnvelope(
            type=ControlMessageType.RESYNC,
            payload=ResyncPayload(scope=scope, reason=reason),
        ))
        sent = closed = 0
        for conn, info in list(self._conn_info.items()):
            if RESYNC_CAPABILITY in info.get("capabilities", ()):
                self._enqueue(ep.encode(ep.DELIVER_CONN, conn=conn, text=text))
                sent += 1
            else:
                self._enqueue(ep.encode(
                    ep.CLOSE_CONN, conn=conn,
                    code=ep.CLOSE_SERVICE_RESTART, reason="Service restart",
                ))
                closed += 1
        logger.info(f"RESYNC {scope} ({reason}): sent to {sent}, closed {closed} older clients")

    # ---------------------------------------------------------------- outbox

    def _enqueue(self, text: str, droppable: bool = False) -> None:
        size = len(text)
        self._outbox.append((text, droppable, size))
        self._outbox_bytes += size
        while (
            len(self._outbox) > self._outbox_max_frames
            or self._outbox_bytes > self._outbox_max_bytes
        ) and len(self._outbox) > 1:
            self._shed()
        self._wake.set()

    def _shed(self) -> None:
        for i, entry in enumerate(self._outbox):
            if entry[1] and entry is not self._sending:
                del self._outbox[i]
                self._outbox_bytes -= entry[2]
                if self._lost is None:
                    self._lost = "changelog"
                return
        i = 1 if self._outbox[0] is self._sending else 0
        _, _, size = self._outbox[i]
        del self._outbox[i]
        self._outbox_bytes -= size
        self._lost = "full"

    async def _writer(self, ws) -> None:
        """Drain the outbox onto the link. A frame leaves the outbox only once
        sent, so one cut off by a dropped link goes out on the next."""
        while True:
            self._wake.clear()
            while self._outbox:
                # Pinned while in flight, so a shed during the await can't
                # remove it and leave the popleft below to eat an unsent frame.
                self._sending = self._outbox[0]
                try:
                    await ws.send(self._sending[0])
                finally:
                    sent, self._sending = self._sending, None
                self._outbox.popleft()
                self._outbox_bytes -= sent[2]
            if self._lost is not None:
                # Shed while linked (the edge fell behind): say so now rather
                # than at a relink that may never come.
                self._send_resync(*self._resync_scope())
                continue
            await self._wake.wait()

    # ------------------------------------------------------------- snapshot

    async def _apply_snapshot(self, snap: dict) -> None:
        previous = self._conn_info
        previous_hosts = self._hosts
        previous_objs = self._conn_objs
        conns: dict[str, set] = {}
        infos: dict[str, dict] = {}
        objs: dict[str, ConnInfo] = {}
        for raw in snap.get("conns") or ():
            if not isinstance(raw, dict) or not isinstance(raw.get("conn"), str):
                continue
            entry, info = _mirror_entry(raw)
            if not info.pid:
                continue
            infos[raw["conn"]] = entry
            objs[raw["conn"]] = info
            conns.setdefault(info.pid, set()).add(raw["conn"])
        hosts: dict[str, dict] = {}
        for host_id, meta in (snap.get("hosts") or {}).items():
            if isinstance(meta, dict) and meta.get("owner_id"):
                hosts[host_id] = {
                    "owner_id": meta["owner_id"],
                    "conns": max(1, int(meta.get("conns") or 1)),
                }
        self._conns, self._conn_info, self._conn_objs, self._hosts = conns, infos, objs, hosts

        try:
            await self._events.reconcile(
                live=list(objs.items()),
                arrived=[(c, i) for c, i in objs.items() if c not in previous],
                departed=[(c, i) for c, i in previous_objs.items() if c not in infos],
                hosts={h: m for h, m in (snap.get("hosts") or {}).items() if h in hosts},
                hosts_arrived={h for h in hosts if h not in previous_hosts},
                hosts_departed={
                    h: m["owner_id"] for h, m in previous_hosts.items() if h not in hosts
                },
                heartbeats=snap.get("heartbeats") or {},
            )
        except Exception:
            logger.error("Reconcile after relink failed", exc_info=True)

    # ------------------------------------------------------- edge -> core

    def _on_message(self, msg: dict) -> None:
        """Apply one edge message. Mirror updates happen here, in arrival
        order; the events they trigger run as tasks, chained per socket so one
        socket's connect, frames and disconnect are handled in order."""
        op = msg["op"]
        if op == ep.AUTH_REQ:
            asyncio.create_task(self._answer_auth(msg))
        elif op == ep.CONNECTED:
            conn, raw = msg.get("conn"), msg.get("info")
            if not isinstance(conn, str) or not isinstance(raw, dict):
                return
            entry, info = _mirror_entry(raw)
            if not info.pid:
                return
            self._conn_info[conn] = entry
            self._conn_objs[conn] = info
            self._conns.setdefault(info.pid, set()).add(conn)
            if info.kind == "agent":
                turns = parse_in_flight_turns(msg.get("in_flight_turns"))
                self._chain(conn, self._events.agent_connected(conn, info, in_flight_turns=turns))
            else:
                self._chain(conn, self._events.user_connected(conn, info))
        elif op == ep.DISCONNECTED:
            conn = msg.get("conn")
            if not isinstance(conn, str) or conn not in self._conn_info:
                return
            del self._conn_info[conn]
            info = self._conn_objs.pop(conn)
            pid_conns = self._conns.get(info.pid)
            if pid_conns is not None:
                pid_conns.discard(conn)
                if not pid_conns:
                    del self._conns[info.pid]
            if info.kind == "agent":
                self._chain(conn, self._events.agent_disconnected(conn, info))
        elif op == ep.RUNNER_RAW:
            conn, raw = msg.get("conn"), msg.get("raw")
            if isinstance(conn, str) and isinstance(raw, str) and conn in self._conn_info:
                self._chain(conn, self._events.agent_fs_frame(conn, raw))
        elif op == ep.HEARTBEATS:
            at = msg.get("at")
            if isinstance(at, dict):
                for agent_id in at:
                    if isinstance(agent_id, str):
                        self._events.agent_heartbeat(agent_id)
        elif op == ep.HOST_EVENT:
            self._on_host_event(msg)

    def _on_host_event(self, msg: dict) -> None:
        host_id, event = msg.get("host_id"), msg.get("event")
        if not isinstance(host_id, str):
            return
        known = self._hosts.get(host_id)
        owner_id = msg.get("owner_id") or (known or {}).get("owner_id")
        if not isinstance(owner_id, str) or not owner_id:
            return
        remaining = msg.get("remaining")
        if event == ep.HOST_CONNECTED:
            self._hosts[host_id] = {
                "owner_id": owner_id,
                "conns": remaining if isinstance(remaining, int) and remaining > 0 else 1,
            }
            frame = msg.get("frame") if isinstance(msg.get("frame"), dict) else {}
            try:
                hello = HostHelloFrame.model_validate({**frame, "token": ""})
            except Exception as e:
                logger.warning(f"Bad host_hello relayed for {host_id}: {e}")
                return
            self._chain(f"host:{host_id}", self._events.host_connected(host_id, owner_id, hello))
        elif event == ep.HOST_FRAME:
            frame = msg.get("frame")
            if isinstance(frame, dict):
                self._chain(f"host:{host_id}", self._events.host_frame(host_id, owner_id, frame))
        elif event == ep.HOST_DISCONNECTED:
            if isinstance(remaining, int) and remaining > 0:
                if known is not None:
                    known["conns"] = remaining
                return
            self._hosts.pop(host_id, None)
            self._chain(f"host:{host_id}", self._events.host_disconnected(host_id, owner_id))

    def _chain(self, key: str, coro) -> None:
        previous = self._chains.get(key)

        async def run() -> None:
            if previous is not None:
                await asyncio.gather(previous, return_exceptions=True)
            try:
                await coro
            except Exception:
                logger.error(f"Socket event for {key[:16]} failed", exc_info=True)
            finally:
                if self._chains.get(key) is task:
                    del self._chains[key]

        task = asyncio.create_task(run())
        self._chains[key] = task

    async def _answer_auth(self, msg: dict) -> None:
        req, kind, sid = msg.get("req"), msg.get("kind"), msg.get("id")
        if not isinstance(req, str) or not isinstance(sid, str) or self._ctx is None:
            return
        model_ctx = self._ctx.model_ctx
        if kind == "agent":
            verdict = await asyncio.to_thread(
                check_agent_socket, sid, msg.get("hello"), msg.get("ip"), model_ctx,
                getattr(self._ctx, "owner_isolation", None),
            )
            info = None
            if verdict.ok:
                i = verdict.info
                info = {
                    "kind": "agent", "pid": i.pid, "ip": i.ip,
                    "clawmeets_version": i.clawmeets_version,
                    "owner_id": i.owner_id, "agent_name": i.agent_name,
                    "capabilities": sorted(i.capabilities),
                }
        elif kind == "host":
            verdict = await asyncio.to_thread(check_host_socket, sid, msg.get("hello"), model_ctx)
            info = {"owner_id": verdict.owner_id} if verdict.ok else None
        else:
            return
        self._enqueue(ep.encode(
            ep.AUTH_RESULT, req=req, ok=verdict.ok,
            code=verdict.code or None, reason=verdict.reason, info=info,
        ))

    # ------------------------------------------------------ core -> edge

    def _deliver(self, pids: list[str], envelope: ControlEnvelope) -> None:
        self._enqueue(
            ep.encode(ep.DELIVER, pids=pids, text=_envelope_text(envelope)),
            droppable=envelope.type in _DROPPABLE,
        )

    async def send_to(self, participant_id: str, envelope: ControlEnvelope) -> bool:
        if participant_id not in self._conns:
            return False
        self._deliver([participant_id], envelope)
        return True

    async def send_to_many(self, participant_ids: list[str], envelope: ControlEnvelope) -> int:
        live = [pid for pid in dict.fromkeys(participant_ids) if pid in self._conns]
        if live:
            self._deliver(live, envelope)
        return len(live)

    async def send_frame(self, conn: ConnId, frame: dict) -> bool:
        if conn not in self._conn_info:
            return False
        # Same bytes the in-process agent endpoint writes for a dict frame.
        text = json.dumps(frame, ensure_ascii=True, separators=(",", ":"))
        self._enqueue(ep.encode(ep.DELIVER_CONN, conn=conn, text=text))
        return True

    async def broadcast_status_change(
        self, agent_id: str, agent_name: str, new_status: str, recipient_ids: list[str],
    ) -> None:
        envelope = ControlEnvelope(
            type=ControlMessageType.AGENT_STATUS_CHANGE,
            payload=AgentStatusChangePayload(
                agent_id=agent_id, agent_name=agent_name, new_status=new_status,
            ),
        )
        await self.send_to_many([r for r in recipient_ids if r != agent_id], envelope)

    async def broadcast_to_project(self, envelope: ControlEnvelope, project: "Project") -> int:
        return await self.send_to_many(sorted(self.deliverable_recipients(project)), envelope)

    async def close_connection(self, agent_id: str) -> bool:
        if agent_id not in self._conns:
            return False
        self._enqueue(ep.encode(ep.CLOSE, pid=agent_id, code=4004, reason="Participant not found"))
        return True

    # ----------------------------------------------------------------- hosts

    def is_host_connected(self, host_id: str) -> bool:
        return host_id in self._hosts

    async def send_to_host(self, host_id: str, frame: dict) -> bool:
        if host_id not in self._hosts:
            return False
        self._enqueue(ep.encode(ep.HOST_SEND, host_id=host_id, text=ep.frame_text(frame)))
        return True

    async def close_host_connection(self, host_id: str) -> bool:
        if host_id not in self._hosts:
            return False
        self._enqueue(ep.encode(
            ep.HOST_CLOSE, host_id=host_id, code=CLOSE_NO_HOST, reason="Computer disconnected",
        ))
        return True

    async def connect(self, *args, **kwargs) -> None:  # pragma: no cover - guard
        raise RuntimeError("In edge mode sockets register with the edge, not with core")

    async def connect_host(self, *args, **kwargs) -> None:  # pragma: no cover - guard
        raise RuntimeError("In edge mode sockets register with the edge, not with core")
