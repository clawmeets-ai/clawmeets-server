# SPDX-License-Identifier: BUSL-1.1
"""In-memory single-use TTL store for the one-time OAuth-login exchange code.

After the provider callback provisions/links/authenticates the account, it mints
a random handoff token here mapping token -> user_id, then 302s the browser to
the SPA with ``?code=<token>``. The SPA immediately POSTs it to
``/auth/oauth/exchange``; ``take()`` pops-and-validates it exactly once (so a
replayed exchange, e.g. browser back-button, cannot mint a second JWT pair).

Mirrors ``server/oauth_state.py`` (the MCP/skill relay store): async-locked,
lazily swept, never persisted across restarts. TTL is short (~120s) because the
SPA exchanges the code within one navigation.
"""
from __future__ import annotations

import asyncio
import secrets
import time

DEFAULT_TTL_SECONDS = 120  # sized for one SPA navigation, not human consent


class LoginHandoffStore:
    """Thread-safe in-memory map of handoff-token -> (user_id, expires_at)."""

    def __init__(self, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._entries: dict[str, tuple[str, float]] = {}
        self._lock = asyncio.Lock()

    async def add(self, user_id: str, *, ttl: int | None = None) -> str:
        """Mint a single-use handoff token for ``user_id``. Returns the token."""
        token = secrets.token_urlsafe(32)
        expires_at = time.monotonic() + (self._ttl if ttl is None else ttl)
        async with self._lock:
            self._entries[token] = (user_id, expires_at)
        return token

    async def take(self, token: str) -> str | None:
        """Pop a handoff token. Returns its user_id, or None if missing/expired.

        Single-use: a successful take() removes the entry so a replayed exchange
        can't mint a second token pair.
        """
        if not token:
            return None
        async with self._lock:
            entry = self._entries.pop(token, None)
            if entry is None:
                return None
            user_id, expires_at = entry
            if expires_at < time.monotonic():
                return None
            return user_id

    async def sweep_expired(self) -> int:
        """Drop expired entries. Returns the count removed."""
        now = time.monotonic()
        async with self._lock:
            stale = [t for t, (_, exp) in self._entries.items() if exp < now]
            for t in stale:
                del self._entries[t]
            return len(stale)
