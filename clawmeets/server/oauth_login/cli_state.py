# SPDX-License-Identifier: BUSL-1.1
"""Server-side single-use TTL store backing the CLI OAuth-login flow.

The web flow round-trips its CSRF/invite state inside a signed
``oauth_login_state`` cookie (see ``flow.py``). A CLI has no browser cookie jar
it can seed, so it can't use that mechanism: instead the CLI's
``POST /auth/oauth/{provider}/cli/start`` stashes the pending flow parameters
here, keyed by the opaque ``state`` value echoed back through the provider
redirect. The callback pops it (single-use) to recover where to send the
handoff and which PKCE challenge to bind.

Two roles, both single-use TTL entries, both served by one generic map:
  - **pending start** (key = provider ``state``):
        {provider, invite_code, redirect, code_challenge, username}
    minted at ``cli/start``, popped at the provider callback.
  - **PKCE binding** (key = the minted handoff code):
        {code_challenge}
    written at the callback, popped at ``/auth/oauth/exchange`` to bind the
    final token mint to the CLI that started the flow (the handoff code alone
    travels over loopback; PKCE stops a racing local process from spending a
    leaked code).

Mirrors ``handoff.py`` / ``server/oauth_state.py``: asyncio-locked, lazily
swept, never persisted across restarts.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from urllib.parse import urlparse

# Pending-start entries live ~10 min (human consent + provider round-trip),
# matching the web cookie's _STATE_MAX_AGE. PKCE bindings live only as long as
# the handoff itself (~120s), but reuse the same store TTL for simplicity —
# the handoff store is the authoritative single-use gate.
DEFAULT_TTL_SECONDS = 600

# The ONLY hosts a CLI redirect may target. The callback 302s the browser to a
# client-supplied URL, so this allowlist is the open-redirect / SSRF guard.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}

# Sentinel redirect meaning "no loopback — show the handoff code for the user to
# paste back into the terminal" (headless / SSH boxes).
OOB_REDIRECT = "oob"


def validate_cli_redirect(redirect: str) -> bool:
    """True iff ``redirect`` is a safe CLI callback target.

    Accepts the ``oob`` sentinel, or an ``http`` URL whose host is loopback and
    whose port is non-privileged (>= 1024). Everything else — other schemes,
    non-loopback hosts, privileged ports, userinfo, malformed URLs — is rejected
    so the callback can never be coerced into redirecting to an attacker origin.
    """
    if redirect == OOB_REDIRECT:
        return True
    try:
        parsed = urlparse(redirect)
    except ValueError:
        return False
    if parsed.scheme != "http":
        return False
    if parsed.username or parsed.password:
        return False
    if (parsed.hostname or "").lower() not in _LOOPBACK_HOSTS:
        return False
    try:
        port = parsed.port
    except ValueError:
        return False
    return port is not None and port >= 1024


class CliOAuthStateStore:
    """Thread-safe in-memory map of key -> (payload dict, expires_at)."""

    def __init__(self, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._entries: dict[str, tuple[dict, float]] = {}
        self._lock = asyncio.Lock()

    async def put(self, payload: dict, *, key: str | None = None, ttl: int | None = None) -> str:
        """Store ``payload`` under ``key`` (a fresh random token if omitted).

        Returns the key. Use the generated key as the provider ``state`` for a
        pending-start entry; pass an explicit ``key`` (the handoff code) to bind
        a PKCE challenge to an already-minted handoff.
        """
        token = key if key is not None else secrets.token_urlsafe(24)
        expires_at = time.monotonic() + (self._ttl if ttl is None else ttl)
        async with self._lock:
            self._entries[token] = (payload, expires_at)
        return token

    async def take(self, key: str) -> dict | None:
        """Pop ``key``. Returns its payload, or None if missing/expired.

        Single-use: a successful take() removes the entry so neither a pending
        state nor a PKCE binding can be replayed.
        """
        if not key:
            return None
        async with self._lock:
            entry = self._entries.pop(key, None)
            if entry is None:
                return None
            payload, expires_at = entry
            if expires_at < time.monotonic():
                return None
            return payload

    async def sweep_expired(self) -> int:
        """Drop expired entries. Returns the count removed."""
        now = time.monotonic()
        async with self._lock:
            stale = [k for k, (_, exp) in self._entries.items() if exp < now]
            for k in stale:
                del self._entries[k]
            return len(stale)
