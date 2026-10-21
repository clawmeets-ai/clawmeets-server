# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/home_fs_relay.py

Carries home-folder operations (list / read / write / mkdir / delete) from an
authorized HTTP request to the ONE runner socket that will perform them, and
the runner's answer back. The frames are ``api/fs_protocol.py``'s; the routes
and the authorization decision are ``server/routes/agent_fs.py``'s; the path
and tier rules are the runner's (``runner/home_fs.py``). The relay owns only
the plumbing in between, and it is narrow on purpose:

- **One socket, chosen once.** An agent can hold several sockets (two machines,
  an overlapping reconnect). A write must run once, so the request goes to the
  most recently connected socket only (``WSHub.newest_connection``), never
  fanned out.
- **Gated on capability.** A socket that did not advertise
  ``FS_CAPABILITY`` on connect is an older runner: ``runner_too_old`` at once,
  nothing sent.
- **Unguessable ids, bound to their socket.** Ids are
  ``secrets.token_urlsafe``. A reply is accepted only from the socket its
  request was sent to; the same id arriving on any other socket (another
  session of the agent, or another agent entirely) is dropped. A reply for a
  request that already finished (timed out, cancelled) is dropped.
- **Offline is immediate.** No socket -> ``agent_offline`` without waiting. When
  the chosen socket disconnects, every request pending on it fails at once as
  ``agent_offline``. A write / mkdir / delete cut off that way also carries
  ``result_unknown``: the runner does not stop an op its socket lost, so the
  change may well have happened.
- **Content in chunks.** A write's bytes follow its request as ``fs_chunk``
  frames; a read's arrive as ``fs_chunk`` frames before its reply, and are
  assembled here — in order, bound to the same socket, capped at
  ``FS_MAX_CONTENT_BYTES`` — so no frame is large enough to starve the
  keepalive (``api/fs_protocol.py``, "Size caps").
- **Bounded.** Content over ``FS_MAX_CONTENT_BYTES`` is refused before sending
  (``too_large``); at most ``FS_MAX_CONCURRENT`` requests per agent are in
  flight (``busy``); every wait has a timeout. A write / mkdir / delete that
  times out is ``result_unknown`` — it may well have happened — while a list /
  read timeout is a plain ``timeout``. A reply over ``FS_MAX_FRAME_CHARS`` fails
  its request (``reply_too_large``) and a malformed one fails its request
  (``bad_reply``); neither touches the socket.

In memory, like ``WSHub`` and ``TerminalRelay``, and so single-process by
construction: the HTTP request and the runner socket must meet in one process.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import weakref
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Optional, Union

from clawmeets.api.fs_protocol import (
    AGENT_OFFLINE,
    BAD_REPLY,
    BUSY,
    FS_CAPABILITY,
    FS_MAX_CONCURRENT,
    FS_MAX_CONTENT_BYTES,
    FS_MAX_FRAME_CHARS,
    FS_MAX_PATH_CHARS,
    FS_CHUNK,
    FS_MUTATING_OPS,
    FS_OPS,
    FS_REPLY,
    FS_TIMEOUT_SECONDS,
    FS_TRANSFER_TIMEOUT_SECONDS,
    REPLY_TOO_LARGE,
    RESULT_UNKNOWN,
    RUNNER_TOO_OLD,
    TIMEOUT,
    TOO_LARGE,
    FsDeletedResult,
    FsEntryResult,
    FsFileResult,
    FsListingResult,
    ChunkAssembler,
    FsReplyError,
    build_chunks,
    build_request,
    parse_reply,
    peek_frame,
)

if TYPE_CHECKING:
    from clawmeets.server.ws_hub import ConnId, Hub

logger = logging.getLogger("clawmeets.server")

FsRelayResult = Union[FsListingResult, FsFileResult, FsEntryResult, FsDeletedResult]

FS_AUDIT_DIR = "fs-audit"
_AUDIT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
# Replies at least this large are parsed in a worker thread, so decoding
# megabytes of base64 does not stall every other socket on the server.
_PARSE_OFF_LOOP_CHARS = 256 * 1024


class FsRelayError(Exception):
    """A relayed op that failed. ``code`` is stable and sent to clients."""

    def __init__(self, code: str, message: str, *, result_unknown: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        # True when a write / mkdir / delete may have happened although no
        # answer came back: refresh before retrying.
        self.result_unknown = result_unknown or code == RESULT_UNKNOWN


@dataclass
class _Pending:
    agent_id: str
    conn: "ConnId"             # the ONE socket the request went to
    op: str
    future: asyncio.Future
    content: Optional[ChunkAssembler] = None  # a read's chunks so far


def fs_audit_path(data_dir: Path, owner_user_id: str, agent_id: str) -> Path:
    """``fs-audit/<owner>/<agent_id>.jsonl`` under the server data dir — one
    line per home-folder operation by anyone other than the agent itself.

    Same shape as the terminal's ``hosts/<owner>/<host>.terminal.jsonl``:
    per owner, append-only JSONL, never file content.
    """
    for value in (owner_user_id, agent_id):
        if not _AUDIT_ID_RE.match(value or ""):
            raise ValueError("not a valid id for an audit path")
    return Path(data_dir) / FS_AUDIT_DIR / owner_user_id / f"{agent_id}.jsonl"


def timeout_for(op: str) -> float:
    return FS_TRANSFER_TIMEOUT_SECONDS if op in ("read", "write") else FS_TIMEOUT_SECONDS


class _GoneSockets:
    """Sockets already reported gone, held no longer than they matter.

    In-process a socket is its ``asyncio.Queue``, which a ``WeakSet`` forgets
    when the endpoint does. Behind the websocket edge it is a plain string
    that cannot be weakly referenced, so those are kept in insertion order and
    the oldest dropped past a cap: an id is never reused, and a request only
    needs the check in the instant between "reported gone" and "forgotten by
    the hub".
    """

    _MAX_IDS = 4096

    def __init__(self) -> None:
        self._weak: "weakref.WeakSet[ConnId]" = weakref.WeakSet()
        self._ids: dict[ConnId, None] = {}

    def add(self, conn: "ConnId") -> None:
        try:
            self._weak.add(conn)
        except TypeError:
            self._ids[conn] = None
            while len(self._ids) > self._MAX_IDS:
                del self._ids[next(iter(self._ids))]

    def __contains__(self, conn: object) -> bool:
        try:
            if conn in self._weak:
                return True
        except TypeError:
            pass
        return conn in self._ids


class HomeFsRelay:
    """Pending home-folder requests for every runner on this server."""

    def __init__(self, ws_hub: "Hub", data_dir: Path) -> None:
        self._hub = ws_hub
        self._data_dir = Path(data_dir)
        self._pending: dict[str, _Pending] = {}
        # Sockets already reported gone. The endpoint reports a socket gone
        # before the hub forgets it, so for a moment ``newest_connection`` can
        # still return one; a request must not be parked on it until timeout.
        self._gone = _GoneSockets()

    # ------------------------------------------------------------- requests

    def in_flight(self, agent_id: str) -> int:
        return sum(1 for p in self._pending.values() if p.agent_id == agent_id)

    async def request(
        self,
        agent_id: str,
        op: str,
        path: str,
        caller: str,
        content: Optional[bytes] = None,
        *,
        timeout: Optional[float] = None,
    ) -> FsRelayResult:
        """Run one op on the agent's runner and return its validated result.

        The caller (the route) has already authenticated and authorized the
        request; ``caller`` is that decision. Raises :class:`FsRelayError` with
        the relay's code or the runner's refusal code.
        """
        if op not in FS_OPS:
            raise FsRelayError("invalid_request", f"unknown operation {op!r}")
        if not isinstance(path, str) or len(path) > FS_MAX_PATH_CHARS:
            raise FsRelayError("invalid_path", "path is too long")
        if op == "write":
            if content is None:
                raise FsRelayError("invalid_request", "write needs content")
            if len(content) > FS_MAX_CONTENT_BYTES:
                raise FsRelayError(TOO_LARGE, f"content is larger than {FS_MAX_CONTENT_BYTES} bytes")

        conn = self._hub.newest_connection(agent_id)
        if conn is None:
            raise FsRelayError(AGENT_OFFLINE, "the agent's runner is not connected")
        conn, info = conn
        if conn in self._gone:
            raise FsRelayError(AGENT_OFFLINE, "the agent's runner is not connected")
        if FS_CAPABILITY not in (info.get("capabilities") or ()):
            raise FsRelayError(
                RUNNER_TOO_OLD,
                "the agent's runner is too old to browse its home folder; "
                "upgrade clawmeets on that machine and restart the agent",
            )
        if self.in_flight(agent_id) >= FS_MAX_CONCURRENT:
            raise FsRelayError(BUSY, "too many file operations in flight for this agent; try again")

        request_id = secrets.token_urlsafe(24)
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = _Pending(agent_id, conn, op, future)
        try:
            sent = await self._hub.send_frame(conn, build_request(
                request_id, op, path, caller, len(content) if content is not None else None,
            ))
            if not sent:  # the socket went between choosing it and sending
                raise FsRelayError(AGENT_OFFLINE, "the agent's runner is not connected")
            for chunk in build_chunks(request_id, content or b""):
                await self._hub.send_frame(conn, chunk)
            del content
            try:
                return await asyncio.wait_for(future, timeout if timeout is not None else timeout_for(op))
            except asyncio.TimeoutError:
                if op in FS_MUTATING_OPS:
                    raise FsRelayError(
                        RESULT_UNKNOWN,
                        "the agent's runner did not answer in time; the change may or may "
                        "not have happened — refresh to see",
                    )
                raise FsRelayError(TIMEOUT, "the agent's runner did not answer in time")
        finally:
            self._pending.pop(request_id, None)

    # -------------------------------------------------------------- replies

    async def from_runner(self, conn: "ConnId", raw: Union[str, bytes]) -> None:
        """One ``fs_reply`` or ``fs_chunk`` frame received on socket ``conn``.
        Never raises.

        Called from the runner socket's receive loop before any
        ``ControlEnvelope`` parse; whatever is wrong with the frame fails at
        most the one request it names.
        """
        try:
            peeked = peek_frame(raw)
            if peeked is None or peeked[0] not in (FS_REPLY, FS_CHUNK):
                logger.warning("Dropped an fs reply that does not name its request")
                return
            frame_type, request_id = peeked
            pending = self._pending.get(request_id)
            if pending is None or pending.future.done():
                return  # late (timed out / cancelled) or never ours
            if pending.conn != conn:
                logger.warning(
                    f"Dropped an fs reply for request {request_id[:6]} that arrived on "
                    f"a socket it was not sent to"
                )
                return
            if len(raw) > FS_MAX_FRAME_CHARS:
                self._fail(pending, REPLY_TOO_LARGE, "the runner's answer was too large")
                return
            if frame_type == FS_CHUNK:
                self._chunk(pending, request_id, raw)
                return
            try:
                if len(raw) >= _PARSE_OFF_LOOP_CHARS:
                    result = await asyncio.to_thread(_parse, raw, pending.op, request_id, pending.content)
                else:
                    result = _parse(raw, pending.op, request_id, pending.content)
            except ValueError as exc:
                logger.warning(f"Malformed fs reply for request {request_id[:6]}: {exc}")
                self._fail(pending, BAD_REPLY, "the runner sent a malformed answer")
                return
            if pending.future.done():
                return
            if isinstance(result, FsReplyError):
                pending.future.set_exception(FsRelayError(result.code, result.message))
            else:
                pending.future.set_result(result)
        except Exception as exc:
            logger.error(f"fs reply handling failed: {exc}", exc_info=True)

    def _chunk(self, pending: _Pending, request_id: str, raw: Union[str, bytes]) -> None:
        """Add one chunk of a read's content. Chunks are small (one
        ``FS_CHUNK_BYTES``), so they are parsed on the loop, in arrival order."""
        if pending.op != "read":
            self._fail(pending, BAD_REPLY, "the runner sent a malformed answer")
            return
        if pending.content is None:
            pending.content = ChunkAssembler(request_id, FS_MAX_CONTENT_BYTES)
        try:
            pending.content.add(raw)
        except ValueError as exc:
            logger.warning(f"Malformed fs chunk for request {request_id[:6]}: {exc}")
            if "too large" in str(exc):
                self._fail(pending, REPLY_TOO_LARGE, "the runner's answer was too large")
            else:
                self._fail(pending, BAD_REPLY, "the runner sent a malformed answer")

    def link_lost(self) -> None:
        """The link to the websocket edge dropped: every reply in transit is
        lost, though the sockets may be fine, so fail every pending request
        without marking any socket gone. A write may have happened."""
        for pending in list(self._pending.values()):
            if pending.op in FS_MUTATING_OPS:
                self._fail(
                    pending, AGENT_OFFLINE,
                    "the server lost contact with the agent's runner; the change may "
                    "or may not have happened — refresh in a moment",
                    result_unknown=True,
                )
            else:
                self._fail(pending, AGENT_OFFLINE, "the server lost contact with the agent's runner")

    def socket_gone(self, conn: "ConnId") -> None:
        """The runner socket ``conn`` closed: everything pending on it is
        offline, now. Synchronous so it is safe in a ``finally`` during
        teardown.

        The runner does not cancel an op whose socket dropped, so a write,
        mkdir or delete may still land: those also say ``result_unknown``.
        """
        self._gone.add(conn)
        for pending in [p for p in self._pending.values() if p.conn == conn]:
            if pending.op in FS_MUTATING_OPS:
                self._fail(
                    pending, AGENT_OFFLINE,
                    "the agent's runner disconnected; the change may or may not have "
                    "happened — refresh when it is back",
                    result_unknown=True,
                )
            else:
                self._fail(pending, AGENT_OFFLINE, "the agent's runner disconnected")

    @staticmethod
    def _fail(pending: _Pending, code: str, message: str, *, result_unknown: bool = False) -> None:
        # An answer we could not read says nothing about whether a write,
        # mkdir or delete ran: the runner sends it after doing the op.
        if pending.op in FS_MUTATING_OPS and code in (BAD_REPLY, REPLY_TOO_LARGE):
            result_unknown = True
        if not pending.future.done():
            pending.future.set_exception(FsRelayError(code, message, result_unknown=result_unknown))

    # ---------------------------------------------------------------- audit

    def audit(self, owner_user_id: str, agent_id: str, entry: dict) -> None:
        """Append one line to the agent's home-folder audit log.

        ``entry`` is built by the route and never holds file content. A
        failure to write is logged, not raised: the operation already ran.
        """
        line = {"at": datetime.now(UTC).isoformat(), "agent_id": agent_id, **entry}
        try:
            path = fs_audit_path(self._data_dir, owner_user_id, agent_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as f:
                f.write(json.dumps(line) + "\n")
        except (OSError, ValueError) as e:
            logger.warning(f"Could not write home-folder audit line: {e}")


def _parse(raw: Union[str, bytes], op: str, request_id: str, content: Optional[ChunkAssembler]):
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("reply is not JSON") from exc
    return parse_reply(data, op, request_id, content)
