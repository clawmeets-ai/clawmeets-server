# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/avatar.py
Remote agents' avatars: fetched from the hub, re-encoded here, and served
from a cache. An avatar is untrusted bytes from another deployment, so it is
never passed to the browser as received.

**Fetch.** The only source is the hub, over this server's outbound socket:
``avatar_get`` (``REQUEST_TIMEOUT_S``, 10 s), never a URL. The bytes must be
at most ``MAX_AVATAR_BYTES`` (256 KiB) and hash to the ``avatar_sha256`` in
the agent's signed listing (checked with the listing signature, as agent
detail does), so the hub cannot swap the image.

**Re-encode** (``reencode``). Before anything decodes:
- the byte cap;
- the magic bytes must be PNG, JPEG or WebP, and agree with the claimed
  content type. Every other format (GIF, GD, fonts, PSD, FITS, PDF, …) is
  refused here, in this process, and never reaches a decoder.
Then, in a spawned worker process with ``DECODE_TIMEOUT_S`` (2 s, killed
after that), Pillow opens the bytes with only that one format allowed,
checks the header's dimensions (``MAX_AVATAR_PIXELS`` a side) before
``load()``, takes the first frame only, copies the pixels into a new image
(no metadata carried), shrinks it to at most ``MAX_OUTPUT_SIDE`` a side and
writes a plain PNG. Pillow never runs on the event loop or in this process.

**Cache** (``hub_avatar_cache``): one re-encode, or one refusal, per
``(hub_agent_id, listing refreshed_at)``. A refusal is final for that
refresh, so a hostile image is decoded once. The route serves the newest
entry whatever the hub mode or registration, and fetches only when the
agent's cached listing shows a newer refresh than the cached avatar (or
nothing is cached). It never calls ``HubRuntime.require``.

**Freshness.** A changed avatar shows without waiting out the 24-hour
directory cache: a live search drops every cached agent item older than the
refresh it reports (``HubDirectory.search``), and a cached item older than
``ITEM_RECHECK_S`` is checked with the hub (``agent_get``, the same per-user
budget) before its avatar is served, while the hub is connected. When the
hub cannot be asked, the cache is served as before. The route sends an
``ETag`` of the listing refresh with ``no-cache``, so the browser revalidates
instead of holding a stale image for an hour.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import logging
import multiprocessing
import warnings
from typing import TYPE_CHECKING, Any, Callable, Mapping, Optional

from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import b64url_decode
from clawmeets.hub_protocol.constants import MAX_AVATAR_BYTES, MAX_AVATAR_PIXELS
from clawmeets.hub_protocol.frames import Avatar

from .browser import HubError

if TYPE_CHECKING:
    from clawmeets.server.channels.hub_store import CachedAvatar
    from .runtime import HubRuntime

logger = logging.getLogger(__name__)

#: The worker's limit for one decode and re-encode; it is killed after this.
DECODE_TIMEOUT_S = 2.0
#: How long a worker may take to start and say it is ready (not the image's fault).
WORKER_START_TIMEOUT_S = 30.0
#: The served PNG is at most this many pixels a side.
MAX_OUTPUT_SIDE = 512
#: A cached agent item older than this is checked with the hub before its
#: avatar is served (when the hub is connected): the worst-case staleness.
ITEM_RECHECK_S = 900
#: Claimed content type -> the one Pillow format allowed to open it.
ALLOWED_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


class AvatarRefused(Exception):
    """The image is refused; the reason is cached, so it is not retried."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class AvatarWorkerError(Exception):
    """The worker could not run (not the image's fault): nothing is cached."""


# ── the format check (this process, before any decoder) ─────────────────

def sniff_format(raw: bytes) -> Optional[str]:
    """The Pillow format the magic bytes name, if it is one we allow."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if raw.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "WEBP"
    return None


def check_before_decode(raw: bytes, content_type: Optional[str] = None) -> str:
    """The byte cap and the format allow-list; the format to open with."""
    if not raw:
        raise AvatarRefused("empty")
    if len(raw) > MAX_AVATAR_BYTES:
        raise AvatarRefused("too_large")
    fmt = sniff_format(raw)
    if fmt is None:
        raise AvatarRefused("format_not_allowed")
    if content_type is not None and ALLOWED_FORMATS.get(content_type) != fmt:
        raise AvatarRefused("content_type_mismatch")
    return fmt


# ── the decode (worker process only) ────────────────────────────────────

def _decode(raw: bytes, fmt: str) -> bytes:
    """Open with one format, dimensions before load, first frame, pixels
    only, ≤ MAX_OUTPUT_SIDE, PNG out. Raises AvatarRefused."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_AVATAR_PIXELS * MAX_AVATAR_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    try:
        im = Image.open(io.BytesIO(raw), formats=[fmt])
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise AvatarRefused("dimensions") from None
    except Exception:  # noqa: BLE001 — anything the opener refuses
        raise AvatarRefused("undecodable") from None
    width, height = im.size
    if width < 1 or height < 1 or width > MAX_AVATAR_PIXELS or height > MAX_AVATAR_PIXELS:
        raise AvatarRefused("dimensions")
    try:
        im.seek(0)                                  # first frame of an animated WebP or APNG
        im.load()
        rgba = im.convert("RGBA")
        clean = Image.frombytes("RGBA", rgba.size, rgba.tobytes())   # pixels only: no info, no ICC, no EXIF
        clean.thumbnail((MAX_OUTPUT_SIDE, MAX_OUTPUT_SIDE))
        out = io.BytesIO()
        clean.save(out, format="PNG")
    except Exception:  # noqa: BLE001 — truncated data, bomb warnings, codec errors
        raise AvatarRefused("undecodable") from None
    return out.getvalue()


def _worker(conn, decoder: Optional[Callable[[bytes, str], bytes]]) -> None:
    conn.send("ready")
    raw, fmt = conn.recv()
    try:
        conn.send(("ok", (decoder or _decode)(raw, fmt)))
    except AvatarRefused as exc:
        conn.send(("refused", exc.reason))
    except Exception:  # noqa: BLE001
        conn.send(("refused", "undecodable"))


def reencode(
    raw: bytes, *, content_type: Optional[str] = None, timeout_s: float = DECODE_TIMEOUT_S,
    _decoder: Optional[Callable[[bytes, str], bytes]] = None,
) -> tuple[bytes, str]:
    """(png bytes, "image/png"), or AvatarRefused. Blocking: call it off the
    event loop. The decode runs in a fresh spawned process, killed after
    ``timeout_s``; ``_decoder`` replaces the decode there (tests only)."""
    fmt = check_before_decode(raw, content_type)
    mp = multiprocessing.get_context("spawn")
    parent, child = mp.Pipe()
    proc = mp.Process(target=_worker, args=(child, _decoder), daemon=True)
    proc.start()
    child.close()
    try:
        if not parent.poll(WORKER_START_TIMEOUT_S) or parent.recv() != "ready":
            raise AvatarWorkerError("the avatar worker did not start")
        parent.send((raw, fmt))
        if not parent.poll(timeout_s):
            raise AvatarRefused("timeout")
        verdict, value = parent.recv()
    except (EOFError, OSError):
        raise AvatarRefused("worker_died") from None
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(5)
        parent.close()
    if verdict != "ok":
        raise AvatarRefused(str(value))
    if not isinstance(value, bytes) or sniff_format(value) != "PNG":
        raise AvatarRefused("undecodable")
    return value, "image/png"


# ── fetch and cache ─────────────────────────────────────────────────────

class HubAvatars:
    """The avatar route's source: the cache first, the hub when the agent's
    listing has a newer refresh. One fetch at a time per agent."""

    def __init__(self, runtime: "HubRuntime") -> None:
        self.runtime = runtime
        #: One fetch per agent at a time; a lock lives only while someone holds or waits for it.
        self._locks = _KeyedLocks()
        #: Replaces the worker's decode (tests only).
        self.decoder: Optional[Callable[[bytes, str], bytes]] = None
        self.timeout_s = DECODE_TIMEOUT_S

    @property
    def hub(self):
        return self.runtime.hub

    def _now(self) -> float:
        return self.runtime._now()

    def _hub_connected(self) -> bool:
        client = self.runtime.client
        return client is not None and client.link == "connected"

    @staticmethod
    def _served(cached: "CachedAvatar") -> tuple[bytes, int]:
        if cached.png is None:
            raise HubError("avatar_unavailable", "the avatar cannot be shown")
        return cached.png, cached.refreshed_at

    async def get(self, user_id: str, hub_agent_id: str, ref) -> tuple[bytes, int]:
        """The PNG for this agent and the listing refresh it is of (the
        route's ETag), or a HubError: avatar_not_set, avatar_unavailable,
        agent_not_found, rate_limited, or hub_unreachable when the hub cannot
        be asked and nothing is cached."""
        async with self._locks.hold(hub_agent_id):
            cached = self.hub.latest_avatar(hub_agent_id)
            found = self.runtime.directory.cached_item(hub_agent_id)
            item = found.body if found is not None else None
            charged = False
            if found is not None and self._now() - found.cached_at > ITEM_RECHECK_S and self._hub_connected():
                try:
                    self.runtime.directory.limiter.check(user_id)
                    charged = True
                    item = await self._agent_item(hub_agent_id, ref)
                except HubError as exc:
                    if exc.code not in ("hub_unreachable", "rate_limited"):
                        raise
                    # The recheck is for freshness only: the cached item stands.
            if item is not None and not item["item"].get("has_avatar"):
                raise HubError("avatar_not_set", "this agent has no avatar")
            if cached is not None and item is not None and cached.refreshed_at >= int(item["item"]["refreshed_at"]):
                return self._served(cached)
            if cached is not None and item is None and not self._hub_connected():
                return self._served(cached)
            try:
                return await self._fetch(user_id, hub_agent_id, ref, item, charged=charged)
            except HubError as exc:
                if exc.code in ("hub_unreachable", "rate_limited") and cached is not None:
                    return self._served(cached)          # an older refresh beats nothing
                raise

    async def _fetch(self, user_id: str, hub_agent_id: str, ref, item: Optional[Mapping[str, Any]], *,
                     charged: bool = False) -> tuple[bytes, int]:
        directory = self.runtime.directory
        if self.runtime.client is None:
            raise HubError("hub_unreachable", "the hub cannot be reached")
        if not charged:
            directory.limiter.check(user_id)
        if item is None:
            item = await self._agent_item(hub_agent_id, ref)
        if not item["item"].get("has_avatar") or not item["listing"].get("avatar_sha256"):
            raise HubError("avatar_not_set", "this agent has no avatar")
        refreshed_at = int(item["item"]["refreshed_at"])
        done = self.hub.avatar_for(hub_agent_id, refreshed_at)
        if done is not None:
            return self._served(done)
        try:
            answer = await directory._ask("avatar_get", {"deployment_fingerprint": ref.deployment_fingerprint,
                                                         "agent_name": ref.agent_name}, "avatar")
        except HubError as exc:
            if exc.code == "agent_unlisted":
                raise HubError("agent_not_found", "no such agent") from None
            raise
        try:
            png = await asyncio.to_thread(self._check_and_reencode, answer, item["listing"]["avatar_sha256"])
        except AvatarRefused as exc:
            logger.info("Avatar of %s refused: %s", hub_agent_id, exc.reason)
            self.hub.put_avatar_refusal(hub_agent_id, refreshed_at, exc.reason, now=self._now())
            raise HubError("avatar_unavailable", "the avatar cannot be shown") from None
        except AvatarWorkerError:
            logger.warning("Avatar worker for %s did not start", hub_agent_id, exc_info=True)
            raise HubError("avatar_unavailable", "the avatar cannot be shown") from None
        self.hub.put_avatar(hub_agent_id, refreshed_at, png, now=self._now())
        return png, refreshed_at

    async def _agent_item(self, hub_agent_id: str, ref) -> Mapping[str, Any]:
        """``agent_get``, its listing signature checked, cached like detail."""
        directory = self.runtime.directory
        try:
            raw = await directory._ask("agent_get", {"deployment_fingerprint": ref.deployment_fingerprint,
                                                     "agent_name": ref.agent_name}, "agent_item")
        except HubError as exc:
            if exc.code == "agent_unlisted":
                raise HubError("agent_not_found", "no such agent") from None
            raise
        if not directory.item_verifies(raw, ref):
            raise HubError("agent_not_found", "no such agent")
        self.hub.cache_agent(hub_agent_id, raw, now=self._now())
        return raw

    def _check_and_reencode(self, answer: Mapping[str, Any], avatar_sha256: str) -> bytes:
        """The avatar frame checked against the signed listing, then re-encoded."""
        try:
            frame = Avatar.model_validate(answer)
            raw = b64url_decode(frame.avatar_b64)
        except (ValidationError, ValueError):
            raise AvatarRefused("bad_frame") from None
        if len(raw) > MAX_AVATAR_BYTES:
            raise AvatarRefused("too_large")
        if hashlib.sha256(raw).hexdigest() != avatar_sha256:
            raise AvatarRefused("sha256_mismatch")
        png, _ = reencode(raw, content_type=frame.content_type, timeout_s=self.timeout_s, _decoder=self.decoder)
        return png


class _KeyedLocks:
    """An ``asyncio.Lock`` per key, kept only while it is held or awaited, so
    caller-supplied keys never accumulate."""

    def __init__(self) -> None:
        self._entries: dict[str, list] = {}          # key -> [lock, holders and waiters]

    def __len__(self) -> int:
        return len(self._entries)

    @contextlib.asynccontextmanager
    async def hold(self, key: str):
        entry = self._entries.setdefault(key, [asyncio.Lock(), 0])
        entry[1] += 1
        try:
            async with entry[0]:
                yield
        finally:
            entry[1] -= 1
            if entry[1] == 0 and self._entries.get(key) is entry:
                del self._entries[key]
