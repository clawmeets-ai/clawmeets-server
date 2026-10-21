# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/ws_edge/link.py

The edge's end of the link to core (api/edge_protocol.py).

At most one core is linked at a time, and the newest wins: a core that
restarts dials in before the old process has necessarily noticed it is gone,
so a second link closes the first (4000) rather than being refused.

Three rules keep a public socket from ever waiting on core:

- **One writer.** Everything for core goes on one queue drained by one task,
  so a slow link backs up that queue and never a socket's handler.
- **Ready means snapshotted.** Events (connected, disconnected, runner_raw,
  host_event) are dropped until SNAPSHOT has been queued in reply to HELLO.
  Nothing is lost by dropping them: the snapshot is built from the registry,
  which already holds whatever those events described. Building it and
  becoming ready happen in one synchronous step, so no event slips between.
- **Auth fails fast.** A pending ``auth_req`` resolves as "core unavailable"
  the moment the link drops, and its socket is told to try again (1013).

Heartbeats are the exception to dropping: they are coalesced latest-per-agent
and kept while unlinked, then handed over in the next snapshot.

Frame bodies (``text``, ``raw``, host frames, auth frames) carry secrets, so
this module logs ops, ids, sizes and close codes only.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Optional

from starlette.websockets import WebSocket, WebSocketDisconnect

from clawmeets.api import edge_protocol as ep
from clawmeets.ws_edge.registry import ConnRegistry

logger = logging.getLogger("clawmeets.ws_edge")

# How long a freshly linked core has to send HELLO.
HELLO_TIMEOUT_S = 10.0
# Close codes on the LINK socket (never seen by a public client).
CLOSE_REPLACED = 4000
CLOSE_BAD_HELLO = 4002


@dataclass
class _Session:
    """One core link, from accept to close."""
    ws: WebSocket
    out: asyncio.Queue = field(default_factory=asyncio.Queue)
    ready: bool = False
    writer: Optional[asyncio.Task] = None


class CoreLink:
    """The current core link, the events bound for it, and pending auths."""

    def __init__(
        self,
        registry: ConnRegistry,
        *,
        heartbeat_flush_s: float = ep.HEARTBEAT_FLUSH_S,
        auth_timeout_s: float = ep.AUTH_TIMEOUT_S,
    ) -> None:
        self._registry = registry
        self._heartbeat_flush_s = heartbeat_flush_s
        self._auth_timeout_s = auth_timeout_s
        # Lets core tell "the edge restarted" (every conn id is new) from
        # "only core restarted" (the snapshot is the same edge's).
        self.edge_boot_id = secrets.token_urlsafe(12)
        self._current: Optional[_Session] = None
        self._pending: dict[str, asyncio.Future] = {}
        self._heartbeats: dict[str, str] = {}
        self._flush_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._flush_task is None:
            self._flush_task = asyncio.create_task(self._flush_heartbeats())

    async def stop(self) -> None:
        if self._flush_task is not None:
            self._flush_task.cancel()
            self._flush_task = None
        if self._current is not None:
            self._unlink(self._current)

    @property
    def ready(self) -> bool:
        """A core is linked and has its snapshot: events reach it now."""
        return self._current is not None and self._current.ready

    # ---------------------------------------------------- events, edge->core

    def emit(self, op: str, **fields: Any) -> None:
        """Queue one message for core; dropped unless ready (see module doc)."""
        session = self._current
        if session is None or not session.ready:
            return
        session.out.put_nowait(ep.encode(op, **fields))

    def heartbeat(self, agent_id: str) -> None:
        """Coalesce: only the latest heartbeat per agent is ever sent."""
        self._heartbeats[agent_id] = datetime.now(UTC).isoformat()

    async def authenticate(
        self, kind: str, id: str, conn: str, ip: Optional[str], hello: Any,
    ) -> Optional[dict]:
        """Ask core whether a runner or computer may connect.

        The ``auth_result`` message, or None if core cannot answer (not linked,
        no answer in time, or the link dropped while waiting) — the caller
        closes 1013 so the client retries.
        """
        if not self.ready:
            return None
        req = secrets.token_urlsafe(12)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req] = fut
        try:
            self.emit(ep.AUTH_REQ, req=req, kind=kind, id=id, conn=conn, ip=ip, hello=hello)
            return await asyncio.wait_for(fut, timeout=self._auth_timeout_s)
        except asyncio.TimeoutError:
            logger.warning(f"Core did not answer auth for {kind} {id} in time")
            return None
        finally:
            self._pending.pop(req, None)

    # ---------------------------------------------------- the link socket

    async def serve(self, ws: WebSocket) -> None:
        """Run one accepted link socket until it closes or is replaced."""
        session = _Session(ws)
        old, self._current = self._current, session
        if old is not None:
            # Newest wins: the old core's pending auths fail now (1013), and
            # its socket is closed so it stops believing it is linked.
            self._unlink(old)
            logger.info("A newer core linked; closing the previous link")
            try:
                await old.ws.close(code=CLOSE_REPLACED, reason="Replaced by a newer core")
            except Exception:
                pass
        session.writer = asyncio.create_task(self._write(session))
        try:
            if not await self._handshake(session):
                return
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    break
                raw = message.get("text")
                if raw is None:
                    raw = message.get("bytes") or b""
                self._handle(raw)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error(f"Core link error: {type(e).__name__}")
        finally:
            if self._current is session:
                self._current = None
                self._unlink(session)
                logger.info("Core link closed")

    async def _handshake(self, session: _Session) -> bool:
        """HELLO in, SNAPSHOT out. False if the link was closed instead."""
        try:
            message = await asyncio.wait_for(session.ws.receive(), timeout=HELLO_TIMEOUT_S)
        except asyncio.TimeoutError:
            message = None
        if message is None or message["type"] == "websocket.disconnect":
            if message is None:
                await session.ws.close(code=CLOSE_BAD_HELLO, reason="Expected hello")
            return False
        msg = ep.decode(message.get("text") or message.get("bytes") or b"")
        if msg is None or msg["op"] != ep.HELLO or msg.get("v") != ep.PROTOCOL_VERSION:
            logger.warning("Core link refused: bad hello or protocol version")
            await session.ws.close(code=CLOSE_BAD_HELLO, reason="Expected hello v%d" % ep.PROTOCOL_VERSION)
            return False
        if self._current is not session:
            return False
        # One synchronous step: build from the registry, hand over the kept
        # heartbeats, become ready. No event can land between these lines.
        conns, hosts = self._registry.snapshot()
        heartbeats, self._heartbeats = self._heartbeats, {}
        session.out.put_nowait(ep.encode(
            ep.SNAPSHOT, edge_boot_id=self.edge_boot_id,
            conns=conns, hosts=hosts, heartbeats=heartbeats,
        ))
        session.ready = True
        logger.info(
            f"Core linked (boot {str(msg.get('boot_id'))[:12]}); snapshot of "
            f"{len(conns)} socket(s), {len(hosts)} computer(s)"
        )
        return True

    def _unlink(self, session: _Session) -> None:
        """Forget a link: not ready, pending auths unavailable, writer stopped."""
        session.ready = False
        if session.writer is not None:
            session.writer.cancel()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_result(None)

    async def _write(self, session: _Session) -> None:
        try:
            while True:
                text = await session.out.get()
                await session.ws.send_text(text)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.debug(f"Core link writer ended: {type(e).__name__}")

    async def _flush_heartbeats(self) -> None:
        while True:
            await asyncio.sleep(self._heartbeat_flush_s)
            if self.ready and self._heartbeats:
                at, self._heartbeats = self._heartbeats, {}
                self.emit(ep.HEARTBEATS, at=at)

    # ---------------------------------------------------- ops, core->edge

    def _handle(self, raw: str | bytes) -> None:
        """Apply one core op to the registry. Never raises, never logs bodies."""
        msg = ep.decode(raw)
        if msg is None:
            logger.warning(f"Malformed core link message ({len(raw)} bytes); ignored")
            return
        op = msg["op"]
        try:
            if op == ep.DELIVER:
                text, pids = msg["text"], msg["pids"]
                if not isinstance(text, str) or not isinstance(pids, list):
                    raise TypeError
                for pid in dict.fromkeys(p for p in pids if isinstance(p, str)):
                    for q in self._registry.queues_for_pid(pid):
                        q.put_nowait(text)
            elif op == ep.DELIVER_CONN:
                text = msg["text"]
                if not isinstance(text, str):
                    raise TypeError
                q = self._registry.queue_for_conn(msg["conn"])
                if q is not None:
                    q.put_nowait(text)
            elif op == ep.CLOSE:
                item = (int(msg["code"]), str(msg.get("reason") or ""))
                for q in self._registry.queues_for_pid(msg["pid"]):
                    q.put_nowait(item)
                logger.info(f"Core closed participant {msg['pid']} ({item[0]})")
            elif op == ep.CLOSE_CONN:
                item = (int(msg["code"]), str(msg.get("reason") or ""))
                q = self._registry.queue_for_conn(msg["conn"])
                if q is not None:
                    q.put_nowait(item)
            elif op == ep.HOST_SEND:
                text = msg["text"]
                if not isinstance(text, str):
                    raise TypeError
                for q in self._registry.host_queues(msg["host_id"]):
                    q.put_nowait(text)
            elif op == ep.HOST_CLOSE:
                item = (int(msg["code"]), str(msg.get("reason") or ""))
                for q in self._registry.host_queues(msg["host_id"]):
                    q.put_nowait(item)
                logger.info(f"Core closed computer {msg['host_id']} ({item[0]})")
            elif op == ep.AUTH_RESULT:
                fut = self._pending.get(msg["req"])
                if fut is not None and not fut.done():
                    fut.set_result(msg)
            # Unknown ops are ignored: a newer core may speak more than we do.
        except (KeyError, TypeError, ValueError):
            logger.warning(f"Malformed core link op {op!r} ({len(raw)} bytes); ignored")
