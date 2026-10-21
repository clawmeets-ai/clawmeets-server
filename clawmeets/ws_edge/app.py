# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/ws_edge/app.py
The websocket edge: the process that holds every public socket.

Two listeners in one process, sharing one registry, one core link and one
terminal relay:

- **public** — the four sockets clients open, with the same paths, handshake
  and close codes as the in-process ``server/routes/websocket.py``, so a
  runner, browser or computer cannot tell which one it reached.
- **link** — loopback ``/link``, dialled by core (api/edge_protocol.py).

Transport only, like the in-process routes, and content-blind on top: core
decides who receives what and sends ready-made text; the edge reports sockets
opening, closing and talking. Browser and terminal sockets need no core at
all (their credentials are JWTs, ``ws_edge/auth.py``), so they connect while
core restarts; runner and computer sockets are told to try again (1013).

Never logs a frame body: frames carry model API keys, env values, OAuth codes.
"""
from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import secrets
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from clawmeets.api import edge_protocol as ep
from clawmeets.api.fs_protocol import FS_CHUNK, FS_REPLY, FS_WS_MAX_SIZE, peek_frame
from clawmeets.api.host_protocol import (
    CLOSE_BAD_TOKEN,
    HOST_ACCEPTED,
    HOST_HELLO,
    HOST_STATE,
    TERM_EXIT,
    TERM_OPENED,
    TERM_OUTPUT,
    HostHelloFrame,
)
from clawmeets.ws_edge.auth import user_jwt_check
from clawmeets.ws_edge.link import CoreLink
from clawmeets.ws_edge.registry import ConnRegistry, new_conn_id
from clawmeets.ws_edge.terminal_relay import TerminalRelay

logger = logging.getLogger("clawmeets.ws_edge")

# Terminal frames a computer sends about one of its sessions; handled by the
# local relay and never forwarded to core.
_HOST_TERMINAL_FRAMES = frozenset({TERM_OPENED, TERM_OUTPUT, TERM_EXIT})
_TRY_AGAIN_REASON = "Server restarting, try again"


@dataclass
class EdgeConfig:
    """Everything the edge needs; no core state, no model context."""
    data_dir: Path  # the server data dir ({--data-dir}/server), for terminal audit lines
    jwt_secret: str  # core's CLAWMEETS_JWT_SECRET: user tokens and terminal tickets
    link_secret: str  # CLAWMEETS_EDGE_LINK_SECRET: core's Bearer on /link
    public_host: str = "127.0.0.1"
    public_port: int = 8090
    link_host: str = "127.0.0.1"
    link_port: int = 8091
    link_allow_remote: bool = False  # tests only: accept /link from a non-loopback peer
    heartbeat_flush_s: float = ep.HEARTBEAT_FLUSH_S
    auth_timeout_s: float = ep.AUTH_TIMEOUT_S
    log_level: str = "info"


class _EmbeddedServer(uvicorn.Server):
    """A uvicorn server that leaves signals alone: two run in one loop, and
    ``EdgeServer.serve_forever`` owns SIGINT/SIGTERM for both."""

    @contextlib.contextmanager
    def capture_signals(self):
        yield


class _NoWireDebug(logging.Filter):
    """Drop the ``websockets`` library's DEBUG records.

    At DEBUG it logs every frame (``> TEXT '{"op":"deliver",...'``) and every
    handshake header (the link's ``authorization: Bearer ...``) to the logger
    uvicorn hands it, ``uvicorn.error``. Those are exactly the bodies the edge
    must never log, so they go whatever level the operator picks.
    """

    _PKG = str(Path(websockets.__file__).resolve().parent)

    def filter(self, record: logging.LogRecord) -> bool:
        return not (
            record.levelno <= logging.DEBUG
            and str(Path(record.pathname).resolve()).startswith(self._PKG)
        )


def _install_wire_log_filter() -> None:
    for name in ("uvicorn.error", "uvicorn", "websockets", "websockets.server", "websockets.protocol"):
        lg = logging.getLogger(name)
        if not any(isinstance(f, _NoWireDebug) for f in lg.filters):
            lg.addFilter(_NoWireDebug())


def _client_ip(websocket: WebSocket) -> Optional[str]:
    return websocket.client.host if websocket.client else None


def _is_loopback(host: Optional[str]) -> bool:
    try:
        addr = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return addr.is_loopback


async def _send_loop(websocket: WebSocket, queue: asyncio.Queue, label: str) -> None:
    """Drain one public socket's queue: text frames, or ``(code, reason)`` = close."""
    try:
        while True:
            item = await queue.get()
            if isinstance(item, tuple):
                await websocket.close(code=item[0], reason=item[1])
                return
            await websocket.send_text(item)
    except Exception as e:
        logger.debug(f"Send task ended for {label}: {type(e).__name__}")


class EdgeServer:
    """The public app, the link app, and the uvicorn servers that bind them."""

    def __init__(self, config: EdgeConfig) -> None:
        self.config = config
        self.registry = ConnRegistry()
        self.link = CoreLink(
            self.registry,
            heartbeat_flush_s=config.heartbeat_flush_s,
            auth_timeout_s=config.auth_timeout_s,
        )
        self.relay = TerminalRelay(self.registry, config.data_dir, config.jwt_secret)
        self.public_app = FastAPI(title="clawmeets ws-edge")
        self.link_app = FastAPI(title="clawmeets ws-edge link")
        self._add_public_routes(self.public_app)
        self._add_link_route(self.link_app)
        self._servers: list[uvicorn.Server] = []
        self._tasks: list[asyncio.Task] = []
        self.public_port: Optional[int] = None
        self.link_port: Optional[int] = None

    # ------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        """Bind both listeners on this event loop; returns once both accept."""
        cfg = self.config
        _install_wire_log_filter()
        public = _EmbeddedServer(uvicorn.Config(
            self.public_app, host=cfg.public_host, port=cfg.public_port,
            ws_max_size=FS_WS_MAX_SIZE, lifespan="off", log_config=None,
            log_level=cfg.log_level, timeout_graceful_shutdown=3,
        ))
        link = _EmbeddedServer(uvicorn.Config(
            self.link_app, host=cfg.link_host, port=cfg.link_port,
            ws_max_size=ep.LINK_MAX_FRAME_BYTES, lifespan="off", log_config=None,
            log_level=cfg.log_level, timeout_graceful_shutdown=3,
        ))
        self.link.start()
        for server in (public, link):
            self._servers.append(server)
            self._tasks.append(asyncio.create_task(server.serve()))
        for server, task in zip(self._servers, self._tasks):
            while not server.started:
                if task.done():
                    await self.stop()
                    raise RuntimeError("ws-edge listener failed to start (port in use?)")
                await asyncio.sleep(0.01)
        self.public_port = public.servers[0].sockets[0].getsockname()[1]
        self.link_port = link.servers[0].sockets[0].getsockname()[1]
        logger.info(
            f"ws-edge listening: public {cfg.public_host}:{self.public_port}, "
            f"link {cfg.link_host}:{self.link_port}"
        )

    async def stop(self) -> None:
        """Close both listeners and every socket on them."""
        for server in self._servers:
            server.should_exit = True
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._servers, self._tasks = [], []
        await self.link.stop()

    async def serve_forever(self) -> None:
        """start(), then run until SIGINT/SIGTERM or a listener exits."""
        await self.start()
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError, RuntimeError):
                loop.add_signal_handler(sig, stop.set)
        waiter = asyncio.create_task(stop.wait())
        try:
            await asyncio.wait([waiter, *self._tasks], return_when=asyncio.FIRST_COMPLETED)
        finally:
            waiter.cancel()
            await self.stop()

    # ------------------------------------------------------------ link app

    def _add_link_route(self, app: FastAPI) -> None:
        cfg = self.config

        @app.websocket(ep.LINK_PATH)
        async def link_websocket(websocket: WebSocket):
            """Core's link. Loopback + shared secret, checked before accept,
            so a refused peer gets HTTP 403 and never a websocket."""
            ip = _client_ip(websocket)
            if not cfg.link_allow_remote and not _is_loopback(ip):
                logger.warning(f"Core link refused: non-loopback peer {ip}")
                await websocket.close(code=1008)
                return
            auth = websocket.headers.get("authorization", "")
            expected = f"Bearer {cfg.link_secret}"
            if not secrets.compare_digest(auth.encode(), expected.encode()):
                logger.warning(f"Core link refused: bad link secret from {ip}")
                await websocket.close(code=1008)
                return
            await websocket.accept()
            await self.link.serve(websocket)

    # ---------------------------------------------------------- public app

    def _add_public_routes(self, app: FastAPI) -> None:
        cfg = self.config
        registry, link, relay = self.registry, self.link, self.relay

        @app.websocket("/ws/{agent_id}")
        async def agent_websocket(websocket: WebSocket, agent_id: str):
            """A runner. Core checks the token (``auth_req``); the edge then
            relays home-folder replies raw and coalesces heartbeats."""
            await websocket.accept()
            ip = _client_ip(websocket)
            conn_id = new_conn_id()
            try:
                auth_msg = await websocket.receive_json()
                if not isinstance(auth_msg, dict):
                    raise TypeError("auth frame is not an object")
                if not link.ready:
                    await websocket.close(code=ep.CLOSE_TRY_AGAIN, reason=_TRY_AGAIN_REASON)
                    return
                result = await link.authenticate("agent", agent_id, conn_id, ip, auth_msg)
                if result is None:
                    await websocket.close(code=ep.CLOSE_TRY_AGAIN, reason=_TRY_AGAIN_REASON)
                    return
                if not result.get("ok"):
                    await websocket.close(
                        code=int(result.get("code") or 4001),
                        reason=str(result.get("reason") or "Auth failed"),
                    )
                    return
            except WebSocketDisconnect:
                logger.debug(f"WebSocket disconnected before auth for {agent_id}")
                return
            except Exception as e:
                logger.warning(f"WebSocket auth failed for {agent_id}: {type(e).__name__}")
                await websocket.close(code=4001, reason="Auth failed")
                return

            queue: asyncio.Queue = asyncio.Queue()
            info = dict(result.get("info") or {})
            info.setdefault("ip", ip)
            # Register and report in one synchronous step (see ws_edge/link.py).
            info = registry.register(conn_id, "agent", agent_id, info, queue)
            link.emit(
                ep.CONNECTED, conn=conn_id, info=info,
                in_flight_turns=auth_msg.get("in_flight_turns"),
            )
            logger.info(
                f"Participant {agent_id} connected via WebSocket "
                f"(clawmeets {info.get('clawmeets_version') or 'unreported'})"
            )

            async def receive_from_websocket():
                """Home-folder replies go to core untouched, routed on their
                prefix before any parse; heartbeats are coalesced; a frame that
                is not a JSON object ends the socket, as a failed
                ``ControlEnvelope`` parse does in-process."""
                while True:
                    message = await websocket.receive()
                    if message["type"] == "websocket.disconnect":
                        raise WebSocketDisconnect(message.get("code", 1000))
                    raw = message.get("text")
                    if raw is None:
                        raw = (message.get("bytes") or b"").decode("utf-8")
                    peeked = peek_frame(raw)
                    if peeked is not None and peeked[0] in (FS_REPLY, FS_CHUNK):
                        link.emit(ep.RUNNER_RAW, conn=conn_id, raw=raw)
                        continue
                    data = json.loads(raw)
                    if not isinstance(data, dict):
                        raise ValueError("frame is not a JSON object")
                    if data.get("type") == "heartbeat":
                        link.heartbeat(agent_id)

            send_task = asyncio.create_task(_send_loop(websocket, queue, agent_id))
            try:
                await receive_from_websocket()
            except WebSocketDisconnect:
                logger.info(f"Participant {agent_id} disconnected")
            except Exception as e:
                logger.error(f"WebSocket error for {agent_id}: {type(e).__name__}")
            finally:
                send_task.cancel()
                registry.unregister(conn_id)  # THIS socket only
                link.emit(ep.DISCONNECTED, conn=conn_id)

        @app.websocket("/ws/user/{user_id}")
        async def user_websocket(websocket: WebSocket, user_id: str):
            """A browser. Its access JWT is checked here, so it connects while
            core is down; core learns of it from the next snapshot."""
            await websocket.accept()
            try:
                auth_msg = await websocket.receive_json()
                reason = user_jwt_check(auth_msg.get("token", ""), user_id, cfg.jwt_secret)
                if reason is not None:
                    await websocket.close(code=4001, reason=reason)
                    return
            except WebSocketDisconnect:
                logger.debug(f"WebSocket disconnected before auth for user {user_id}")
                return
            except Exception as e:
                logger.warning(f"WebSocket auth failed for user {user_id}: {type(e).__name__}")
                await websocket.close(code=4001, reason="Auth failed")
                return

            reported_caps = auth_msg.get("capabilities")
            capabilities = [
                c for c in (reported_caps if isinstance(reported_caps, list) else ())
                if isinstance(c, str) and len(c) <= 64
            ]
            conn_id = new_conn_id()
            queue: asyncio.Queue = asyncio.Queue()
            info = registry.register(conn_id, "user", user_id, {
                "ip": _client_ip(websocket), "capabilities": capabilities,
            }, queue)
            link.emit(ep.CONNECTED, conn=conn_id, info=info)
            logger.info(f"User {user_id} authenticated via WebSocket")

            send_task = asyncio.create_task(_send_loop(websocket, queue, f"user {user_id}"))
            try:
                while True:
                    # Heartbeats only; nothing a browser sends needs core.
                    await websocket.receive_json()
            except WebSocketDisconnect:
                logger.info(f"User {user_id} disconnected")
            except Exception as e:
                logger.error(f"WebSocket error for user {user_id}: {type(e).__name__}")
            finally:
                send_task.cancel()
                registry.unregister(conn_id)
                link.emit(ep.DISCONNECTED, conn=conn_id)

        @app.websocket("/ws/host/{host_id}")
        async def host_websocket(websocket: WebSocket, host_id: str):
            """A user's computer. Core checks the token; terminal frames stay
            here (the relay), everything else is forwarded as ``host_event``."""
            await websocket.accept()
            ip = _client_ip(websocket)
            conn_id = new_conn_id()
            try:
                hello_raw = await websocket.receive_json()
                if not isinstance(hello_raw, dict) or hello_raw.get("type") != HOST_HELLO:
                    await websocket.close(code=CLOSE_BAD_TOKEN, reason="Expected host_hello")
                    return
                HostHelloFrame.model_validate(hello_raw)
                if not link.ready:
                    await websocket.close(code=ep.CLOSE_TRY_AGAIN, reason=_TRY_AGAIN_REASON)
                    return
                result = await link.authenticate("host", host_id, conn_id, ip, hello_raw)
                if result is None:
                    await websocket.close(code=ep.CLOSE_TRY_AGAIN, reason=_TRY_AGAIN_REASON)
                    return
                if not result.get("ok"):
                    await websocket.close(
                        code=int(result.get("code") or CLOSE_BAD_TOKEN),
                        reason=str(result.get("reason") or "Auth failed"),
                    )
                    return
            except WebSocketDisconnect:
                logger.debug(f"Host socket disconnected before auth for {host_id}")
                return
            except Exception as e:
                # Never the exception text: a validation error quotes the hello.
                logger.warning(f"Host socket auth failed for {host_id}: {type(e).__name__}")
                await websocket.close(code=CLOSE_BAD_TOKEN, reason="Auth failed")
                return

            owner_id = (result.get("info") or {}).get("owner_id")
            queue: asyncio.Queue = asyncio.Queue()
            remaining = registry.register_host(conn_id, host_id, owner_id, hello_raw, queue)
            link.emit(
                ep.HOST_EVENT, host_id=host_id, event=ep.HOST_CONNECTED,
                owner_id=owner_id,
                frame={k: v for k, v in hello_raw.items() if k != "token"},
                remaining=remaining,
            )
            logger.info(f"Computer {host_id} connected ({remaining} socket(s))")
            await websocket.send_json({"type": HOST_ACCEPTED, "host_id": host_id})

            async def receive_from_websocket():
                while True:
                    data = await websocket.receive_json()
                    if not isinstance(data, dict):
                        continue
                    kind = data.get("type")
                    if kind in _HOST_TERMINAL_FRAMES:
                        # Checked first: terminal output is the high-volume frame.
                        await relay.from_host(host_id, data)
                        continue
                    if kind == HOST_STATE:
                        registry.set_host_state(host_id, data)
                    link.emit(
                        ep.HOST_EVENT, host_id=host_id, event=ep.HOST_FRAME,
                        owner_id=owner_id, frame=data,
                    )

            send_task = asyncio.create_task(_send_loop(websocket, queue, f"computer {host_id}"))
            try:
                await receive_from_websocket()
            except WebSocketDisconnect:
                logger.info(f"Computer {host_id} disconnected")
            except Exception as e:
                logger.error(f"Host socket error for {host_id}: {type(e).__name__}")
            finally:
                send_task.cancel()
                _, remaining = registry.unregister_host(conn_id)
                link.emit(
                    ep.HOST_EVENT, host_id=host_id, event=ep.HOST_DISCONNECTED,
                    owner_id=owner_id, remaining=remaining,
                )
                if remaining == 0:
                    await relay.host_gone(host_id)

        @app.websocket("/ws/terminal/{host_id}")
        async def terminal_websocket(websocket: WebSocket, host_id: str):
            """One terminal session: a browser tab <-> a shell on the user's
            computer, entirely inside the edge (no core needed). Same ticket
            handshake and close codes as the in-process endpoint."""
            await websocket.accept()
            try:
                first = await websocket.receive_json()
            except WebSocketDisconnect:
                return
            except Exception:
                await websocket.close(code=4001, reason="Expected a ticket")
                return
            grant = None
            if isinstance(first, dict):
                grant = relay.redeem_ticket(first.get("ticket"), host_id)
            if grant is None:
                await websocket.close(code=4001, reason="Invalid or expired ticket")
                return

            queue: asyncio.Queue = asyncio.Queue()
            session_id = await relay.open(grant, queue, _client_ip(websocket) or "")
            if session_id is None:
                await websocket.send_json({
                    "type": TERM_OPENED,
                    "ok": False,
                    "detail": "The computer could not be reached, or already has "
                              "the most terminal sessions it allows.",
                })
                await websocket.close()
                return

            async def send_from_queue():
                try:
                    while True:
                        frame = await queue.get()
                        if frame is None:
                            await websocket.close()
                            return
                        await websocket.send_json(frame)
                except Exception as e:
                    logger.debug(f"Terminal send task ended for {session_id[:8]}: {type(e).__name__}")

            send_task = asyncio.create_task(send_from_queue())
            try:
                while True:
                    data = await websocket.receive_json()
                    if isinstance(data, dict):
                        await relay.from_browser(session_id, data)
            except WebSocketDisconnect:
                pass
            except Exception as e:
                logger.debug(f"Terminal socket error for {session_id[:8]}: {type(e).__name__}")
            finally:
                await relay.close(session_id, "The browser closed the session.")
                # Let a queued term_exit and the close sentinel flush, then stop.
                try:
                    await asyncio.wait_for(send_task, timeout=2)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    send_task.cancel()
