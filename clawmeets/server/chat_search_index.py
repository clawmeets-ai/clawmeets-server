# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/chat_search_index.py

Derived FTS5 search index over chat message bodies, plus the changelog
subscriber that keeps it current.

The index is a single SQLite file at ``{data_dir}/search/chat_index.db``. It
holds no authoritative data: every row is derived from a room's
``CHATS.ndjson``, so the file can be deleted at any time and is rebuilt on the
next boot by :meth:`ChatSearchIndex.reconcile_all`.

Three tables and one FTS5 virtual table (see ``_SCHEMA_SQL``):

- ``projects`` mirrors the ACL-relevant columns of a :class:`Project`
  (``created_by``, ``fd_requester_name``, ``surface``) so permission scoping is
  a SQL predicate on the same statement as the match. This is the decision that
  buys the latency target: recomputing the ACL from the filesystem per query
  means ``Project.list_all()`` — 540 ``meta.json`` reads — which costs 30-60x
  the rest of the query. Any change that reintroduces a filesystem walk into
  :meth:`ChatSearchIndex.search` should be rejected on latency grounds alone.
- ``rooms`` carries the pre-computed ``room_type`` / ``room_label`` the wire
  contract returns, a mirrored ``is_user_communication`` boolean (see below),
  and a ``(size, mtime_ns)`` fingerprint of ``CHATS.ndjson`` so reconcile can
  skip an unchanged room without opening it.
- ``messages`` + ``messages_fts`` hold the corpus. ``messages_fts`` is an
  external-content table over ``messages``, kept in sync by triggers.

The wire format this module produces is pinned by ``SEARCH_API_CONTRACT.md``
v1.0 — do not change a field name or shape here without updating that document
and announcing the change.

Permission model (contract §5), enforced in :meth:`ChatSearchIndex.search`:
a message is searchable by user U iff its project P satisfies one of

1. ``P.created_by == U.id``;
2. ``P.fd_requester_name == U.username`` AND the room is ``user-communication``
   (the room restriction is load-bearing — a Front Desk requester can read that
   one room and nothing else in the host's project);
3. U is a share-token viewer of P.

Clause 2's room test is **not** restated in SQL. ``Chatroom.is_user_communication_name``
is called once per room at index-WRITE time and mirrored into
``rooms.is_user_communication``, so the query reads one boolean column and the
model keeps the single definition of the rule. The first cut of this module
wrote the clause as ``chatroom_name LIKE 'user-communication%'``, which is
ASCII-case-INSENSITIVE in SQLite while ``startswith`` is not: a room named
``User-communication-notes`` satisfied search's clause 2 but failed the
room-read endpoint's, leaking snippets across a user boundary. Do not
reintroduce a room-name predicate in SQL.

There is deliberately **no bypass** parameter on the query path: every caller
is scoped to their own plate. ``is_ack`` rows never enter the corpus.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import unicodedata
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Iterable, Literal
from urllib.parse import quote

from pydantic import BaseModel, field_serializer

from clawmeets.models.chat_message import ChatMessage
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project
from clawmeets.sync.changelog import ChangelogEntryType
from clawmeets.sync.subscriber import ChangelogSubscriber

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.sync.changelog import ChangelogEntry

logger = logging.getLogger("clawmeets.server")

SCHEMA_VERSION = 2   # 2: rooms.is_user_communication (mirrors the model predicate)
CANDIDATE_POOL = 200      # rows BM25 hands to the Python re-ranker
RECENCY_HALF_LIFE_D = 30.0  # days; recency weight halves every 30d
RECENCY_FLOOR = 0.25      # oldest possible weight; recency scales 0.25..1.0
SNIPPET_CHARS = 240       # hard cap on the snippet window (contract §3.5)
SNIPPET_CORE_CHARS = 200  # initial window before outward word-boundary snapping
MIN_QUERY_CHARS = 2
MAX_LIMIT = 50
MAX_OFFSET = 200


class SearchIndexError(RuntimeError):
    """A query-path failure the caller must surface as 503, not as zero hits.

    The write path deliberately swallows ``sqlite3.Error`` — a broken search
    index must never take chat down. The QUERY path must not: a locked or
    corrupted index that answered ``hits: []`` would be indistinguishable from
    "nothing matched", and the UI's ``unavailable`` state could never be
    reached (contract §2.3).
    """


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS projects (
  project_id        TEXT PRIMARY KEY,
  project_name      TEXT NOT NULL,
  display_name      TEXT,
  surface           TEXT NOT NULL,     -- 'regular' | 'dm' | 'frontdesk'
  created_by        TEXT NOT NULL,     -- owner user_id
  fd_requester_name TEXT,              -- FD requester username, else NULL
  coordinator_name  TEXT NOT NULL      -- the DM deep link's :agentName
);

CREATE TABLE IF NOT EXISTS rooms (
  project_id     TEXT NOT NULL,
  chatroom_name  TEXT NOT NULL,
  room_type      TEXT NOT NULL,        -- 'dm' | 'project'
  room_label     TEXT NOT NULL,        -- group header the palette renders
  -- Chatroom.is_user_communication_name(chatroom_name), resolved at write time.
  -- The ACL reads THIS, never a room-name pattern; defaults closed (0) so a
  -- writer that forgets it narrows the scope rather than widening it.
  is_user_communication INTEGER NOT NULL DEFAULT 0,
  fingerprint    TEXT,                 -- "{size}:{mtime_ns}" of CHATS.ndjson
  PRIMARY KEY (project_id, chatroom_name)
);

CREATE TABLE IF NOT EXISTS messages (
  rowid         INTEGER PRIMARY KEY,
  message_id    TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  chatroom_name TEXT NOT NULL,
  ts            REAL NOT NULL,         -- epoch seconds, UTC, sub-second kept
  author_id     TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  content       TEXT NOT NULL,
  UNIQUE (project_id, chatroom_name, message_id)   -- makes replay idempotent
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(project_id, chatroom_name);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content       = 'messages',      -- external content: no duplicate text blob
  content_rowid = 'rowid',
  tokenize      = "unicode61 remove_diacritics 2",
  prefix        = '2 3'            -- typeahead: 2- and 3-char prefixes are O(1)
);

-- External-content FTS5 is NOT auto-maintained; these triggers are what keep
-- the index and the content table from diverging on any write path.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT);
"""


# ---------------------------------------------------------------------------
# Wire models — SEARCH_API_CONTRACT.md v1.0, serialized verbatim by the route
# ---------------------------------------------------------------------------

class DeepLink(BaseModel):
    """The click-through target of a hit (contract §4).

    ``path`` is a complete, URL-encoded, application-relative route the client
    hands straight to ``navigate()``; the structured parts are provided so a
    caller never has to parse it back apart.
    """
    path: str
    kind: Literal["dm", "project_room"]
    project_id: str
    chatroom_name: str
    agent_name: str | None  # non-null iff kind == "dm"
    message_id: str


class SearchHit(BaseModel):
    """One ranked message hit (contract §3.2). Every field is always present."""
    message_id: str
    project_id: str
    project_name: str
    room_id: str                    # == chatroom_name (the room's primary key)
    room_type: Literal["dm", "project"]
    room_label: str
    ts: datetime
    author_id: str
    author_name: str
    snippet: str
    snippet_truncated_start: bool
    snippet_truncated_end: bool
    match_offsets: list[tuple[int, int]]   # UTF-16 [start, end) into `snippet`
    score: float
    deep_link: DeepLink

    @field_serializer("ts")
    def _ser_ts(self, value: datetime) -> str:
        """Emit the contract's exact timestamp shape: ISO-8601, UTC, Z-suffixed,
        microsecond precision (``2026-07-26T14:03:11.482000Z``). Pinned here
        rather than left to Pydantic's default so the wire string cannot drift
        with a library upgrade."""
        return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


class SearchResponse(BaseModel):
    """The response envelope (contract §3.1)."""
    query: str
    hits: list[SearchHit]
    limit: int
    offset: int
    has_more: bool
    next_offset: int | None
    indexing: bool          # backfill still running -> results may be partial
    took_ms: float


class SearchScope(BaseModel):
    """The caller's searchable scope. Derived server-side from the JWT alone —
    there is no request parameter that widens or narrows it."""
    model_config = {"frozen": True}

    user_id: str
    username: str
    viewer_project_ids: frozenset[str] = frozenset()


class _SnippetResult(BaseModel):
    """Internal: a snippet window plus its UTF-16 highlight offsets."""
    text: str
    truncated_start: bool
    truncated_end: bool
    offsets: list[tuple[int, int]]


# ---------------------------------------------------------------------------
# Text helpers — tokenization, diacritic folding, UTF-16 offsets
# ---------------------------------------------------------------------------

@lru_cache(maxsize=8192)
def _fold_char(ch: str) -> str:
    """Fold one character to exactly one character.

    NFD-decompose, drop combining marks, lowercase, then collapse back to a
    single character — a combining mark that folds away becomes ``\\x00``,
    which never matches a query token. Cached because real text reuses a very
    small alphabet.
    """
    stripped = "".join(
        c for c in unicodedata.normalize("NFD", ch) if not unicodedata.combining(c)
    )
    lowered = stripped.lower()
    return lowered[0] if lowered else "\x00"


def _fold(text: str) -> str:
    """Case- and diacritic-fold ``text`` **preserving a 1:1 code-point mapping**
    to the original.

    The FTS5 tokenizer is ``unicode61 remove_diacritics 2``, so ``café`` and
    ``cafe`` are the same token to SQLite. Highlight offsets, though, have to
    point back into the ORIGINAL string — so folding must not change the
    length, which rules out a plain ``NFKD`` normalize.

    This runs over the FULL body of every returned hit to locate matches, so it
    is the hottest Python on the query path: a naive per-character loop cost
    ~22 ms of a ~50 ms query against the real corpus. ASCII text — effectively
    all of it — has no diacritics to strip and folds to exactly ``str.lower()``,
    which is one C-level call and length-preserving, so it takes that path.
    """
    if text.isascii():
        return text.lower()
    return "".join(map(_fold_char, text))


def tokenize_query(query: str) -> list[str]:
    """Split raw user input into FTS5 tokens (contract §2.2).

    Input is split on every non-alphanumeric character, so quotes, ``*``,
    ``(``, ``)``, ``:``, ``^``, ``-`` and the words AND / OR / NOT / NEAR carry
    no special meaning — there is no query DSL in v1 and no way to inject one.
    Tokens come back diacritic- and case-folded to match the tokenizer.
    """
    tokens: list[str] = []
    current: list[str] = []
    for ch in query:
        if ch.isalnum():
            current.append(ch)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return [_fold(t) for t in tokens if t]


def build_match_expr(tokens: Iterable[str]) -> str:
    """Build the FTS5 MATCH expression: every token quoted (so no FTS5 syntax
    character can escape), joined by implicit AND, with ``*`` appended to the
    LAST token only. ``deep lin`` becomes ``"deep" "lin"*`` — that trailing
    star is what makes this a typeahead rather than a whole-word search."""
    parts = list(tokens)
    quoted = ['"' + t.replace('"', '""') + '"' for t in parts]
    if quoted:
        quoted[-1] += "*"
    return " ".join(quoted)


def _utf16_prefix(text: str) -> list[int]:
    """Cumulative UTF-16 code-unit length at each code-point index.

    Python string indices are code points; JavaScript's are UTF-16 code units.
    A single emoji before a match shifts every downstream highlight by one, so
    the server converts rather than leaving the client to guess (contract §3.5).
    """
    prefix = [0] * (len(text) + 1)
    for i, ch in enumerate(text):
        prefix[i + 1] = prefix[i] + (2 if ord(ch) > 0xFFFF else 1)
    return prefix


def _is_token_char(ch: str) -> bool:
    return ch.isalnum()


def _find_token_spans(
    folded_content: str, tokens: list[str]
) -> list[tuple[int, int]]:
    """Locate every literal occurrence of each token in ``folded_content``.

    Matches are anchored at a token boundary the way the ``unicode61``
    tokenizer sees one: a match must start at the beginning of a word, and
    every token except the last (which matched as a prefix) must also end at a
    word boundary. Returns merged, ascending, non-overlapping ``[start, end)``
    code-point spans.
    """
    spans: list[tuple[int, int]] = []
    last_index = len(tokens) - 1
    for idx, token in enumerate(tokens):
        if not token:
            continue
        is_prefix = idx == last_index
        start = 0
        while True:
            pos = folded_content.find(token, start)
            if pos < 0:
                break
            start = pos + 1
            if pos > 0 and _is_token_char(folded_content[pos - 1]):
                continue  # mid-word: the tokenizer would not have matched here
            end = pos + len(token)
            if not is_prefix and end < len(folded_content) and _is_token_char(
                folded_content[end]
            ):
                continue  # a longer word: only the final token matches as a prefix
            spans.append((pos, end))
    if not spans:
        return []
    spans.sort()
    merged = [spans[0]]
    for span in spans[1:]:
        prev_start, prev_end = merged[-1]
        if span[0] <= prev_end:
            merged[-1] = (prev_start, max(prev_end, span[1]))
        else:
            merged.append(span)
    return merged


def _snap_outward(text: str, start: int, end: int, budget: int) -> tuple[int, int]:
    """Widen ``[start, end)`` to the enclosing word boundaries, spending at most
    ``budget`` extra characters in total. Keeps the window from slicing a word
    in half without ever breaching ``SNIPPET_CHARS``."""
    left = start
    while left > 0 and budget > 0 and _is_token_char(text[left - 1]):
        left -= 1
        budget -= 1
    right = end
    while right < len(text) and budget > 0 and _is_token_char(text[right]):
        right += 1
        budget -= 1
    return left, right


def build_snippet(content: str, tokens: list[str]) -> _SnippetResult:
    """Build the returned snippet and the offsets the frontend highlights with.

    A window of at most ``SNIPPET_CHARS`` characters centred on the first
    match, snapped outward to word boundaries. No ellipsis is embedded — the
    truncation booleans say which side was cut so the client renders the
    ellipsis itself and it never lands inside a highlight range. Offsets are
    UTF-16 code units into the returned snippet, half-open, ascending and
    non-overlapping; an empty list is legal (a tokenizer-level match with no
    literal substring) and is not an error.
    """
    folded = _fold(content)
    spans = _find_token_spans(folded, tokens)

    if spans:
        first_start, first_end = spans[0]
        centre = (first_start + first_end) // 2
    else:
        centre = 0
    half = SNIPPET_CORE_CHARS // 2
    if len(content) <= SNIPPET_CORE_CHARS:
        start, end = 0, len(content)
    else:
        # Centre the window on the first match, then slide it back inside the
        # string if centring pushed it past either edge.
        start = min(max(0, centre - half), len(content) - SNIPPET_CORE_CHARS)
        end = start + SNIPPET_CORE_CHARS
    start, end = _snap_outward(content, start, end, SNIPPET_CHARS - (end - start))

    snippet = content[start:end]
    prefix = _utf16_prefix(snippet)
    offsets: list[tuple[int, int]] = []
    for span_start, span_end in spans:
        if span_start >= end or span_end <= start:
            continue
        clipped_start = max(span_start, start) - start
        clipped_end = min(span_end, end) - start
        if clipped_end > clipped_start:
            offsets.append((prefix[clipped_start], prefix[clipped_end]))

    return _SnippetResult(
        text=snippet,
        truncated_start=start > 0,
        truncated_end=end < len(content),
        offsets=offsets,
    )


def recency_weight(age_days: float) -> float:
    """``0.25 + 0.75 * 0.5^(age_days / 30)`` — multiplicative with a floor.

    A message from today can outrank an otherwise-identical one from long ago
    by up to 4x, but the floor means recency can never fully bury a much
    stronger older match (contract §3.6).
    """
    decay = 0.5 ** (max(0.0, age_days) / RECENCY_HALF_LIFE_D)
    return RECENCY_FLOOR + (1.0 - RECENCY_FLOOR) * decay


# ---------------------------------------------------------------------------
# ChatSearchIndex
# ---------------------------------------------------------------------------

class ChatSearchIndex:
    """Derived FTS5 index over chat message bodies. Rebuildable at any time.

    Writes arrive on the event-loop thread from
    :class:`ChatSearchIndexSubscriber` (single-row upserts inside WAL —
    microseconds). Reads arrive on threadpool workers from the route, which is
    why connections are thread-local: ``sqlite3`` connections are not
    thread-safe and ``run_in_threadpool`` hands work to an arbitrary worker.
    """

    def __init__(self, model_ctx: "ModelContext") -> None:
        self._model_ctx = model_ctx
        self._db_path = Path(model_ctx.base_dir) / "search" / "chat_index.db"
        self._local = threading.local()
        self._available = False
        self._backfilling = False

    # -- lifecycle ---------------------------------------------------------

    @property
    def available(self) -> bool:
        """False when FTS5 is missing from the SQLite build or the kill switch
        is set; the route turns this into a 503 rather than an empty result."""
        return self._available

    @property
    def backfilling(self) -> bool:
        """True while :meth:`reconcile_all` runs. Surfaces as the response's
        ``indexing`` flag so the UI can say "still indexing your history" rather
        than rendering a bare "no results"."""
        return self._backfilling

    @property
    def db_path(self) -> Path:
        return self._db_path

    def open(self) -> None:
        """Create the DB and schema, probe FTS5, and honor the kill switch.

        A missing search feature must never take the chat server down: any
        failure here logs once, leaves :attr:`available` False and makes every
        write method a silent no-op. Idempotent. Recreates the file from
        scratch when the on-disk schema version differs — the index holds no
        authoritative data, so a full rebuild beats a migration ladder.
        """
        if os.environ.get("CLAWMEETS_SEARCH_DISABLED", "").strip():
            logger.warning("Chat search disabled by CLAWMEETS_SEARCH_DISABLED")
            self._available = False
            return
        try:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = self._connect()
            version = self._read_schema_version(conn)
            if version is not None and version != SCHEMA_VERSION:
                logger.info(
                    f"Chat search index schema {version} != {SCHEMA_VERSION}; rebuilding"
                )
                conn.close()
                self._reset_thread_state()
                for suffix in ("", "-wal", "-shm"):
                    Path(str(self._db_path) + suffix).unlink(missing_ok=True)
                conn = self._connect()
                version = None
            conn.executescript(_SCHEMA_SQL)
            if version is None:
                conn.execute(
                    "INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)",
                    (str(SCHEMA_VERSION),),
                )
            conn.commit()
            self._available = True
        except sqlite3.Error as e:
            logger.error(
                f"Chat search index unavailable ({e}); /me/search/messages will 503",
                exc_info=True,
            )
            self._available = False

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
        self._reset_thread_state()
        self._available = False

    def _reset_thread_state(self) -> None:
        self._local = threading.local()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        self._local.conn = conn
        return conn

    def _conn(self) -> sqlite3.Connection:
        """Per-thread connection (see the class docstring)."""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
        return conn

    @staticmethod
    def _read_schema_version(conn: sqlite3.Connection) -> int | None:
        try:
            row = conn.execute(
                "SELECT value FROM index_meta WHERE key = 'schema_version'"
            ).fetchone()
        except sqlite3.OperationalError:
            return None  # fresh file: index_meta does not exist yet
        if row is None:
            return None
        try:
            return int(row["value"])
        except (TypeError, ValueError):
            return None

    # -- write path --------------------------------------------------------

    def upsert_project(self, project: Project) -> None:
        """Mirror the ACL-relevant columns of a project. These columns are the
        ONLY authorization inputs on the query path — see :meth:`search`."""
        if not self._available:
            return
        try:
            conn = self._conn()
            conn.execute(
                """
                INSERT INTO projects
                  (project_id, project_name, display_name, surface,
                   created_by, fd_requester_name, coordinator_name)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                  project_name      = excluded.project_name,
                  display_name      = excluded.display_name,
                  surface           = excluded.surface,
                  created_by        = excluded.created_by,
                  fd_requester_name = excluded.fd_requester_name,
                  coordinator_name  = excluded.coordinator_name
                """,
                (
                    project.id,
                    project.name,
                    project.display_name,
                    str(project.surface),
                    project.created_by or "",
                    project.fd_requester_name,
                    project.coordinator_name,
                ),
            )
            conn.commit()
        except sqlite3.Error:
            logger.warning(f"Search index: upsert_project({project.id}) failed", exc_info=True)

    def upsert_room(
        self, project: Project, chatroom_name: str, fingerprint: str | None = None
    ) -> None:
        """Mirror a room, deriving the two pre-computed display fields.

        ``room_type`` is ``"dm"`` iff the project is DM-shaped AND the room is
        ``user-communication`` — mirroring ``Project.is_dm_shaped`` exactly, so
        the client never has to re-derive DM-ness from a project name.
        ``room_label`` is the coordinator (agent) name for a DM row and the
        chatroom name otherwise (contract §3.4).

        This is also where clause 2 of the ACL is resolved: the room-name
        predicate is evaluated ONCE here, by the model that owns it, and stored
        as ``is_user_communication`` for :meth:`_candidate_rows` to read as a
        plain column.
        """
        if not self._available:
            return
        is_uc = Chatroom.is_user_communication_name(chatroom_name)
        is_dm = project.is_dm_shaped and is_uc
        room_type = "dm" if is_dm else "project"
        room_label = project.coordinator_name if is_dm else chatroom_name
        try:
            conn = self._conn()
            conn.execute(
                """
                INSERT INTO rooms
                  (project_id, chatroom_name, room_type, room_label,
                   is_user_communication, fingerprint)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id, chatroom_name) DO UPDATE SET
                  room_type             = excluded.room_type,
                  room_label            = excluded.room_label,
                  is_user_communication = excluded.is_user_communication,
                  fingerprint = COALESCE(excluded.fingerprint, rooms.fingerprint)
                """,
                (
                    project.id, chatroom_name, room_type, room_label,
                    int(is_uc), fingerprint,
                ),
            )
            conn.commit()
        except sqlite3.Error:
            logger.warning(
                f"Search index: upsert_room({project.id}/{chatroom_name}) failed",
                exc_info=True,
            )

    def index_message(
        self, project_id: str, chatroom_name: str, message: ChatMessage
    ) -> None:
        """Upsert one message.

        No-op for ``is_ack`` rows (protocol acknowledgments, never user-authored
        text — the same exclusion ``collect_recent_activity`` applies) and for
        blank content. The upsert is keyed on
        ``(project_id, chatroom_name, message_id)``, so changelog replay and
        backfill converge on the same row.
        """
        if not self._available:
            return
        if message.is_ack or not message.content.strip():
            return
        try:
            conn = self._conn()
            self._insert_message(conn, project_id, chatroom_name, message)
            conn.commit()
        except sqlite3.Error:
            logger.warning(
                f"Search index: index_message({project_id}/{chatroom_name}) failed",
                exc_info=True,
            )

    @staticmethod
    def _insert_message(
        conn: sqlite3.Connection,
        project_id: str,
        chatroom_name: str,
        message: ChatMessage,
    ) -> None:
        ts = message.ts
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        conn.execute(
            """
            INSERT INTO messages
              (message_id, project_id, chatroom_name, ts, author_id, author_name, content)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, chatroom_name, message_id) DO UPDATE SET
              ts          = excluded.ts,
              author_id   = excluded.author_id,
              author_name = excluded.author_name,
              content     = excluded.content
            """,
            (
                message.id,
                project_id,
                chatroom_name,
                ts.timestamp(),
                message.from_participant_id,
                message.from_participant_name,
                message.content,
            ),
        )

    def drop_room(self, project_id: str, chatroom_name: str) -> None:
        """Delete every message row for a room.

        Called on CHATROOM_CLEARED — critically, since a user who wipes a room's
        history must not keep finding it in search — and on ROOM_DELETED for
        every room the model layer will actually delete (the subscriber applies
        ``Chatroom.is_system_room_name`` first; see ``_dispatch``).
        """
        if not self._available:
            return
        try:
            conn = self._conn()
            conn.execute(
                "DELETE FROM messages WHERE project_id = ? AND chatroom_name = ?",
                (project_id, chatroom_name),
            )
            conn.execute(
                "UPDATE rooms SET fingerprint = NULL WHERE project_id = ? AND chatroom_name = ?",
                (project_id, chatroom_name),
            )
            conn.commit()
        except sqlite3.Error:
            logger.warning(
                f"Search index: drop_room({project_id}/{chatroom_name}) failed",
                exc_info=True,
            )

    def drop_project(self, project_id: str) -> None:
        """Delete a project and all of its rooms and messages.

        Called from ``_delete_project_in_place``, which tears down the
        changelog itself and so is never observed by the subscriber. Without
        this hook a deleted project's messages stay searchable forever — a
        permission leak, not merely staleness.
        """
        if not self._available:
            return
        try:
            conn = self._conn()
            conn.execute("DELETE FROM messages WHERE project_id = ?", (project_id,))
            conn.execute("DELETE FROM rooms WHERE project_id = ?", (project_id,))
            conn.execute("DELETE FROM projects WHERE project_id = ?", (project_id,))
            conn.commit()
        except sqlite3.Error:
            logger.warning(f"Search index: drop_project({project_id}) failed", exc_info=True)

    # -- backfill / reconcile ---------------------------------------------

    @staticmethod
    def _fingerprint(path: Path) -> str | None:
        try:
            st = path.stat()
        except OSError:
            return None
        return f"{st.st_size}:{st.st_mtime_ns}"

    async def reconcile_all(self) -> None:
        """Walk every project and room, re-indexing only what changed.

        Each room's ``CHATS.ndjson`` is compared against the stored
        ``(size, mtime_ns)`` fingerprint; a room that matches is skipped after a
        single ``stat()`` without ever being opened. This is BOTH the first-run
        backfill of existing history AND the ongoing drift repair — it catches
        anything that reached ``CHATS.ndjson`` without passing the subscriber.
        Yields to the event loop between rooms so an in-progress backfill never
        starves live requests.
        """
        if not self._available:
            return
        import asyncio

        self._backfilling = True
        indexed_rooms = 0
        indexed_messages = 0
        try:
            try:
                projects = Project.list_all(self._model_ctx)
            except (OSError, ValueError):
                logger.warning("Search index: could not list projects", exc_info=True)
                return
            live_ids = set()
            for project in projects:
                live_ids.add(project.id)
                self.upsert_project(project)
                try:
                    room_names = project.chatrooms
                except (OSError, ValueError):
                    continue
                for chatroom_name in room_names:
                    changed, message_count = self._reconcile_room(project, chatroom_name)
                    if changed:
                        indexed_rooms += 1
                        indexed_messages += message_count
                    await asyncio.sleep(0)
            self._prune_missing_projects(live_ids)
        finally:
            self._backfilling = False
            if indexed_rooms:
                logger.info(
                    f"Chat search index: reindexed {indexed_messages} message(s) "
                    f"across {indexed_rooms} room(s)"
                )

    def _reconcile_room(self, project: Project, chatroom_name: str) -> tuple[bool, int]:
        """Re-index one room if its CHATS.ndjson fingerprint moved. Returns
        ``(changed, messages_indexed)``."""
        room = Chatroom.get(project.id, chatroom_name, self._model_ctx)
        if room is None:
            return (False, 0)
        fingerprint = self._fingerprint(room.chats_path)
        try:
            conn = self._conn()
            row = conn.execute(
                "SELECT fingerprint FROM rooms WHERE project_id = ? AND chatroom_name = ?",
                (project.id, chatroom_name),
            ).fetchone()
        except sqlite3.Error:
            logger.warning("Search index: fingerprint read failed", exc_info=True)
            return (False, 0)
        if row is not None and row["fingerprint"] == fingerprint and fingerprint is not None:
            return (False, 0)

        self.upsert_room(project, chatroom_name)
        count = 0
        try:
            entries = room.get_log_entries()
        except (OSError, ValueError):
            logger.warning(
                f"Search index: could not read {project.id}/{chatroom_name}", exc_info=True
            )
            return (False, 0)
        try:
            conn = self._conn()
            with conn:  # one transaction per room
                conn.execute(
                    "DELETE FROM messages WHERE project_id = ? AND chatroom_name = ?",
                    (project.id, chatroom_name),
                )
                for entry in entries:
                    if not isinstance(entry, ChatMessage):
                        continue
                    if entry.is_ack or not entry.content.strip():
                        continue
                    self._insert_message(conn, project.id, chatroom_name, entry)
                    count += 1
                # Normally an ON CONFLICT update of the fingerprint alone: the
                # upsert_room() above already wrote the row. The INSERT branch
                # is only reachable if that call was swallowed by an error.
                conn.execute(
                    """
                    INSERT INTO rooms (project_id, chatroom_name, room_type, room_label,
                                       is_user_communication, fingerprint)
                    VALUES (?, ?, 'project', ?, ?, ?)
                    ON CONFLICT(project_id, chatroom_name)
                      DO UPDATE SET fingerprint = excluded.fingerprint
                    """,
                    (
                        project.id, chatroom_name, chatroom_name,
                        int(Chatroom.is_user_communication_name(chatroom_name)),
                        fingerprint,
                    ),
                )
        except sqlite3.Error:
            logger.warning(
                f"Search index: reindex of {project.id}/{chatroom_name} failed", exc_info=True
            )
            return (False, 0)
        return (True, count)

    def _prune_missing_projects(self, live_ids: set[str]) -> None:
        """Drop index rows for projects that no longer exist on disk — the
        second half of the deletion story, covering any path that removed a
        project without calling :meth:`drop_project`."""
        try:
            conn = self._conn()
            stored = {r["project_id"] for r in conn.execute("SELECT project_id FROM projects")}
        except sqlite3.Error:
            return
        for project_id in stored - live_ids:
            logger.info(f"Chat search index: pruning deleted project {project_id}")
            self.drop_project(project_id)

    # -- query path --------------------------------------------------------

    def search(
        self,
        query: str,
        scope: SearchScope,
        *,
        limit: int = 20,
        offset: int = 0,
    ) -> SearchResponse:
        """Ranked message hits across every room ``scope`` can read.

        Blocking — the route wraps this in ``run_in_threadpool`` so a slow
        query never stalls the single-process event loop (including WebSocket
        traffic).

        Two-stage ranking: FTS5/BM25 selects a bounded candidate pool in C,
        then Python re-weights it by recency. A single SQL expression is not an
        option because ``exp()`` is not available in a stock CPython SQLite
        build, and a per-row Python UDF is slower than re-ranking 200 rows.

        The ACL predicate is inlined into the matching statement, so a row the
        caller may not read is never materialized. Every caller gets their own
        plate; there is no bypass parameter.

        Raises:
            SearchIndexError: the index could not be queried. The route turns
                this into a 503; it is never reported as zero hits.
        """
        started = _now_monotonic_ms()
        limit = max(1, min(limit, MAX_LIMIT))
        offset = max(0, min(offset, MAX_OFFSET))
        tokens = tokenize_query(query)

        def _empty() -> SearchResponse:
            return SearchResponse(
                query=query, hits=[], limit=limit, offset=offset,
                has_more=False, next_offset=None,
                indexing=self._backfilling,
                took_ms=round(_now_monotonic_ms() - started, 3),
            )

        # Below the floor after tokenization is a normal typeahead state, not an
        # error: typing one character returns 200 with no hits (contract §2.2).
        if sum(len(t) for t in tokens) < MIN_QUERY_CHARS:
            return _empty()

        rows = self._candidate_rows(build_match_expr(tokens), scope)
        if not rows:
            return _empty()

        now = datetime.now(UTC).timestamp()
        ranked = []
        for row in rows:
            # bm25() is negative-is-better; flip it so a bigger score is better.
            relevance = max(0.0, -float(row["rel"]))
            age_days = max(0.0, (now - float(row["ts"])) / 86400.0)
            ranked.append((relevance * recency_weight(age_days), row))
        ranked.sort(key=lambda pair: pair[0], reverse=True)

        page = ranked[offset:offset + limit]
        has_more = (offset + limit) < len(ranked)
        hits = [self._build_hit(row, score, tokens) for score, row in page]
        return SearchResponse(
            query=query,
            hits=hits,
            limit=limit,
            offset=offset,
            has_more=has_more,
            next_offset=(offset + len(hits)) if has_more else None,
            indexing=self._backfilling,
            took_ms=round(_now_monotonic_ms() - started, 3),
        )

    def _candidate_rows(self, match_expr: str, scope: SearchScope) -> list[sqlite3.Row]:
        """One statement: MATCH + the ACL predicate + BM25 ordering, bounded to
        ``CANDIDATE_POOL`` rows. Raises :class:`SearchIndexError` on a SQLite
        failure rather than degrading to an empty result."""
        viewer_ids = sorted(scope.viewer_project_ids)
        # The contract §5 three-clause rule. The invariant is that search returns
        # a hit iff the same user could open that room via the room-read endpoint:
        # not narrower, not wider.
        #
        # Clause 2's room test is a mirrored boolean, NOT a room-name pattern:
        # `Chatroom.is_user_communication_name` was already called at index-write
        # time (see upsert_room) and stored in `rooms.is_user_communication`, so
        # the model owns the rule and SQL only reads the answer. A `LIKE` here
        # leaked across a user boundary once — see the module docstring.
        acl = [
            "p.created_by = :user_id",
            "(p.fd_requester_name = :username AND r.is_user_communication = 1)",
        ]
        params: dict[str, object] = {
            "match": match_expr,
            "user_id": scope.user_id,
            "username": scope.username,
            "pool": CANDIDATE_POOL,
        }
        if viewer_ids:
            placeholders = []
            for i, project_id in enumerate(viewer_ids):
                key = f"viewer{i}"
                params[key] = project_id
                placeholders.append(f":{key}")
            acl.append(f"p.project_id IN ({', '.join(placeholders)})")
        sql = f"""
            SELECT m.message_id, m.project_id, m.chatroom_name, m.ts,
                   m.author_id, m.author_name, m.content,
                   r.room_type, r.room_label,
                   p.project_name, p.coordinator_name,
                   bm25(messages_fts) AS rel
            FROM messages_fts
            JOIN messages  m ON m.rowid = messages_fts.rowid
            JOIN rooms     r ON r.project_id = m.project_id
                            AND r.chatroom_name = m.chatroom_name
            JOIN projects  p ON p.project_id = m.project_id
            WHERE messages_fts MATCH :match
              AND ({' OR '.join(acl)})
            ORDER BY bm25(messages_fts)
            LIMIT :pool
        """
        try:
            return self._conn().execute(sql, params).fetchall()
        except sqlite3.Error as e:
            # NOT swallowed into an empty result: a locked or corrupted index
            # must be distinguishable from "nothing matched" (contract §2.3).
            logger.warning("Search index: query failed", exc_info=True)
            raise SearchIndexError(str(e)) from e

    def _build_hit(self, row: sqlite3.Row, score: float, tokens: list[str]) -> SearchHit:
        snippet = build_snippet(row["content"], tokens)
        return SearchHit(
            message_id=row["message_id"],
            project_id=row["project_id"],
            project_name=row["project_name"],
            room_id=row["chatroom_name"],
            room_type=row["room_type"],
            room_label=row["room_label"],
            ts=datetime.fromtimestamp(float(row["ts"]), tz=UTC),
            author_id=row["author_id"],
            author_name=row["author_name"],
            snippet=snippet.text,
            snippet_truncated_start=snippet.truncated_start,
            snippet_truncated_end=snippet.truncated_end,
            match_offsets=snippet.offsets,
            score=round(score, 6),
            deep_link=_build_deep_link(
                room_type=row["room_type"],
                project_id=row["project_id"],
                chatroom_name=row["chatroom_name"],
                coordinator_name=row["coordinator_name"],
                message_id=row["message_id"],
            ),
        )


def _build_deep_link(
    *,
    room_type: str,
    project_id: str,
    chatroom_name: str,
    coordinator_name: str,
    message_id: str,
) -> DeepLink:
    """Build the click-through target (contract §4.2).

    Both shapes are routes that already exist in ``App.tsx``:
    ``dm/:agentName/:threadId`` and ``projects/:projectId/chatrooms/:chatroomName``.
    A DM thread's ``:threadId`` **is** its ``project_id`` — each thread is its
    own project — which is how ``ProjectItem.tsx`` and ``DmsPanel.tsx`` already
    build DM links.
    """
    if room_type == "dm":
        return DeepLink(
            path=(
                f"/dm/{quote(coordinator_name, safe='')}/{quote(project_id, safe='')}"
                f"?msg={quote(message_id, safe='')}"
            ),
            kind="dm",
            project_id=project_id,
            chatroom_name=chatroom_name,
            agent_name=coordinator_name,
            message_id=message_id,
        )
    return DeepLink(
        path=(
            f"/projects/{quote(project_id, safe='')}"
            f"/chatrooms/{quote(chatroom_name, safe='')}"
            f"?msg={quote(message_id, safe='')}"
        ),
        kind="project_room",
        project_id=project_id,
        chatroom_name=chatroom_name,
        agent_name=None,
        message_id=message_id,
    )


def _now_monotonic_ms() -> float:
    import time

    return time.perf_counter() * 1000.0


# ---------------------------------------------------------------------------
# Changelog subscriber
# ---------------------------------------------------------------------------

class ChatSearchIndexSubscriber(ChangelogSubscriber):
    """Indexes each entry AFTER ``ModelContextChangelogSubscriber`` has written it.

    Registered directly after ``model_ctx.changelog_subscriber`` in the
    ``runloop_factory`` list. ``ChangelogRunloop`` calls subscribers in
    insertion order per entry, so by the time this runs the row is already
    durable in ``CHATS.ndjson`` — the index mirrors what was just written
    rather than racing it.

    Must be idempotent (entries are replayed) and must never raise: an
    exception here would wedge the runloop cursor for a room's chat delivery,
    and search is strictly less important than chat.
    """

    def __init__(self, index: ChatSearchIndex, model_ctx: "ModelContext") -> None:
        self._index = index
        self._model_ctx = model_ctx

    async def on_entry(
        self, entry: "ChangelogEntry", project_id: str, project_name: str
    ) -> None:
        if not self._index.available:
            return
        try:
            await self._dispatch(entry, project_id)
        except Exception:  # never propagate — see the class docstring
            logger.warning(
                f"Search index: subscriber failed on {entry.entry_type} "
                f"v{entry.version} in {project_id}",
                exc_info=True,
            )

    async def _dispatch(self, entry: "ChangelogEntry", project_id: str) -> None:
        entry_type = entry.entry_type
        payload = entry.payload

        if entry_type == ChangelogEntryType.MESSAGE:
            chatroom_name = getattr(payload, "chatroom_name", None)
            if not chatroom_name:
                return
            if getattr(payload, "is_ack", False):
                return  # protocol noise, never user-authored text
            message = ChatMessage.from_message_payload(payload, version=entry.version)
            # A room the index has not seen yet (first message after a restart
            # that missed ROOM_CREATED) would otherwise produce a message row
            # with no rooms row to join, i.e. an invisible hit.
            self._ensure_room(project_id, chatroom_name)
            self._index.index_message(project_id, chatroom_name, message)

        elif entry_type == ChangelogEntryType.PROJECT_CREATED:
            self._upsert_project(project_id)

        elif entry_type == ChangelogEntryType.ROOM_CREATED:
            chatroom_name = getattr(payload, "chatroom_name", None)
            if chatroom_name:
                self._ensure_room(project_id, chatroom_name)

        elif entry_type == ChangelogEntryType.DISPLAY_NAME_CHANGED:
            self._upsert_project(project_id)

        elif entry_type == ChangelogEntryType.ROOM_DELETED:
            chatroom_name = getattr(payload, "chatroom_name", None)
            # Mirror ``ModelContext._handle_room_deleted``: it REFUSES to delete
            # the two system rooms, and ``_delete_project_in_place`` relies on
            # that refusal — it emits ROOM_DELETED for a room in a *different,
            # surviving* project. Dropping those rows here would silently empty a
            # live, still-readable room until the next reconcile_all at boot.
            if chatroom_name and not Chatroom.is_system_room_name(chatroom_name):
                self._index.drop_room(project_id, chatroom_name)

        elif entry_type == ChangelogEntryType.CHATROOM_CLEARED:
            # No skip here: a clear is honored for every room, system ones
            # included. Wiped history that stayed searchable would be the leak.
            chatroom_name = getattr(payload, "chatroom_name", None)
            if chatroom_name:
                self._index.drop_room(project_id, chatroom_name)

        # Everything else — file events, batch events, participant adds,
        # allowlist updates — carries no indexable text.

    def _project(self, project_id: str) -> Project | None:
        try:
            return Project.get(project_id, self._model_ctx)
        except ValueError:
            return None  # Project.get raises rather than returning None

    def _upsert_project(self, project_id: str) -> None:
        project = self._project(project_id)
        if project is not None:
            self._index.upsert_project(project)

    def _ensure_room(self, project_id: str, chatroom_name: str) -> None:
        project = self._project(project_id)
        if project is None:
            return
        self._index.upsert_project(project)
        self._index.upsert_room(project, chatroom_name)
