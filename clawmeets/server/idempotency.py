# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/idempotency.py

Server half of "a write sent during a restart is applied exactly once".
Clients (``api/retry_transport.py``) retry a write with the same
``Idempotency-Key``; this middleware answers the retry from the record of the
first attempt instead of running the handler again.

- Only unsafe methods carrying the header take part. Everything else passes
  straight through, so a client that sends no key behaves exactly as before.
- The record is scoped to the caller: the key is hashed together with the
  credentials (``Authorization`` + ``X-Agent-ID`` + ``X-User-ID``), the method
  and the path, so one caller's key can never replay another caller's
  response.
- Responses with status >= 500, a body over 256 KiB, or ``Cache-Control:
  no-store`` are not recorded: a retry of those runs the handler again.
  ``no-store`` is how a route that mints a secret (``POST /me/install-token``)
  keeps it off disk.
- A retry that arrives while the first attempt is still running in this
  process waits for it.

One window is left: core dies after the handler wrote but before the record
was. The message and file routes close it themselves by stamping the key on
the changelog entry (``client_request_id``) and looking for it on entry.

Records are one JSON file per key under ``{data_dir}/idempotency/<UTC hour>/``,
written atomically; :meth:`IdempotencyStore.sweep` drops hours older than the
TTL.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Optional

from clawmeets.api.retry_transport import IDEMPOTENCY_HEADER, REPLAYED_HEADER
from clawmeets.utils.file_io import FileUtil

logger = logging.getLogger(__name__)

_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_MAX_STORED_BODY = 256 * 1024
_MAX_KEY_LEN = 200
_HOUR_FMT = "%Y%m%d%H"
_SUBJECT_HEADERS = (b"authorization", b"x-agent-id", b"x-user-id")


@dataclass(frozen=True)
class StoredResponse:
    status: int
    headers: list[tuple[bytes, bytes]]
    body: bytes

    def to_json(self) -> dict:
        return {
            "status": self.status,
            "headers": [[k.decode("latin-1"), v.decode("latin-1")] for k, v in self.headers],
            "body_b64": base64.b64encode(self.body).decode("ascii"),
        }

    @classmethod
    def from_json(cls, data: dict) -> "StoredResponse":
        return cls(
            status=int(data["status"]),
            headers=[(k.encode("latin-1"), v.encode("latin-1")) for k, v in data["headers"]],
            body=base64.b64decode(data["body_b64"]),
        )


class IdempotencyStore:
    def __init__(self, root: Path, ttl_s: int = 86400) -> None:
        self._root = root
        self._ttl = timedelta(seconds=ttl_s)

    def _hours(self, now: datetime) -> list[str]:
        """Hour directories a live record can be in, newest first."""
        count = int(self._ttl.total_seconds() // 3600) + 1
        return [(now - timedelta(hours=i)).strftime(_HOUR_FMT) for i in range(count)]

    def get(self, scope_key: str) -> Optional[StoredResponse]:
        for hour in self._hours(datetime.now(UTC)):
            data = FileUtil.read(self._root / hour / f"{scope_key}.json", "json")
            if data:
                try:
                    return StoredResponse.from_json(data)
                except (KeyError, TypeError, ValueError):
                    logger.warning("Unreadable idempotency record %s", scope_key[:12])
                    return None
        return None

    def put(self, scope_key: str, resp: StoredResponse) -> None:
        hour = datetime.now(UTC).strftime(_HOUR_FMT)
        FileUtil.write(self._root / hour / f"{scope_key}.json", resp.to_json(), "json")

    def sweep(self) -> int:
        """Delete hour directories past the TTL. Returns how many went."""
        if not self._root.is_dir():
            return 0
        live = set(self._hours(datetime.now(UTC)))
        removed = 0
        for d in self._root.iterdir():
            if d.is_dir() and d.name not in live:
                shutil.rmtree(d, ignore_errors=True)
                removed += 1
        return removed


def _header(scope: dict, name: bytes) -> Optional[bytes]:
    for k, v in scope.get("headers", ()):
        if k == name:
            return v
    return None


def scope_key_for(scope: dict, key: bytes) -> str:
    h = hashlib.sha256()
    for name in _SUBJECT_HEADERS:
        h.update(name + b"=" + (_header(scope, name) or b"") + b"\0")
    h.update(scope["method"].encode() + b"\0")
    h.update(scope.get("raw_path") or scope["path"].encode())
    h.update(b"?" + scope.get("query_string", b"") + b"\0")
    h.update(key)
    return h.hexdigest()


class IdempotencyMiddleware:
    """Pure ASGI, so the request body is never touched on the way in."""

    def __init__(self, app, store: IdempotencyStore) -> None:
        self.app = app
        self._store = store
        self._in_flight: dict[str, asyncio.Event] = {}

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http" or scope.get("method") not in _UNSAFE_METHODS:
            await self.app(scope, receive, send)
            return
        key = _header(scope, IDEMPOTENCY_HEADER.lower().encode())
        if not key or len(key) > _MAX_KEY_LEN:
            await self.app(scope, receive, send)
            return

        scope_key = scope_key_for(scope, key)
        running = self._in_flight.get(scope_key)
        if running is not None:
            await running.wait()
        stored = self._store.get(scope_key)
        if stored is not None:
            await self._replay(stored, send)
            return

        done = asyncio.Event()
        self._in_flight[scope_key] = done
        try:
            await self._run_and_record(scope_key, scope, receive, send)
        finally:
            self._in_flight.pop(scope_key, None)
            done.set()

    async def _run_and_record(self, scope_key: str, scope, receive, send) -> None:
        status = 0
        headers: list[tuple[bytes, bytes]] = []
        chunks: list[bytes] = []
        size = 0
        complete = False

        async def capture(message) -> None:
            nonlocal status, headers, size, complete
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = list(message.get("headers", []))
            elif message["type"] == "http.response.body":
                body = message.get("body", b"")
                size += len(body)
                if size <= _MAX_STORED_BODY:
                    chunks.append(body)
                if not message.get("more_body", False):
                    complete = True
            await send(message)

        await self.app(scope, receive, capture)
        no_store = any(
            k.lower() == b"cache-control" and b"no-store" in v.lower() for k, v in headers
        )
        if complete and 0 < status < 500 and size <= _MAX_STORED_BODY and not no_store:
            try:
                self._store.put(scope_key, StoredResponse(status, headers, b"".join(chunks)))
            except OSError:
                logger.warning("Could not record idempotent response", exc_info=True)

    @staticmethod
    async def _replay(stored: StoredResponse, send) -> None:
        await send({
            "type": "http.response.start",
            "status": stored.status,
            "headers": stored.headers + [(REPLAYED_HEADER.lower().encode(), b"true")],
        })
        await send({"type": "http.response.body", "body": stored.body})
