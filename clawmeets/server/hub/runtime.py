# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/runtime.py
``HubRuntime``: the one owner of "is the hub live right now". The app builds
one beside the channel gateway, starts it after the gateway and stops it
before; routes read the hub's state only through it.

**By mode.**
- ``off`` (unset, empty or ``off``): no ``HubClient`` is ever built and no
  network call is made; the runtime only reopens paused work, so the
  gateway's sweep can still close it.
- ``discover_only``: the client connects, and relays nothing in either
  direction (``HubClient.relay`` parks ``browse_only``).
- ``full``: everything.
- ``auto`` (the default): ``full``, on demand. Users register the deployment
  from the browser (``enroll.py``), and the client runs only while
  ``demand.py`` says something needs it: a listed agent, a retained agent, an
  open conversation or row, a recent search. ``require_live`` connects first
  when a browser action needs the hub and nothing else had.
An unrecognised mode never gets here: ``hub_config_for_boot`` refuses boot.

**Boot, in order.** (1) Paused conversations are reopened from the outbox:
every open hub request (held rows included) gets its ``PendingWork`` back,
paused (``awaiting_delivery``), with ``awaiting_since`` the row's own
``created_at``, so the 7-day ceiling is not reset by a restart; and every
request the target accepted whose batch had not ended (no reply, no closing
note) gets it back unpaused, its timer running from the receipt. In every
mode. (2) Mode not off: the trusted hub keys are seeded and the kids a
release withdrew (``REVOKED_HUB_KIDS``) purged with every key accepted
through them (``trust.seed_trust``), BEFORE any connect. A hub URL with only
a placeholder pinned stops here (link ``untrusted``): nothing connects.
(3) The registration is read; if active, the client starts.

**Registration pick-up.** ``clawmeets server hub register | verify`` run in
another process and write ``channels.db``. The runtime re-reads the
registration row every ``REGISTRATION_POLL_SECONDS`` (one indexed read) and
starts, restarts (a new deployment id or key) or stops the client to match,
with no server restart.

**Operator requests.** ``clawmeets server hub rotate`` cannot rotate on its
own (``key_rotate`` is a socket frame, and a second socket would displace
this one), so it leaves a request file that the same poll picks up
(``_serve_operator_request``): the rotation runs on this server's socket and
the answer is written back for the waiting command.

**Close code 4004.** The client asks once (``_reclaim``): a re-registration
under the same key, reclaim, no email (``operator.same_key_reclaim``). The
HTTP call runs in a worker thread; the answer is checked and saved on the
event loop. The next poll restarts the client if the deployment id changed,
or stops it until the registration is active again.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Callable, Mapping, Optional

import httpx
from cryptography.fernet import InvalidToken
from pydantic import ValidationError

from clawmeets.api.control import ControlEnvelope, ControlMessageType
from clawmeets.hub_protocol.codes import StatementKind
from clawmeets.models.agent import Agent
from clawmeets.models.project import Project, counterpart_of
from clawmeets.server.agent_visibility import local_conversation_count
from clawmeets.server.batch_timeout import AWAITING_DELIVERY_CEILING_SECONDS
from clawmeets.server.channels.hub_store import HubLink, HubRegistration
from clawmeets.server.channels.store import HUB_CHANNEL, KIND_HUB_REQUEST, OutboxRow
from clawmeets.sync.changelog import ChangelogEntryType

from . import keys, operator
from .adapter import HubAdapter, local_day, next_local_midnight
from .avatar import HubAvatars
from .browser import (
    HubChannel,
    HubChannelStatusEvent,
    HubChannelStatusPayload,
    HubDeliveryStateEvent,
    HubDeliveryStatePayload,
    HubError,
)
from .demand import Demand
from .directory import HubDirectory
from .enroll import HubEnrollmentService
from .views import channel_out, delivery_out
from .client import HubClient, HubIdentity
from .mirror import RequesterMirror
from .room_bridge import RoomBridge
from .retain import RetainStore
from .http import HubHttp, HubRefused, HubUnreachable
from .identity import load_identity
from .trust import HubUntrusted, seed_trust

if TYPE_CHECKING:
    from clawmeets.server.channels.gateway import ChannelGateway
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

#: How often the registration row is re-read (``register`` / ``verify`` pick-up).
REGISTRATION_POLL_SECONDS = 5.0
#: How long ``require_live`` waits for an on-demand connect.
LIVE_WAIT_SECONDS = 5.0
UC = "user-communication"


@dataclass
class HubRuntimeOptions:
    """Injection points (tests); the defaults are production's."""

    #: The client's ``connect`` (default: websockets' client).
    connect: Optional[Callable[..., Any]] = None
    #: The automatic reclaim's HTTP transport (default: the network).
    http_transport: Optional[httpx.BaseTransport] = None
    poll_seconds: float = REGISTRATION_POLL_SECONDS
    #: Extra HubClient arguments (sleep, rng, heartbeat_s, ack_timeout).
    client_kwargs: dict = field(default_factory=dict)


class HubRuntime:
    def __init__(
        self, ctx: "ServerContext", gateway: "ChannelGateway", *,
        options: Optional[HubRuntimeOptions] = None,
    ) -> None:
        self._ctx = ctx
        self.gateway = gateway
        self.config = gateway.config.hub
        self.options = options or HubRuntimeOptions()
        self.client: Optional[HubClient] = None
        self._client_task: Optional[asyncio.Task] = None
        self._client_key: Optional[tuple] = None
        self._poll_task: Optional[asyncio.Task] = None
        #: One reconcile at a time (the poll and a 4004 reclaim both call it).
        self._reconcile_lock = asyncio.Lock()
        self._stopped = False
        #: Set when this deployment will not trust the hub (e.g. a placeholder pin).
        self.untrusted_reason: Optional[str] = None
        #: What happened at boot, in order (read by tests and logs).
        self.boot_steps: list[str] = []
        self._identity: Optional[HubIdentity] = None
        self._identity_key: Optional[tuple] = None
        #: The host side: this server's agents' Hub channels.
        self.adapter = HubAdapter(self)
        #: The requester side: this server's users' threads with remote agents.
        self.mirror = RequesterMirror(self)
        #: Search, agent detail and reports, cached 24 h.
        self.directory = HubDirectory(self)
        #: Remote agents' avatars: fetched, re-encoded, cached per listing refresh.
        self.avatars = HubAvatars(self)
        #: The users' retained remote agents (statements move their state).
        self.retained = RetainStore(ctx, self.hub, self)
        #: Retained agents taking part in workrooms (room_bridge.py).
        self.bridge = RoomBridge(self)
        #: Whether the socket is wanted now (mode auto connects on demand).
        self.demand = Demand(self)
        #: This server's registration and its users' owner checks, from the browser.
        self.enrollment = HubEnrollmentService(self)
        gateway.on_hub_row_change = self.push_delivery
        gateway.on_hub_allowed = self.adapter.on_allowed
        gateway.on_hub_inspected = self.adapter.on_inspected
        gateway.hub_files_for = self.adapter.files_for
        gateway.hub_files_flushed = self.adapter.files_flushed
        #: Inbound deliver / deliver_probe / dispatch_deliver frames, handled in order, off the
        #: socket's reader (a first contact asks the hub for a key).
        self._inbound: Optional[asyncio.Queue] = None
        self._inbound_task: Optional[asyncio.Task] = None

    @property
    def mode(self) -> str:
        """What the socket does (``auto`` relays like ``full``); the
        configured value is ``config.mode``."""
        return self.config.effective_mode

    @property
    def hub(self):
        return self.gateway.hub

    def _now(self) -> float:
        return self.gateway._now()

    def registration(self) -> Optional[HubRegistration]:
        if not self.config.hub_url:
            return None
        return self.hub.registration(self.config.hub_url)

    def identity(self) -> Optional[HubIdentity]:
        """This deployment's id and current identity key, when registered."""
        reg = self.registration()
        if (reg is None or reg.status != "active" or not reg.deployment_id
                or not reg.identity_connection_id or self.config.fernet is None):
            return None
        key = (reg.deployment_id, reg.identity_connection_id)
        if key != self._identity_key:
            try:
                private = load_identity(self.gateway.store, reg.identity_connection_id, self.config.fernet)
            except (KeyError, InvalidToken):
                return None
            self._identity = HubIdentity(deployment_id=reg.deployment_id, key=private,
                                         genesis_fp=reg.genesis_fp or "")
            self._identity_key = key
        return self._identity

    def deployment_document(self) -> Optional[dict]:
        """This deployment's signed DeploymentDocument (the hub fetches it to
        verify ``public_url``), signed now by the current identity key. None
        when the hub is off, nothing names a public URL, or the key is
        revoked (``held_for_reclaim``). Served before the first registration
        is answered too (status ``none``), without a deployment id: that is
        when the hub checks it."""
        reg = self.registration()
        if (not self.config.enabled or reg is None or not reg.public_url or not reg.identity_connection_id
                or reg.status == "held_for_reclaim" or self.config.fernet is None):
            return None
        try:
            key = load_identity(self.gateway.store, reg.identity_connection_id, self.config.fernet)
        except (KeyError, InvalidToken):
            return None
        return keys.sign_deployment_document(
            key, hub_url=self.config.hub_url, public_url=reg.public_url, deployment_id=reg.deployment_id,
            genesis_fp=reg.genesis_fp if reg.deployment_id else None, now=self._now(),
        )

    def require(self, *, send: bool) -> None:
        """The hub-state errors, in their fixed order (design section 5):
        mode off, not registered, browse-only (for start, send, enable),
        untrusted, unreachable. Raises :class:`HubError`."""
        if not self.config.enabled:
            raise HubError("hub_off_on_server", "the hub is off on this server")
        reg = self.registration()
        if reg is None or reg.status != "active":
            raise HubError("hub_not_registered", "this server is not registered with the hub")
        if send and self.mode == "discover_only":
            raise HubError("hub_discover_only", "this server only browses the hub")
        link = self.link()
        if link == "untrusted":
            raise HubError("hub_untrusted", "this server does not trust the hub")
        if link != "connected":
            raise HubError("hub_unreachable", "the hub cannot be reached")

    async def require_live(self, *, send: bool) -> None:
        """``require``, after connecting first when the mode is ``auto`` and
        nothing had wanted the socket: the use is recorded as demand and the
        client given up to ``LIVE_WAIT_SECONDS`` to connect."""
        if self.config.lazy and self.config.enabled and self.untrusted_reason is None:
            reg = self.registration()
            if reg is not None and reg.status == "active" and self.link() != "connected":
                self.demand.touch(self._now())
                await self.reconcile()
                client = self.client
                if client is not None:
                    deadline = asyncio.get_running_loop().time() + LIVE_WAIT_SECONDS
                    while client.link != "connected" and asyncio.get_running_loop().time() < deadline:
                        await asyncio.sleep(0.05)
        self.require(send=send)

    def link(self) -> HubLink:
        if not self.config.enabled:
            return "off"
        if self.untrusted_reason is not None:
            return "untrusted"
        if self.client is not None:
            return self.client.link
        return "off"

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        await self.reopen_paused_work()
        self.boot_steps.append("reopened")
        if not self.config.enabled:
            return
        if self.config.refusal == "config_invalid":
            self.untrusted_reason = "config_invalid"      # auto with bad settings: logged at boot
            return
        try:
            purged = seed_trust(self.hub, self.config, now=self._now())
        except HubUntrusted as exc:
            self.untrusted_reason = exc.reason
            # Nobody chose auto on an upgraded server: no warning for the
            # placeholder-pinned default hub there.
            (logger.info if self.config.lazy else logger.warning)("Hub client OFF: %s", exc)
            return
        self.boot_steps.append("purged")
        if purged:
            logger.warning("Hub keys withdrawn before connecting: %s", ", ".join(purged))
        await self.reconcile()
        self._poll_task = asyncio.create_task(self._poll())

    async def stop(self) -> None:
        self._stopped = True
        await self.adapter.stop()
        if self._poll_task is not None:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._poll_task = None
        async with self._reconcile_lock:            # a reconcile in progress finishes first
            await self._stop_client()

    async def _poll(self) -> None:
        while True:
            await asyncio.sleep(self.options.poll_seconds)
            try:
                task = self._client_task
                if task is not None and task.done():
                    logger.warning("Hub client loop ended: starting it again")
                    self._client_key = None           # reconcile builds a new client
                await self.reconcile()
            except Exception as exc:  # noqa: BLE001 — the next poll tries again
                logger.warning("Hub registration re-read failed: %s", type(exc).__name__)
            try:
                await self._serve_operator_request()
            except Exception as exc:  # noqa: BLE001 — the command times out and says so
                logger.warning("Hub operator request failed: %s", type(exc).__name__)
            try:
                await self.adapter.disable_private()
                await self.adapter.expire_drains()
                self.adapter.expire_held()
                self.adapter.prune_staged()
                self.adapter.expire_file_buffers()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Hub drain or held-message check failed: %s", type(exc).__name__)

    async def reconcile(self) -> None:
        """Make the client match the registration row: start it when the
        registration is active, restart it when the deployment id or key
        changed, stop it otherwise. Serialized (the poll and a 4004 reclaim
        both call it), and a no-op once the runtime has stopped."""
        async with self._reconcile_lock:
            if self._stopped:
                return
            await self._reconcile()

    async def _reconcile(self) -> None:
        reg = self.registration()
        active = (reg is not None and reg.status == "active" and reg.deployment_id
                  and reg.identity_connection_id and reg.genesis_fp)
        if active and not self.demand.wanted(self._now()):
            active = False                          # auto: nothing needs the socket (demand.py)
        key = (reg.deployment_id, reg.current_fp, reg.identity_connection_id) if active else None
        if key == self._client_key:
            return
        await self._stop_client()
        if key is None:
            return
        assert reg is not None and self.config.fernet is not None
        identity = self.identity()
        if identity is None:
            logger.error("Hub client OFF: the identity key cannot be loaded")
            return
        if reg.genesis_fp == reg.current_fp:
            # After a reclaim, nothing signed by the old identity may go out
            # first: rows under it are re-signed or end key_revoked. A no-op
            # for a deployment that never re-keyed, and safe to repeat.
            report = await keys.rekey_unchained(self.gateway.store, self.config, self.gateway)
            if report.resigned or report.revoked or report.refused:
                logger.info("Hub re-key after a reclaim: %d re-signed, %d key_revoked, %d refused",
                            len(report.resigned), len(report.revoked), len(report.refused))
        self.client = HubClient(
            config=self.config, hub=self.hub, gateway=self.gateway, identity=identity, mode=self.mode,
            clock=self._now, connect=self.options.connect, on_statement=self._on_statement,
            on_unknown_deployment=self._reclaim, on_deliver=self._on_deliver,
            on_binary=self.adapter.on_binary, prepare_relay=self.adapter.prepare_relay,
            agents_online=self.adapter.agents_online, files_for=self.mirror.files_for,
            pending_identity=self.pending_identity, **self.options.client_kwargs,
        )
        self.client.on_connected.append(self._settle_rotation)
        self.client.on_connected.append(self.adapter.on_connected)
        self.client.on_disconnected.append(self.adapter.socket_closed)
        self.gateway.adapters[HUB_CHANNEL] = self.client
        if self._inbound_task is None:
            self._inbound = asyncio.Queue()
            self._inbound_task = asyncio.create_task(self._inbound_worker())
        self._client_key = key
        self.boot_steps.append("client")
        self._client_task = asyncio.create_task(self.client.run())

    async def _stop_client(self) -> None:
        inbound = self._inbound_task
        self._inbound_task, self._inbound = None, None
        if inbound is not None:
            inbound.cancel()
            try:
                await inbound
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        client, task = self.client, self._client_task
        self.client, self._client_task, self._client_key = None, None, None
        if self.gateway.adapters.get(HUB_CHANNEL) is client and client is not None:
            del self.gateway.adapters[HUB_CHANNEL]
        if client is not None:
            if asyncio.current_task() is not client._reclaim_task:
                client.cancel_background()
            await client.stop()
        if task is not None:
            try:
                await asyncio.wait_for(task, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):  # noqa: BLE001
                task.cancel()

    def pending_identity(self) -> Optional[HubIdentity]:
        """The one pending rotation's key (``keys.pending_identity``): what the
        client dials with once after a 4001."""
        return keys.pending_identity(self.gateway.store, self.config, self.registration())

    async def _settle_rotation(self) -> None:
        """On every connect: a rotation whose answer was lost is committed or
        dropped, from the hub's own record (``keys.settle_rotation``). After a
        commit the cached identity is dropped and the client takes the new
        key, so it, every signer and the next dial use it (no restart)."""
        client = self.client
        if client is None:
            return
        try:
            report = await keys.settle_rotation(self.gateway.store, self.config, self.gateway, client.request,
                                                now=self._now())
        except (ConnectionError, asyncio.TimeoutError) as exc:
            logger.info("Hub pending rotation not settled yet: %s", type(exc).__name__)
            return
        if report is not None:
            logger.info("Hub pending rotation committed: %d row(s) re-signed", len(report.resign.resigned))
            self._adopt_current_key()

    def _adopt_current_key(self) -> None:
        """The registration's key changed under a running client (a rotation
        committed): reload it and hand it to the client in place."""
        self._identity_key = None
        identity = self.identity()
        reg = self.registration()
        if identity is None or reg is None or self.client is None:
            return
        self.client.identity = identity
        self._client_key = (reg.deployment_id, reg.current_fp, reg.identity_connection_id)

    async def _serve_operator_request(self) -> None:
        """A waiting ``server hub rotate``: rotate on this server's socket
        (``keys.rotate_chained`` over ``socket_rotate``) and write the answer.
        ``kind`` tells the command its exit: state (5), refused (6),
        unreachable (7), unknown (8)."""
        server_dir = self.gateway.store.directory.parent
        nonce = operator.take_rotate_request(server_dir, hub_url=self.config.hub_url, now=self._now())
        if nonce is None:
            return
        client = self.client
        # Answered on every path: an exception nobody expected (after the new
        # key may already be committed) is "outcome unknown", never silence,
        # which the command would report as "nothing was changed".
        answer: dict = {"ok": False, "kind": "unknown", "code": "internal",
                        "message": "the rotation failed part-way; run `clawmeets server hub status` "
                                   "to see whether the key changed"}
        try:
            answer = await self._rotate_for_operator(client)
        finally:
            operator.answer_rotate_request(server_dir, nonce, answer)

    async def _rotate_for_operator(self, client) -> dict:
        answer: dict
        if client is None or client.link != "connected":
            answer = {"ok": False, "kind": "unreachable", "code": "hub_unreachable",
                      "message": "the server is not connected to the hub"}
        else:
            try:
                report = await keys.rotate_chained(self.gateway.store, self.config, self.gateway,
                                                   keys.socket_rotate(client.request), now=self._now())
            except keys.RotationRefused as exc:
                answer = {"ok": False, "kind": "refused", "code": exc.code, "message": "the hub refused the rotation"}
            except keys.RevokeRefused as exc:
                kind = "state" if exc.code in ("rotation_pending", "unknown_deployment") else "refused"
                answer = {"ok": False, "kind": kind, "code": exc.code, "message": exc.detail or exc.code}
            except (ConnectionError, asyncio.TimeoutError, HubUntrusted, ValueError, ValidationError) as exc:
                answer = {"ok": False, "kind": "unreachable", "code": "rotation_pending",
                          "message": f"the hub's answer did not arrive or check out ({type(exc).__name__}); "
                                     "the new key is kept and settles on the next connect"}
            else:
                self._adopt_current_key()
                answer = {"ok": True, "fingerprint": report.fingerprint,
                          "resigned": len(report.resign.resigned)}
        return answer

    # ── what the client hands up ─────────────────────────────────────────

    async def _on_deliver(self, parsed) -> None:
        """From the socket's reader: queued, so the reader never waits."""
        if parsed.frame.type == "deliver":
            self.adapter.expect_files(parsed)
        if self._inbound is not None:
            self._inbound.put_nowait(parsed)

    async def _inbound_worker(self) -> None:
        assert self._inbound is not None
        queue = self._inbound
        while True:
            parsed = await queue.get()
            try:
                await self._route(parsed)
            except Exception as exc:  # noqa: BLE001 — one frame never stops the rest
                logger.warning("Hub %s not handled: %s", parsed.frame.type, type(exc).__name__, exc_info=True)

    async def _route(self, parsed) -> None:
        """deliver to an agent here -> the adapter; a reply to one of this
        server's requesters -> the mirror; deliver_probe and a hub-dispatched
        ask (dispatch_deliver) -> the adapter.
        Outside mode full nothing is relayed: a message is refused
        browse-only (and stored), a probe goes unanswered."""
        full = self.mode == "full"
        if parsed.frame.type == "deliver_probe":
            if full:
                await self.adapter.on_deliver_probe(parsed)
            return
        if parsed.frame.type == "dispatch_deliver":
            await self.adapter.on_dispatch_deliver(parsed, browse_only=not full)
            return
        envelope = parsed.data.get("envelope")
        if not isinstance(envelope, Mapping):
            return
        if envelope.get("to_agent") is not None:
            await self.adapter.on_deliver(parsed, browse_only=not full)
        elif full:
            await self.mirror.on_reply(parsed)
        else:
            await self.adapter.refuse_browse_only(parsed)

    # ── browser pushes ───────────────────────────────────────────────────

    async def _push(self, user_id: str, kind: ControlMessageType, payload: dict) -> None:
        ws_hub = getattr(self._ctx, "ws_hub", None)
        if ws_hub is None or not user_id:
            return
        await ws_hub.send_to(user_id, ControlEnvelope(type=kind, payload=payload))

    async def push_delivery(self, row: OutboxRow) -> None:
        """``hub_delivery_state`` to the requester, on every change to one of
        their messages' rows (the gateway's ``on_hub_row_change``)."""
        if row.kind != KIND_HUB_REQUEST or not row.project_id:
            return
        thread = self.hub.thread_for_project(row.project_id)
        if thread is None:
            return
        if thread.kind == "room_bridge":
            await self.bridge.on_row_change(row, thread)
        event = HubDeliveryStateEvent(payload=HubDeliveryStatePayload(
            project_id=row.project_id, delivery=delivery_out(row)))
        await self._push(thread.user_id, ControlMessageType.HUB_DELIVERY_STATE,
                         event.payload.model_dump(mode="json"))

    def channel_view(self, agent) -> HubChannel:
        """One local agent's Hub channel, as its owner's card shows it."""
        state = self.hub.channel_state(agent.id)
        threads, rows = self.hub.channel_counts(state.connection_id if state is not None else None)
        now = self._now()
        isolation, held = "unavailable", 0
        gate = getattr(self._ctx, "isolation_gate", None)
        if gate is not None:
            isolation = "sandboxed" if gate.agent_capable(agent.id) else "unavailable"
            held = sum(1 for _ in gate.held.held_for(agent.id))
        return channel_out(self.config, self.registration(), link=self.link(), agent=agent, state=state,
                           open_conversations=threads, in_flight_messages=rows,
                           next_midnight=next_local_midnight(now), now=now,
                           isolation=isolation, held_conversations=held,
                           local_conversations=local_conversation_count(self._ctx.model_ctx, agent),
                           dispatched_today=self.hub.dispatch_count(agent.id, local_day(now)))

    async def push_channel(self, agent_id: str) -> None:
        """``hub_channel_status`` (the whole masked HubChannel) to the agent's owner."""
        agent = Agent.get(agent_id, self._ctx.model_ctx)
        if agent is None or not agent.registered_by:
            return
        event = HubChannelStatusEvent(payload=HubChannelStatusPayload(
            agent_full_name=agent.name, channel=self.channel_view(agent)))
        try:
            await self._push(agent.registered_by, ControlMessageType.HUB_CHANNEL_STATUS,
                             event.payload.model_dump(mode="json"))
        except Exception as exc:  # noqa: BLE001 — a push never undoes the change
            logger.warning("Hub channel push failed: %s", type(exc).__name__)

    async def agent_connected(self, agent_id: str) -> None:
        """A local agent's runner connected (``SocketEvents``)."""
        await self.adapter.agent_connected(agent_id)

    async def _on_statement(self, raw: Mapping[str, Any]) -> None:
        kind = raw.get("kind") if isinstance(raw, Mapping) else None
        if kind == StatementKind.KEY_REVOKED.value:
            try:
                revoked = keys.apply_key_revoked(self.hub, self.config, raw, now=self._now())
            except (HubUntrusted, keys.RevokeRefused) as exc:
                logger.warning("Hub key_revoked statement refused: %s", exc)
                return
            if revoked:
                logger.info("Hub: %d remote key(s) revoked", len(revoked))
                genesis = self.hub.genesis_of(revoked[0])
                if genesis is not None:
                    await self.retained.identity_changed(genesis)
            return
        # Delistings and suspensions close requester threads.
        await self.mirror.on_statement(raw)

    async def _reclaim(self) -> None:
        """Close code 4004: one re-registration under the same key."""
        reg = self.registration()
        if reg is None or reg.identity_connection_id is None or self.config.fernet is None:
            return
        try:
            key = load_identity(self.gateway.store, reg.identity_connection_id, self.config.fernet)
        except (KeyError, InvalidToken):
            return
        now = self._now()
        body = operator.same_key_reclaim(self.config, reg, key, now=now)

        def _post() -> dict:
            with HubHttp(self.config.hub_url, transport=self.options.http_transport) as http:
                return http.register(body)

        try:
            raw = await asyncio.to_thread(_post)
            saved = operator.accept_same_key_reclaim(self.hub, self.config, reg, key, raw, now=now)
        except (HubUnreachable, HubRefused, HubUntrusted, ValidationError) as exc:
            logger.warning("Hub automatic reclaim failed: %s", type(exc).__name__)
            return
        logger.info("Hub automatic reclaim: registration %s", saved.status)
        await self.reconcile()

    # ── boot: paused conversations ───────────────────────────────────────

    async def reopen_paused_work(self) -> int:
        """Every open hub request (held included) gets its paused PendingWork
        back; then every request the target accepted but has not answered
        gets its batch back with its timer running from the receipt.
        Returns how many were reopened."""
        tracker = getattr(self._ctx, "work_tracker", None)
        if tracker is None:
            return 0
        reopened = 0
        for row in self.hub.hub_rows_open():
            if row.kind == KIND_HUB_REQUEST and row.project_id:
                reopened += await self._reopen(tracker, row, timer_started_at=None)
        since = self._now() - AWAITING_DELIVERY_CEILING_SECONDS
        for row, receipt_at in self.hub.requests_delivered_since(since):
            if row.project_id and not row.delivered_late:
                reopened += await self._reopen(
                    tracker, row, timer_started_at=datetime.fromtimestamp(receipt_at, UTC))
        if reopened:
            logger.info("Hub: reopened %d paused conversation(s) from the outbox", reopened)
        return reopened

    async def _reopen(self, tracker, row, *, timer_started_at: Optional[datetime]) -> int:
        """One request's batch, unless its room has one, the message is gone,
        or (for a delivered request) the batch already ended after it: a
        reply from the stand-in, a BATCH_COMPLETE / BATCH_TIMEOUT for it, or
        the server's own closing note."""
        try:
            project = Project.get(row.project_id, self._ctx.model_ctx)
        except ValueError:
            return 0
        if await tracker.get_pending_work(project.id, UC) is not None:
            return 0
        runloop = await self._ctx.runloop_manager.get_or_create(
            project.id, project.name, project.coordinator_id,
        )
        entries = runloop.get_entries_since(0)
        version = next((
            e.version for e in entries
            if e.entry_type == ChangelogEntryType.MESSAGE
            and getattr(e.payload, "id", None) == row.message_id
            and getattr(e.payload, "chatroom_name", None) == UC
        ), None)
        if version is None:
            return 0
        # The stand-in is the thread's counterpart (the user coordinates).
        stand_in_id = counterpart_of(project) or project.coordinator_id
        if timer_started_at is not None and any(
            _ends_batch(e, stand_in_id, row.message_id) for e in entries if e.version > version
        ):
            return 0
        await tracker.restore_awaiting_delivery(
            message_id=row.message_id or "", message_version=version, project_id=project.id,
            project_name=project.name, chatroom_name=UC, coordinator_id=project.created_by or project.coordinator_id,
            expected_participants=[stand_in_id],
            awaiting_since=datetime.fromtimestamp(row.created_at, UTC), timer_started_at=timer_started_at,
        )
        return 1


def _ends_batch(entry, stand_in_id: str, message_id: Optional[str]) -> bool:
    payload = entry.payload
    if getattr(payload, "chatroom_name", None) != UC:
        return False
    if entry.entry_type == ChangelogEntryType.MESSAGE:
        return getattr(payload, "from_participant_id", None) in (stand_in_id, "system")
    if entry.entry_type in (ChangelogEntryType.BATCH_COMPLETE, ChangelogEntryType.BATCH_TIMEOUT):
        return getattr(payload, "message_id", None) == message_id
    return False
