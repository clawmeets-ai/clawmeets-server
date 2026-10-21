# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/oauth_state.py

In-memory state store for MCP + skill OAuth relay flows.

The runner mints a ``state`` token when it builds an authorization URL for
an MCP or a skill that needs OAuth, then POSTs (state, agent_id, name) to
the server with a ``kind`` ("mcp" | "skill"). When Google redirects the user
to ``/oauth/{mcp,skill}/callback?code=&state=``, the server looks up
state -> (kind, agent_id, name) and forwards the code to the runner over the
existing WebSocket via the right envelope (``MCP_AUTH_CODE`` or
``SKILL_AUTH_CODE``). The state token is single-use and TTL'd; state values
are not persisted across server restarts.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass

DEFAULT_TTL_SECONDS = 600  # 10 minutes — sized for human consent latency


@dataclass(frozen=True)
class PendingAuth:
    """One pending OAuth relay entry.

    ``kind`` discriminates MCP vs skill flows so the callback handler can
    dispatch the right envelope. ``name`` is the MCP server name (kind="mcp")
    or the skill name (kind="skill").
    """
    agent_id: str
    name: str
    kind: str  # "mcp" | "skill"
    expires_at: float  # monotonic seconds


class OAuthStateStore:
    """Thread-safe in-memory map of state-token -> pending auth metadata."""

    def __init__(self, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._entries: dict[str, PendingAuth] = {}
        self._lock = asyncio.Lock()

    async def add(
        self, state: str, agent_id: str, name: str, kind: str = "mcp",
    ) -> None:
        if kind not in ("mcp", "skill"):
            raise ValueError(f"kind must be 'mcp' or 'skill', got {kind!r}")
        expires_at = time.monotonic() + self._ttl
        async with self._lock:
            self._entries[state] = PendingAuth(
                agent_id=agent_id, name=name, kind=kind,
                expires_at=expires_at,
            )

    async def take(self, state: str) -> PendingAuth | None:
        """Pop a state token. Returns None if missing or expired.

        Single-use: a successful take() removes the entry so a replayed
        callback (e.g. browser back-button) can't dispatch a second
        AUTH_CODE envelope.
        """
        async with self._lock:
            entry = self._entries.pop(state, None)
            if entry is None:
                return None
            if entry.expires_at < time.monotonic():
                return None
            return entry

    async def sweep_expired(self) -> int:
        """Drop expired entries. Returns the count removed."""
        now = time.monotonic()
        async with self._lock:
            stale = [s for s, e in self._entries.items() if e.expires_at < now]
            for s in stale:
                del self._entries[s]
            return len(stale)
