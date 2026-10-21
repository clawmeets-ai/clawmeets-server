# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/announcements.py
Announcements config loading.

This module reads ``announcements.json`` and hands it back verbatim as
parsed. That is the whole job.

**There is no matcher and no grouping here, deliberately.** Version matching
lives in exactly ONE place in this system and it is TypeScript, on the client
(``src/utils/versionMatch.ts``). The server relays facts — this config, and the
live-runner snapshot pushed by ``RUNNER_VERSIONS`` — and the browser decides
what to show. If you find yourself importing ``packaging`` in this file, stop:
that is the reverted hybrid design coming back, and it reintroduces two
matchers that must agree forever.

Record-level validation is likewise the client's job and only the client's
(fail-closed rules, one copy). What this module guarantees is narrower and
purely structural: the caller gets a ``list``, and it never raises. A typo'd
config yields zero announcements plus a log line — never a 5xx, because a
mis-edited config file must not break the app shell.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger("clawmeets.server")

# Parsed configs keyed on (path, st_mtime_ns, st_size). See load_announcements.
_CACHE: dict[tuple, tuple[list, str]] = {}

# ETag returned when the file cannot be stat'd at all (absent, or an
# unreadable parent). Stable, so a client that 304s against it keeps 304ing
# while the file stays missing; distinct in practice from any real file, whose
# mtime_ns is never 0.
_MISSING_ETAG = 'W/"0-0"'


def default_announcements_path() -> Path:
    """The repo-root ``announcements.json``.

    This module lives at ``<root>/clawmeets/server/announcements.py``, so the
    repo root is two parents up. A deployment with no such file (an installed
    wheel, a stripped container) simply gets zero announcements — the file
    being absent is a supported state, not an error condition.
    """
    return Path(__file__).resolve().parents[2] / "announcements.json"


def load_announcements(path: Path | None) -> tuple[list, str]:
    """Return ``(records, etag)`` for the announcements config.

    ``records`` is the ``announcements`` array **exactly as parsed** — no
    per-record validation, no filtering, no normalization. A record the client
    would reject is still returned; the client is the one place that decides.
    A missing file, an unreadable file, invalid JSON, a non-object root, or a
    missing / non-list ``announcements`` key all yield ``[]`` and a log line.
    This function does not raise.

    ``etag`` is ``W/"<st_mtime_ns>-<st_size>"``. Weak, because the byte
    representation the route serializes is not guaranteed identical to the
    file's; the identity that matters is "same file contents".

    **Stat-cached on ``(path, st_mtime_ns, st_size)``, not cached outright.**
    Caching outright would break the property that actually matters here:
    editing ``announcements.json`` takes effect with **no server restart**,
    because the next stat sees a different mtime and misses the cache. A
    missing file gets a stable sentinel key too, so it is diagnosed once rather
    than on every request — and creating the file later still changes the key
    and is picked up.
    """
    resolved = Path(path) if path is not None else default_announcements_path()

    try:
        st = resolved.stat()
        key = (str(resolved), st.st_mtime_ns, st.st_size)
        etag = f'W/"{st.st_mtime_ns}-{st.st_size}"'
    except OSError:
        key = (str(resolved), None, None)
        etag = _MISSING_ETAG

    cached = _CACHE.get(key)
    if cached is not None:
        return cached

    records: list = []
    try:
        data = json.loads(resolved.read_text(encoding="utf-8"))
    except FileNotFoundError:
        logger.warning(
            "announcements: no config at %s — serving zero announcements", resolved
        )
        data = None
    except (OSError, ValueError) as e:
        logger.error(
            "announcements: could not read %s (%s) — serving zero announcements",
            resolved, e,
        )
        data = None

    if isinstance(data, dict):
        raw_records = data.get("announcements")
        if isinstance(raw_records, list):
            records = raw_records
        else:
            logger.error(
                "announcements: %s has no 'announcements' array — serving zero",
                resolved,
            )
    elif data is not None:
        logger.error(
            "announcements: %s is not a JSON object — serving zero", resolved
        )

    result = (records, etag)
    _CACHE[key] = result
    return result
