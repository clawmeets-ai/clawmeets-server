# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/websocket.py
WebSocket connection routes.

Transport only: accept, the auth handshake, the send and receive loops, close
codes. What the server DOES when a socket opens, reports in or closes is
``server/socket_events.py``.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING

import jwt
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from clawmeets.api.control import ControlEnvelope, ControlMessageType
from clawmeets.api.fs_protocol import FS_CHUNK, FS_REPLY, peek_frame
from clawmeets.api.host_protocol import (
    CLOSE_BAD_TOKEN,
    CLOSE_NO_HOST,
    HOST_ACCEPTED,
    TERM_EXIT,
    TERM_OPENED,
    TERM_OUTPUT,
)
from clawmeets.server.auth import JWT_SECRET, JWT_ALGORITHM
# Re-exported: these used to live here, and callers import them from here.
from clawmeets.server.socket_events import (  # noqa: F401
    ConnInfo,
    SocketEvents,
    check_agent_socket,
    check_host_socket,
    get_status_broadcast_recipients,
    push_host_sync,
    push_install_sync,
    push_runner_versions,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# Terminal frames a computer sends about one of its sessions; relayed to the
# browser tab that opened it (ws_edge/terminal_relay.py).
_HOST_TERMINAL_FRAMES = frozenset({TERM_OPENED, TERM_OUTPUT, TERM_EXIT})


def create_websocket_router(ctx: "ServerContext") -> APIRouter:
    """Create the WebSocket router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["websocket"])
    events = SocketEvents.of(ctx)

    @router.websocket("/ws/{agent_id}")
    async def agent_websocket(websocket: WebSocket, agent_id: str):
        """WebSocket endpoint for agent/assistant connections."""
        # Accept connection first to allow auth exchange
        await websocket.accept()

        try:
            auth_msg = await websocket.receive_json()
        except WebSocketDisconnect:
            # Client disconnected before auth - connection already closed
            logger.debug(f"WebSocket disconnected before auth for {agent_id}")
            return
        except Exception as e:
            logger.warning(f"WebSocket auth failed for {agent_id}: {e}")
            await websocket.close(code=4001, reason="Auth failed")
            return
        verdict = check_agent_socket(
            agent_id, auth_msg,
            websocket.client.host if websocket.client else None,
            ctx.model_ctx, getattr(ctx, "owner_isolation", None),
        )
        if not verdict.ok:
            await websocket.close(code=verdict.code, reason=verdict.reason)
            return
        info = verdict.info
        in_flight_turns = list(verdict.in_flight_turns)

        # Create queue for outbound messages
        queue: asyncio.Queue[ControlEnvelope] = asyncio.Queue()

        await ctx.ws_hub.connect(
            agent_id, queue, client_ip=info.ip,
            clawmeets_version=info.clawmeets_version,
            owner_id=info.owner_id,
            agent_name=info.agent_name,
            capabilities=info.capabilities,
        )
        logger.info(
            f"Participant {info.agent_name} ({agent_id}) connected via WebSocket "
            f"(clawmeets {info.clawmeets_version or 'unreported'})"
        )
        await events.agent_connected(queue, info, in_flight_turns=in_flight_turns)

        async def send_from_queue():
            """Send envelopes from queue to websocket.

            A `None` on the queue is the server-initiated close sentinel
            (see WSHub.close_connection); we close with 4004 so the
            runner treats it as a participant-gone signal and
            self-destructs rather than reconnect-looping.
            """
            try:
                while True:
                    envelope = await queue.get()
                    if envelope is None:
                        await websocket.close(code=4004, reason="Participant not found")
                        return
                    if isinstance(envelope, dict):
                        # A home-folder request (server/home_fs_relay.py),
                        # already a plain fs_protocol frame. Compact and
                        # ASCII-only, so its length is its size on the wire.
                        await websocket.send_text(
                            json.dumps(envelope, ensure_ascii=True, separators=(",", ":"))
                        )
                        continue
                    await websocket.send_json(envelope.model_dump(mode="json", by_alias=True))
            except Exception as e:
                logger.debug(f"Send task ended for {agent_id}: {e}")

        async def receive_from_websocket():
            """Receive and handle messages from websocket.

            Home-folder replies and chunks are routed on their frame prefix BEFORE the
            ``ControlEnvelope`` parse below — whose failure ends the socket —
            and handled inside the relay's own error boundary, so a malformed
            or oversized reply fails one request and never this connection.
            """
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    raise WebSocketDisconnect(message.get("code", 1000))
                raw = message.get("text")
                if raw is None:
                    raw = (message.get("bytes") or b"").decode("utf-8")
                peeked = peek_frame(raw)
                if peeked is not None and peeked[0] in (FS_REPLY, FS_CHUNK):
                    await events.agent_fs_frame(queue, raw)
                    continue
                data = json.loads(raw)
                envelope = ControlEnvelope.model_validate(data)

                if envelope.type == ControlMessageType.HEARTBEAT:
                    events.agent_heartbeat(agent_id)

        send_task = asyncio.create_task(send_from_queue())
        try:
            await receive_from_websocket()
        except WebSocketDisconnect:
            logger.info(f"Participant {agent_id} disconnected")
        except Exception as e:
            logger.error(f"WebSocket error for {agent_id}: {e}")
        finally:
            send_task.cancel()
            await ctx.ws_hub.disconnect(agent_id, queue)  # remove THIS socket only
            await events.agent_disconnected(queue, info)

    @router.websocket("/ws/user/{user_id}")
    async def user_websocket(websocket: WebSocket, user_id: str):
        """WebSocket endpoint for user (browser) connections."""
        await websocket.accept()

        # Expect auth message with JWT token
        try:
            auth_msg = await websocket.receive_json()
            token = auth_msg.get("token", "")

            try:
                payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
                # Only access tokens authenticate a socket (defense-in-depth;
                # the client never sends a refresh token here).
                if payload.get("type") != "access":
                    await websocket.close(code=4001, reason="Invalid token type")
                    return
                token_user_id = payload.get("user_id")
                if token_user_id != user_id:
                    await websocket.close(code=4001, reason="User ID mismatch")
                    return
            except jwt.InvalidTokenError as e:
                await websocket.close(code=4001, reason=f"Invalid token: {e}")
                return

        except WebSocketDisconnect:
            # Client disconnected before auth - connection already closed
            logger.debug(f"WebSocket disconnected before auth for user {user_id}")
            return
        except Exception as e:
            logger.warning(f"WebSocket auth failed for user {user_id}: {e}")
            await websocket.close(code=4001, reason="Auth failed")
            return

        logger.info(f"User {user_id} authenticated via WebSocket, registering queue")

        # Create queue for outbound messages
        queue: asyncio.Queue[ControlEnvelope] = asyncio.Queue()

        # Register with hub (unified queue for all participants)
        info = ConnInfo(
            kind="user",
            pid=user_id,
            ip=websocket.client.host if websocket.client else None,
        )
        await ctx.ws_hub.connect(user_id, queue, client_ip=info.ip)
        connected_count = len(await ctx.ws_hub.connected_agents())
        logger.info(f"User {user_id} registered, connected participants: {connected_count}")

        # Enqueuing before `send_from_queue` starts is safe: it is an
        # asyncio.Queue and the task drains it.
        await events.user_connected(queue, info)

        async def send_from_queue():
            """Send envelopes from queue to websocket."""
            try:
                while True:
                    envelope = await queue.get()
                    await websocket.send_json(envelope.model_dump(mode="json", by_alias=True))
            except Exception as e:
                logger.debug(f"Send task ended for user {user_id}: {e}")

        async def receive_from_websocket():
            """Receive and handle messages from websocket."""
            while True:
                data = await websocket.receive_json()
                envelope = ControlEnvelope.model_validate(data)

                if envelope.type == ControlMessageType.HEARTBEAT:
                    # User heartbeat - no action needed, connection stays alive
                    pass

        send_task = asyncio.create_task(send_from_queue())
        try:
            await receive_from_websocket()
        except WebSocketDisconnect:
            logger.info(f"User {user_id} disconnected")
        except Exception as e:
            logger.error(f"WebSocket error for user {user_id}: {e}")
        finally:
            send_task.cancel()
            await ctx.ws_hub.disconnect(user_id, queue)  # remove THIS socket only


    @router.websocket("/ws/host/{host_id}")
    async def host_websocket(websocket: WebSocket, host_id: str):
        """WebSocket endpoint for a USER'S COMPUTER — not an agent.

        The third socket, alongside ``/ws/{agent_id}`` (a runner) and
        ``/ws/user/{user_id}`` (a browser), and the one that makes the whole
        host feature possible: it stays connected when every agent on the
        machine is dead, which is the only way "your computer is on, but none of
        your agents are running" can be told apart from "your computer is off".
        Before this, both states were silence.

        Same first-message auth-frame handshake as the other two, same close
        codes, deliberately: a daemon and a runner should react to 4001 and 4004
        identically. 4001 means the token is wrong — stop retrying with it.
        4004 means the host record is gone or revoked — self-destruct, do not
        reconnect-loop. The revoked case routes to 4004 rather than 4001 because
        the credential was destroyed on purpose and there is nothing to retry.

        The frames here are plain JSON validated against
        ``api/host_protocol.py``, NOT ``ControlEnvelope``: the other end is the
        ``clawmeets-daemon`` distribution, which installs without pydantic, and
        ``ControlEnvelope.payload`` is a non-discriminated Union that would
        mis-resolve real inbound payloads (see its docstring).
        """
        await websocket.accept()

        try:
            hello_raw = await websocket.receive_json()
        except WebSocketDisconnect:
            logger.debug(f"Host socket disconnected before auth for {host_id}")
            return
        except Exception as e:
            logger.warning(f"Host socket auth failed for {host_id}: {e}")
            await websocket.close(code=CLOSE_BAD_TOKEN, reason="Auth failed")
            return
        verdict = check_host_socket(host_id, hello_raw, ctx.model_ctx)
        if not verdict.ok:
            await websocket.close(code=verdict.code, reason=verdict.reason)
            return
        hello = verdict.hello

        owner_id = verdict.owner_id
        queue: asyncio.Queue = asyncio.Queue()
        await ctx.ws_hub.connect_host(host_id, queue)

        logger.info(
            f"Computer {verdict.host_name!r} ({host_id}) connected "
            f"(daemon {hello.daemon_version or 'unreported'})"
        )
        await events.host_connected(host_id, owner_id, hello)
        await websocket.send_json({"type": HOST_ACCEPTED, "host_id": host_id})

        async def send_from_queue():
            """Forward queued frames; a ``None`` is the server-initiated close.

            Mirrors the agent endpoint's sentinel. ``close_host_connection``
            enqueues ``None`` when the user revokes the computer, and closing
            with ``CLOSE_NO_HOST`` is what makes the machine let go now rather
            than at its next reconnect attempt.
            """
            try:
                while True:
                    frame = await queue.get()
                    if frame is None:
                        await websocket.close(
                            code=CLOSE_NO_HOST, reason="Computer disconnected"
                        )
                        return
                    await websocket.send_json(frame)
            except Exception as e:
                logger.debug(f"Host send task ended for {host_id}: {e}")

        async def receive_from_websocket():
            while True:
                data = await websocket.receive_json()
                if not isinstance(data, dict):
                    continue
                kind = data.get("type")
                if kind in _HOST_TERMINAL_FRAMES:
                    # Checked before anything else: terminal output is the
                    # high-volume frame on this socket.
                    relay = getattr(ctx, "terminal_relay", None)
                    if relay is not None:
                        await relay.from_host(host_id, data)
                else:
                    await events.host_frame(host_id, owner_id, data)

        send_task = asyncio.create_task(send_from_queue())
        try:
            await receive_from_websocket()
        except WebSocketDisconnect:
            logger.info(f"Computer {host_id} disconnected")
        except Exception as e:
            logger.error(f"Host socket error for {host_id}: {e}")
        finally:
            send_task.cancel()
            await ctx.ws_hub.disconnect_host(host_id, queue)
            relay = getattr(ctx, "terminal_relay", None)
            if relay is not None and not ctx.ws_hub.is_host_connected(host_id):
                await relay.host_gone(host_id)
            await events.host_disconnected(host_id, owner_id)

    @router.websocket("/ws/terminal/{host_id}")
    async def terminal_websocket(websocket: WebSocket, host_id: str):
        """One terminal session: a browser tab <-> a shell on the user's computer.

        The fourth socket, and the only one that lives exactly as long as one
        thing on the other end: closing it ends the shell. First frame is
        ``{"ticket": ...}`` from ``POST /me/computers/{id}/terminal/ticket``
        (browsers cannot set headers on a websocket); an unknown, spent,
        expired or other-computer ticket closes with 4001. After that the tab
        may send ``term_input`` / ``term_resize`` / ``term_ack`` /
        ``term_close`` and receives ``term_opened`` / ``term_output`` /
        ``term_exit``, with the session id added and stripped by the relay.

        No reconnect: a dropped session is over, the same as closing a
        terminal window.
        """
        await websocket.accept()
        relay = getattr(ctx, "terminal_relay", None)
        try:
            first = await websocket.receive_json()
        except WebSocketDisconnect:
            return
        except Exception:
            await websocket.close(code=4001, reason="Expected a ticket")
            return
        grant = None
        if relay is not None and isinstance(first, dict):
            grant = relay.redeem_ticket(first.get("ticket"), host_id)
        if grant is None:
            await websocket.close(code=4001, reason="Invalid or expired ticket")
            return

        queue: asyncio.Queue = asyncio.Queue()
        client_ip = websocket.client.host if websocket.client else ""
        session_id = await relay.open(grant, queue, client_ip or "")
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
                logger.debug(f"Terminal send task ended for {session_id[:8]}: {e}")

        send_task = asyncio.create_task(send_from_queue())
        try:
            while True:
                data = await websocket.receive_json()
                if isinstance(data, dict):
                    await relay.from_browser(session_id, data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.debug(f"Terminal socket error for {session_id[:8]}: {e}")
        finally:
            await relay.close(session_id, "The browser closed the session.")
            # Let a queued term_exit and the close sentinel flush, then stop.
            try:
                await asyncio.wait_for(send_task, timeout=2)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                send_task.cancel()

    return router
