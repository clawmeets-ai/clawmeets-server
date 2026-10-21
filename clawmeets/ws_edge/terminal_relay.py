# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/ws_edge/terminal_relay.py

Carries terminal sessions between a browser tab (``/ws/terminal/{host_id}``)
and the user's computer (``/ws/host/{host_id}``).

The server is a pipe here, and a narrow one:

- **Tickets.** A browser socket cannot carry an Authorization header, so the
  ticket route mints a 60-second, single-use ticket bound to (user, computer),
  and the terminal socket spends it. The ticket is a signed JWT
  (``ws_edge/auth.py``) so core can mint it and the edge can check it; the
  spent-ticket set is the only part held here.
- **Routing by owner.** A session belongs to exactly one computer. A frame the
  computer sends for a session that is not its own is dropped, so one machine
  cannot write into another user's tab even if it guesses an id.
- **No content kept.** The audit log records who opened a session, from where,
  for how long and how many bytes moved — never what was typed or printed.

In memory, and so single-process by construction: the browser socket and the
machine socket must meet in the same process. That process is the websocket
edge (``clawmeets server ws-edge``) when it runs, which is what lets a terminal
survive a core restart, and core itself in in-process mode. Both ends of a
session are sockets, so nothing here needs core: the module imports nothing
from ``clawmeets.server`` or ``clawmeets.models`` and writes its own audit
lines.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional, Protocol

from clawmeets.api.host_protocol import (
    TERM_ACK,
    TERM_CLOSE,
    TERM_EXIT,
    TERM_INPUT,
    TERM_MAX_INPUT_BYTES,
    TERM_MAX_SESSIONS,
    TERM_OPEN,
    TERM_OPENED,
    TERM_OUTPUT,
    TERM_RESIZE,
    validate_session_id,
    validate_size,
)
from clawmeets.ws_edge.auth import TicketGrant, decode_terminal_ticket, ticket_is_for

logger = logging.getLogger("clawmeets.server")

# Same rule as ``models/host.validate_host_id`` (server-minted 16 hex); the
# audit path is built from it, so anything else is refused, not written.
_HOST_ID_RE = re.compile(r"^[0-9a-f]{16}$")
_OWNER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def terminal_audit_path(data_dir: Path, owner_user_id: str, host_id: str) -> Path:
    """``hosts/<owner>/<host>.terminal.jsonl`` — the same file
    ``models/host.terminal_audit_path`` names (a test pins the two together)."""
    if not _HOST_ID_RE.match(host_id or "") or not _OWNER_ID_RE.match(owner_user_id or ""):
        raise ValueError("Not a valid computer or owner id")
    return Path(data_dir) / "hosts" / owner_user_id / f"{host_id}.terminal.jsonl"


class HostSender(Protocol):
    async def send_to_host(self, host_id: str, frame: dict) -> bool: ...

# What a browser may send. Everything else on the terminal socket is dropped.
_BROWSER_FRAMES = frozenset({TERM_INPUT, TERM_RESIZE, TERM_ACK, TERM_CLOSE})
# What a machine may send about a session.
_HOST_FRAMES = frozenset({TERM_OPENED, TERM_OUTPUT, TERM_EXIT})
# Base64 of TERM_MAX_INPUT_BYTES, the cheap pre-decode bound.
_MAX_INPUT_B64 = 4 * ((TERM_MAX_INPUT_BYTES + 2) // 3)


@dataclass
class _Session:
    session_id: str
    owner_id: str
    host_id: str
    browser: asyncio.Queue
    ip: str
    opened_at: float = field(default_factory=time.monotonic)
    bytes_in: int = 0
    bytes_out: int = 0


class TerminalRelay:
    """Tickets and live sessions for every computer on this server."""

    def __init__(self, hosts: HostSender, data_dir: Path, jwt_secret: str) -> None:
        self._hub = hosts
        self._data_dir = Path(data_dir)
        self._jwt_secret = jwt_secret
        # jti -> expiry (unix time) of every ticket already spent
        self._spent: dict[str, float] = {}
        self._sessions: dict[str, _Session] = {}

    # ---------------------------------------------------------------- tickets

    def redeem_ticket(self, ticket: object, host_id: str) -> Optional[TicketGrant]:
        """The grant, spent. None if invalid, expired, spent, or for another
        computer — and presenting it at the wrong computer spends it too."""
        now = time.time()
        for jti in [j for j, exp in self._spent.items() if exp <= now]:
            del self._spent[jti]
        grant = decode_terminal_ticket(ticket, self._jwt_secret)
        if grant is None or grant.jti in self._spent:
            return None
        self._spent[grant.jti] = grant.expires_at
        if not ticket_is_for(grant, host_id):
            return None
        return grant

    # --------------------------------------------------------------- sessions

    def session_count(self, host_id: str) -> int:
        return sum(1 for s in self._sessions.values() if s.host_id == host_id)

    async def open(
        self, grant: TicketGrant, browser: asyncio.Queue, ip: str
    ) -> Optional[str]:
        """Ask the computer to start a shell. None if it could not be asked.

        The machine answers with ``term_opened``; a refusal there (switched off,
        too many sessions) reaches the tab as that frame and ends the session.
        """
        if self.session_count(grant.host_id) >= TERM_MAX_SESSIONS:
            return None
        session_id = secrets.token_urlsafe(18)
        session = _Session(session_id, grant.user_id, grant.host_id, browser, ip)
        self._sessions[session_id] = session
        delivered = await self._hub.send_to_host(grant.host_id, {
            "type": TERM_OPEN,
            "session_id": session_id,
            "cols": grant.cols,
            "rows": grant.rows,
        })
        if not delivered:
            self._sessions.pop(session_id, None)
            return None
        self._audit(session, {"event": "open", "ip": ip})
        logger.info(
            f"Terminal session {session_id[:8]} opened on computer "
            f"{grant.host_id[:8]} by user {grant.user_id[:8]}"
        )
        return session_id

    async def from_browser(self, session_id: str, frame: dict) -> None:
        """Forward one browser frame to the session's computer, within limits."""
        session = self._sessions.get(session_id)
        kind = frame.get("type") if isinstance(frame, dict) else None
        if session is None or kind not in _BROWSER_FRAMES:
            return
        if kind == TERM_CLOSE:
            await self.close(session_id, "Session ended.")
            return
        out: dict = {"type": kind, "session_id": session_id}
        if kind == TERM_INPUT:
            data = frame.get("data_b64")
            if not isinstance(data, str) or len(data) > _MAX_INPUT_B64:
                return
            session.bytes_in += len(data) * 3 // 4
            out["data_b64"] = data
        elif kind == TERM_RESIZE:
            try:
                out["cols"], out["rows"] = validate_size(frame.get("cols"), frame.get("rows"))
            except ValueError:
                return
        elif kind == TERM_ACK:
            try:
                out["bytes"] = max(0, int(frame.get("bytes") or 0))
            except (TypeError, ValueError):
                return
        await self._hub.send_to_host(session.host_id, out)

    async def from_host(self, host_id: str, frame: dict) -> None:
        """Deliver one machine frame to the tab that owns the session.

        Dropped unless the session belongs to THIS computer.
        """
        kind = frame.get("type")
        if kind not in _HOST_FRAMES:
            return
        try:
            session_id = validate_session_id(frame.get("session_id"))
        except ValueError:
            return
        session = self._sessions.get(session_id)
        if session is None:
            return
        if session.host_id != host_id:
            logger.warning(
                f"Computer {host_id[:8]} sent a terminal frame for a session "
                f"on another computer; dropped"
            )
            return
        out = {k: v for k, v in frame.items() if k != "session_id"}
        if kind == TERM_OUTPUT:
            data = frame.get("data_b64")
            if not isinstance(data, str):
                return
            session.bytes_out += len(data) * 3 // 4
        await session.browser.put(out)
        if kind == TERM_EXIT:
            self._finish(session, str(frame.get("reason") or ""))
        elif kind == TERM_OPENED and not frame.get("ok"):
            self._finish(session, str(frame.get("detail") or "refused"))

    async def close(self, session_id: str, reason: str) -> None:
        """End a session from the server side (tab closed, End session)."""
        session = self._sessions.get(session_id)
        if session is None:
            return
        await self._hub.send_to_host(
            session.host_id, {"type": TERM_CLOSE, "session_id": session_id}
        )
        self._finish(session, reason)

    async def host_gone(self, host_id: str) -> None:
        """The computer's socket dropped: every session on it is over."""
        for session in [s for s in self._sessions.values() if s.host_id == host_id]:
            await session.browser.put({
                "type": TERM_EXIT,
                "code": None,
                "reason": "The computer disconnected, so the session ended.",
            })
            self._finish(session, "computer disconnected")

    # -------------------------------------------------------------- internals

    def _finish(self, session: _Session, reason: str) -> None:
        """Forget the session, write its close line, and close the tab's socket."""
        if self._sessions.pop(session.session_id, None) is None:
            return
        self._audit(session, {
            "event": "close",
            "duration_seconds": round(time.monotonic() - session.opened_at, 1),
            "bytes_in": session.bytes_in,
            "bytes_out": session.bytes_out,
            "reason": reason[:200],
        })
        logger.info(f"Terminal session {session.session_id[:8]} closed: {reason}")
        session.browser.put_nowait(None)

    def _audit(self, session: _Session, entry: dict) -> None:
        line = {
            "at": datetime.now(UTC).isoformat(),
            "session_id": session.session_id,
            "user_id": session.owner_id,
            **entry,
        }
        try:
            path = terminal_audit_path(self._data_dir, session.owner_id, session.host_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as f:
                f.write(json.dumps(line) + "\n")
        except (OSError, ValueError) as e:
            logger.warning(f"Could not write terminal audit line: {e}")

