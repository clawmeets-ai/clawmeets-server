# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/client.py
``HubClient``: this deployment's one WebSocket to the hub
(``wss://{hub}/v1/connect``), and the gateway's ``RelayingAdapter``.

**Outbound only.** The deployment dials the hub; the hub never calls in. There
is no listening socket and no inbound route for the hub to reach.

**Handshake.** The hub's ``hello`` must verify under a hub key this deployment
trusts (``trust.verify_hello``); otherwise the socket is closed with nothing
sent and the link is ``untrusted``. It must name the configured hub and its
clock must be within five minutes of ours; otherwise the socket is closed
with nothing sent (link ``unreachable``, reason ``wrong_hub_url`` /
``clock_skew``). Then ``auth`` (signed by the identity key, over the hello's
nonce) and ``welcome``, whose key set is accepted through the trust rules and
whose pending statements are handed on.

**After every (re)connect**, in order: the ``on_connected`` callbacks (agent
registration, from the adapter); then, in mode ``full``, a ``watch`` for the
deployments rows are parked on, the rows parked ``hub_unreachable`` /
``browse_only`` woken, every ``awaiting_receipt`` row re-armed for one
re-relay (paced by the gateway's relay bucket), and one sweep for due probes.

**Steady state.** A ``heartbeat`` every ``welcome.heartbeat_s``; two missed
``heartbeat_ack`` drop the socket. A request (``request``) is correlated by
its frame id; every other frame is dispatched (``_dispatch``).

**Backoff.** Full jitter, doubling from 1 s to 60 s, reset after a connection
that stayed up 60 s. Close codes 4003, 4006 and 4008 are terminal (one retry
an hour, the reason kept in ``link_reason``); 4029 waits ``retry_after`` (the
close reason's number); 4004 runs ONE automatic same-key reclaim
(``on_unknown_deployment``), after which the runtime waits for the
registration to be active again; 4001 and 4009 back off normally. An
untrusted hello retries hourly.

**A rotation whose answer was lost.** After ``key_rotate`` the hub's head is
the new key, but the registration still holds the old one until
``settle_rotation`` sees the hub's chain, and that runs only after a
``welcome``. So when an ``auth`` is answered 4001 and the runtime holds one
pending rotation (``pending_identity``), the next dial signs ``auth`` with the
pending key. On its ``welcome`` the usual connect steps run, settle first;
if the pending key is still pending after them (settle did not commit it),
the socket is closed 1000 and the next dial uses the current key again. Only
a 4001 to the pending key itself disproves it (one try per 4001 streak);
a pending dial that ended any other way (no settle, a transient close, a
timeout) is tried again on the next 4001, under the backoff. A ``welcome``
under the current key ends the streak. Nothing is committed without a
``welcome`` and the hub's signed chain.

**Relay** (``RelayingAdapter``). ``prepare_relay`` (the host side's) may
refuse a reply row, or sign it first. Then the row's stored envelope is
written verbatim, ``on_written`` is called the moment ``send()`` returns
(before any file chunk and before ``relay_ack``), the files are streamed
(each binary frame: the 16-byte ``file_stream_header`` then at most
``FILE_CHUNK_BYTES``), and ``relay_ack`` / ``relay_rejected`` is awaited 10 s. A frame that left counts as forwarded
whatever happens next: a lost ack, or the socket dropping, still returns
``Forwarded`` and the row waits for its receipt. Not connected: ``Parked``
(``hub_unreachable``), nothing written. Mode ``discover_only``: ``Parked``
(``browse_only``), nothing written, ever.

**Receipts.** A ``delivery_receipt`` completes its row only when the ack's
signature verifies under the key pinned for the row's target (same genesis,
not revoked), and the ack names this deployment and this hub. Otherwise it is
logged and dropped: the row keeps waiting and is re-relayed. A receipt signed
by a key not pinned yet (the receiver rotated) is checked after a
``key_lookup`` extends the pinned chain, off the reader.
"""
from __future__ import annotations

import asyncio
import logging
import random
import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Optional

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import BaseModel, ValidationError
from websockets.exceptions import ConnectionClosed

from clawmeets.hub_protocol.canonical import (
    CanonicalError,
    Purpose,
    loads_strict,
    sign_object,
    to_wire,
    verify_object,
)
from clawmeets.hub_protocol.codes import (
    TERMINAL_CLOSE_CODES,
    CloseCode,
    DeliverResult,
    NotAcceptingDetail,
    RelayAckResult,
)
from clawmeets.hub_protocol.constants import (
    FILE_CHUNK_BYTES,
    MAX_JSON_FRAME_BYTES,
    PROTOCOL_VERSION,
)
from clawmeets.hub_protocol.envelope import file_stream_header
from clawmeets.hub_protocol.frames import (
    Auth,
    DeliverAck,
    DeliveryProbe,
    DispatchPlan,
    FrameError,
    ParsedFrame,
    make_frame,
    parse_frame,
)
from clawmeets.server.channels import hub_delivery
from clawmeets.server.channels.adapter import Forwarded, Parked, Refused, RelayOutcome
from clawmeets.server.channels.config import HubConfig
from clawmeets.server.channels.hub_store import HubLink, HubStore
from clawmeets.server.channels.store import (
    HUB_CHANNEL,
    WAIT_BROWSE_ONLY,
    WAIT_DEPLOYMENT_OFFLINE,
    WAIT_HUB_UNREACHABLE,
    ChannelConnection,
    OutboxRow,
)

from .identity import key_fingerprint
from .trust import HubUntrusted, accept_pushed_key_set, verify_hello

logger = logging.getLogger(__name__)

#: How far the hub's clock may be from ours at the handshake (design: 5 min).
HANDSHAKE_SKEW_S = 300.0
HELLO_TIMEOUT_S = 10.0
WELCOME_TIMEOUT_S = 10.0
REQUEST_TIMEOUT_S = 10.0
#: How long a requester waits for the hub's dispatch plan before giving up.
DISPATCH_ASK_TIMEOUT_S = 10.0
#: A receipt for a message with no row yet is held this long, at most this
#: many at once. A hub-dispatched request's receipt can beat its thread: the
#: hub answers with the plan, then delivers, while the requester is still
#: pinning each pick's key before it writes the row.
EARLY_RECEIPT_TTL_S = 60.0
MAX_EARLY_RECEIPTS = 256


class DispatchUnavailable(Exception):
    """The hub did not answer a dispatch_ask with a plan: ``code`` is its
    error code (``ranking_unavailable``, ``rate_limited`` with
    ``retry_after`` when the hub gave one, ``unsupported`` from a hub that
    predates the frame, ...) or ``hub_unreachable`` / ``timeout`` /
    ``bad_reply``. Nothing ranks a public request but the hub, so the caller
    reports the failure."""

    def __init__(self, code: str, *, retry_after: Optional[float] = None) -> None:
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after
BACKOFF_FIRST_S = 1.0
BACKOFF_MAX_S = 60.0
#: A connection that stayed up this long resets the backoff.
STABLE_S = 60.0
#: Terminal close codes and an untrusted hub: one retry an hour.
TERMINAL_RETRY_S = 3600.0
UNTRUSTED_RETRY_S = 3600.0
#: 4029 without a readable retry_after.
DEFAULT_RETRY_AFTER_S = 60.0
MISSED_HEARTBEATS = 2
#: What this build reports in auth.
CLIENT_VERSION = "clawmeets-server"

#: Link reasons, kept beside the link state for the browser (never secrets).
REASON_CLOCK_SKEW = "clock_skew"
REASON_WRONG_HUB_URL = "wrong_hub_url"
REASON_CONNECT_FAILED = "connect_failed"
REASON_HANDSHAKE_FAILED = "handshake_failed"

Connect = Callable[..., Any]
FrameSink = Callable[[ParsedFrame], Awaitable[None]]
StatementSink = Callable[[Mapping[str, Any]], Awaitable[None]]


@dataclass(frozen=True)
class HubIdentity:
    """This deployment on the hub: its id and its current identity key."""

    deployment_id: str
    key: Ed25519PrivateKey
    genesis_fp: str

    @property
    def fingerprint(self) -> str:
        return key_fingerprint(self.key)


class Backoff:
    """Full jitter, doubling from ``first`` to ``ceiling``: the n-th wait is
    uniform in ``[0, min(ceiling, first * 2**n)]``."""

    def __init__(self, *, rng: Callable[[], float] = random.random,
                 first: float = BACKOFF_FIRST_S, ceiling: float = BACKOFF_MAX_S) -> None:
        self._rng = rng
        self._first = first
        self._ceiling = ceiling
        self.attempt = 0

    def cap(self) -> float:
        return min(self._ceiling, self._first * (2 ** self.attempt))

    def next(self) -> float:
        wait = self._rng() * self.cap()
        self.attempt += 1
        return wait

    def reset(self) -> None:
        self.attempt = 0


class _HandshakeFailed(Exception):
    def __init__(self, link: HubLink, reason: str, retry_after: Optional[float] = None) -> None:
        super().__init__(reason)
        self.link = link
        self.reason = reason
        self.retry_after = retry_after


def ws_url(hub_url: str) -> str:
    """``https://host[:port]`` -> ``wss://host[:port]/v1/connect``."""
    return "wss://" + hub_url.split("://", 1)[1] + "/v1/connect"


def _default_connect(url: str, **kwargs: Any) -> Any:
    """The one outbound dial: straight to the hub, like ``HubHttp`` -- no
    proxy from the environment, and a redirect is a failed dial, never
    followed."""
    from websockets.asyncio.client import connect

    class _Direct(connect):
        def process_redirect(self, exc: Exception) -> Exception:
            return exc

    return _Direct(url, proxy=None, **kwargs)


async def _no_statement(_raw: Mapping[str, Any]) -> None:
    return None


class HubClient:
    """The socket, and the gateway's ``RelayingAdapter`` for ``hub`` rows."""

    channel = HUB_CHANNEL
    #: The envelope's signature authenticated the sender (checked before the gateway).
    provider_authenticates_sender = True

    def __init__(
        self, *, config: HubConfig, hub: HubStore, gateway: Any, identity: HubIdentity,
        mode: str, clock: Callable[[], float] = time.time, connect: Optional[Connect] = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        rng: Callable[[], float] = random.random,
        on_statement: StatementSink = _no_statement,
        on_deliver: Optional[FrameSink] = None,
        on_unknown_deployment: Optional[Callable[[], Awaitable[None]]] = None,
        agents_online: Callable[[], list[str]] = list,
        files_for: Optional[Callable[[OutboxRow], list[tuple[int, bytes]]]] = None,
        on_binary: Optional[Callable[[bytes], None]] = None,
        prepare_relay: Optional[Callable[[ChannelConnection, OutboxRow], Any]] = None,
        heartbeat_s: Optional[float] = None, ack_timeout: float = REQUEST_TIMEOUT_S,
        pending_identity: Callable[[], Optional[HubIdentity]] = lambda: None,
    ) -> None:
        self.config = config
        self.hub = hub
        self.gateway = gateway
        self.identity = identity
        self.mode = mode
        self._clock = clock
        self._connect = connect or _default_connect
        self._sleep = sleep
        self._backoff = Backoff(rng=rng)
        self._on_statement = on_statement
        self._on_deliver = on_deliver
        self._on_unknown_deployment = on_unknown_deployment
        self._agents_online = agents_online
        self._files_for = files_for or (lambda _row: [])
        self._on_binary = on_binary
        self._prepare_relay = prepare_relay
        self._heartbeat_override = heartbeat_s
        self._ack_timeout = ack_timeout
        #: Awaited, in order, after every welcome (the adapter's agent_register).
        self.on_connected: list[Callable[[], Awaitable[None]]] = []
        #: Called when a connected socket closes (before the next dial).
        self.on_disconnected: list[Callable[[], None]] = []
        self._ws: Any = None
        self._pending: dict[str, asyncio.Future] = {}
        self._stopping = asyncio.Event()
        self._unacked_heartbeats = 0
        self._reclaimed = False
        self._reclaim_task: Optional[asyncio.Future] = None
        #: The one pending rotation's key, if the runtime holds one.
        self.pending_identity = pending_identity
        #: The next dial signs auth with the pending key (set by a 4001).
        self._dial_pending = False
        #: The pending key was tried in this 4001 streak.
        self._pending_tried = False
        #: The identity the current session's auth was signed with.
        self._session_identity: Optional[HubIdentity] = None
        #: Receipts waiting for a key_lookup of their signer.
        self._lookups: set[asyncio.Future] = set()
        #: Receipts that arrived before their row: message_id -> (held at, data).
        self._early_receipts: dict[str, tuple[float, dict]] = {}
        self.link: HubLink = "unreachable"
        self.link_reason: Optional[str] = None
        #: The last close code the hub sent, if any.
        self.close_code: Optional[int] = None
        #: The waits between attempts, in order (read by tests and logs).
        self.waits: list[float] = []
        self.connected = asyncio.Event()

    # ── lifecycle ────────────────────────────────────────────────────────

    async def run(self) -> None:
        """Connect, serve until the socket closes, wait, again; until ``stop``.
        An unexpected error in one session (a locked database, say) is logged
        and waited out like a dropped connection: it never ends the loop. A
        4004 reclaim running in the background is waited for before the next
        dial, so the dial after a successful reclaim is not another 4004."""
        while not self._stopping.is_set():
            try:
                wait = await self._session()
            except Exception:  # noqa: BLE001 — the loop must outlive any one session
                logger.error("Hub session failed; reconnecting after a backoff", exc_info=True)
                self._set_link("unreachable", None)
                wait = self._backoff.next()
            if self._stopping.is_set():
                break
            reclaim = self._reclaim_task
            if reclaim is not None and not reclaim.done():
                await self._until(reclaim)
                if self._stopping.is_set():
                    break
            self.waits.append(wait)
            await self._wait(wait)

    async def _until(self, future: asyncio.Future) -> None:
        """Wait for ``future`` (never cancelling it) or ``stop``."""
        stopper = asyncio.ensure_future(self._stopping.wait())
        try:
            await asyncio.wait({future, stopper}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            stopper.cancel()

    def cancel_background(self) -> None:
        """Cancel the 4004 reclaim and receipt key lookups still running (the
        runtime is replacing or stopping this client)."""
        for task in [self._reclaim_task, *self._lookups]:
            if task is not None and not task.done():
                task.cancel()
        self._lookups.clear()

    async def stop(self) -> None:
        self._stopping.set()
        ws = self._ws
        if ws is not None:
            try:
                await ws.close(1001, "shutting down")
            except Exception:  # noqa: BLE001 — closing a dead socket
                pass

    async def _wait(self, seconds: float) -> None:
        sleeper = asyncio.ensure_future(self._sleep(seconds))
        stopper = asyncio.ensure_future(self._stopping.wait())
        try:
            await asyncio.wait({sleeper, stopper}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in (sleeper, stopper):
                task.cancel()

    def _set_link(self, link: HubLink, reason: Optional[str] = None) -> None:
        self.link, self.link_reason = link, reason
        if link == "connected":
            self.connected.set()
        else:
            self.connected.clear()
        try:
            self.hub.set_hub_link(self.config.hub_url, link, now=self._clock())
        except Exception as exc:  # noqa: BLE001 — the stored link is a display hint
            logger.warning("Hub link not stored: %s", type(exc).__name__)

    # ── one connection ───────────────────────────────────────────────────

    async def _session(self) -> float:
        """One connection from dial to close. Returns the wait before the next."""
        try:
            ws = await self._connect(
                ws_url(self.config.hub_url), max_size=MAX_JSON_FRAME_BYTES, open_timeout=10,
                ping_interval=None,
            )
        except Exception as exc:  # noqa: BLE001 — any dial failure is "unreachable"
            logger.info("Hub connect failed: %s", type(exc).__name__)
            self._set_link("unreachable", REASON_CONNECT_FAILED)
            return self._backoff.next()
        self.close_code = None
        self._session_identity = None
        try:
            try:
                welcome = await self._handshake(ws)
            except _HandshakeFailed as failed:
                await _quiet_close(ws)
                self._set_link(failed.link, failed.reason)
                if failed.link == "untrusted":
                    return UNTRUSTED_RETRY_S
                if failed.retry_after is not None:
                    return failed.retry_after
                return self._backoff.next()
            except ConnectionClosed as closed:
                return self._after_close(closed, stable=False, answered_auth=True)
            connected_at = time.monotonic()
            self._ws = ws
            self._unacked_heartbeats = 0
            self._reclaimed = False
            dialed_pending = self._session_identity is not self.identity
            if not dialed_pending:
                self._pending_tried = False             # a welcome under the current key ends the streak
            await self._accept_welcome(welcome)
            self._set_link("connected")
            heartbeats = asyncio.create_task(self._heartbeats(ws, welcome))
            # The reader runs from the start: a reconnect step that asks the
            # hub something (watch) needs its answer read.
            reader = asyncio.create_task(self._serve(ws))
            closed_exc: Optional[ConnectionClosed] = None
            try:
                try:
                    await self._after_connect()
                except (ConnectionError, ConnectionClosed, asyncio.TimeoutError) as exc:
                    logger.info("Hub reconnect steps cut short: %s", type(exc).__name__)
                if dialed_pending and self._still_pending(self._session_identity):
                    logger.warning("Hub: the pending rotation did not settle; dialing with the current key")
                    await ws.close(1000, "rotation not settled")
                elif dialed_pending:
                    self._pending_tried = False         # settled: the streak is over
                await reader
            except ConnectionClosed as closed:
                closed_exc = closed
            finally:
                heartbeats.cancel()
                reader.cancel()
                self._ws = None
                self._fail_pending()
                for callback in list(self.on_disconnected):
                    try:
                        callback()
                    except Exception as exc:  # noqa: BLE001 — one callback never stops the rest
                        logger.warning("Hub on-disconnect step failed: %s", type(exc).__name__)
            stable = time.monotonic() - connected_at >= STABLE_S
            if closed_exc is None:
                closed_exc = _closed_of(ws)
            return self._after_close(closed_exc, stable=stable)
        except Exception:
            await _quiet_close(ws)                  # run() logs it and dials again
            raise
        finally:
            if self.link == "connected":
                self._set_link("unreachable", None)
            self._end_pending_dial()

    def _end_pending_dial(self) -> None:
        """After a session dialed with the pending key: only the hub's 4001 to
        that key disproves it. Any other end (welcome but no settle, a
        transient close, a timeout) leaves it possible, so the next old-key
        4001 dials it again -- under the growing backoff, since such a session
        was never stable. Without this, one lost settle meant 4001 on every
        dial until a restart."""
        identity = self._session_identity
        if (identity is not None and identity is not self.identity and self._still_pending(identity)
                and self.close_code != CloseCode.INVALID_SIGNATURE):
            self._pending_tried = False

    def _auth_identity(self) -> HubIdentity:
        """The key this dial's auth is signed with: the pending rotation's
        key once after a 4001 (``_dial_pending``), else the current one."""
        if self._dial_pending:
            self._dial_pending = False
            pending = self.pending_identity()
            if pending is not None and pending.deployment_id == self.identity.deployment_id:
                return pending
        return self.identity

    def _still_pending(self, identity: Optional[HubIdentity]) -> bool:
        """The key a session dialed with is still a pending rotation (not committed)."""
        pending = self.pending_identity()
        return identity is not None and pending is not None and pending.fingerprint == identity.fingerprint

    def _after_close(self, closed: Optional[ConnectionClosed], *, stable: bool,
                     answered_auth: bool = False) -> float:
        rcvd = getattr(closed, "rcvd", None)
        code = rcvd.code if rcvd is not None else None
        reason = rcvd.reason if rcvd is not None else ""
        self.close_code = code
        if stable:
            self._backoff.reset()
        if (answered_auth and code == CloseCode.INVALID_SIGNATURE and not self._pending_tried
                and self.pending_identity() is not None):
            # The hub's head may be a rotation whose answer was lost: one dial with it.
            self._pending_tried = True
            self._dial_pending = True
        if code in {int(c) for c in TERMINAL_CLOSE_CODES}:
            self._set_link("unreachable", CloseCode(code).name.lower())
            return TERMINAL_RETRY_S
        if code == CloseCode.RATE_LIMITED:
            self._set_link("unreachable", "rate_limited")
            match = re.search(r"\d+", reason or "")
            # Read before the hub is verified: never a tight loop, never parked for good.
            retry = float(match.group()) if match else DEFAULT_RETRY_AFTER_S
            return min(max(retry, BACKOFF_FIRST_S), TERMINAL_RETRY_S)
        if code == CloseCode.UNKNOWN_DEPLOYMENT:
            self._set_link("unreachable", "unknown_deployment")
            if self._reclaimed or self._on_unknown_deployment is None:
                return TERMINAL_RETRY_S
            self._reclaimed = True
            self._reclaim_task = asyncio.ensure_future(self._on_unknown_deployment())
            return self._backoff.next()
        self._set_link("unreachable", None)
        return self._backoff.next()

    async def _handshake(self, ws: Any) -> dict:
        """hello -> auth -> welcome. Returns the welcome's raw data."""
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=HELLO_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise _HandshakeFailed("unreachable", REASON_HANDSHAKE_FAILED) from None
        hello_frame = self._parse(raw)
        if hello_frame is None or hello_frame.frame.type != "hello":
            raise _HandshakeFailed("unreachable", REASON_HANDSHAKE_FAILED)
        now = self._clock()
        try:
            hello = verify_hello(hello_frame.data, hub=self.hub, config=self.config, now=now)
        except HubUntrusted as exc:
            logger.warning("Hub hello not trusted (%s): closing, nothing sent", exc.reason)
            raise _HandshakeFailed("untrusted", exc.reason) from None
        if hello.hub_url != self.config.hub_url:
            raise _HandshakeFailed("unreachable", REASON_WRONG_HUB_URL)
        if abs(hello.hub_time - now) > HANDSHAKE_SKEW_S:
            raise _HandshakeFailed("unreachable", REASON_CLOCK_SKEW)
        identity = self._auth_identity()
        self._session_identity = identity
        auth = Auth(
            v=PROTOCOL_VERSION, aud=self.config.hub_url, nonce=hello.nonce,
            deployment_id=identity.deployment_id, fingerprint=identity.fingerprint,
            client_version=CLIENT_VERSION, ts=int(now),
        )
        signed = sign_object(to_wire(auth), identity.key, purpose=Purpose.AUTH)
        frame_id = _frame_id()
        await ws.send(make_frame("auth", signed, id=frame_id).decode("utf-8"))
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=WELCOME_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise _HandshakeFailed("unreachable", REASON_HANDSHAKE_FAILED) from None
        welcome = self._parse(raw)
        if welcome is None or welcome.frame.type != "welcome":
            raise _HandshakeFailed("unreachable", REASON_HANDSHAKE_FAILED)
        return welcome.data

    async def _accept_welcome(self, welcome: dict) -> None:
        """The welcome's key set (through the trust rules) and its pending statements."""
        now = self._clock()
        try:
            added = accept_pushed_key_set(self.hub, self.config, welcome["hub_key_set"], now=now)
            if added:
                logger.info("Hub key set: %d new key(s) trusted", len(added))
        except HubUntrusted as exc:
            logger.warning("Hub key set in welcome not accepted: %s", exc.reason)
        for statement in welcome.get("pending_statements") or ():
            await self._statement(statement)

    async def _after_connect(self) -> None:
        """The reconnect steps, in order (see the module docstring)."""
        for callback in list(self.on_connected):
            try:
                await callback()
            except Exception as exc:  # noqa: BLE001 — one callback never stops the rest
                logger.warning("Hub on-connect step failed: %s", type(exc).__name__)
        if self.mode != "full":
            return
        await self._watch_parked_targets()
        self.hub.wake_hub_rows(now=self.gateway._now(), reasons=(WAIT_HUB_UNREACHABLE, WAIT_BROWSE_ONLY))
        self.hub.rearm_awaiting(now=self.gateway._now())
        try:
            await self.gateway.sweep_hub_rows()
        except Exception as exc:  # noqa: BLE001 — the regular sweep tries again
            logger.warning("Hub reconnect sweep failed: %s", type(exc).__name__)

    async def _watch_parked_targets(self) -> None:
        targets = self.hub.deployment_ids_for(self.hub.parked_targets(WAIT_DEPLOYMENT_OFFLINE))
        if not targets:
            return
        try:
            reply = await self.request("watch", {"deployment_ids": sorted(targets)})
        except Exception as exc:  # noqa: BLE001 — presence pushes still wake them
            logger.info("Hub watch failed: %s", type(exc).__name__)
            return
        if reply.frame.type == "watch_ack":
            for item in reply.data.get("presence") or ():
                if item.get("connected") and item.get("deployment_id") in targets:
                    self._wake_target(targets[item["deployment_id"]])

    def _wake_target(self, genesis_fp: str) -> None:
        self.hub.wake_hub_rows(now=self.gateway._now(), conversation_prefix=f"{genesis_fp}/")

    async def _serve(self, ws: Any) -> None:
        async for message in ws:
            if isinstance(message, bytes):
                if self._on_binary is not None:     # inbound file chunks: the adapter's
                    try:
                        self._on_binary(message)
                    except Exception as exc:  # noqa: BLE001 — one bad chunk never drops the socket
                        logger.warning("Hub file chunk not taken: %s", type(exc).__name__)
                continue
            parsed = self._parse(message)
            if parsed is None:
                continue
            future = self._pending.pop(parsed.frame.id, None)
            if future is not None and not future.done():
                future.set_result(parsed)
                continue
            try:
                await self._dispatch(parsed)
            except Exception as exc:  # noqa: BLE001 — one bad frame never drops the socket
                logger.warning("Hub frame %s not handled: %s", parsed.frame.type, type(exc).__name__)

    async def _heartbeats(self, ws: Any, welcome: dict) -> None:
        every = self._heartbeat_override or float(welcome.get("heartbeat_s") or 20)
        seq = 0
        while True:
            await asyncio.sleep(every)
            if self._unacked_heartbeats >= MISSED_HEARTBEATS:
                logger.info("Hub missed %d heartbeat acks: dropping the socket", MISSED_HEARTBEATS)
                await _quiet_close(ws, 1011, "heartbeat")
                return
            seq += 1
            self._unacked_heartbeats += 1
            try:
                await self.send("heartbeat", {"seq": seq, "agents_online": list(self._agents_online())})
            except ConnectionClosed:
                return

    def _parse(self, raw: Any) -> Optional[ParsedFrame]:
        try:
            return parse_frame(raw, direction="hub_to_dep")
        except FrameError as exc:
            logger.warning("Hub sent a frame this build cannot read: %s", exc.code.value)
            return None

    def _fail_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ConnectionError("hub socket closed"))
        self._pending.clear()

    # ── requests ─────────────────────────────────────────────────────────

    async def send(self, frame_type: str, data: BaseModel | Mapping[str, Any]) -> bool:
        """Fire and forget. False when no socket is up (nothing written)."""
        ws = self._ws
        if ws is None:
            return False
        await ws.send(make_frame(frame_type, data, id=_frame_id()).decode("utf-8"))
        return True

    async def request(
        self, frame_type: str, data: BaseModel | Mapping[str, Any], *, timeout: float = REQUEST_TIMEOUT_S,
    ) -> ParsedFrame:
        """Send and wait for the frame that echoes its id. ConnectionError when
        no socket is up or it closes first; asyncio.TimeoutError after ``timeout``."""
        ws = self._ws
        if ws is None:
            raise ConnectionError("hub socket not connected")
        frame_id = _frame_id()
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[frame_id] = future
        try:
            await ws.send(make_frame(frame_type, data, id=frame_id).decode("utf-8"))
            return await asyncio.wait_for(future, timeout=timeout)
        finally:
            self._pending.pop(frame_id, None)

    async def ask(self, ask: Mapping[str, Any], *, timeout: float = DISPATCH_ASK_TIMEOUT_S) -> DispatchPlan:
        """Send a signed DispatchAsk and return the hub's plan.
        DispatchUnavailable for anything else (see its docstring)."""
        try:
            reply = await self.request("dispatch_ask", ask, timeout=timeout)
        except asyncio.TimeoutError:
            raise DispatchUnavailable("timeout") from None
        except (ConnectionError, ConnectionClosed):
            raise DispatchUnavailable("hub_unreachable") from None
        if reply.frame.type == "error":
            retry_after = reply.data.get("retry_after")
            raise DispatchUnavailable(
                str(reply.data.get("code") or "error"),
                retry_after=float(retry_after) if isinstance(retry_after, (int, float)) else None,
            )
        if reply.frame.type != "dispatch_plan" or not isinstance(reply.model, DispatchPlan):
            raise DispatchUnavailable("bad_reply")
        if reply.model.ask_id != ask.get("ask_id"):
            raise DispatchUnavailable("bad_reply")
        return reply.model

    async def report_outcome(self, outcome: Mapping[str, Any], *, timeout: float = REQUEST_TIMEOUT_S) -> int:
        """Send a signed DispatchOutcome; the number of events the hub took.
        DispatchUnavailable when it did not acknowledge."""
        try:
            reply = await self.request("dispatch_outcome", outcome, timeout=timeout)
        except asyncio.TimeoutError:
            raise DispatchUnavailable("timeout") from None
        except (ConnectionError, ConnectionClosed):
            raise DispatchUnavailable("hub_unreachable") from None
        if reply.frame.type == "error":
            raise DispatchUnavailable(str(reply.data.get("code") or "error"))
        if reply.frame.type != "dispatch_outcome_ack":
            raise DispatchUnavailable("bad_reply")
        return int(reply.data.get("accepted") or 0)

    # ── RelayingAdapter ──────────────────────────────────────────────────

    async def relay(
        self, connection: ChannelConnection, row: OutboxRow, *, on_written: Callable[[], None],
    ) -> RelayOutcome:
        if self.mode != "full":
            return Parked(WAIT_BROWSE_ONLY)
        ws = self._ws
        if ws is None or self.link != "connected":
            return Parked(WAIT_HUB_UNREACHABLE)
        text = row.envelope
        if self._prepare_relay is not None:
            prepared = self._prepare_relay(connection, row)
            if isinstance(prepared, (Forwarded, Parked, Refused)):
                return prepared
            text = prepared or text
        if not text:
            return Parked(WAIT_HUB_UNREACHABLE)
        try:
            envelope = loads_strict(text)
        except CanonicalError:
            return Refused("invalid_frame")
        frame_id = _frame_id()
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[frame_id] = future
        try:
            try:
                await ws.send(make_frame("relay", envelope, id=frame_id).decode("utf-8"))
            except Exception:  # noqa: BLE001 — nothing left: wait for the hub
                return Parked(WAIT_HUB_UNREACHABLE)
            on_written()
            try:
                for index, data in self._files_for(row):
                    header = file_stream_header(row.message_id, index)
                    for start in range(0, len(data), FILE_CHUNK_BYTES):
                        await ws.send(header + data[start:start + FILE_CHUNK_BYTES])
            except Exception:  # noqa: BLE001 — the relay left; the receipt decides
                return Forwarded()
            try:
                reply = await asyncio.wait_for(future, timeout=self._ack_timeout)
            except (asyncio.TimeoutError, ConnectionError):
                return Forwarded()                    # a lost ack still counts as forwarded
        finally:
            self._pending.pop(frame_id, None)
        return self._relay_outcome(reply)

    def _relay_outcome(self, reply: ParsedFrame) -> RelayOutcome:
        kind, data = reply.frame.type, reply.data
        if kind == "relay_ack":
            if data.get("result") == RelayAckResult.TARGET_DISCONNECTED.value:
                return Parked(WAIT_DEPLOYMENT_OFFLINE)
            return Forwarded()
        if kind == "relay_rejected":
            t = hub_delivery.relay_rejected_transition(
                data.get("reason", ""), data.get("detail"), data.get("retry_after"), now=self.gateway._now(),
            )
            if isinstance(t, hub_delivery.ParkFor):
                return Parked(t.reason, t.until)
            return Refused(t.reason or "refused", detail=t.delivery_detail, retry_at=t.retry_at)
        if kind == "error":
            return Refused(str(data.get("code") or "error"))
        return Forwarded()

    async def probe(self, connection: ChannelConnection, row: OutboxRow) -> bool:
        """A signed delivery_probe for a held row (no body). True if written."""
        if self.mode != "full" or self._ws is None or not row.envelope:
            return False
        envelope = loads_strict(row.envelope)
        probe = DeliveryProbe(
            v=PROTOCOL_VERSION, aud=self.config.hub_url, message_id=row.message_id,
            from_deployment=self.identity.deployment_id, to_deployment=envelope["to_deployment"],
            to_agent=envelope.get("to_agent"), ts=int(self._clock()),
        )
        signed = sign_object(to_wire(probe), self.identity.key, purpose=Purpose.DELIVERY_PROBE)
        try:
            return await self.send("delivery_probe", signed)
        except ConnectionClosed:
            return False

    # ── inbound ──────────────────────────────────────────────────────────

    async def _dispatch(self, parsed: ParsedFrame) -> None:
        kind, data = parsed.frame.type, parsed.data
        if kind == "heartbeat_ack":
            self._unacked_heartbeats = 0
        elif kind == "delivery_receipt":
            await self._receipt(data)
        elif kind in ("deliver", "deliver_probe", "dispatch_deliver"):
            if self._on_deliver is not None:
                await self._on_deliver(parsed)          # the runtime routes it, by mode
            elif self.mode != "full":
                if kind == "deliver":
                    await self._refuse_browse_only(data)
            else:
                logger.info("Hub %s dropped: nothing here receives it", kind)
        elif kind == "statement":
            await self._statement(data)
        elif kind == "deployment_presence":
            genesis_fp = self.hub.genesis_for_deployment(str(data.get("deployment_id", "")))
            if data.get("connected") and genesis_fp is not None:
                self._wake_target(genesis_fp)
        elif kind == "error":
            logger.info("Hub error frame: %s", data.get("code"))
        else:
            logger.debug("Hub %s frame ignored", kind)

    async def _statement(self, raw: Mapping[str, Any]) -> None:
        try:
            await self._on_statement(raw)
        except Exception as exc:  # noqa: BLE001 — a bad statement is logged, never fatal
            logger.warning("Hub statement not applied: %s", type(exc).__name__)

    async def _receipt(self, data: Mapping[str, Any], *, looked_up: bool = False) -> None:
        """A receipt completes its row only if B's signature checks out. A
        receipt signed by a key not met yet (B rotated) is checked after a
        key_lookup, off the reader (whose answer it waits for)."""
        raw_ack = data.get("ack")
        message_id = data.get("message_id")
        row = self.hub.hub_row_for_message(message_id) if isinstance(message_id, str) else None
        if row is None or not isinstance(raw_ack, Mapping):
            if isinstance(message_id, str) and isinstance(raw_ack, Mapping):
                self._hold_early_receipt(message_id, data)
            else:
                logger.info("Hub receipt for no row here: dropped")
            return
        target_genesis = row.conversation_key.split("/", 1)[0]
        signer = str(raw_ack.get("from_fingerprint", ""))
        pin = self.hub.pin_for(signer)
        if pin is None and not looked_up:
            task = asyncio.ensure_future(self._receipt_after_lookup(data, target_genesis, signer))
            self._lookups.add(task)
            task.add_done_callback(self._lookups.discard)
            return
        if (pin is None or pin.genesis_fp != target_genesis or pin.revoked_at is not None
                or pin.identity_changed_at is not None):
            logger.warning("Hub receipt not signed by the row's target: dropped, the row waits")
            return
        if not verify_object(raw_ack, pin.pubkey, purpose=Purpose.DELIVER_ACK):
            logger.warning("Hub receipt signature does not verify: dropped, the row waits")
            return
        try:
            ack = DeliverAck.model_validate(raw_ack)
        except ValidationError:
            logger.warning("Hub receipt does not fit its schema: dropped")
            return
        if ack.to_deployment != self.identity.deployment_id or ack.aud != self.config.hub_url:
            logger.warning("Hub receipt names another deployment or hub: dropped")
            return
        await self.gateway.complete_on_receipt(row.connection_id, ack)

    def _hold_early_receipt(self, message_id: str, data: Mapping[str, Any]) -> None:
        """Keep a receipt with no row for EARLY_RECEIPT_TTL_S (oldest dropped
        past MAX_EARLY_RECEIPTS); replay_early_receipt places it once its row
        exists. Nothing is trusted here: the replay runs every check."""
        now = self._clock()
        for key in [k for k, (at, _) in self._early_receipts.items() if now - at > EARLY_RECEIPT_TTL_S]:
            del self._early_receipts[key]
        while len(self._early_receipts) >= MAX_EARLY_RECEIPTS:
            del self._early_receipts[next(iter(self._early_receipts))]
        self._early_receipts[message_id] = (now, dict(data))
        logger.info("Hub receipt for no row yet: held for %ss", int(EARLY_RECEIPT_TTL_S))

    async def replay_early_receipt(self, message_id: str) -> None:
        """A row for ``message_id`` was just written: run a receipt that
        arrived before it, if one is held and still fresh."""
        held = self._early_receipts.pop(message_id, None)
        if held is not None and self._clock() - held[0] <= EARLY_RECEIPT_TTL_S:
            await self._receipt(held[1])

    async def _receipt_after_lookup(self, data: Mapping[str, Any], target_genesis: str, signer: str) -> None:
        from .keys import ChainUnverified, look_up_and_pin

        deployment_id = next((d for d, g in self.hub.deployment_ids_for([target_genesis]).items()), None)
        try:
            await look_up_and_pin(self.request, self.hub, self.config, now=self._clock(),
                                  deployment_id=deployment_id, fingerprint=signer)
        except (ChainUnverified, ConnectionError, asyncio.TimeoutError) as exc:
            logger.warning("Hub receipt signer could not be looked up (%s): dropped, the row waits",
                           type(exc).__name__)
            return
        await self._receipt(data, looked_up=True)

    async def _refuse_browse_only(self, data: Mapping[str, Any]) -> None:
        """discover_only: every inbound message is refused not_accepting /
        browse_only, signed, and nothing else happens."""
        envelope = data.get("envelope")
        if not isinstance(envelope, Mapping):
            return
        message_id, sender = envelope.get("message_id"), envelope.get("from_deployment")
        if not isinstance(message_id, str) or not isinstance(sender, str):
            return
        try:
            ack = DeliverAck(
                aud=self.config.hub_url, message_id=message_id, to_deployment=sender,
                result=DeliverResult.NOT_ACCEPTING.value, detail=NotAcceptingDetail.BROWSE_ONLY.value,
                at=int(self._clock()), from_fingerprint=self.identity.fingerprint,
            )
        except ValidationError:
            return
        signed = sign_object(to_wire(ack), self.identity.key, purpose=Purpose.DELIVER_ACK)
        await self.send("deliver_ack", signed)


def _frame_id() -> str:
    return uuid.uuid4().hex[:24]


def _closed_of(ws: Any) -> Optional[ConnectionClosed]:
    """The ConnectionClosed a finished ``async for`` swallowed, rebuilt from the socket."""
    rcvd = getattr(ws, "close_rcvd", None)
    if rcvd is None:
        return None
    return ConnectionClosed(rcvd, getattr(ws, "close_sent", None))


async def _quiet_close(ws: Any, code: int = 1000, reason: str = "") -> None:
    try:
        await ws.close(code, reason)
    except Exception:  # noqa: BLE001 — closing a dead socket
        pass
