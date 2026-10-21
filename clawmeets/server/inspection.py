# SPDX-License-Identifier: BUSL-1.1
"""The message inspection hook: the one place every outside message passes
before it is stored or fanned out (design section 4.5).

An OUTSIDE message is one whose author ``outside_author`` names: a hub
stand-in, another account's agent in a workroom, or the requester of a host
conversation (a channel contact, a same-server Front Desk requester). Each
path that brings one in calls ``OutsideIngress.admit`` at the first point it
would store the message:

* the room's flow (``server/room_flow.py``) is checked first: a stopped room
  holds everything (reason ``flow_stopped``) without asking the inspector;
* a requester's message into a host conversation that has no
  ``requester_key`` yet (the startup migration failed) is held as well
  (reason ``requester_key_pending``): its turn would run unscoped;
* then the configured inspector (``CLAWMEETS_MESSAGE_INSPECTOR``, default
  ``PassThroughInspector``: pass, no I/O). An inspector that raises or runs
  past its timeout yields HOLD, never PASS: a broken monitor fails closed
  without losing messages;
* PASS returns an ``IngressTicket`` bound to (project, room, author, content);
  HOLD stores the message in ``held_messages`` (never the changelog); BLOCK
  stores only an audit row. Room notes never quote the held or blocked text.

**No bypass, by construction.** ``guard`` is installed on every server
runloop (``ChangelogRunloopManager.set_append_guard``): an outside-authored
MESSAGE or FILE whose append carries no valid ticket for its project, room,
author and content raises ``OutsideIngressBypass`` and is not stored. A path
that forgets the hook fails loudly instead of slipping past it.

On reopen, ``release_held`` runs each held message of the room through the
inspector again and hands the passes, oldest first, to the deliverer its
call site registered (``register_deliverer``), which appends it with the new
ticket exactly as the original path would have. One message the inspector
holds again, or whose delivery fails, stays held without stranding the ones
after it; a later reopen (also of an already-open room) tries it again. The
requester_key migration releases a project's rooms once it keys the project
(``release_project``): that lifts a ``requester_key_pending`` hold. Each
held row is claimed while release or the expiry sweep acts on it, so the two
never act on the same row twice.

**Expiry.** A held message expires at its path's ceiling (hub 72 h, others
7 days). ``run_expiry_sweep`` (started with the server) drops expired ones
every ``HELD_SWEEP_INTERVAL_S`` (``expire_held``), and ``release_held`` drops
any it meets: each gets an ``expired`` audit row and its closing note: in the
target room for the paths noted there, plus whatever the call site registered
(``register_closer``): the sender's side for tunnel relays, a failed delivery
line for room-bridge relays. A channel contact or hub requester is told
nothing more (the hub requester's own request expires on its own clock).

**Block on release.** A held message the inspector blocks on reopen gets
the same effects as a live block on its path: the audit row and room note,
plus whatever the call site registered (``register_blocker``): a blocked
reply to a channel contact, a signed ``blocked`` ack to a hub requester,
"Not delivered." on a tunnel sender's side, a note in the requester's room
for a direct Front Desk post, a failed (``blocked``) delivery line or a
closed stand-in slot for the room-bridge and DM-thread paths.

Server tree only: not shipped in the runner wheel.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Iterable, Literal, Mapping, Optional, Protocol, Sequence

from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project
from clawmeets.models.provenance import SYSTEM_AUTHORS, outside_author
from clawmeets.sync.changelog import ChangelogEntryType, MessagePayload

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server.inspection")

INSPECTOR_ENV = "CLAWMEETS_MESSAGE_INSPECTOR"
DEFAULT_INSPECTOR = "clawmeets.server.inspection:PassThroughInspector"
INSPECTOR_TIMEOUT_S = 5.0

REASON_FLOW_STOPPED = "flow_stopped"
REASON_INSPECTOR_ERROR = "inspector_error"
REASON_EXPIRED = "expired"
#: A requester's message into a host conversation that has no
#: ``requester_key`` yet (the startup migration failed): its turn would run
#: unscoped, so it waits until the key is there.
REASON_REQUESTER_KEY_PENDING = "requester_key_pending"

#: Held messages expire at the existing ceilings (isolation_gate): hub 72 h,
#: Front Desk and channels 7 days.
HUB_HELD_CEILING_S = 72 * 3600
OTHER_HELD_CEILING_S = 7 * 24 * 3600
#: How often the background sweep drops expired held messages.
HELD_SWEEP_INTERVAL_S = 300.0

SYSTEM_NOTE_ID = "system"
SYSTEM_NOTE_NAME = "ClawMeets"

_GUARDED_TYPES = frozenset({
    ChangelogEntryType.MESSAGE, ChangelogEntryType.FILE_CREATED, ChangelogEntryType.FILE_UPDATED,
})


class OutsidePath(StrEnum):
    HUB_INBOUND = "hub_inbound"                    # B: a hub request into a channel conversation
    HUB_REPLY_DM = "hub_reply_dm"                  # A: a remote reply into an agent- or user-started DM thread
    HUB_REPLY_BRIDGE = "hub_reply_bridge"          # A: a remote reply into a room-bridge thread, then the workroom
    BRIDGE_OUTBOUND = "bridge_outbound"            # A: a local room message relayed TO a stand-in (direction="outbound")
    CROSS_ACCOUNT_RELAY = "cross_account_relay"    # A: another account's agent's message mirrored into a workroom
    FRONT_DESK_REQUESTER = "front_desk_requester"  # host: a same-server requester's message into a Front Desk host project
    CHANNEL_INBOUND = "channel_inbound"            # host: webchat, Telegram and other channel contacts


class Verdict(StrEnum):
    PASS = "pass"
    HOLD = "hold"
    BLOCK = "block"


#: Paths whose hold or block is noted in the target room itself. The others
#: tell the sender only (hub inbound: the ack; channel inbound: a generic
#: reply on block; Front Desk requester: the requester's own thread).
_ROOM_NOTE_PATHS = frozenset({
    OutsidePath.HUB_REPLY_DM, OutsidePath.HUB_REPLY_BRIDGE, OutsidePath.CROSS_ACCOUNT_RELAY,
})
_HUB_PATHS = frozenset({
    OutsidePath.HUB_INBOUND, OutsidePath.HUB_REPLY_DM, OutsidePath.HUB_REPLY_BRIDGE,
    OutsidePath.BRIDGE_OUTBOUND,
})


@dataclass(frozen=True)
class FileRef:
    name: str
    sha256: str
    size: int = 0


@dataclass(frozen=True)
class InspectionRequest:
    path: OutsidePath
    direction: Literal["inbound", "outbound"]
    owner_user_id: str
    project_id: str
    chatroom: str
    author_id: str
    author_label: str              # e.g. "alice-researcher@acme", "bob-analyst (another account)"
    text: str
    files: tuple[FileRef, ...] = ()
    source_ref: Optional[str] = None   # hub message id, tunnel entry id, channel message id

    def to_json(self) -> str:
        data = asdict(self)
        data["files"] = [asdict(f) for f in self.files]
        return json.dumps(data, sort_keys=True)

    @classmethod
    def from_json(cls, raw: str) -> "InspectionRequest":
        data = json.loads(raw)
        data["path"] = OutsidePath(data["path"])
        data["files"] = tuple(FileRef(**f) for f in data.get("files") or ())
        return cls(**data)


@dataclass(frozen=True)
class InspectionResult:
    verdict: Verdict
    reason_code: Optional[str] = None   # short machine code shown to the owner, never to the sender
    stop_room: bool = False              # the inspector may also stop the room's flow (4.6)


class MessageInspector(Protocol):
    async def inspect(self, req: InspectionRequest) -> InspectionResult: ...


class PassThroughInspector:
    """The default: pass everything, no I/O."""

    async def inspect(self, req: InspectionRequest) -> InspectionResult:
        return InspectionResult(Verdict.PASS)


class OutsideIngressBypass(RuntimeError):
    """An outside-authored MESSAGE or FILE reached the changelog append
    without a matching ingress ticket. Nothing was stored."""


def content_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class IngressTicket:
    """Proof that one admission passed: valid only for this project, room,
    author and content (the message text's hash and each file's sha256).
    ``mac`` is keyed with a per-process secret, so a ticket cannot be made up
    by code that did not go through ``admit``."""

    project_id: str
    chatroom: str
    author_id: str
    content_hashes: frozenset[str]
    mac: str = ""
    #: Further (project, room) pairs the SAME admission covers: a room-bridge
    #: reply is appended to its hidden bridge thread and mirrored into the
    #: workroom on one ticket (``OutsideIngress.extend``).
    also: frozenset[tuple[str, str]] = frozenset()

    def _material(self) -> bytes:
        material = [self.project_id, self.chatroom, self.author_id, sorted(self.content_hashes)]
        if self.also:
            material.append(sorted(list(pair) for pair in self.also))
        return json.dumps(material).encode("utf-8")

    def covers(self, project_id: str, chatroom: str, author_id: str, digest: str) -> bool:
        return (
            ((self.project_id, self.chatroom) == (project_id, chatroom) or (project_id, chatroom) in self.also)
            and self.author_id == author_id and digest in self.content_hashes
        )


@dataclass(frozen=True)
class Admission:
    verdict: Verdict
    ticket: Optional[IngressTicket] = None
    note_posted: bool = False
    reason_code: Optional[str] = None
    held_id: Optional[str] = None

    @property
    def passed(self) -> bool:
        return self.verdict == Verdict.PASS


def load_inspector(env: Optional[Mapping[str, str]] = None) -> MessageInspector:
    """The inspector ``CLAWMEETS_MESSAGE_INSPECTOR`` names (``module:Class``),
    constructed with no arguments. Default: ``PassThroughInspector``. A bad
    value raises: a monitor that was asked for and cannot load must stop the
    server, not silently pass everything."""
    spec = ((env if env is not None else os.environ).get(INSPECTOR_ENV) or "").strip() or DEFAULT_INSPECTOR
    module_name, _, attr = spec.partition(":")
    if not module_name or not attr:
        raise ValueError(f"{INSPECTOR_ENV} must be 'module:Class', got {spec!r}")
    cls = getattr(importlib.import_module(module_name), attr)
    inspector = cls()
    if not callable(getattr(inspector, "inspect", None)):
        raise ValueError(f"{spec} has no inspect() method")
    return inspector


@dataclass(frozen=True)
class HeldMessage:
    held_id: str
    path: OutsidePath
    project_id: str
    chatroom: str
    author_id: str
    reason: str
    held_at: float
    expires_at: float
    request: InspectionRequest
    replay: dict = field(default_factory=dict)


def _held_from_row(r: Sequence[Any]) -> HeldMessage:
    return HeldMessage(
        held_id=r[0], path=OutsidePath(r[1]), project_id=r[2], chatroom=r[3], author_id=r[4],
        reason=r[5], held_at=r[6], expires_at=r[7],
        request=InspectionRequest.from_json(r[8]), replay=json.loads(r[9]),
    )


class InspectionStore:
    """``held_messages`` (what waits for release) and ``inspection_audit``
    (one row per hold, block and release decision). Survives a restart."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS held_messages (held_id TEXT PRIMARY KEY, path TEXT NOT NULL,"
            " project_id TEXT NOT NULL, chatroom TEXT NOT NULL, author_id TEXT NOT NULL,"
            " reason TEXT NOT NULL, held_at REAL NOT NULL, expires_at REAL NOT NULL,"
            " seq INTEGER NOT NULL, request_json TEXT NOT NULL, replay_json TEXT NOT NULL)"
        )
        self._db.execute(
            "CREATE INDEX IF NOT EXISTS held_messages_room ON held_messages (project_id, chatroom, seq)"
        )
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS inspection_audit (id TEXT PRIMARY KEY, path TEXT NOT NULL,"
            " project_id TEXT NOT NULL, chatroom TEXT NOT NULL, author_id TEXT NOT NULL,"
            " verdict TEXT NOT NULL, reason TEXT, at REAL NOT NULL)"
        )

    def hold(self, req: InspectionRequest, *, reason: str, now: float, expires_at: float,
             replay: Mapping[str, Any]) -> str:
        # Keyed on the source when there is one: a path retried after a crash
        # (a re-flush, a re-relay) holds the same message once.
        held_id = (
            hashlib.sha256(f"{req.path.value}|{req.project_id}|{req.source_ref}".encode()).hexdigest()[:32]
            if req.source_ref else uuid.uuid4().hex
        )
        with self._lock:
            (seq,) = self._db.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM held_messages").fetchone()
            self._db.execute(
                "INSERT OR IGNORE INTO held_messages VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (held_id, req.path.value, req.project_id, req.chatroom, req.author_id, reason,
                 now, expires_at, seq, req.to_json(), json.dumps(dict(replay))),
            )
        return held_id

    def held_for_room(self, project_id: str, chatroom: str) -> list[HeldMessage]:
        with self._lock:
            rows = list(self._db.execute(
                "SELECT held_id, path, project_id, chatroom, author_id, reason, held_at, expires_at,"
                " request_json, replay_json FROM held_messages WHERE project_id = ? AND chatroom = ?"
                " ORDER BY seq",
                (project_id, chatroom),
            ))
        return [_held_from_row(r) for r in rows]

    def expired(self, now: float) -> list[HeldMessage]:
        """Every held message whose ceiling has passed, oldest first."""
        with self._lock:
            rows = list(self._db.execute(
                "SELECT held_id, path, project_id, chatroom, author_id, reason, held_at, expires_at,"
                " request_json, replay_json FROM held_messages WHERE expires_at <= ? ORDER BY seq",
                (now,),
            ))
        return [_held_from_row(r) for r in rows]

    def held_rooms(self, project_id: str) -> list[str]:
        """The rooms of a project that hold at least one message."""
        with self._lock:
            rows = list(self._db.execute(
                "SELECT DISTINCT chatroom FROM held_messages WHERE project_id = ? ORDER BY chatroom",
                (project_id,),
            ))
        return [r[0] for r in rows]

    def held_count(self, project_id: str, chatroom: str) -> int:
        with self._lock:
            (n,) = self._db.execute(
                "SELECT COUNT(*) FROM held_messages WHERE project_id = ? AND chatroom = ?",
                (project_id, chatroom),
            ).fetchone()
        return int(n)

    def set_reason(self, held_id: str, reason: str) -> None:
        with self._lock:
            self._db.execute("UPDATE held_messages SET reason = ? WHERE held_id = ?", (reason, held_id))

    def get(self, held_id: str) -> Optional[HeldMessage]:
        """The held row as it is now, or None once it is gone."""
        with self._lock:
            row = self._db.execute(
                "SELECT held_id, path, project_id, chatroom, author_id, reason, held_at, expires_at,"
                " request_json, replay_json FROM held_messages WHERE held_id = ?",
                (held_id,),
            ).fetchone()
        return _held_from_row(row) if row is not None else None

    def remove(self, held_id: str) -> int:
        """Delete the row; returns how many went (1, or 0 when it was already
        gone). Whoever gets the 1 owns the row's expiry or block effects."""
        with self._lock:
            return self._db.execute("DELETE FROM held_messages WHERE held_id = ?", (held_id,)).rowcount

    def audit(self, req: InspectionRequest, verdict: str, reason: Optional[str], now: float) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO inspection_audit VALUES (?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex, req.path.value, req.project_id, req.chatroom, req.author_id,
                 verdict, reason, now),
            )

    def audits(self) -> list[dict]:
        with self._lock:
            rows = list(self._db.execute(
                "SELECT path, project_id, chatroom, author_id, verdict, reason, at FROM inspection_audit"
                " ORDER BY at, rowid"
            ))
        keys = ("path", "project_id", "chatroom", "author_id", "verdict", "reason", "at")
        return [dict(zip(keys, r)) for r in rows]

    def close(self) -> None:
        with self._lock:
            self._db.close()


#: Re-delivers a released message: the call site's own append, given the
#: replay data it stored at hold time and the fresh ticket.
Deliverer = Callable[[Mapping[str, Any], IngressTicket], Awaitable[None]]
#: Tells a held message's sender side it expired (a closer) or was blocked on
#: release (a blocker), given its replay data.
Closer = Callable[[Mapping[str, Any]], Awaitable[None]]


class OutsideIngress:
    """The single choke point. See the module docstring."""

    def __init__(
        self,
        model_ctx: "ModelContext",
        store: InspectionStore,
        inspector: Optional[MessageInspector] = None,
        *,
        timeout_s: float = INSPECTOR_TIMEOUT_S,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._model_ctx = model_ctx
        self.store = store
        self.inspector: MessageInspector = inspector or PassThroughInspector()
        self.timeout_s = timeout_s
        self._now = now
        self._secret = os.urandom(32)
        self._deliverers: dict[str, Deliverer] = {}
        self._closers: dict[str, Closer] = {}
        self._blockers: dict[str, Closer] = {}
        #: Held rows a release or the expiry sweep is acting on right now.
        self._claimed: set[str] = set()
        self._release_locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._server: Optional["ServerContext"] = None

    def bind(self, server_ctx: "ServerContext") -> None:
        self._server = server_ctx

    def register_deliverer(self, key: str, deliverer: Deliverer) -> None:
        """``key``: an ``OutsidePath`` value, or the ``via`` a call site puts
        in its replay data when one path has two call sites."""
        self._deliverers[str(key)] = deliverer

    def register_closer(self, key: str, closer: Closer) -> None:
        """What tells the sender side that a held message of this path (or
        ``via``) expired undelivered; keyed like ``register_deliverer``."""
        self._closers[str(key)] = closer

    def register_blocker(self, key: str, blocker: Closer) -> None:
        """What a live block on this path (or ``via``) does beyond the audit
        and room note, run when a held message is blocked on release; keyed
        like ``register_deliverer``."""
        self._blockers[str(key)] = blocker

    # ── the choke point ─────────────────────────────────────────────────

    async def admit(self, req: InspectionRequest, *, replay: Optional[Mapping[str, Any]] = None) -> Admission:
        """Admit one outside message: Admission(verdict, ticket | None, note_posted).

        ``replay``: what this path's deliverer needs to append the message
        later, stored with a hold."""
        # A stopped room holds both ways: outside messages into it, and
        # room-bridge relays out of it (4.6), until the owner reopens it.
        if not self.is_room_open(req.project_id, req.chatroom):
            return await self._hold(req, REASON_FLOW_STOPPED, replay)
        if self._awaits_requester_key(req):
            return await self._hold(req, REASON_REQUESTER_KEY_PENDING, replay)
        result = await self._inspect(req)
        if result.stop_room:
            await self._stop_room(req, result.reason_code)
        if result.verdict == Verdict.PASS and result.stop_room and req.direction == "inbound":
            # The inspector stopped the room it let this message into: the
            # stop wins, the message waits for the owner like the rest.
            return await self._hold(req, REASON_FLOW_STOPPED, replay)
        if result.verdict == Verdict.PASS:
            return Admission(Verdict.PASS, ticket=self.issue(req))
        if result.verdict == Verdict.BLOCK:
            return await self._block(req, result.reason_code)
        return await self._hold(req, result.reason_code or "held", replay)

    def _awaits_requester_key(self, req: InspectionRequest) -> bool:
        """An inbound message from the requester of a host conversation that
        has no ``requester_key`` (fail closed on a failed migration)."""
        if req.direction != "inbound":
            return False
        try:
            project = Project.get(req.project_id, self._model_ctx)
        except ValueError:
            return False
        return (project.requester_key is None
                and outside_author(project, req.author_id, self._model_ctx) == "requester")

    async def _inspect(self, req: InspectionRequest) -> InspectionResult:
        try:
            result = await asyncio.wait_for(self.inspector.inspect(req), timeout=self.timeout_s)
        except Exception as exc:  # noqa: BLE001 — TimeoutError included: fail closed
            logger.warning("Message inspector failed on %s (%s): holding", req.path.value, type(exc).__name__)
            return InspectionResult(Verdict.HOLD, reason_code=REASON_INSPECTOR_ERROR)
        if not isinstance(result, InspectionResult):
            logger.warning("Message inspector returned %r: holding", type(result).__name__)
            return InspectionResult(Verdict.HOLD, reason_code=REASON_INSPECTOR_ERROR)
        try:
            verdict = Verdict(result.verdict)
        except ValueError:
            return InspectionResult(Verdict.HOLD, reason_code=REASON_INSPECTOR_ERROR, stop_room=result.stop_room)
        return InspectionResult(verdict, result.reason_code, bool(result.stop_room))

    def issue(self, req: InspectionRequest) -> IngressTicket:
        hashes = frozenset({content_hash(req.text), *(f.sha256 for f in req.files)})
        ticket = IngressTicket(req.project_id, req.chatroom, req.author_id, hashes)
        return IngressTicket(
            req.project_id, req.chatroom, req.author_id, hashes,
            mac=hmac.new(self._secret, ticket._material(), hashlib.sha256).hexdigest(),
        )

    def extend(self, ticket: IngressTicket, *rooms: tuple[str, str]) -> IngressTicket:
        """The same admission, also covering ``rooms``. Refuses a ticket this
        ingress did not issue."""
        if not self._valid(ticket):
            raise OutsideIngressBypass("extend: not a ticket of this ingress")
        out = IngressTicket(ticket.project_id, ticket.chatroom, ticket.author_id, ticket.content_hashes,
                            also=frozenset({*ticket.also, *rooms}))
        return IngressTicket(out.project_id, out.chatroom, out.author_id, out.content_hashes, also=out.also,
                             mac=hmac.new(self._secret, out._material(), hashlib.sha256).hexdigest())

    def _valid(self, ticket: Any) -> bool:
        if not isinstance(ticket, IngressTicket):
            return False
        expected = hmac.new(self._secret, ticket._material(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, ticket.mac)

    async def _hold(self, req: InspectionRequest, reason: str, replay: Optional[Mapping[str, Any]]) -> Admission:
        now = self._now()
        held_id = self.store.hold(req, reason=reason, now=now, expires_at=now + self._ceiling(req),
                                  replay=replay or {})
        self.store.audit(req, Verdict.HOLD.value, reason, now)
        noted = await self._room_note(req, "is held for review.")
        return Admission(Verdict.HOLD, note_posted=noted, reason_code=reason, held_id=held_id)

    async def _block(self, req: InspectionRequest, reason: Optional[str]) -> Admission:
        self.store.audit(req, Verdict.BLOCK.value, reason, self._now())
        noted = await self._room_note(req, "was blocked.")
        return Admission(Verdict.BLOCK, note_posted=noted, reason_code=reason)

    @staticmethod
    def _ceiling(req: InspectionRequest) -> float:
        return HUB_HELD_CEILING_S if req.path in _HUB_PATHS else OTHER_HELD_CEILING_S

    async def _room_note(self, req: InspectionRequest, tail: str) -> bool:
        """The system note in the target room. Never quotes the message."""
        if req.path not in _ROOM_NOTE_PATHS:
            return False
        kind = "reply" if req.path in (OutsidePath.HUB_REPLY_DM, OutsidePath.HUB_REPLY_BRIDGE) else "message"
        return await self.post_note(req.project_id, req.chatroom, f"A {kind} from {req.author_label} {tail}")

    async def post_note(self, project_id: str, chatroom: str, text: str, *,
                        mirrored_from: Any = None) -> bool:
        """Append a system note (wakes nobody) to a room and push it.
        ``mirrored_from``: set by the tunnel for a note on the sender's side,
        so the tunnel's loop guard never carries it across the binding."""
        server = self._server
        if server is None:
            return False
        try:
            project = Project.get(project_id, self._model_ctx)
        except ValueError:
            return False
        if Chatroom.get_in(project, chatroom) is None:
            return False
        runloop = await server.runloop_manager.get_or_create(project.id, project.name, project.coordinator_id)
        entry = await runloop.append(ChangelogEntryType.MESSAGE, MessagePayload(
            chatroom_name=chatroom, id=str(uuid.uuid4()), ts=datetime.now(UTC),
            from_participant_id=SYSTEM_NOTE_ID, from_participant_name=SYSTEM_NOTE_NAME, content=text,
        ), mirrored_from=mirrored_from)
        from clawmeets.server.routes.messages import _broadcast_changelog

        try:
            await _broadcast_changelog(server, project, entry.version)
        except Exception as exc:  # noqa: BLE001 — a push never undoes the write
            logger.warning("Inspection note push failed: %s", type(exc).__name__)
        return True

    # ── the room's flow ─────────────────────────────────────────────────

    def is_room_open(self, project_id: str, chatroom: str) -> bool:
        """Read straight from the room's record, no cache. A room that does
        not exist (yet) is open."""
        room = Chatroom.get(project_id, chatroom, self._model_ctx)
        return room is None or room.flow.inbound_flow != "stopped"

    async def _stop_room(self, req: InspectionRequest, reason: Optional[str]) -> None:
        switch = getattr(self._server, "room_flow", None) if self._server is not None else None
        if switch is None:
            logger.warning("Inspector asked to stop a room, but no room flow switch is bound")
            return
        await switch.stop(req.project_id, req.chatroom, by="inspector", reason=reason)

    # ── release ─────────────────────────────────────────────────────────

    async def release_held(self, project_id: str, chatroom: str) -> int:
        """Re-inspect each held message of the room, oldest first, and deliver
        the passes. Returns how many were delivered. A message held again, or
        whose deliverer fails, stays held and the rest are still tried; the
        loop stops only when the room is stopped again. One release per room
        at a time."""
        lock = self._release_locks.setdefault((project_id, chatroom), asyncio.Lock())
        delivered = 0
        async with lock:
            for snapshot in self.store.held_for_room(project_id, chatroom):
                if not self._claim(snapshot.held_id):
                    continue                                  # the expiry sweep has it
                try:
                    # Re-read under the claim: the sweep may have expired it
                    # while an earlier message of the snapshot was delivered.
                    held = self.store.get(snapshot.held_id)
                    if held is None:
                        continue
                    outcome = await self._release_one(held)
                finally:
                    self._claimed.discard(snapshot.held_id)
                if outcome == "stopped":
                    break
                delivered += outcome == "delivered"
        return delivered

    async def release_project(self, project_id: str) -> int:
        """``release_held`` for every room of the project that holds
        messages: run when something other than a reopen lifts a hold, e.g.
        the requester_key migration keying a host conversation. Returns how
        many were delivered."""
        delivered = 0
        for chatroom in self.store.held_rooms(project_id):
            delivered += await self.release_held(project_id, chatroom)
        return delivered

    async def _release_one(self, held: HeldMessage) -> str:
        """One claimed held message: ``delivered``, ``expired``, ``blocked``,
        ``held`` (still held), ``gone`` (its row was already removed) or
        ``stopped`` (the room is stopped again)."""
        req = held.request
        now = self._now()
        if held.expires_at <= now:
            return "expired" if await self._expire(held, now) else "gone"
        if not self.is_room_open(held.project_id, held.chatroom):
            return "stopped"
        if self._awaits_requester_key(req):
            self.store.set_reason(held.held_id, REASON_REQUESTER_KEY_PENDING)
            return "held"
        result = await self._inspect(req)
        if result.stop_room:
            await self._stop_room(req, result.reason_code)
            return "stopped"
        if result.verdict == Verdict.BLOCK:
            if self.store.remove(held.held_id) != 1:
                return "gone"                                 # someone else already acted on it
            await self._block(req, result.reason_code)
            await self._sender_hook(self._blockers, held, "blocked")
            return "blocked"
        if result.verdict == Verdict.HOLD:
            self.store.set_reason(held.held_id, result.reason_code or "held")
            return "held"
        deliverer = self._deliverers.get(held.replay.get("via") or held.path.value)
        if deliverer is None:
            logger.error("No deliverer for held %s message; it stays held", held.path.value)
            return "held"
        try:
            await deliverer(held.replay, self.issue(req))
        except Exception:  # noqa: BLE001 — it stays held; the next reopen tries again
            logger.warning("Delivering a released %s message failed; it stays held", held.path.value,
                           exc_info=True)
            return "held"
        self.store.remove(held.held_id)
        self.store.audit(req, "released", held.reason, now)
        return "delivered"

    def _claim(self, held_id: str) -> bool:
        if held_id in self._claimed:
            return False
        self._claimed.add(held_id)
        return True

    def held_count(self, project_id: str, chatroom: str) -> int:
        return self.store.held_count(project_id, chatroom)

    # ── expiry ──────────────────────────────────────────────────────────

    async def expire_held(self, now: Optional[float] = None) -> int:
        """Drop every held message past its ceiling, each with its closing
        note. Returns how many went."""
        now = self._now() if now is None else now
        dropped = 0
        for snapshot in self.store.expired(now):
            if not self._claim(snapshot.held_id):
                continue                                      # a release is acting on it
            try:
                held = self.store.get(snapshot.held_id)
                if held is not None and await self._expire(held, now):
                    dropped += 1
            finally:
                self._claimed.discard(snapshot.held_id)
        return dropped

    async def _expire(self, held: HeldMessage, now: float) -> bool:
        """Drop one held message with its audit row and closing notes.
        False (and nothing done) when its row was already gone."""
        if self.store.remove(held.held_id) != 1:
            return False
        self.store.audit(held.request, "expired", REASON_EXPIRED, now)
        req = held.request
        if req.path in _ROOM_NOTE_PATHS:
            try:
                await self._room_note(req, "was held for review and expired; it was not delivered.")
            except Exception:  # noqa: BLE001 — the row is gone: the closer must still run
                logger.warning("Expiry note for a held %s message failed", req.path.value, exc_info=True)
        await self._sender_hook(self._closers, held, "expired")
        return True

    async def _sender_hook(self, hooks: Mapping[str, Closer], held: HeldMessage, what: str) -> None:
        """Run the call site's closer or blocker for a held message, if any."""
        hook = hooks.get(held.replay.get("via") or held.path.value)
        if hook is None:
            return
        try:
            await hook(held.replay)
        except Exception:  # noqa: BLE001 — one sender-side effect never stops the sweep or release
            logger.warning("Sender side of a %s held %s message failed", what, held.path.value, exc_info=True)

    async def run_expiry_sweep(self, interval_s: float = HELD_SWEEP_INTERVAL_S) -> None:
        """The background sweep (started with the server): ``expire_held``
        every ``interval_s`` until cancelled."""
        while True:
            try:
                dropped = await self.expire_held()
                if dropped:
                    logger.info("Inspection: %d held message(s) expired", dropped)
            except Exception:  # noqa: BLE001 — the next pass tries again
                logger.warning("Held-message expiry sweep failed", exc_info=True)
            await asyncio.sleep(interval_s)

    # ── the structural guard ────────────────────────────────────────────

    def guard(
        self,
        project_id: str,
        items: Sequence[tuple[ChangelogEntryType, Any]],
        ingress_ticket: Any,
    ) -> None:
        """The append guard (``ChangelogRunloop``'s ``append_guard``).

        Raises ``OutsideIngressBypass`` for an outside-authored MESSAGE or
        FILE with no valid ticket for its project, room, author and content.
        ``ingress_ticket`` is one ticket or a sequence of them (a batch that
        carries several admitted messages)."""
        candidates = [
            (entry_type, payload) for entry_type, payload in items
            if entry_type in _GUARDED_TYPES
            and getattr(payload, "from_participant_id", "") not in SYSTEM_AUTHORS
        ]
        if not candidates:
            return
        try:
            project = Project.get(project_id, self._model_ctx)
        except ValueError:
            return            # no project yet: nobody it could be outside of
        tickets = _tickets(ingress_ticket)
        for entry_type, payload in candidates:
            author = payload.from_participant_id
            kind = outside_author(project, author, self._model_ctx)
            # An owner-isolated agent's own posts are fenced as outside content
            # wherever they are read, but they are not inspected (yet): its
            # writes are held to the serving-only allowlist instead
            # (plan-owner-isolation 5d; inspection of them is a follow-up).
            if kind is None or kind == "owner_isolated_agent":
                continue
            digest = content_hash(payload.content) if entry_type == ChangelogEntryType.MESSAGE else payload.sha256
            if not any(
                self._valid(t) and t.covers(project_id, payload.chatroom_name, author, digest)
                for t in tickets
            ):
                raise OutsideIngressBypass(
                    f"{entry_type.value} by outside author {author!r} into "
                    f"{project_id[:8]}/{payload.chatroom_name} has no ingress ticket"
                )


def _tickets(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, IngressTicket):
        return [value]
    if isinstance(value, Iterable):
        return list(value)
    return [value]


def file_refs(payloads: Iterable[Any]) -> tuple[FileRef, ...]:
    """FileRefs for FILE payloads about to be appended with a message."""
    out = []
    for p in payloads:
        sha = getattr(p, "sha256", None)
        if sha:
            out.append(FileRef(name=getattr(p, "filename", ""), sha256=sha,
                               size=len(getattr(p, "content_b64", "") or "") * 3 // 4))
    return tuple(out)


def build_outside_ingress(data_dir: Path, model_ctx: "ModelContext",
                          env: Optional[Mapping[str, str]] = None) -> OutsideIngress:
    """The server's ingress: its store under ``data_dir/isolation`` and the
    inspector ``CLAWMEETS_MESSAGE_INSPECTOR`` names."""
    return OutsideIngress(
        model_ctx, InspectionStore(data_dir / "isolation" / "inspection.sqlite3"), load_inspector(env),
    )
