# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/store.py
Durable records of the channel gateway, in one SQLite file.

``{data_dir}/channels/channels.db`` holds every record the gateway needs to
survive a restart: connections (with their encrypted credential), contacts,
the conversation → thread mapping, inbound dedupe keys, the burst buffer and
the outbox, and access control: allowlist entries, blocks, the Requests queue
with its held messages, and the rate-limit window. SQLite rather than JSON
files because several of the gateway's promises are only true if several rows
commit together or not at all:

- a provider event's dedupe key and what was decided for it — buffered, held
  for a Request, or dropped (otherwise a crash between them turns the
  provider's redelivery into a "duplicate" and loses the message for good);
- a Request's fixed reply and the mark that says it was sent once;
- an outbox scan's rows and the cursor that says the scan happened.

**Held messages are not in ``inbound_buffer``.** Everything that recovers
buffered work (the boot flush, the flush-retry sweep) reads that table, and all
of it is meant to deliver to the agent. A waiting stranger's messages live in
``held_messages`` and leave it only through Allow (into the thread) or Block
(deleted).

**Schema version.** The file carries ``PRAGMA user_version``. A version-3 file
(written before email) is upgraded in place on open: three columns added with
their defaults and the two email tables created, in one transaction
(``_MIGRATIONS``). A file written by any other version is refused when the
gateway is built (the kill switch stays off, with one log line saying why)
rather than failing later on a missing column.

Version 5 (the hub) is additive and needs no backfill: the hub tables are in
``_SCHEMA`` (``CREATE TABLE IF NOT EXISTS``), the new outbox and dedupe
columns in ``_ADDED_COLUMNS``, and indexes on those columns in
``_POST_COLUMN_SCHEMA``, which runs once the columns exist. Every new column is
nullable or has a default. ``rollback_schema_v5`` goes back to version 4
without dropping anything (see its docstring), and opening the file again
reuses what was left in place.

Version 6 (the hub client) is additive too: four tables in ``_SCHEMA`` and
nothing else. ``hub_threads`` is the requester's side of each hub
conversation (its stand-in and how it closed); ``hub_channels`` is each local
agent's Hub channel (listing state, certificate, daily run count);
``hub_directory_cache`` keeps search and agent answers for up to 24 hours; and
``hub_avatar_cache`` keeps one re-encoded avatar, or the refusal, per
``(hub_agent_id, refreshed_at)``. Version-5 code never reads them, so
``rollback_schema_v6`` only sets the version back to 5.

``hub_sender_via_agent`` (no version bump: ``CREATE TABLE IF NOT EXISTS``
adds it on open, and older code never reads it) is, per hub connection and
remote person, which of that person's own agents sent their newest kept
message (``via_agent``, cleaned; NULL when they sent it themselves): a label
on their Request and thread rows, never part of any key.

``hub_bridge_relays`` (no version bump, like ``hub_sender_via_agent``) is
one row per room message relayed (or held, or refused) to a retained agent's
stand-in by the room bridge, with its delivery state; ``hub_threads`` gains
``kind`` (``dm`` | ``room_bridge``), ``bound_project_id`` and ``bound_room``
as added columns.

``local_retained`` (no version bump, like ``hub_sender_via_agent``) is
each user's retained agents of THIS server, by local agent id: a pin, with
no stand-in and no state (``server/hub/retain.py``).

Version 7 (retain) is additive too: one table in ``_SCHEMA``.
``hub_retained`` is each user's retained remote agents (stand-in ids) with
the state the hub's signed statements left them in (``active``,
``unlisted``, ``identity_changed``) and a snapshot of the listing taken at
retain time. Version-6 code never reads it, so ``rollback_schema_v7`` only
sets the version back to 6.

**Hub rows** (a connection whose channel is ``hub``) use two states no other
channel reaches: ``parked`` (waiting for the target, the hub, or a
``retry_after``; no attempt counted) and ``awaiting_receipt`` (the relay frame
was written to the hub; only a verified receipt ends it). Both are
``WAITING_STATES``: not terminal, never claimed, shown to the owner as
"waiting". The hub tables and the methods on hub rows are in ``hub_store.py``,
on this file's connection and transactions.

**Signed objects** are stored verbatim with the purpose they were signed
under, in a sibling ``*_purpose`` column pinned by a CHECK to the one
``hub_protocol`` ``Purpose`` that object may carry (``outbox.envelope``,
``hub_pins.rotation``, ``hub_registration.statement``, ``remote_agents.cert``).

**Per-connection extras** (``connection_extras``). Settings and counters
added after version 4, in their own table so a version-4 file needs no
migration (``CREATE TABLE IF NOT EXISTS`` adds it on open): LINE's
acknowledgement text, the count of webhook calls that failed the signature
check since the last one that passed (capped at ``MAX_UNVERIFIED_CALLS``), the
push quota LINE reported at the last fetch with the time of the last attempt,
and when LINE last answered a push with its monthly limit, and the automatic
mail dropped from senders the agent doesn't talk to (email: a count, capped at
``MAX_AUTOMATIC_DROPPED``, plus when, from which domain and why the last one
was — never the address, subject or text). At most one row per connection; a
missing row reads as defaults. Columns added to this table (or to ``outbox``)
later are added on open when missing (``_ADDED_COLUMNS``).

**Customer-service windows** (``conversation_windows``). WhatsApp lets a
business answer freely only within 24 hours of the customer's last message.
The clock is per conversation, never per connection (one person writing must
not reopen everyone's window): ``last_user_message_at`` is the provider's own
timestamp of the newest message, capped at our clock and only ever moved
forward, written in the SAME transaction as the message's dedupe key
(``note_user_message``, through ``accept_inbound``'s ``on_accept``) whatever
the access decision was. ``provider_closed_at`` is when the provider itself
refused a send as outside the window (WhatsApp's 131047): the window counts as
closed from then until the customer writes again. In a table of its own, like
the extras, so a version-4 file needs no migration.

**Email threading state** (``email_threads``, ``email_message_ids``). A reply
by email needs a recipient, a subject and threading headers that Telegram's
``send(conversation_key, text)`` never carried. They are stored per
conversation, written in the SAME transaction as the inbound mail that changes
them (``accept_inbound``'s ``on_kept``: only for a mail that is kept or answered
— a dropped one, blocked, rate-limited or automatic, leaves no threading state),
and read by the email adapter at send time. The Message-ID index maps
``(connection, sender, Message-ID)`` to the conversation: every kept inbound id,
and every id WE set on an outbound row — recorded when the row is created
(``_index_outbound``), not after the send, so a reply to it threads even while
the row is still ``sending``; removed again in the commit that ends the row
never sent (``_unindex_outbound``: a provider rejection, an earlier part's
failure, the reply cap, expiry before any attempt). The sender is part
of the key: a Message-ID is not a secret (it is in every CC'd copy and every
list archive), so one contact's id never continues another contact's thread.

Every method that writes is ONE transaction (``with self._tx():``) and has no
``await`` inside it, so on the single asyncio process a check and the insert
that follows it cannot interleave with another request.

**Removed connections leave a history record** (``removed_threads``).
Removing a connection deletes its thread mappings and contacts, but the
threads' projects stay for the owner to read. So that the Front Desk sidebar
can still show which channel such a thread came from and who the person was,
``remove_connection`` writes one row per mapped project, in the same commit:
the owner, the channel and the contact's display name as it was. No secret and
no provider identifier. Deleting the project deletes its row
(``forget_removed_thread``). In a table of its own, like the extras, so a
version-4 file needs no migration.

**Web chat widget** (``webchat_grants``, ``webchat_messages``). A widget
connection has no provider: each grant is one embeddable API key with the site
origins allowed to use it. The key is stored twice — a SHA-256 for the lookup
on every widget call, and encrypted (rotated with the connection credentials)
so the owner's page can show the snippet again. Revoking sets ``revoked_at``;
a revoked grant never matches again. ``webchat_messages`` is each visitor's
mailbox: the adapter's ``send`` writes the reply there (once per retry key)
and the widget reads it by ``seq``. Both are in tables of their own, so a
version-4 file needs no migration.

Times are epoch seconds (floats) from the gateway's injectable clock.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Iterator, Optional

from cryptography.fernet import MultiFernet
from pydantic import BaseModel, SecretStr

from clawmeets.hub_protocol.canonical import Purpose
from clawmeets.sync.changelog import make_contact_id

from . import access
from .email_address import outbound_message_id

SCHEMA_VERSION = 9

#: Refused webhook calls stop being counted here; the card shows "1,000+".
MAX_UNVERIFIED_CALLS = 1000
#: Dropped automatic mail stops being counted here, likewise.
MAX_AUTOMATIC_DROPPED = 1000

#: ``connection_extras`` columns added after the table first shipped, added on
#: open to a file that lacks them.
_EXTRAS_COLUMNS = {
    "quota_attempted_at": "REAL",
    "quota_exhausted_at": "REAL",
    "handshake_ok_at": "REAL",
    "verify_token_last4": "TEXT",
    "push_refused_at": "REAL",
    "automatic_dropped": "INTEGER NOT NULL DEFAULT 0",
    "automatic_dropped_at": "REAL",
    "automatic_dropped_domain": "TEXT",
    "automatic_dropped_reason": "TEXT",
}
#: Every table's added columns, the same way.
_ADDED_COLUMNS = {
    "connection_extras": _EXTRAS_COLUMNS,
    "outbox": {
        "detail": "TEXT",
        # Hub rows only (see "Hub rows" above); NULL or 0 on every other row.
        "receipt_due_at": "REAL",           # awaiting_receipt: the re-relay is due then
        "parked_until": "REAL",             # parked: wake then (a retry_after); NULL = on an event
        "forwarded_at": "REAL",             # the FIRST write of the relay frame; never reset
        "relay_count": "INTEGER NOT NULL DEFAULT 0",
        "probe_due_at": "REAL",             # held rows: the next delivery probe
        "last_receipt": "TEXT",             # the receipt's result after mapping (held_*, accepted, ...)
        "delivery_detail": "TEXT",          # not_accepting's detail (channel_off, daily_cap, ...)
        "retry_at": "REAL",                 # the refusal's retry_after, as a time
        "delivered_late": "INTEGER NOT NULL DEFAULT 0",
        "envelope": "TEXT",                 # the signed envelope exactly as first sent
        "envelope_purpose": (
            f"TEXT CHECK (envelope_purpose IS NULL OR envelope_purpose = '{Purpose.ENVELOPE.value}')"
        ),
    },
    # What was decided for an event, so a redelivery is answered with it.
    "inbound_events": {"outcome": "TEXT", "outcome_detail": "TEXT", "current_state": "TEXT"},
    # Agent send (plan-agent-access 4.1): the owned agent that opened a DM
    # thread, and its wake count for the day (at most 20 reply wakes a day).
    "hub_threads": {"started_by_agent_id": "TEXT", "wake_day": "TEXT",
                    "wake_count": "INTEGER NOT NULL DEFAULT 0",
                    # The room bridge (plan-agent-access 4.2): a hidden thread
                    # bound to one workroom and one stand-in.
                    "kind": "TEXT NOT NULL DEFAULT 'dm'", "bound_project_id": "TEXT",
                    "bound_room": "TEXT"},
    # Hub-ranked dispatch (version 9): the owner opted this agent in to
    # requests the hub routes to it, under its own daily cap.
    "hub_channels": {"accept_dispatch": "INTEGER NOT NULL DEFAULT 0",
                     "dispatch_daily_cap": "INTEGER NOT NULL DEFAULT 20"},
}
#: Indexes on added columns: run after ``_ADDED_COLUMNS``, once the columns exist.
_POST_COLUMN_SCHEMA = """
CREATE INDEX IF NOT EXISTS outbox_receipt_due ON outbox (state, receipt_due_at);
CREATE INDEX IF NOT EXISTS outbox_probe_due ON outbox (probe_due_at) WHERE probe_due_at IS NOT NULL;
"""
#: Upgrades from an older version, run in one transaction before ``_SCHEMA``.
_MIGRATIONS = {
    3: (
        "ALTER TABLE connections ADD COLUMN last_inbound_at REAL",
        "ALTER TABLE inbound_buffer ADD COLUMN dispatch INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE outbox ADD COLUMN from_agent INTEGER NOT NULL DEFAULT 0",
    ),
    # Version 4 -> 5 is additive: _SCHEMA, _ADDED_COLUMNS and _POST_COLUMN_SCHEMA.
    4: (),
    # Version 5 -> 6 is additive: four new tables in _SCHEMA.
    5: (),
    # Version 6 -> 7 is additive: hub_retained in _SCHEMA.
    6: (),
    # Version 7 -> 8 is additive: hub_owners in _SCHEMA.
    7: (),
    # Version 8 -> 9 is additive: two hub_channels columns in _ADDED_COLUMNS and
    # hub_dispatch_counts in _SCHEMA.
    8: (),
}

# Outbox states. ``sent``, ``failed``, ``expired``, ``held_paused`` and
# ``held_window`` are terminal: the worker never claims those rows again.
PENDING = "pending"
SENDING = "sending"
SENT = "sent"
FAILED = "failed"
EXPIRED = "expired"
#: An agent reply whose row was inserted while its thread was paused: the owner
#: had taken over, so it is never sent — not even after un-pausing.
HELD_PAUSED = "held_paused"
#: A reply that could not be sent because the channel's customer-service
#: window had closed (WhatsApp: 24 h after the customer's last message). Never
#: sent, and never released: when the customer writes again the agent answers
#: the new message. Only an adapter with ``customer_service_window_seconds``
#: produces it.
HELD_WINDOW = "held_window"
TERMINAL_STATES = (SENT, FAILED, EXPIRED, HELD_PAUSED, HELD_WINDOW)
#: A hub row waiting for its target, its hub or a ``retry_after``: never
#: claimed, no attempt counted. Woken by an event (presence, a reconnect),
#: by ``parked_until``, or ended by the hub sweep.
PARKED = "parked"
#: A hub row whose relay frame was written to the hub: ends only on a verified
#: receipt (or the sweep); re-relayed, byte for byte, when ``receipt_due_at``
#: passes.
AWAITING_RECEIPT = "awaiting_receipt"
#: Neither waiting state is terminal; the owner sees both as "waiting".
WAITING_STATES = (PARKED, AWAITING_RECEIPT)
#: Every state a row may be in. SQLite cannot add a CHECK to an existing
#: column, so this set is the constraint; the channel tests check every row.
ALL_OUTBOX_STATES = frozenset({PENDING, SENDING, *WAITING_STATES, *TERMINAL_STATES})
#: The states of a row that has not ended: what removing a connection,
#: repointing a thread and the schema rollback close.
OPEN_STATES = (PENDING, SENDING, *WAITING_STATES)

# Outbox row kinds. A fixed reply belongs to a Request, not to a thread: its
# ``project_id`` is NULL and the "thread gone" rule does not apply to it.
KIND_REPLY = "reply"
KIND_FIXED_REPLY = "fixed_reply"
#: A requester's message to an agent on another deployment (the A side).
KIND_HUB_REQUEST = "hub_request"
#: The channel name of a hub connection.
HUB_CHANNEL = "hub"

# Reasons on an ``expired`` row. The owner reads them, so "never sent" and
# "may have been delivered" must not be the same word.
REASON_NEVER_SENT = "expired_never_sent"       # expired from pending: no attempt was made
REASON_MAYBE_SENT = "expired_maybe_sent"       # expired from sending: an attempt may have reached the contact
REASON_THREAD_GONE = "thread_deleted"          # the thread's project was deleted before sending
REASON_RETRIES_EXHAUSTED = "retries_exhausted"
# Reasons on a ``failed`` row the gateway writes itself.
#: A later part of a reply whose earlier part failed for good: never sent, so a
#: reply never arrives with a hole in it.
REASON_EARLIER_PART_FAILED = "earlier_part_failed"
#: The connection was removed while the row was still waiting.
REASON_CONNECTION_REMOVED = "connection_removed"
#: The message could not be turned into the channel's format at all (the
#: adapter's ``format_parts`` raised): one row, never sent, so the scan moves on.
REASON_FORMAT_ERROR = "format_error"
#: The thread already had the most agent replies a channel allows in an hour
#: (``ChannelAdapter.max_agent_replies_per_hour``, email's loop guard).
REASON_REPLY_LIMIT = "reply_limit_reached"
# Reasons on a ``held_window`` row.
#: Not attempted: the window had closed before the row was claimed (or the
#: provider said so for this row or an earlier one).
REASON_WINDOW_CLOSED = "window_closed"
#: Reclaimed from ``sending`` (a crash mid-send) after the window closed: an
#: earlier attempt may have reached the customer.
REASON_WINDOW_CLOSED_MAYBE_SENT = "window_closed_maybe_sent"
# Reasons on hub rows.
#: A request older than the envelope's 72 h without a receipt.
REASON_EXPIRED_72H = "expired_72h"
#: Held on the receiving deployment for 7 days without being picked up.
REASON_HELD_EXPIRED = "held_expired"
#: Already forwarded when this deployment's identity key was replaced: the
#: target may have it, and nothing signed by the old key can follow it.
REASON_KEY_REVOKED = "key_revoked"
#: The hub channel was turned off while the row was waiting.
REASON_CHANNEL_DISABLED = "channel_disabled"
#: Closed by ``rollback_schema_v5``: version-4 code could never finish it.
REASON_SCHEMA_ROLLBACK = "schema_rollback"
# Why a hub row is parked (kept in ``reason`` while it waits).
WAIT_DEPLOYMENT_OFFLINE = "deployment_offline"
WAIT_HUB_UNREACHABLE = "hub_unreachable"
WAIT_RATE_LIMITED = "rate_limited"
#: The hub mode is discover_only: nothing is relayed until it is full again.
WAIT_BROWSE_ONLY = "browse_only"

THREAD_CREATING = "creating"
THREAD_LIVE = "live"

# Request states. At most one request per sender is open (pending or allowing).
REQUEST_PENDING = "pending"     # waiting for the owner; messages are held
REQUEST_ALLOWING = "allowing"   # Allow has begun (intent written); finished by whoever gets there
REQUEST_ALLOWED = "allowed"
REQUEST_BLOCKED = "blocked"
OPEN_REQUEST_STATES = (REQUEST_PENDING, REQUEST_ALLOWING)

# Why a request was allowed. Only the owner's own Allow writes an allow entry.
ALLOWED_BY_OWNER = "owner"
ALLOWED_BY_ENTRY = "entry"      # an allowlist entry the owner added matches the sender
ALLOWED_BY_ANYONE = "anyone"    # the sender wrote again while the mode was "anyone"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    secret_ciphertext BLOB NOT NULL,
    secret_last4 TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'allowlist',
    fixed_reply TEXT NOT NULL DEFAULT '',
    external_id TEXT,
    account_name TEXT NOT NULL DEFAULT '',
    disabled INTEGER NOT NULL DEFAULT 0,
    status TEXT,
    status_detail TEXT,
    status_count INTEGER,
    status_at REAL,
    key_rotation_pending INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    last_inbound_at REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS connections_one_per_account
    ON connections (channel, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    provider_user_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at REAL NOT NULL,
    UNIQUE (connection_id, provider_user_key)
);
CREATE TABLE IF NOT EXISTS threads (
    connection_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    project_id TEXT NOT NULL UNIQUE,
    project_name TEXT NOT NULL,
    state TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    outbox_cursor INTEGER NOT NULL DEFAULT 0,
    replaced_project_id TEXT,
    created_at REAL NOT NULL,
    PRIMARY KEY (connection_id, conversation_key)
);
CREATE TABLE IF NOT EXISTS inbound_events (
    connection_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    received_at REAL NOT NULL,
    PRIMARY KEY (connection_id, event_id)
);
CREATE TABLE IF NOT EXISTS inbound_buffer (
    message_id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    text TEXT NOT NULL,
    received_at REAL NOT NULL,
    flush_after REAL NOT NULL,
    flush_base_version INTEGER,
    flushed INTEGER NOT NULL DEFAULT 0,
    dispatch INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS inbound_buffer_unflushed
    ON inbound_buffer (connection_id, conversation_key, flushed);
CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'reply',
    project_id TEXT,
    message_id TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    retry_key TEXT NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at REAL NOT NULL,
    claimed_by TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    from_agent INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, message_id, part_index)
);
CREATE INDEX IF NOT EXISTS outbox_claimable ON outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS outbox_conversation
    ON outbox (connection_id, conversation_key, state);
CREATE TABLE IF NOT EXISTS allow_entries (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    pinned_user_key TEXT,
    created_at REAL NOT NULL,
    UNIQUE (connection_id, kind, value)
);
CREATE TABLE IF NOT EXISTS blocks (
    connection_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (connection_id, user_key)
);
CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    handle TEXT,
    contact_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    first_text TEXT NOT NULL,
    state TEXT NOT NULL,
    held_count INTEGER NOT NULL DEFAULT 0,
    dropped_count INTEGER NOT NULL DEFAULT 0,
    unverified_count INTEGER NOT NULL DEFAULT 0,
    fixed_reply_outbox_id TEXT,
    allowed_by TEXT,
    allow_plan TEXT,
    created_at REAL NOT NULL,
    decided_at REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS requests_one_open
    ON requests (connection_id, user_key) WHERE state IN ('pending', 'allowing');
CREATE TABLE IF NOT EXISTS held_messages (
    message_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    text TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    received_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS held_messages_request ON held_messages (request_id);
CREATE TABLE IF NOT EXISTS rate_hits (
    connection_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    admitted INTEGER NOT NULL,
    at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_hits_window ON rate_hits (connection_id, at);
CREATE TABLE IF NOT EXISTS email_threads (
    connection_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    user_key TEXT NOT NULL,
    agent_address TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    last_message_id TEXT,
    references_chain TEXT NOT NULL DEFAULT '[]',
    updated_at REAL NOT NULL,
    PRIMARY KEY (connection_id, conversation_key)
);
CREATE TABLE IF NOT EXISTS connection_extras (
    connection_id TEXT PRIMARY KEY,
    ack_text TEXT NOT NULL DEFAULT '',
    unverified_calls INTEGER NOT NULL DEFAULT 0,
    quota_type TEXT,
    quota_limit INTEGER,
    quota_usage INTEGER,
    quota_fetched_at REAL,
    quota_attempted_at REAL,
    quota_exhausted_at REAL
);
CREATE TABLE IF NOT EXISTS conversation_windows (
    connection_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    last_user_message_at REAL NOT NULL,
    last_received_at REAL NOT NULL DEFAULT 0,
    provider_closed_at REAL,
    PRIMARY KEY (connection_id, conversation_key)
);
CREATE TABLE IF NOT EXISTS removed_threads (
    project_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    removed_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS removed_threads_owner ON removed_threads (owner_id);
CREATE TABLE IF NOT EXISTS email_message_ids (
    connection_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (connection_id, user_key, message_id)
);
CREATE TABLE IF NOT EXISTS webchat_grants (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'site',
    label TEXT NOT NULL DEFAULT '',
    key_hash TEXT NOT NULL UNIQUE,
    key_ciphertext BLOB NOT NULL,
    key_prefix TEXT NOT NULL,
    origins TEXT NOT NULL DEFAULT '[]',
    created_at REAL NOT NULL,
    revoked_at REAL
);
CREATE INDEX IF NOT EXISTS webchat_grants_connection ON webchat_grants (connection_id);
CREATE TABLE IF NOT EXISTS webchat_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    retry_key TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS webchat_messages_visitor
    ON webchat_messages (connection_id, visitor_id, seq);
CREATE INDEX IF NOT EXISTS outbox_message ON outbox (connection_id, message_id);
""" + f"""
CREATE TABLE IF NOT EXISTS hub_registration (
    hub_url TEXT PRIMARY KEY,
    deployment_id TEXT,
    name TEXT,
    label TEXT NOT NULL DEFAULT '',
    public_url TEXT,
    status TEXT NOT NULL DEFAULT 'none'
        CHECK (status IN ('none', 'pending_email', 'active', 'suspended', 'held_for_reclaim')),
    genesis_fp TEXT,
    current_fp TEXT,
    identity_connection_id TEXT,
    contact_email_hash TEXT,
    reporter_secret_ciphertext BLOB NOT NULL,
    statement TEXT,
    statement_purpose TEXT
        CHECK (statement_purpose IS NULL OR statement_purpose = '{Purpose.STATEMENT.value}'),
    hub_link TEXT NOT NULL DEFAULT 'off'
        CHECK (hub_link IN ('connected', 'unreachable', 'untrusted', 'off')),
    last_connected_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    CHECK ((statement IS NULL) = (statement_purpose IS NULL))
);
CREATE TABLE IF NOT EXISTS hub_trusted_keys (
    hub_url TEXT NOT NULL,
    kid TEXT NOT NULL,
    pubkey BLOB NOT NULL CHECK (length(pubkey) = 32),
    not_before INTEGER NOT NULL,
    not_after INTEGER NOT NULL CHECK (not_after > not_before),
    source TEXT NOT NULL CHECK (source IN ('pinned', 'configured', 'key_set')),
    accepted_via TEXT,
    accepted_at REAL NOT NULL,
    PRIMARY KEY (hub_url, kid),
    CHECK ((source = 'key_set') = (accepted_via IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS hub_sends (
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (user_id, project_id, client_message_id)
);
CREATE TABLE IF NOT EXISTS hub_pins (
    fingerprint TEXT PRIMARY KEY,
    genesis_fp TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq >= 0),
    prev_fp TEXT,
    pubkey BLOB NOT NULL CHECK (length(pubkey) = 32),
    rotation TEXT,
    rotation_purpose TEXT
        CHECK (rotation_purpose IS NULL OR rotation_purpose = '{Purpose.KEY_ROTATE.value}'),
    rotation_ts INTEGER,
    deployment_id TEXT,
    deployment_name TEXT,
    first_seen_at REAL NOT NULL,
    revoked_at REAL,
    identity_changed_at REAL,
    UNIQUE (genesis_fp, seq),
    CHECK ((seq = 0) = (prev_fp IS NULL)),
    CHECK ((seq = 0) = (rotation IS NULL)),
    CHECK ((rotation IS NULL) = (rotation_purpose IS NULL))
);
CREATE INDEX IF NOT EXISTS hub_pins_deployment ON hub_pins (deployment_id);
CREATE TABLE IF NOT EXISTS hub_blocked_deployments (
    scope TEXT NOT NULL,
    genesis_fp TEXT NOT NULL,
    deployment_name TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    PRIMARY KEY (scope, genesis_fp)
);
CREATE TABLE IF NOT EXISTS remote_agents (
    id TEXT PRIMARY KEY,
    genesis_fp TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    current_fp TEXT,
    deployment_id TEXT,
    deployment_name TEXT NOT NULL,
    display TEXT NOT NULL,
    cert TEXT,
    cert_purpose TEXT
        CHECK (cert_purpose IS NULL OR cert_purpose = '{Purpose.AGENT_CERT.value}'),
    cert_serial TEXT,
    cert_not_after INTEGER,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE (genesis_fp, agent_name),
    CHECK (id = genesis_fp || '~' || agent_name),
    CHECK ((cert IS NULL) = (cert_purpose IS NULL))
);
CREATE TABLE IF NOT EXISTS hub_threads (
    project_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_thread_key TEXT NOT NULL,
    stand_in_id TEXT NOT NULL,
    genesis_fp TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    created_at REAL NOT NULL,
    closed_reason TEXT CHECK (closed_reason IS NULL OR closed_reason IN (
        'agent_unlisted', 'key_revoked', 'deployment_suspended', 'conversation_closed',
        'hub_off_on_server', 'identity_changed')),
    closed_at REAL,
    drain_until REAL,
    UNIQUE (user_id, client_thread_key),
    CHECK (stand_in_id = genesis_fp || '~' || agent_name),
    CHECK ((closed_reason IS NULL) = (closed_at IS NULL)),
    CHECK (drain_until IS NULL OR closed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS hub_threads_stand_in ON hub_threads (stand_in_id);
CREATE TABLE IF NOT EXISTS hub_send_windows (
    window_key TEXT NOT NULL,          -- e.g. agent:<id>:hour, user:<id>:target:<ref>:10min
    window_start REAL NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (window_key, window_start)
);
CREATE INDEX IF NOT EXISTS hub_threads_root ON hub_threads (genesis_fp);
CREATE TABLE IF NOT EXISTS hub_channels (
    agent_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    connection_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'off' CHECK (status IN (
        'off', 'enabling', 'connected', 'hub_unreachable', 'key_revoked', 'key_rotation_pending',
        'hub_cannot_reach_deployment', 'rejected', 'hub_off_on_server', 'agent_not_public',
        'hub_untrusted', 'hub_not_registered')),
    status_detail TEXT,
    reject_reason TEXT,
    enable_request_id TEXT,
    cert TEXT,
    cert_purpose TEXT
        CHECK (cert_purpose IS NULL OR cert_purpose = '{Purpose.AGENT_CERT.value}'),
    cert_serial TEXT,
    cert_not_after INTEGER,
    rotate_by REAL,
    last_success_at REAL,
    next_retry_at REAL,
    disabled_at REAL,
    stop_now INTEGER NOT NULL DEFAULT 0,
    unregister_pending INTEGER NOT NULL DEFAULT 0,
    daily_run_cap INTEGER NOT NULL DEFAULT 200 CHECK (daily_run_cap >= 0),
    runs_today INTEGER NOT NULL DEFAULT 0 CHECK (runs_today >= 0),
    runs_reset_at REAL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    CHECK ((cert IS NULL) = (cert_purpose IS NULL))
);
CREATE TABLE IF NOT EXISTS hub_dispatch_counts (
    agent_id TEXT NOT NULL,            -- hub-dispatched asks accepted for this agent
    day TEXT NOT NULL,                 -- local date, YYYY-MM-DD
    count INTEGER NOT NULL CHECK (count >= 0),
    PRIMARY KEY (agent_id, day)
);
CREATE TABLE IF NOT EXISTS hub_directory_cache (
    kind TEXT NOT NULL CHECK (kind IN ('search', 'agent')),
    cache_key TEXT NOT NULL,
    body TEXT NOT NULL,
    cached_at REAL NOT NULL,
    PRIMARY KEY (kind, cache_key)
);
CREATE TABLE IF NOT EXISTS hub_sender_via_agent (
    connection_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    via_agent TEXT,
    sent_at REAL NOT NULL,
    PRIMARY KEY (connection_id, user_key)
);
CREATE TABLE IF NOT EXISTS hub_retained (
    user_id TEXT NOT NULL,
    stand_in_id TEXT NOT NULL,
    retained_at REAL NOT NULL,
    state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'unlisted', 'identity_changed')),
    description TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (user_id, stand_in_id)
);
CREATE INDEX IF NOT EXISTS hub_retained_stand_in ON hub_retained (stand_in_id);
CREATE TABLE IF NOT EXISTS local_retained (
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    retained_at REAL NOT NULL,
    PRIMARY KEY (user_id, agent_id)
);
CREATE INDEX IF NOT EXISTS local_retained_agent ON local_retained (agent_id);
CREATE TABLE IF NOT EXISTS hub_bridge_relays (
    room_project_id TEXT NOT NULL,
    room TEXT NOT NULL,
    room_message_id TEXT NOT NULL,
    stand_in_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    thread_project_id TEXT,
    hub_message_id TEXT,
    state TEXT NOT NULL,
    reason TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (room_message_id, stand_in_id)
);
CREATE INDEX IF NOT EXISTS hub_bridge_relays_room ON hub_bridge_relays (room_project_id, room);
CREATE INDEX IF NOT EXISTS hub_bridge_relays_hub_message ON hub_bridge_relays (hub_message_id);
CREATE TABLE IF NOT EXISTS hub_avatar_cache (
    hub_agent_id TEXT NOT NULL,
    refreshed_at INTEGER NOT NULL,
    png BLOB,
    refusal TEXT,
    created_at REAL NOT NULL,
    PRIMARY KEY (hub_agent_id, refreshed_at),
    CHECK ((png IS NULL) != (refusal IS NULL))
);
CREATE TABLE IF NOT EXISTS hub_owners (
    hub_url TEXT NOT NULL,
    user_id TEXT NOT NULL,
    owner_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('code_sent', 'verified', 'banned')),
    -- The code goes out with the deployment's own registration (one code
    -- activates both): verified when that registration is.
    via_registration INTEGER NOT NULL DEFAULT 0,
    email_hash TEXT,
    code_sent_at REAL,
    verified_at REAL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (hub_url, user_id)
);
"""


class ChannelConnection(BaseModel):
    """One agent's connection to one channel. Never carries the secret.

    The decrypted credential is only ever returned by
    :meth:`ChannelStore.load_secret`, as a ``SecretStr``, so neither this
    model's ``repr`` nor an API response can contain it.
    """

    model_config = {"frozen": True}

    id: str
    agent_id: str
    owner_id: str
    channel: str
    label: str
    secret_last4: str
    mode: str = access.MODE_ALLOWLIST
    fixed_reply: str = ""
    #: The provider account this connection speaks as (Telegram's bot id). One
    #: connection per account across ALL owners: Telegram keeps one webhook per
    #: bot, so a second connection would silently take it from the first.
    external_id: Optional[str] = None
    account_name: str = ""          # e.g. the bot's @username, for display
    disabled: bool = False
    #: The last health check's code (see ``gateway.STATUS_*``), when it ran,
    #: and its text detail / count (Telegram's last error message, pending updates).
    status: Optional[str] = None
    status_detail: Optional[str] = None
    status_count: Optional[int] = None
    status_at: Optional[float] = None
    #: A webhook call verified only under an older secret key: the webhook
    #: must be registered again under the current one.
    key_rotation_pending: bool = False
    created_at: float
    #: When the provider last delivered a message for this connection (email:
    #: the practical proof that MX and Inbound Parse work).
    last_inbound_at: Optional[float] = None


class ChannelContact(BaseModel):
    model_config = {"frozen": True}

    id: str                 # contact:<uuid> — the message sender id
    connection_id: str
    provider_user_key: str  # the provider's own user id; never leaves the store
    display_name: str       # cleaned on arrival (contacts.clean_display_name)


class ChannelThread(BaseModel):
    """The conversation → Front Desk thread mapping (one per conversation).

    ``paused`` lives here, not on the project, so it survives the project
    being deleted and the mapping being pointed at a fresh one.
    """

    model_config = {"frozen": True}

    connection_id: str
    conversation_key: str
    contact_id: str
    project_id: str
    project_name: str
    state: str
    paused: bool
    outbox_cursor: int
    replaced_project_id: Optional[str]


class OwnedThread(BaseModel):
    """A live channel thread as its owner's sidebar sees it. ``contact_id`` is
    the opaque ``contacts.id``, never a provider identifier."""

    model_config = {"frozen": True}

    project_id: str
    channel: str
    connection_id: str
    connection_enabled: bool
    contact_id: str
    contact_name: str
    paused: bool


class RemovedThread(BaseModel):
    """The history record of a thread whose connection was removed."""

    model_config = {"frozen": True}

    project_id: str
    owner_id: str
    channel: str
    contact_name: str
    removed_at: float


@dataclass(frozen=True)
class BufferedMessage:
    message_id: str
    connection_id: str
    conversation_key: str
    event_id: str
    contact_id: str
    display_name: str
    text: str
    received_at: float
    flush_after: float
    flush_base_version: Optional[int]
    #: False for automatic mail (an out-of-office): kept in the thread for the
    #: owner, never addressed to the agent.
    dispatch: bool = True


@dataclass(frozen=True)
class OutboxRow:
    id: str
    connection_id: str
    conversation_key: str
    kind: str
    project_id: Optional[str]   # None for a fixed reply
    message_id: str             # a fixed reply's is its request id
    part_index: int
    retry_key: str
    text: str
    state: str
    reason: Optional[str]
    attempts: int
    next_attempt_at: float
    created_at: float
    from_agent: bool = False
    #: The provider's own words for the last failure, bounded and redacted by
    #: the adapter (``AdapterError.detail``); shown to the owner beside the
    #: fixed ``reason``, never logged. None when the provider said nothing.
    detail: Optional[str] = None
    # Hub rows only (see "Hub rows" in the module docstring).
    receipt_due_at: Optional[float] = None
    parked_until: Optional[float] = None
    forwarded_at: Optional[float] = None
    relay_count: int = 0
    probe_due_at: Optional[float] = None
    last_receipt: Optional[str] = None
    delivery_detail: Optional[str] = None
    retry_at: Optional[float] = None
    delivered_late: bool = False
    envelope: Optional[str] = None
    envelope_purpose: Optional[str] = None
    #: When the row last changed (a hub delivery's ``state_at``).
    updated_at: float = 0.0


@dataclass(frozen=True)
class ConnectionExtras:
    """See "Per-connection extras" in the module docstring."""

    ack_text: str = ""
    #: Webhook calls refused by ``verify`` since the last verified one.
    unverified_calls: int = 0
    #: The provider's quota at the last fetch: ``limited`` (with a limit) or
    #: ``none``; None before any fetch. ``quota_usage`` is the provider's own
    #: usage figure then, ``quota_fetched_at`` when it was fetched.
    quota_type: Optional[str] = None
    quota_limit: Optional[int] = None
    quota_usage: Optional[int] = None
    quota_fetched_at: Optional[float] = None
    #: When a fetch was last tried, whether or not it succeeded.
    quota_attempted_at: Optional[float] = None
    #: When LINE last answered a push with its monthly limit; None once a push
    #: succeeds or a fetch finds the quota month has turned.
    quota_exhausted_at: Optional[float] = None
    #: When the provider's subscription check (WhatsApp's GET handshake) last
    #: got the challenge back.
    handshake_ok_at: Optional[float] = None
    #: The last four characters of a second shown credential (WhatsApp's
    #: verify token); "" when there is none.
    verify_token_last4: Optional[str] = None
    #: When the provider last refused a push outright (LINE's 403: the plan
    #: does not allow push); None once a push succeeds.
    push_refused_at: Optional[float] = None
    #: Automatic mail dropped because its sender has no conversation with the
    #: agent (capped at ``MAX_AUTOMATIC_DROPPED``), and the last one's time,
    #: sender domain and signal (``email_mail.AUTO_*``). Nothing else of it is kept.
    automatic_dropped: int = 0
    automatic_dropped_at: Optional[float] = None
    automatic_dropped_domain: Optional[str] = None
    automatic_dropped_reason: Optional[str] = None


@dataclass(frozen=True)
class ConversationWindow:
    """See "Customer-service windows" in the module docstring."""

    last_user_message_at: float
    #: Our clock when the newest message was recorded: what clears "window
    #: closed" on the thread (a hold before it is history, not news).
    last_received_at: float = 0.0
    provider_closed_at: Optional[float] = None


@dataclass(frozen=True)
class EmailThreadState:
    """What an email reply in one conversation is sent with."""

    connection_id: str
    conversation_key: str
    user_key: str               # the contact's From: address; the only recipient
    agent_address: str          # our address: the From: of every reply
    subject: str                # the latest inbound subject
    last_message_id: Optional[str]
    references: list[str]


@dataclass(frozen=True)
class OutboundUnit:
    """One message the outbox scan found, before it becomes rows: one per
    part, already formatted for the channel (``ChannelAdapter.format_parts``)."""

    message_id: str
    parts: list[str]
    created_at: float  # the message's own timestamp — what the 24 h rule measures
    from_agent: bool = False  # the agent's reply (held, not sent, if its thread is paused)
    failed_reason: Optional[str] = None  # set → one ``failed`` row with this reason, no parts


@dataclass(frozen=True)
class AllowEntry:
    id: str
    connection_id: str
    kind: str
    value: str
    pinned_user_key: Optional[str]
    created_at: float


@dataclass(frozen=True)
class AllowPlanItem:
    """One conversation an Allow writes into: its combined message's id is fixed
    when Allow begins, and the changelog tip is recorded just before the append,
    so a retried Allow finds the message it already wrote instead of writing it
    again (the same adoption rule as the burst flush)."""

    conversation_key: str
    message_id: str
    base_version: Optional[int] = None


@dataclass(frozen=True)
class ChannelRequest:
    id: str
    connection_id: str
    user_key: str               # the stable provider id; shown to the owner only
    handle: Optional[str]
    contact_id: str
    display_name: str
    first_text: str
    state: str
    held_count: int
    dropped_count: int
    unverified_count: int       # held messages whose sender check did not pass
    fixed_reply_outbox_id: Optional[str]
    allowed_by: Optional[str]
    allow_plan: list[AllowPlanItem]
    created_at: float
    decided_at: Optional[float]


@dataclass(frozen=True)
class HeldMessage:
    message_id: str
    request_id: str
    connection_id: str
    conversation_key: str
    event_id: str
    text: str
    truncated: bool
    received_at: float


class Outcome(str, Enum):
    """What the inbound transaction decided for one provider event."""

    DUPLICATE = "duplicate"         # already recorded
    BUFFERED = "buffered"           # goes to the agent (burst buffer)
    HELD = "held"                   # kept in the sender's Request
    DROPPED_BLOCKED = "blocked"
    DROPPED_RATE_LIMITED = "rate_limited"
    DROPPED_CAP = "held_cap"        # the Request already holds its maximum
    DROPPED_REQUESTS_FULL = "requests_full"  # too many pending Requests on the connection
    DROPPED_UNVERIFIED = "unverified"  # failed the sender check while its Request is being allowed
    DROPPED_AUTOMATIC = "automatic"  # automatic mail from a sender the agent doesn't already talk to
    #: Refused before any access rule ran (``accept_inbound``'s ``refuse``):
    #: the hub channel is off or the agent takes no requests now.
    NOT_ACCEPTING = "not_accepting"


#: Where an accepted event is now (``inbound_events.current_state``), the
#: values a hub duplicate answers with: buffered for the agent, held in a
#: Request, or appended to the thread for the agent.
EVENT_ACCEPTED = "accepted"
EVENT_HELD_FOR_APPROVAL = "held_for_approval"
EVENT_PICKED_UP = "picked_up"
#: A hub message accepted while its agent's runner was offline: in the thread,
#: not yet with the agent. The flush leaves it; the runner's return moves it
#: to ``picked_up`` (``HubAdapter.agent_connected``).
EVENT_HELD_AGENT_OFFLINE = "held_agent_offline"
#: A hub message accepted while its agent's runner was connected but could not
#: run it isolated (its isolation check failed): in the thread, held by the
#: isolation gate. Answered ``held_agent_offline`` with detail
#: ``isolation_unavailable``; a capable runner's connect moves it to
#: ``picked_up`` like the offline case.
EVENT_HELD_ISOLATION = "held_isolation"

#: Decides, inside the inbound transaction, whether a NEW Request may be
#: opened: ``(db, pending Requests on the connection)`` -> a refusal detail
#: (stored as ``not_accepting``) or None. The hub's pending-Requests fill rule.
RequestGate = Callable[[sqlite3.Connection, int], Optional[str]]
#: Runs inside the accept transaction just before a message is buffered for
#: the agent; a returned detail refuses it (stored ``not_accepting``) instead.
AcceptGate = Callable[[sqlite3.Connection], Optional[str]]


@dataclass(frozen=True)
class StoredOutcome:
    """What was decided for an event the first time, as stored with its
    dedupe key: the outcome, its detail (a refusal's), and where the message
    is now (None for an event that was dropped)."""

    outcome: str
    detail: Optional[str]
    current_state: Optional[str]


@dataclass(frozen=True)
class InboundLimits:
    held_per_request: int
    held_text_bytes: int
    pending_requests: int
    rate_window_seconds: float
    rate_per_sender: int
    rate_per_connection: int


@dataclass(frozen=True)
class InboundDecision:
    outcome: Outcome
    #: Set when this message began an Allow (the sender is admitted now and had
    #: a pending Request): the flush must finish that Allow first.
    allowing_request_id: Optional[str] = None
    #: Set on the message that hit the rate limit first in its window (log once).
    first_over_limit: bool = False
    #: On a ``DUPLICATE``: what was decided the first time. None for a key
    #: stored before version 5, which recorded no outcome.
    original: Optional[StoredOutcome] = None


@dataclass(frozen=True)
class WebchatGrant:
    """One embeddable widget key (never carries the key itself: see
    :meth:`ChannelStore.grant_key`). ``kind`` is always ``site`` now; rows
    written as ``playground`` behave the same (a key listing this server)."""

    id: str
    connection_id: str
    kind: str
    label: str
    key_prefix: str
    origins: tuple[str, ...]
    created_at: float
    revoked_at: Optional[float] = None


@dataclass(frozen=True)
class WebchatMessage:
    seq: int
    text: str
    created_at: float


class DuplicateConnection(Exception):
    """The provider account (``external_id``) already has a connection."""


class SchemaMismatch(RuntimeError):
    """``channels.db`` was written by another schema version."""

    def __init__(self, found: int) -> None:
        super().__init__(f"channels.db schema version {found}, expected {SCHEMA_VERSION}")
        self.found = found


def _marks(values: tuple) -> str:
    """``?, ?, ...`` for an ``IN`` over ``values``."""
    return ", ".join("?" * len(values))


def _last4(secret: str) -> str:
    return secret[-4:] if len(secret) >= 8 else ""


def cut_text(text: str, max_bytes: int) -> tuple[str, bool]:
    """``text`` cut to at most ``max_bytes`` of UTF-8, never mid-character."""
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text, False
    return raw[:max_bytes].decode("utf-8", errors="ignore"), True


_CONNECTION_COLUMNS = (
    "id, agent_id, owner_id, channel, label, secret_last4, mode, fixed_reply, external_id,"
    " account_name, disabled, status, status_detail, status_count, status_at,"
    " key_rotation_pending, created_at, last_inbound_at"
)
_OUTBOX_COLUMNS = (
    "id, connection_id, conversation_key, kind, project_id, message_id, part_index,"
    " retry_key, text, state, reason, attempts, next_attempt_at, created_at, from_agent,"
    " detail, receipt_due_at, parked_until, forwarded_at, relay_count, probe_due_at,"
    " last_receipt, delivery_detail, retry_at, delivered_late, envelope, envelope_purpose,"
    " updated_at"
)


def _outbox_row(row: sqlite3.Row) -> "OutboxRow":
    data = dict(row)
    data["delivered_late"] = bool(data["delivered_late"])
    return OutboxRow(**data)
#: How many References ids a reply carries (the root is always kept first).
MAX_REFERENCES = 20


class ChannelStore:
    """The gateway's SQLite file. Opened by ``create_app`` whether or not the
    kill switch is on: the message write paths ask it whether a project is a
    channel thread (to mark outbound messages and honour pause), and that
    question needs no key. Only the credential methods need the ``MultiFernet``.
    """

    def __init__(self, data_dir: Path) -> None:
        self._path = data_dir / "channels" / "channels.db"
        self._conn: Optional[sqlite3.Connection] = None
        #: Crash-point hook for tests: called with a point name INSIDE a
        #: transaction; raising there rolls the transaction back, which is what
        #: a process dying at that point leaves behind. A no-op in production.
        self.hook: Callable[[str], None] = lambda _point: None

    # ── connection plumbing ──────────────────────────────────────────────

    def _db(self) -> sqlite3.Connection:
        if self._conn is None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self._path, isolation_level=None)
            conn.row_factory = sqlite3.Row
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            empty = conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0
            known = version == SCHEMA_VERSION or (version == 0 and empty) or version in _MIGRATIONS
            if not known:
                conn.close()
                raise SchemaMismatch(version)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=FULL")
            if version in _MIGRATIONS:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    for statement in _MIGRATIONS[version]:
                        conn.execute(statement)
                    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                except BaseException:
                    conn.execute("ROLLBACK")
                    conn.close()
                    raise
                conn.execute("COMMIT")
            conn.executescript(_SCHEMA)
            for table, columns in _ADDED_COLUMNS.items():
                present = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
                for column, kind in columns.items():
                    if column not in present:
                        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
            conn.executescript(_POST_COLUMN_SCHEMA)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            self._conn = conn
        return self._conn

    def check_schema(self) -> None:
        """Raise :class:`SchemaMismatch` if the file on disk is another version
        (a missing file is fine: it is created at this version)."""
        self._db()

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        """One transaction: committed on a clean exit, rolled back on any raise."""
        db = self._db()
        db.execute("BEGIN IMMEDIATE")
        try:
            yield db
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")

    def exists(self) -> bool:
        return self._conn is not None or self._path.exists()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    # ── connections + secrets ────────────────────────────────────────────

    def create_connection(
        self, *, agent_id: str, owner_id: str, channel: str, label: str,
        secret: str, fernet: MultiFernet, now: float,
        external_id: Optional[str] = None, account_name: str = "",
        secret_last4: Optional[str] = None, ack_text: Optional[str] = None,
    ) -> ChannelConnection:
        """Raises :class:`DuplicateConnection` when ``external_id`` (the
        provider account) already has a connection, whoever owns it.

        An empty ``secret`` (email: the server's own SendGrid key sends) is
        stored as NO ciphertext at all, so there is nothing of the connection's
        to decrypt and a key rotation cannot affect it.

        ``secret_last4`` overrides what is shown of a credential that is not a
        single token (LINE's stored blob holds two; only the access token's last
        four are ever shown). ``ack_text`` starts the connection's extras row."""
        conn_id = uuid.uuid4().hex
        token = fernet.encrypt(secret.encode("utf-8")) if secret else b""
        with self._tx() as db:
            if external_id is not None and db.execute(
                "SELECT 1 FROM connections WHERE channel = ? AND external_id = ?",
                (channel, external_id),
            ).fetchone():
                raise DuplicateConnection()
            db.execute(
                "INSERT INTO connections (id, agent_id, owner_id, channel, label,"
                " secret_ciphertext, secret_last4, external_id, account_name, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (conn_id, agent_id, owner_id, channel, label, token,
                 _last4(secret) if secret_last4 is None else secret_last4,
                 external_id, account_name, now),
            )
            if ack_text is not None:
                db.execute(
                    "INSERT INTO connection_extras (connection_id, ack_text) VALUES (?,?)",
                    (conn_id, ack_text),
                )
        connection = self.get_connection(conn_id)
        assert connection is not None
        return connection

    def get_connection(self, connection_id: str) -> Optional[ChannelConnection]:
        row = self._db().execute(
            f"SELECT {_CONNECTION_COLUMNS} FROM connections WHERE id = ?", (connection_id,),
        ).fetchone()
        return ChannelConnection(**dict(row)) if row else None

    def list_connections(self, owner_id: str) -> list[ChannelConnection]:
        rows = self._db().execute(
            f"SELECT {_CONNECTION_COLUMNS} FROM connections WHERE owner_id = ?"
            " ORDER BY created_at", (owner_id,),
        ).fetchall()
        return [ChannelConnection(**dict(r)) for r in rows]

    # ── per-connection extras ────────────────────────────────────────────

    def extras(self, connection_id: str) -> ConnectionExtras:
        row = self._db().execute(
            "SELECT ack_text, unverified_calls, quota_type, quota_limit, quota_usage,"
            " quota_fetched_at, quota_attempted_at, quota_exhausted_at, handshake_ok_at,"
            " verify_token_last4, push_refused_at, automatic_dropped, automatic_dropped_at,"
            " automatic_dropped_domain, automatic_dropped_reason"
            " FROM connection_extras WHERE connection_id = ?",
            (connection_id,),
        ).fetchone()
        return ConnectionExtras(**dict(row)) if row else ConnectionExtras()

    def _ensure_extras(self, db: sqlite3.Connection, connection_id: str) -> None:
        db.execute(
            "INSERT OR IGNORE INTO connection_extras (connection_id) SELECT id FROM connections"
            " WHERE id = ?", (connection_id,),
        )

    def set_ack_text(self, connection_id: str, text: str) -> None:
        with self._tx() as db:
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET ack_text = ? WHERE connection_id = ?",
                (text, connection_id),
            )

    def set_verify_token_last4(self, connection_id: str, last4: str) -> None:
        with self._tx() as db:
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET verify_token_last4 = ? WHERE connection_id = ?",
                (last4, connection_id),
            )

    def note_handshake(self, connection_id: str, now: float) -> None:
        """The provider's subscription check got its challenge back. Nothing
        else is written: the check is not a delivery (``last_inbound_at``
        stays as it was)."""
        with self._tx() as db:
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET handshake_ok_at = ? WHERE connection_id = ?",
                (now, connection_id),
            )

    # ── customer-service windows ─────────────────────────────────────────

    def note_user_message(
        self, db: sqlite3.Connection, *, connection_id: str, conversation_key: str, at: float,
        now: float,
    ) -> None:
        """Move the conversation's window clock forward to ``at`` (never back:
        a late redelivery of an older message can't shorten the window). Runs
        inside the caller's transaction — the inbound one, so the clock and the
        message's dedupe key commit together."""
        db.execute(
            "INSERT INTO conversation_windows (connection_id, conversation_key,"
            " last_user_message_at, last_received_at) VALUES (?,?,?,?)"
            " ON CONFLICT (connection_id, conversation_key) DO UPDATE SET"
            " last_user_message_at = MAX(last_user_message_at, excluded.last_user_message_at),"
            " last_received_at = MAX(last_received_at, excluded.last_received_at)",
            (connection_id, conversation_key, at, now),
        )

    def window(self, connection_id: str, conversation_key: str) -> Optional[ConversationWindow]:
        row = self._db().execute(
            "SELECT last_user_message_at, last_received_at, provider_closed_at"
            " FROM conversation_windows"
            " WHERE connection_id = ? AND conversation_key = ?",
            (connection_id, conversation_key),
        ).fetchone()
        return ConversationWindow(**dict(row)) if row else None

    def note_provider_closed(self, connection_id: str, conversation_key: str, now: float) -> None:
        """The provider refused a send as outside the window."""
        with self._tx() as db:
            db.execute(
                "INSERT INTO conversation_windows (connection_id, conversation_key,"
                " last_user_message_at, provider_closed_at) VALUES (?,?,0,?)"
                " ON CONFLICT (connection_id, conversation_key) DO UPDATE SET"
                " provider_closed_at = excluded.provider_closed_at",
                (connection_id, conversation_key, now),
            )

    def held_for_window(
        self, connection_id: str, conversation_key: str, *, since: float,
    ) -> list[tuple[OutboxRow, float]]:
        """Rows of this conversation held because the window had closed, that
        ended at or after ``since`` (the customer's last message), each with
        when it was held."""
        rows = self._db().execute(
            f"SELECT {_OUTBOX_COLUMNS} FROM outbox WHERE connection_id = ?"
            " AND conversation_key = ? AND state = ? AND updated_at >= ?"
            " ORDER BY created_at, part_index",
            (connection_id, conversation_key, HELD_WINDOW, since),
        ).fetchall()
        out = []
        for r in rows:
            data = dict(r)
            held_at = data["updated_at"]
            data["delivered_late"] = bool(data["delivered_late"])
            out.append((OutboxRow(**data), held_at))
        return out

    def held_window_count(self, connection_id: str, *, since: float) -> int:
        """Rows of this connection held for a closed window since ``since``."""
        return self._db().execute(
            "SELECT COUNT(*) FROM outbox WHERE connection_id = ? AND state = ?"
            " AND updated_at >= ?", (connection_id, HELD_WINDOW, since),
        ).fetchone()[0]

    def note_webhook_verified(self, connection_id: str, verified: bool) -> None:
        """Count a webhook call that failed the signature check, or reset the
        count on one that passed (written only when it changes). The count
        stops at ``MAX_UNVERIFIED_CALLS``: past it a refused call costs a read
        and no write."""
        if not verified and self.extras(connection_id).unverified_calls >= MAX_UNVERIFIED_CALLS:
            return
        with self._tx() as db:
            if verified:
                db.execute(
                    "UPDATE connection_extras SET unverified_calls = 0"
                    " WHERE connection_id = ? AND unverified_calls != 0", (connection_id,),
                )
                return
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET unverified_calls = unverified_calls + 1"
                " WHERE connection_id = ?", (connection_id,),
            )

    def note_automatic_dropped(
        self, connection_id: str, *, domain: str, reason: str, now: float,
    ) -> None:
        """Count one dropped automatic mail and remember the last one's time,
        sender domain and signal, so the owner can see that mail arrived and
        was not answered (a provider's "verify your sender" mail, a bounce)."""
        with self._tx() as db:
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET automatic_dropped = MIN(automatic_dropped + 1, ?),"
                " automatic_dropped_at = ?, automatic_dropped_domain = ?,"
                " automatic_dropped_reason = ? WHERE connection_id = ?",
                (MAX_AUTOMATIC_DROPPED, now, domain, reason, connection_id),
            )

    def note_delivery(self, connection_id: str, now: float) -> None:
        """A verified webhook call reached us: what "last webhook received"
        on the card shows."""
        with self._tx() as db:
            db.execute(
                "UPDATE connections SET last_inbound_at = ? WHERE id = ?", (now, connection_id),
            )

    def set_quota(
        self, connection_id: str, *, quota_type: str, limit: Optional[int],
        usage: Optional[int], now: float,
    ) -> None:
        with self._tx() as db:
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET quota_type = ?, quota_limit = ?, quota_usage = ?,"
                " quota_fetched_at = ? WHERE connection_id = ?",
                (quota_type, limit, usage, now, connection_id),
            )

    def note_quota_attempt(self, connection_id: str, now: float) -> None:
        with self._tx() as db:
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET quota_attempted_at = ? WHERE connection_id = ?",
                (now, connection_id),
            )

    def set_quota_exhausted(self, connection_id: str, at: Optional[float]) -> None:
        """Record LINE's monthly-limit answer (``at``), or clear it (None;
        written only when set)."""
        with self._tx() as db:
            if at is None:
                db.execute(
                    "UPDATE connection_extras SET quota_exhausted_at = NULL"
                    " WHERE connection_id = ? AND quota_exhausted_at IS NOT NULL",
                    (connection_id,),
                )
                return
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET quota_exhausted_at = ? WHERE connection_id = ?",
                (at, connection_id),
            )

    def set_push_refused(self, connection_id: str, at: Optional[float]) -> None:
        """Record the provider's refusal of a push (``at``), or clear it (None;
        written only when set)."""
        with self._tx() as db:
            if at is None:
                db.execute(
                    "UPDATE connection_extras SET push_refused_at = NULL"
                    " WHERE connection_id = ? AND push_refused_at IS NOT NULL",
                    (connection_id,),
                )
                return
            self._ensure_extras(db, connection_id)
            db.execute(
                "UPDATE connection_extras SET push_refused_at = ? WHERE connection_id = ?",
                (at, connection_id),
            )

    def pushes_sent_between(self, connection_id: str, start: float, end: float) -> int:
        """Outbox rows of this connection that ended ``sent`` in ``(start, end]``:
        what a push-metered channel (LINE) has used. Every row is one message
        (one part); a row reaches ``sent`` once (``finish``), so a re-send that
        the provider answered "already accepted" counts once. The outbox is
        never pruned, so the count survives a restart."""
        return self._db().execute(
            "SELECT COUNT(*) FROM outbox WHERE connection_id = ? AND state = ?"
            " AND kind IN (?, ?) AND updated_at > ? AND updated_at <= ?",
            (connection_id, SENT, KIND_REPLY, KIND_FIXED_REPLY, start, end),
        ).fetchone()[0]

    def has_earlier_unflushed(self, connection_id: str, conversation_key: str) -> bool:
        """Whether this conversation's burst already had a message before the
        latest one (more than one unflushed buffer row)."""
        return self._db().execute(
            "SELECT COUNT(*) FROM inbound_buffer WHERE connection_id = ?"
            " AND conversation_key = ? AND flushed = 0", (connection_id, conversation_key),
        ).fetchone()[0] > 1

    def set_fixed_reply(self, connection_id: str, text: str) -> None:
        with self._tx() as db:
            db.execute(
                "UPDATE connections SET fixed_reply = ? WHERE id = ?", (text, connection_id),
            )

    def set_disabled(self, connection_id: str, disabled: bool) -> None:
        with self._tx() as db:
            db.execute(
                "UPDATE connections SET disabled = ? WHERE id = ?", (int(disabled), connection_id),
            )

    def set_status(
        self, connection_id: str, status: Optional[str], *, now: float,
        detail: Optional[str] = None, count: Optional[int] = None,
    ) -> None:
        with self._tx() as db:
            db.execute(
                "UPDATE connections SET status = ?, status_detail = ?, status_count = ?,"
                " status_at = ? WHERE id = ?", (status, detail, count, now, connection_id),
            )

    def set_key_rotation_pending(self, connection_id: str, pending: bool) -> None:
        with self._tx() as db:
            db.execute(
                "UPDATE connections SET key_rotation_pending = ? WHERE id = ?",
                (int(pending), connection_id),
            )

    def remove_connection(self, connection_id: str, *, now: float) -> bool:
        """Remove a connection, ONE commit: the connection and its encrypted
        credential; its allowlist (pins included), Requests with their held
        messages, blocks, contacts, rate counts, dedupe keys, unflushed buffer
        and thread mappings; and every outbox row still waiting (``parked`` and
        ``awaiting_receipt`` included) ends ``failed`` with
        ``connection_removed``; for email also the threading state and the
        Message-ID index (so reconnecting the same agent starts fresh threads);
        for the hub the deployments this connection blocked.

        The threads' projects are not touched: they stay as history the owner
        can read. Without the mapping nothing posted there afterwards is sent
        anywhere. Each mapped project gets a ``removed_threads`` row (owner,
        channel, the contact's name as it was) in the same commit, so the
        sidebar keeps its badge and contact. An Allow that is already running
        finds its Request gone and stops (``finish_allow``).
        """
        with self._tx() as db:
            connection = db.execute(
                "SELECT owner_id, channel FROM connections WHERE id = ?", (connection_id,),
            ).fetchone()
            if connection is None:
                return False
            db.execute(
                "INSERT OR REPLACE INTO removed_threads"
                " (project_id, owner_id, channel, contact_name, removed_at)"
                " SELECT t.project_id, ?, ?, COALESCE(c.display_name, ''), ?"
                " FROM threads t LEFT JOIN contacts c ON c.id = t.contact_id"
                " WHERE t.connection_id = ? AND t.state = ?",
                (connection["owner_id"], connection["channel"], now, connection_id, THREAD_LIVE),
            )
            db.execute("DELETE FROM connections WHERE id = ?", (connection_id,))
            self.hook("remove.after_connection_deleted")
            db.execute(
                "UPDATE outbox SET state = ?, reason = ?, updated_at = ?"
                f" WHERE connection_id = ? AND state IN ({_marks(OPEN_STATES)})",
                (FAILED, REASON_CONNECTION_REMOVED, now, connection_id, *OPEN_STATES),
            )
            db.execute("DELETE FROM hub_blocked_deployments WHERE scope = ?", (connection_id,))
            for table in ("allow_entries", "blocks", "held_messages", "requests", "contacts",
                          "rate_hits", "inbound_events", "inbound_buffer", "threads",
                          "email_threads", "email_message_ids", "connection_extras",
                          "conversation_windows", "webchat_grants", "webchat_messages",
                          "hub_sender_via_agent"):
                db.execute(f"DELETE FROM {table} WHERE connection_id = ?", (connection_id,))
        return True

    def connection_for_account(self, channel: str, external_id: str) -> Optional[ChannelConnection]:
        row = self._db().execute(
            f"SELECT {_CONNECTION_COLUMNS} FROM connections WHERE channel = ? AND external_id = ?",
            (channel, external_id),
        ).fetchone()
        return ChannelConnection(**dict(row)) if row else None

    def load_secret(self, connection_id: str, fernet: MultiFernet) -> SecretStr:
        row = self._db().execute(
            "SELECT secret_ciphertext FROM connections WHERE id = ?", (connection_id,),
        ).fetchone()
        if row is None:
            raise KeyError(connection_id)
        if not row["secret_ciphertext"]:
            return SecretStr("")  # a connection with no credential of its own (email)
        return SecretStr(fernet.decrypt(row["secret_ciphertext"]).decode("utf-8"))

    def rotate_secrets(self, fernet: MultiFernet) -> int:
        """Re-encrypt every credential with the first key; returns the count.

        Run after putting a new key first in ``CLAWMEETS_CHANNEL_SECRET_KEY``;
        once it has run, the old key can be dropped from the list. Covers the
        connection credentials, the widget keys and the hub reporter secret.
        """
        with self._tx() as db:
            rows = db.execute(
                "SELECT id, secret_ciphertext FROM connections WHERE length(secret_ciphertext) > 0",
            ).fetchall()
            for row in rows:
                db.execute(
                    "UPDATE connections SET secret_ciphertext = ? WHERE id = ?",
                    (fernet.rotate(row["secret_ciphertext"]), row["id"]),
                )
            grants = db.execute("SELECT id, key_ciphertext FROM webchat_grants").fetchall()
            for row in grants:
                db.execute(
                    "UPDATE webchat_grants SET key_ciphertext = ? WHERE id = ?",
                    (fernet.rotate(row["key_ciphertext"]), row["id"]),
                )
            hubs = db.execute(
                "SELECT hub_url, reporter_secret_ciphertext FROM hub_registration",
            ).fetchall()
            for row in hubs:
                db.execute(
                    "UPDATE hub_registration SET reporter_secret_ciphertext = ? WHERE hub_url = ?",
                    (fernet.rotate(row["reporter_secret_ciphertext"]), row["hub_url"]),
                )
        return len(rows) + len(grants) + len(hubs)

    # ── contacts ─────────────────────────────────────────────────────────

    def upsert_contact(
        self, db: sqlite3.Connection, *, connection_id: str, provider_user_key: str,
        display_name: str, now: float,
    ) -> ChannelContact:
        """Find or create the contact, refreshing its display name. Runs inside
        the caller's transaction (the inbound one)."""
        row = db.execute(
            "SELECT id FROM contacts WHERE connection_id = ? AND provider_user_key = ?",
            (connection_id, provider_user_key),
        ).fetchone()
        if row is None:
            contact_id = make_contact_id(str(uuid.uuid4()))
            db.execute(
                "INSERT INTO contacts (id, connection_id, provider_user_key, display_name,"
                " created_at) VALUES (?,?,?,?,?)",
                (contact_id, connection_id, provider_user_key, display_name, now),
            )
        else:
            contact_id = row["id"]
            db.execute(
                "UPDATE contacts SET display_name = ? WHERE id = ?", (display_name, contact_id),
            )
        return ChannelContact(
            id=contact_id, connection_id=connection_id,
            provider_user_key=provider_user_key, display_name=display_name,
        )

    def get_contact(self, contact_id: str) -> Optional[ChannelContact]:
        row = self._db().execute(
            "SELECT id, connection_id, provider_user_key, display_name FROM contacts"
            " WHERE id = ?", (contact_id,),
        ).fetchone()
        return ChannelContact(**dict(row)) if row else None

    def contact_name(self, connection_id: str, provider_user_key: str) -> Optional[str]:
        """The stored display name of a contact, or None if never seen."""
        row = self._db().execute(
            "SELECT display_name FROM contacts WHERE connection_id = ? AND provider_user_key = ?",
            (connection_id, provider_user_key),
        ).fetchone()
        return row["display_name"] if row else None

    def rename_contact(
        self, *, connection_id: str, provider_user_key: str, display_name: str, replacing: str,
    ) -> bool:
        """Replace a stand-in name (``replacing``) with a looked-up one (LINE's
        profile) on the contact, its Requests and its not-yet-flushed messages.
        A row whose name is no longer the stand-in is left alone. False when
        the contact is unknown or no longer has the stand-in."""
        with self._tx() as db:
            row = db.execute(
                "SELECT id FROM contacts WHERE connection_id = ? AND provider_user_key = ?"
                " AND display_name = ?", (connection_id, provider_user_key, replacing),
            ).fetchone()
            if row is None:
                return False
            contact_id = row["id"]
            db.execute(
                "UPDATE contacts SET display_name = ? WHERE id = ?", (display_name, contact_id),
            )
            db.execute(
                "UPDATE requests SET display_name = ? WHERE contact_id = ? AND display_name = ?",
                (display_name, contact_id, replacing),
            )
            db.execute(
                "UPDATE inbound_buffer SET display_name = ? WHERE contact_id = ? AND flushed = 0"
                " AND display_name = ?", (display_name, contact_id, replacing),
            )
        return True

    # ── inbound: dedupe + the access decision (ONE transaction) ──────────

    def accept_inbound(
        self, *, connection_id: str, event_id: str, conversation_key: str,
        user_key: str, handle: Optional[str], display_name: str, text: str,
        verdict: Optional[str], verified: bool, limits: InboundLimits,
        now: float, flush_after: float,
        render: Callable[[str], list[str]] = lambda text: [text],
        dispatch: bool = True,
        on_accept: Optional[Callable[[sqlite3.Connection], None]] = None,
        on_kept: Optional[Callable[[sqlite3.Connection], None]] = None,
        refuse: Optional[tuple[Outcome, Optional[str]]] = None,
        request_gate: Optional[RequestGate] = None,
        accept_gate: Optional[AcceptGate] = None,
    ) -> InboundDecision:
        """Record one provider event and decide what happens to it.

        One commit holds the dedupe key AND the decision — a buffer row, a held
        message (creating the sender's Request, and enqueueing its fixed reply
        together with the mark that says it was sent), or nothing (dropped). So
        a redelivery is only ever a duplicate of an event whose outcome is
        durable, and two messages from one unknown sender — even in two
        conversations — cannot both create a Request or both get the fixed
        reply: there is no ``await`` between reading the access state and
        writing the result, and the partial unique index on open Requests backs
        that up.

        Precedence: block > allowlist entry > mode. A sender whose Request is
        already being allowed is admitted if the message passed the sender
        check, and dropped if not. A message that failed the sender check is
        held, and a pending Request holding one is never allowed by a later
        message (only by the owner). Rate limits
        apply in "anyone" mode to senders no entry admits.

        The message id is minted here (``uuid4``), stored on the row and read
        from it at flush, so a provider reusing an event id after the dedupe key
        was pruned produces a second message, not a collision.

        ``render`` turns the fixed reply into the channel's parts (the
        adapter's ``format_parts``); pure, so it is safe inside the transaction.

        ``dispatch=False`` (automatic mail): kept in the thread for the owner
        but never addressed to the agent, and never the start of anything — a
        sender no entry or mode admits, or one with a pending Request, is
        dropped (no Request, no fixed reply, no Allow).

        ``on_accept`` runs inside this transaction right after the dedupe key is
        written, whatever is decided (WhatsApp's window clock, email's "last
        mail received"). ``on_kept`` runs inside it only when the message is
        kept — buffered or held — or answered by the fixed reply, before
        anything is enqueued (email: the thread's reply state and Message-ID
        index, which the fixed reply's own Message-ID is indexed against).

        The decision is stored with the dedupe key (``outcome``,
        ``outcome_detail``, ``current_state``), and a redelivery is answered
        ``DUPLICATE`` carrying it (``InboundDecision.original``), so the hub can
        tell a re-relaying sender what happened the first time. ``refuse`` is a
        decision made before the store (a blocked deployment, a hub channel
        that is off): stored with the dedupe key, and nothing else runs.
        ``request_gate`` may refuse a message that would open a new Request
        (stored ``not_accepting`` with the gate's detail); ``accept_gate``, a
        message about to be buffered for the agent (the hub's daily run cap is
        claimed there, and its channel re-read, in this same commit).
        """
        message_id = str(uuid.uuid4())
        with self._tx() as db:
            cur = db.execute(
                "INSERT OR IGNORE INTO inbound_events (connection_id, event_id, received_at)"
                " VALUES (?,?,?)", (connection_id, event_id, now),
            )
            if cur.rowcount == 0:
                stored = db.execute(
                    "SELECT outcome, outcome_detail, current_state FROM inbound_events"
                    " WHERE connection_id = ? AND event_id = ?", (connection_id, event_id),
                ).fetchone()
                original = None
                if stored is not None and stored["outcome"] is not None:
                    original = StoredOutcome(
                        stored["outcome"], stored["outcome_detail"], stored["current_state"],
                    )
                return InboundDecision(Outcome.DUPLICATE, original=original)
            self.hook("inbound.after_dedupe_insert")

            def decided(decision: InboundDecision, detail: Optional[str] = None) -> InboundDecision:
                return self._decided(db, connection_id, event_id, decision, detail=detail)

            if refuse is not None:
                return decided(InboundDecision(refuse[0]), detail=refuse[1])
            if on_accept is not None:
                on_accept(db)
            conn_row = db.execute(
                "SELECT mode, fixed_reply FROM connections WHERE id = ?", (connection_id,),
            ).fetchone()
            if db.execute(
                "SELECT 1 FROM blocks WHERE connection_id = ? AND user_key = ?",
                (connection_id, user_key),
            ).fetchone():
                return decided(InboundDecision(Outcome.DROPPED_BLOCKED))
            request = self._open_request(db, connection_id, user_key)

            # A message that failed the sender check (a forged email under this
            # address) goes to the address's Request and never changes how the
            # address's verified mail is treated: the real sender's next
            # message goes to the agent on its own, and a Request holding a
            # forgery is never allowed by it — only by the owner, who sees the
            # sender marked unconfirmed.
            allowed_by: Optional[str] = None
            if request is not None and request.state == REQUEST_ALLOWING:
                if not verified:
                    # The owner decided on what they saw; a forged message
                    # arriving before that Allow finishes is neither carried
                    # to the agent nor added to a Request already decided.
                    return decided(InboundDecision(Outcome.DROPPED_UNVERIFIED))
                allowed_by = request.allowed_by
            elif verified and self._admitted_by_entry(db, connection_id, user_key, handle, verdict):
                allowed_by = ALLOWED_BY_ENTRY
            elif verified and conn_row["mode"] == access.MODE_ANYONE:
                # An unverified sender (a failed email check) is unknown even
                # in "anyone" mode: replies to a forged From: would be backscatter.
                over, first_over = self._rate_limited(db, connection_id, user_key, limits, now)
                if over:
                    return decided(InboundDecision(
                        Outcome.DROPPED_RATE_LIMITED, first_over_limit=first_over,
                    ))
                allowed_by = ALLOWED_BY_ANYONE

            if not dispatch and (
                allowed_by is None or (request is not None and request.state == REQUEST_PENDING)
            ):
                return decided(InboundDecision(Outcome.DROPPED_AUTOMATIC))

            if allowed_by is not None:
                if accept_gate is not None:
                    refusal = accept_gate(db)
                    if refusal is not None:
                        return decided(InboundDecision(Outcome.NOT_ACCEPTING), detail=refusal)
                if on_kept is not None:
                    on_kept(db)
                contact = self.upsert_contact(
                    db, connection_id=connection_id, provider_user_key=user_key,
                    display_name=display_name, now=now,
                )
                allowing_id = None
                if request is not None and request.state == REQUEST_ALLOWING:
                    allowing_id = request.id
                elif request is not None and request.unverified_count == 0:
                    self._begin_allow(db, request, allowed_by, now)
                    allowing_id = request.id
                db.execute(
                    "INSERT INTO inbound_buffer (message_id, connection_id, conversation_key,"
                    " event_id, contact_id, display_name, text, received_at, flush_after,"
                    " dispatch) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (message_id, connection_id, conversation_key, event_id, contact.id,
                     display_name, text, now, flush_after, int(dispatch)),
                )
                return decided(InboundDecision(Outcome.BUFFERED, allowing_request_id=allowing_id))

            # An unknown sender: their Request.
            held_text, truncated = cut_text(text, limits.held_text_bytes)
            if request is None:
                pending = db.execute(
                    "SELECT COUNT(*) FROM requests WHERE connection_id = ? AND state = ?",
                    (connection_id, REQUEST_PENDING),
                ).fetchone()[0]
                if request_gate is not None:
                    refusal = request_gate(db, pending)
                    if refusal is not None:
                        return decided(InboundDecision(Outcome.NOT_ACCEPTING), detail=refusal)
                if pending >= limits.pending_requests:
                    return decided(InboundDecision(Outcome.DROPPED_REQUESTS_FULL))
                contact = self.upsert_contact(
                    db, connection_id=connection_id, provider_user_key=user_key,
                    display_name=display_name, now=now,
                )
                request_id = uuid.uuid4().hex
                db.execute(
                    "INSERT INTO requests (id, connection_id, user_key, handle, contact_id,"
                    " display_name, first_text, state, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (request_id, connection_id, user_key, access.normalize_handle(handle),
                     contact.id, display_name, held_text, REQUEST_PENDING, now),
                )
                request = self._request(db, request_id)
            else:
                self.upsert_contact(
                    db, connection_id=connection_id, provider_user_key=user_key,
                    display_name=display_name, now=now,
                )
                db.execute(
                    "UPDATE requests SET display_name = ?, handle = ? WHERE id = ?",
                    (display_name, access.normalize_handle(handle), request.id),
                )
            assert request is not None

            if request.held_count >= limits.held_per_request:
                # The first messages are kept (the Request shows the first one);
                # later ones are dropped and counted.
                db.execute(
                    "UPDATE requests SET dropped_count = dropped_count + 1 WHERE id = ?",
                    (request.id,),
                )
                outcome = Outcome.DROPPED_CAP
            else:
                db.execute(
                    "INSERT INTO held_messages (message_id, request_id, connection_id,"
                    " conversation_key, event_id, text, truncated, received_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (message_id, request.id, connection_id, conversation_key, event_id,
                     held_text, int(truncated), now),
                )
                db.execute(
                    "UPDATE requests SET held_count = held_count + 1,"
                    " unverified_count = unverified_count + ? WHERE id = ?",
                    (0 if verified else 1, request.id),
                )
                outcome = Outcome.HELD

            # The fixed reply: once per Request, and only to a sender whose
            # address we can trust (a forged email From: gets nothing). The
            # mark is set in this commit, together with the enqueue, and only
            # when something was enqueued — a sender who wrote while the reply
            # was empty gets it on their next message once the owner sets one.
            reply = conn_row["fixed_reply"]
            parts = render(reply) if reply.strip() else []
            answer = request.fixed_reply_outbox_id is None and verified and bool(parts)
            if on_kept is not None and (outcome == Outcome.HELD or answer):
                on_kept(db)
            if answer:
                row_id = uuid.uuid4().hex
                for index, part in enumerate(parts):
                    db.execute(
                        "INSERT INTO outbox (id, connection_id, conversation_key, kind,"
                        " project_id, message_id, part_index, retry_key, text, state, attempts,"
                        " next_attempt_at, created_at, updated_at)"
                        " VALUES (?,?,?,?,NULL,?,?,?,?,?,0,?,?,?)",
                        (row_id if index == 0 else uuid.uuid4().hex, connection_id,
                         conversation_key, KIND_FIXED_REPLY, request.id, index,
                         f"{row_id}:{index}", part, PENDING, now, now, now),
                    )
                    self._index_outbound(db, connection_id, conversation_key, f"{row_id}:{index}", now)
                self.hook("request.fixed_reply_enqueued")
                db.execute(
                    "UPDATE requests SET fixed_reply_outbox_id = ? WHERE id = ?",
                    (row_id, request.id),
                )
            return decided(InboundDecision(outcome))

    def _decided(
        self, db: sqlite3.Connection, connection_id: str, event_id: str,
        decision: InboundDecision, *, detail: Optional[str] = None,
    ) -> InboundDecision:
        """Store ``decision`` with its event's dedupe key (inside the same
        transaction) and return it. A kept message is ``accepted`` (buffered)
        or ``held_for_approval`` (in a Request); a dropped one has no state."""
        current = {
            Outcome.BUFFERED: EVENT_ACCEPTED, Outcome.HELD: EVENT_HELD_FOR_APPROVAL,
        }.get(decision.outcome)
        db.execute(
            "UPDATE inbound_events SET outcome = ?, outcome_detail = ?, current_state = ?"
            " WHERE connection_id = ? AND event_id = ?",
            (decision.outcome.value, detail, current, connection_id, event_id),
        )
        return decision

    def set_event_state(self, connection_id: str, event_ids: list[str], current_state: str) -> None:
        """Move the stored ``current_state`` of kept events (one never set,
        a dropped event's, stays empty)."""
        with self._tx() as db:
            db.executemany(
                "UPDATE inbound_events SET current_state = ? WHERE connection_id = ?"
                " AND event_id = ? AND current_state IS NOT NULL",
                [(current_state, connection_id, e) for e in event_ids],
            )

    def record_event(
        self, connection_id: str, event_id: str, *, outcome: str, current_state: Optional[str], now: float,
    ) -> Optional[StoredOutcome]:
        """Store an event id with its outcome, once: None the first time, the
        outcome stored then on every repeat (the hub requester side's reply
        dedupe, kept as long as every other dedupe key)."""
        with self._tx() as db:
            cur = db.execute(
                "INSERT OR IGNORE INTO inbound_events (connection_id, event_id, received_at, outcome,"
                " current_state) VALUES (?,?,?,?,?)", (connection_id, event_id, now, outcome, current_state),
            )
            if cur.rowcount == 1:
                return None
            row = db.execute(
                "SELECT outcome, outcome_detail, current_state FROM inbound_events"
                " WHERE connection_id = ? AND event_id = ?", (connection_id, event_id),
            ).fetchone()
        return StoredOutcome(row["outcome"] or outcome, row["outcome_detail"], row["current_state"])

    def forget_event(self, connection_id: str, event_id: str) -> None:
        """Undo ``record_event`` when what it guarded did not happen."""
        with self._tx() as db:
            db.execute("DELETE FROM inbound_events WHERE connection_id = ? AND event_id = ?",
                       (connection_id, event_id))

    def events_in_state(self, connection_id: str, current_state: str) -> list[str]:
        """The event ids of one connection whose message is ``current_state``."""
        return [r[0] for r in self._db().execute(
            "SELECT event_id FROM inbound_events WHERE connection_id = ? AND current_state = ?"
            " ORDER BY received_at", (connection_id, current_state),
        )]

    def latest_event_id(self, connection_id: str, conversation_key: str) -> Optional[str]:
        """The newest buffered event of one conversation (what a reply answers)."""
        row = self._db().execute(
            "SELECT event_id FROM inbound_buffer WHERE connection_id = ? AND conversation_key = ?"
            " ORDER BY received_at DESC, rowid DESC LIMIT 1", (connection_id, conversation_key),
        ).fetchone()
        return row[0] if row is not None else None

    @property
    def directory(self) -> Path:
        """The folder ``channels.db`` lives in (staging space beside it)."""
        return self._path.parent

    def stored_outcome(self, connection_id: str, event_id: str) -> Optional[StoredOutcome]:
        row = self._db().execute(
            "SELECT outcome, outcome_detail, current_state FROM inbound_events"
            " WHERE connection_id = ? AND event_id = ?", (connection_id, event_id),
        ).fetchone()
        if row is None or row["outcome"] is None:
            return None
        return StoredOutcome(row["outcome"], row["outcome_detail"], row["current_state"])

    def _admitted_by_entry(
        self, db: sqlite3.Connection, connection_id: str, user_key: str,
        handle: Optional[str], verdict: Optional[str],
    ) -> bool:
        """Whether an allowlist entry admits this (verified) sender. Pins an
        unpinned ``@username`` entry to them on the way — compare-and-set, so a
        pin is never overwritten."""
        rows = db.execute(
            "SELECT kind, value FROM allow_entries WHERE connection_id = ? AND kind != ?",
            (connection_id, access.USERNAME),
        ).fetchall()
        admitted = any(
            access.entry_matches(r["kind"], r["value"], user_key=user_key, verdict=verdict)
            for r in rows
        )
        # A pinned username entry matches its numeric id only, whatever the
        # sender is called now.
        if db.execute(
            "SELECT 1 FROM allow_entries WHERE connection_id = ? AND kind = ?"
            " AND pinned_user_key = ?", (connection_id, access.USERNAME, user_key),
        ).fetchone():
            admitted = True
        name = access.normalize_handle(handle)
        if name is not None:
            candidates = db.execute(
                "SELECT id FROM allow_entries WHERE connection_id = ? AND kind = ? AND value = ?"
                " AND (pinned_user_key IS NULL OR pinned_user_key != ?)",
                (connection_id, access.USERNAME, name, user_key),
            ).fetchall()
            for row in candidates:
                self.hook("allow.before_pin")
                cur = db.execute(
                    "UPDATE allow_entries SET pinned_user_key = ?"
                    " WHERE id = ? AND pinned_user_key IS NULL", (user_key, row["id"]),
                )
                if cur.rowcount:
                    admitted = True
        return admitted

    def _rate_limited(
        self, db: sqlite3.Connection, connection_id: str, user_key: str,
        limits: InboundLimits, now: float,
    ) -> tuple[bool, bool]:
        """Count this message against both windows; (over the limit, first drop
        of this sender in the window). Every message counts toward its sender's
        window, dropped ones included, so a flooder stays limited; only admitted
        ones count toward the connection's, so one flooder cannot use up
        everybody's allowance."""
        since = now - limits.rate_window_seconds
        sender_hits, sender_drops = db.execute(
            "SELECT COUNT(*), COALESCE(SUM(1 - admitted), 0) FROM rate_hits"
            " WHERE connection_id = ? AND user_key = ? AND at > ?",
            (connection_id, user_key, since),
        ).fetchone()
        connection_hits = db.execute(
            "SELECT COUNT(*) FROM rate_hits WHERE connection_id = ? AND admitted = 1 AND at > ?",
            (connection_id, since),
        ).fetchone()[0]
        over = (sender_hits >= limits.rate_per_sender
                or connection_hits >= limits.rate_per_connection)
        db.execute(
            "INSERT INTO rate_hits (connection_id, user_key, admitted, at) VALUES (?,?,?,?)",
            (connection_id, user_key, 0 if over else 1, now),
        )
        return over, over and sender_drops == 0

    def unflushed(self, connection_id: str, conversation_key: str) -> list[BufferedMessage]:
        rows = self._db().execute(
            "SELECT message_id, connection_id, conversation_key, event_id, contact_id,"
            " display_name, text, received_at, flush_after, flush_base_version, dispatch"
            " FROM inbound_buffer WHERE connection_id = ? AND conversation_key = ?"
            " AND flushed = 0 ORDER BY received_at, rowid",
            (connection_id, conversation_key),
        ).fetchall()
        return [BufferedMessage(**{**dict(r), "dispatch": bool(r["dispatch"])}) for r in rows]

    def conversations_with_unflushed(self) -> list[tuple[str, str]]:
        rows = self._db().execute(
            "SELECT DISTINCT connection_id, conversation_key FROM inbound_buffer"
            " WHERE flushed = 0",
        ).fetchall()
        return [(r["connection_id"], r["conversation_key"]) for r in rows]

    def overdue_unflushed(self, now: float) -> list[tuple[str, str]]:
        """Conversations whose burst window has closed and still have
        unflushed rows — what the flush-retry sweep reschedules."""
        rows = self._db().execute(
            "SELECT connection_id, conversation_key FROM inbound_buffer WHERE flushed = 0"
            " GROUP BY connection_id, conversation_key HAVING MAX(flush_after) <= ?",
            (now,),
        ).fetchall()
        return [(r["connection_id"], r["conversation_key"]) for r in rows]

    def message_ids_for_event(self, connection_id: str, event_id: str) -> list[str]:
        rows = self._db().execute(
            "SELECT message_id FROM inbound_buffer WHERE connection_id = ? AND event_id = ?"
            " ORDER BY received_at, rowid", (connection_id, event_id),
        ).fetchall()
        return [r["message_id"] for r in rows]

    def set_flush_base(self, message_ids: list[str], version: int) -> None:
        """Record the changelog tip just before these rows are appended, so a
        flush interrupted after the append finds them by id instead of
        appending them again."""
        with self._tx() as db:
            db.executemany(
                "UPDATE inbound_buffer SET flush_base_version = ? WHERE message_id = ?",
                [(version, mid) for mid in message_ids],
            )

    def mark_flushed(
        self, message_ids: list[str], *, connection_id: str, conversation_key: str,
        clear_replaced: bool = False,
    ) -> None:
        """The rows are in the thread: flushed, and their events ``picked_up``."""
        with self._tx() as db:
            db.executemany(
                "UPDATE inbound_buffer SET flushed = 1 WHERE message_id = ?",
                [(mid,) for mid in message_ids],
            )
            db.executemany(
                "UPDATE inbound_events SET current_state = ? WHERE current_state IS NOT NULL"
                " AND current_state NOT IN (?, ?) AND (connection_id, event_id) IN"
                " (SELECT connection_id, event_id FROM inbound_buffer WHERE message_id = ?)",
                [(EVENT_PICKED_UP, EVENT_HELD_AGENT_OFFLINE, EVENT_HELD_ISOLATION, mid)
                 for mid in message_ids],
            )
            if clear_replaced:
                db.execute(
                    "UPDATE threads SET replaced_project_id = NULL"
                    " WHERE connection_id = ? AND conversation_key = ?",
                    (connection_id, conversation_key),
                )

    def prune(self, *, older_than: float, rate_older_than: Optional[float] = None) -> int:
        """Retention: dedupe keys, flushed buffer rows, widget mailbox rows and
        the browser's hub send keys (``hub_sends``) older than the cutoff, and
        rate-limit hits older than their window.

        Providers redeliver for hours, not weeks, so a key older than the
        retention window can no longer suppress a real duplicate — unless its
        message is still waiting (unflushed, or held in a Request, which can
        wait for weeks): those keys stay, or a late redelivery would become a
        second copy. Held messages themselves are never pruned; they leave only
        through Allow or Block.
        """
        with self._tx() as db:
            n = db.execute(
                "DELETE FROM inbound_events WHERE received_at < ?"
                " AND NOT EXISTS (SELECT 1 FROM inbound_buffer b"
                "   WHERE b.connection_id = inbound_events.connection_id"
                "   AND b.event_id = inbound_events.event_id AND b.flushed = 0)"
                " AND NOT EXISTS (SELECT 1 FROM held_messages h"
                "   WHERE h.connection_id = inbound_events.connection_id"
                "   AND h.event_id = inbound_events.event_id)",
                (older_than,),
            ).rowcount
            db.execute(
                "DELETE FROM inbound_buffer WHERE flushed = 1 AND received_at < ?",
                (older_than,),
            )
            # A widget visitor away longer than this starts from an empty mailbox
            # (the thread itself keeps the whole conversation for the owner).
            db.execute("DELETE FROM webchat_messages WHERE created_at < ?", (older_than,))
            # A browser retrying a send after this long gets a new message id.
            db.execute("DELETE FROM hub_sends WHERE created_at < ?", (older_than,))
            if rate_older_than is not None:
                db.execute("DELETE FROM rate_hits WHERE at < ?", (rate_older_than,))
        return n

    def count_inbound_events(self) -> int:
        return self._db().execute("SELECT COUNT(*) FROM inbound_events").fetchone()[0]

    # ── threads ──────────────────────────────────────────────────────────

    def _thread_from_row(self, row: sqlite3.Row) -> ChannelThread:
        data = dict(row)
        data["paused"] = bool(data["paused"])
        data.pop("created_at", None)
        return ChannelThread(**data)

    def get_thread(self, connection_id: str, conversation_key: str) -> Optional[ChannelThread]:
        row = self._db().execute(
            "SELECT * FROM threads WHERE connection_id = ? AND conversation_key = ?",
            (connection_id, conversation_key),
        ).fetchone()
        return self._thread_from_row(row) if row else None

    def thread_for_project(self, project_id: str) -> Optional[ChannelThread]:
        """The mapping whose CURRENT project is ``project_id``, if any."""
        if not self.exists():
            return None
        try:
            db = self._db()
        except SchemaMismatch:
            # Logged when the gateway was built; the message routes must keep
            # working for every other project.
            return None
        row = db.execute(
            "SELECT * FROM threads WHERE project_id = ?", (project_id,),
        ).fetchone()
        return self._thread_from_row(row) if row else None

    def all_threads(self) -> list[ChannelThread]:
        rows = self._db().execute("SELECT * FROM threads").fetchall()
        return [self._thread_from_row(r) for r in rows]

    def claim_thread(
        self, *, connection_id: str, conversation_key: str, contact_id: str,
        project_id: str, project_name: str, now: float,
    ) -> ChannelThread:
        """Return the mapping, writing a ``creating`` one (the intent) if none.

        The intent is durable BEFORE the project exists, so a crash during
        project creation leaves a row that names the half-made project; the
        next flush completes THAT project instead of minting a second one.
        """
        with self._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO threads (connection_id, conversation_key, contact_id,"
                " project_id, project_name, state, created_at) VALUES (?,?,?,?,?,?,?)",
                (connection_id, conversation_key, contact_id, project_id, project_name,
                 THREAD_CREATING, now),
            )
        thread = self.get_thread(connection_id, conversation_key)
        assert thread is not None
        return thread

    def repoint_thread(
        self, thread: ChannelThread, *, project_id: str, project_name: str, now: float,
    ) -> ChannelThread:
        """The mapped project is gone: point the mapping at a new one, as an
        intent, and close every outbox row of the old one that has not ended
        (the waiting states included) — in one commit. Pause, contact and
        cursor reset ride along on the same row."""
        with self._tx() as db:
            db.execute(
                "UPDATE threads SET project_id = ?, project_name = ?, state = ?,"
                " outbox_cursor = 0, replaced_project_id = ?"
                " WHERE connection_id = ? AND conversation_key = ?",
                (project_id, project_name, THREAD_CREATING, thread.project_id,
                 thread.connection_id, thread.conversation_key),
            )
            db.execute(
                "UPDATE outbox SET state = ?, reason = ?, updated_at = ?"
                f" WHERE project_id = ? AND state IN ({_marks(OPEN_STATES)})",
                (EXPIRED, REASON_THREAD_GONE, now, thread.project_id, *OPEN_STATES),
            )
        fresh = self.get_thread(thread.connection_id, thread.conversation_key)
        assert fresh is not None
        return fresh

    def mark_thread_live(self, connection_id: str, conversation_key: str) -> None:
        with self._tx() as db:
            db.execute(
                "UPDATE threads SET state = ? WHERE connection_id = ? AND conversation_key = ?",
                (THREAD_LIVE, connection_id, conversation_key),
            )

    def set_paused(self, project_id: str, paused: bool) -> Optional[ChannelThread]:
        with self._tx() as db:
            db.execute(
                "UPDATE threads SET paused = ? WHERE project_id = ?", (int(paused), project_id),
            )
        return self.thread_for_project(project_id)

    def owned_threads(self, owner_id: str) -> list[OwnedThread]:
        """Every live thread on a connection ``owner_id`` owns, with its
        channel, connection state and the contact's display name."""
        rows = self._db().execute(
            "SELECT t.project_id, t.connection_id, t.contact_id, t.paused,"
            " k.channel, k.disabled, COALESCE(c.display_name, '') AS contact_name"
            " FROM threads t JOIN connections k ON k.id = t.connection_id"
            " LEFT JOIN contacts c ON c.id = t.contact_id"
            " WHERE k.owner_id = ? AND t.state = ?",
            (owner_id, THREAD_LIVE),
        ).fetchall()
        return [
            OwnedThread(
                project_id=r["project_id"], channel=r["channel"],
                connection_id=r["connection_id"], connection_enabled=not r["disabled"],
                contact_id=r["contact_id"], contact_name=r["contact_name"],
                paused=bool(r["paused"]),
            )
            for r in rows
        ]

    def removed_threads(self, owner_id: str) -> list[RemovedThread]:
        rows = self._db().execute(
            "SELECT * FROM removed_threads WHERE owner_id = ?", (owner_id,),
        ).fetchall()
        return [RemovedThread(**dict(r)) for r in rows]

    def removed_thread(self, project_id: str) -> Optional[RemovedThread]:
        """The history record of a thread whose connection was removed."""
        if not self.exists():
            return None
        try:
            db = self._db()
        except SchemaMismatch:
            return None
        row = db.execute(
            "SELECT * FROM removed_threads WHERE project_id = ?", (project_id,),
        ).fetchone()
        return RemovedThread(**dict(row)) if row else None

    def forget_removed_thread(self, project_id: str) -> None:
        """The project was deleted: its history record goes with it."""
        if not self.exists():
            return
        with self._tx() as db:
            db.execute("DELETE FROM removed_threads WHERE project_id = ?", (project_id,))

    # ── outbox ───────────────────────────────────────────────────────────

    def enqueue(self, thread: ChannelThread, units: list[OutboundUnit], *,
                cursor: int, now: float) -> int:
        """Insert outbox rows for ``units`` and advance the thread's scan cursor,
        in one commit. Re-running a scan is harmless (unique per message part).

        The retry key is fixed here, per outbound unit (row + part), and never
        derived at send time.

        Pause is judged here, when the row is inserted: an agent reply found
        while the thread is paused (the agent was already working when the
        owner took over) ends ``held_paused`` and is never sent; the owner's own
        messages still go out. A reply already ``pending`` before the pause is
        sent as usual.

        "Paused" is the flag as ``thread`` was read at the start of the pass
        **or** as it is now, inside this transaction. The pass awaits between
        reading the threads and calling here, so the owner's Pause can land in
        between: the fresh read makes that Pause win. The stale read keeps a
        reply held when the owner un-paused in that gap, since it was found
        while the owner was in charge.
        """
        inserted = 0
        with self._tx() as db:
            now_paused = db.execute(
                "SELECT paused FROM threads WHERE project_id = ?", (thread.project_id,),
            ).fetchone()
            paused = thread.paused or bool(now_paused and now_paused["paused"])
            for unit in units:
                held = paused and unit.from_agent
                if unit.failed_reason is not None:
                    row_id = uuid.uuid4().hex
                    cur = db.execute(
                        "INSERT OR IGNORE INTO outbox (id, connection_id, conversation_key,"
                        " kind, project_id, message_id, part_index, retry_key, text, state,"
                        " reason, attempts, next_attempt_at, created_at, updated_at)"
                        " VALUES (?,?,?,?,?,?,0,?,'',?,?,0,?,?,?)",
                        (row_id, thread.connection_id, thread.conversation_key, KIND_REPLY,
                         thread.project_id, unit.message_id, f"{row_id}:0", FAILED,
                         unit.failed_reason, now, unit.created_at, now),
                    )
                    inserted += cur.rowcount
                    continue
                for index, part in enumerate(unit.parts):
                    row_id = uuid.uuid4().hex
                    cur = db.execute(
                        "INSERT OR IGNORE INTO outbox (id, connection_id, conversation_key,"
                        " kind, project_id, message_id, part_index, retry_key, text, state,"
                        " reason, attempts, next_attempt_at, created_at, updated_at, from_agent)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)",
                        (row_id, thread.connection_id, thread.conversation_key, KIND_REPLY,
                         thread.project_id, unit.message_id, index, f"{row_id}:{index}", part,
                         HELD_PAUSED if held else PENDING, "paused" if held else None,
                         now, unit.created_at, now, int(unit.from_agent)),
                    )
                    inserted += cur.rowcount
                    if cur.rowcount and not held:
                        self._index_outbound(
                            db, thread.connection_id, thread.conversation_key,
                            f"{row_id}:{index}", now,
                        )
            db.execute(
                "UPDATE threads SET outbox_cursor = ? WHERE project_id = ?",
                (cursor, thread.project_id),
            )
        return inserted

    def claimable(
        self, now: float, *, stale_sending_before: float, claimer: str,
    ) -> list[OutboxRow]:
        """Rows the worker may take, oldest first:

        - ``pending`` rows that are due;
        - ``sending`` rows claimed by an earlier process (``claimer`` is this
          process's id: only a crash leaves a row ``sending`` across a
          restart), or by this one before ``stale_sending_before`` (a send is
          bounded by the adapter's timeout, so a row that old is a crashed
          attempt); a fresh one is a send still in flight and is left alone;
        - only on a connection that exists and is not disabled (a disabled
          connection's rows wait, untouched, until it is enabled again);
        - **head of line, per conversation:** never a row while an earlier row
          of the same conversation (by ``created_at``, then insertion order —
          the parts of one reply are inserted in order) is still ``pending``
          or ``sending``. Part 1 of a reply never overtakes part 0 waiting for
          a retry, nor a reply the one before it. Rows that ended (``sent``,
          ``failed``, ``expired``, ``held_paused``, ``held_window``) do not block.
          A hub row blocks while it is ``pending``, ``sending`` or ``parked``
          and has never been forwarded, so a requester's second message cannot
          overtake the first while the target is offline; once forwarded (and
          in ``awaiting_receipt``) it has left and blocks nothing. Rows of other
          channels are never forwarded or parked, so their order is unchanged.

        ``parked`` and ``awaiting_receipt`` rows are never claimed here: the
        hub's wake calls put them back to ``pending`` first.
        """
        rows = self._db().execute(
            f"SELECT {', '.join('o.' + c.strip() for c in _OUTBOX_COLUMNS.split(','))}"
            " FROM outbox o JOIN connections c ON c.id = o.connection_id AND c.disabled = 0"
            " WHERE ((o.state = ? AND o.next_attempt_at <= ?)"
            "        OR (o.state = ? AND (o.claimed_by IS NOT ? OR o.updated_at <= ?)))"
            " AND NOT EXISTS (SELECT 1 FROM outbox e"
            "   WHERE e.connection_id = o.connection_id"
            "   AND e.conversation_key = o.conversation_key"
            "   AND e.state IN (?, ?, ?) AND e.forwarded_at IS NULL"
            "   AND (e.created_at < o.created_at"
            "        OR (e.created_at = o.created_at AND e.rowid < o.rowid)))"
            " ORDER BY o.created_at, o.rowid",
            (PENDING, now, SENDING, claimer, stale_sending_before, PENDING, SENDING, PARKED),
        ).fetchall()
        return [_outbox_row(r) for r in rows]

    def mark_sending(
        self, row_id: str, now: float, *, claimer: str, count_attempt: bool = True,
    ) -> bool:
        """Claim a row for one attempt. False when it has ended meanwhile (the
        connection was removed): the caller must not send it.

        ``count_attempt=False`` claims without counting an attempt: a hub
        re-relay of the same signed envelope is not a new try at delivery."""
        with self._tx() as db:
            cur = db.execute(
                "UPDATE outbox SET state = ?, attempts = attempts + ?, updated_at = ?,"
                " claimed_by = ? WHERE id = ? AND state IN (?, ?)",
                (SENDING, int(count_attempt), now, claimer, row_id, PENDING, SENDING),
            )
        return cur.rowcount == 1

    def retry_later(
        self, row_id: str, *, at: float, reason: str, now: float, detail: Optional[str] = None,
        count_attempt: bool = False,
    ) -> None:
        """Back to ``pending`` until ``at``. ``count_attempt``: count the
        attempt now (a hub row was claimed without counting one)."""
        with self._tx() as db:
            db.execute(
                "UPDATE outbox SET state = ?, reason = ?, detail = ?, next_attempt_at = ?,"
                " attempts = attempts + ?, updated_at = ? WHERE id = ? AND state = ?",
                (PENDING, reason, detail, at, int(count_attempt), now, row_id, SENDING),
            )

    def finish(
        self, row_id: str, state: str, *, reason: Optional[str], now: float,
        detail: Optional[str] = None, never_sent: bool = False,
        delivery_detail: Optional[str] = None, retry_at: Optional[float] = None,
    ) -> bool:
        """End a row that has not ended yet (``pending``, ``sending`` or one of
        the waiting states). Conditional: a row that has already ended keeps
        its end state — a send in flight when the connection was removed can't
        turn ``connection_removed`` into ``sent``. ``delivery_detail`` and
        ``retry_at`` are a hub refusal's detail and ``retry_after`` (as a time).

        A ``failed`` part fails the LATER parts of the same reply in the same
        commit, with ``earlier_part_failed``: a failed row no longer blocks the
        head of line, so failing them in a second step would let the worker
        claim the next part in between. A ``held_window`` part holds the later
        parts the same way, with its own reason (part 1 must never go out
        after part 0 was held). Other replies are not touched.

        A row the caller says ended ``never_sent`` — no attempt was ever made
        on it, judged by the gateway on the row as it was before this claim
        (``pending`` with no attempts), so a refusal after a timed-out attempt
        that SendGrid may have accepted keeps its id — loses its email
        Message-ID in the same commit. The later parts failed with a failed
        part lose theirs too: they are never claimed before it ends."""
        assert state in TERMINAL_STATES
        with self._tx() as db:
            cur = db.execute(
                "UPDATE outbox SET state = ?, reason = ?, detail = ?, updated_at = ?,"
                " delivery_detail = COALESCE(?, delivery_detail), retry_at = COALESCE(?, retry_at),"
                " receipt_due_at = NULL, parked_until = NULL"
                f" WHERE id = ? AND state IN ({_marks(OPEN_STATES)})",
                (state, reason, detail, now, delivery_detail, retry_at, row_id, *OPEN_STATES),
            )
            if cur.rowcount == 0:
                return False
            if never_sent and state in (FAILED, EXPIRED):
                self._unindex_outbound(db, [row_id])
            if state in (FAILED, HELD_WINDOW):
                self.hook("outbox.after_part_failed")
                row = db.execute(
                    "SELECT connection_id, kind, project_id, message_id, part_index"
                    " FROM outbox WHERE id = ?", (row_id,),
                ).fetchone()
                later = REASON_EARLIER_PART_FAILED if state == FAILED else REASON_WINDOW_CLOSED
                where = (
                    " WHERE connection_id = ? AND kind = ? AND message_id = ?"
                    f" AND project_id IS ? AND part_index > ? AND state IN ({_marks(OPEN_STATES)})"
                )
                args = (row["connection_id"], row["kind"], row["message_id"], row["project_id"],
                        row["part_index"], *OPEN_STATES)
                if state == FAILED:
                    self._unindex_outbound(db, [
                        r["id"] for r in db.execute(f"SELECT id FROM outbox{where}", args)
                    ])
                db.execute(
                    f"UPDATE outbox SET state = ?, reason = ?, updated_at = ?{where}",
                    (state, later, now, *args),
                )
        return True

    def outbox_for_project(self, project_id: str) -> list[OutboxRow]:
        rows = self._db().execute(
            f"SELECT {_OUTBOX_COLUMNS} FROM outbox WHERE project_id = ? ORDER BY created_at, part_index",
            (project_id,),
        ).fetchall()
        return [_outbox_row(r) for r in rows]

    def all_outbox(self) -> list[OutboxRow]:
        rows = self._db().execute(
            f"SELECT {_OUTBOX_COLUMNS} FROM outbox ORDER BY created_at, part_index",
        ).fetchall()
        return [_outbox_row(r) for r in rows]

    def count_waiting(
        self, connection_id: str, *, conversation_prefix: Optional[str] = None,
    ) -> int:
        """Rows of a connection in a waiting state (``parked`` or
        ``awaiting_receipt``), optionally only conversations whose key starts
        with ``conversation_prefix`` (a hub conversation key starts with the
        requester deployment's genesis fingerprint)."""
        sql = (
            "SELECT COUNT(*) FROM outbox WHERE connection_id = ?"
            f" AND state IN ({_marks(WAITING_STATES)})"
        )
        args: list = [connection_id, *WAITING_STATES]
        if conversation_prefix is not None:
            sql += " AND substr(conversation_key, 1, ?) = ?"
            args += [len(conversation_prefix), conversation_prefix]
        return self._db().execute(sql, args).fetchone()[0]

    def get_outbox_row(self, row_id: str) -> Optional[OutboxRow]:
        row = self._db().execute(
            f"SELECT {_OUTBOX_COLUMNS} FROM outbox WHERE id = ?", (row_id,),
        ).fetchone()
        return _outbox_row(row) if row else None

    # ── access control: mode, allowlist, blocks ──────────────────────────

    def set_mode(self, connection_id: str, mode: str) -> None:
        """Switching modes leaves pending Requests waiting: access is judged per
        message, so a waiting sender who writes while the mode is "anyone" is
        allowed then (combined message first)."""
        assert mode in access.MODES
        with self._tx() as db:
            db.execute("UPDATE connections SET mode = ? WHERE id = ?", (mode, connection_id))

    def list_entries(self, connection_id: str) -> list[AllowEntry]:
        rows = self._db().execute(
            "SELECT id, connection_id, kind, value, pinned_user_key, created_at"
            " FROM allow_entries WHERE connection_id = ? ORDER BY created_at, rowid",
            (connection_id,),
        ).fetchall()
        return [AllowEntry(**dict(r)) for r in rows]

    def add_entry(
        self, connection_id: str, entry: access.ParsedEntry, *, now: float,
    ) -> tuple[AllowEntry, list[str]]:
        """Add an allowlist entry (an existing identical one is returned as is)
        and, in the same commit, begin Allow for every pending Request the entry
        now admits. Returns the entry and those Requests' ids.

        A ``@username`` entry pins to a waiting sender only when exactly ONE
        pending Request carries that handle: two (after a rename and a takeover)
        are ambiguous, so both keep waiting and nothing is pinned.
        """
        with self._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO allow_entries (id, connection_id, kind, value, created_at)"
                " VALUES (?,?,?,?,?)",
                (uuid.uuid4().hex, connection_id, entry.kind, entry.value, now),
            )
            row = db.execute(
                "SELECT id, connection_id, kind, value, pinned_user_key, created_at"
                " FROM allow_entries WHERE connection_id = ? AND kind = ? AND value = ?",
                (connection_id, entry.kind, entry.value),
            ).fetchone()
            pending = [
                self._request_from_row(r) for r in db.execute(
                    "SELECT * FROM requests WHERE connection_id = ? AND state = ?",
                    (connection_id, REQUEST_PENDING),
                ).fetchall()
            ]
            # Only Requests whose every held message passed the sender check:
            # an entry must not admit what it would not admit live.
            trusted = [r for r in pending if r.unverified_count == 0]
            if entry.kind == access.USERNAME:
                matching = [r for r in trusted if r.handle == entry.value]
                if row["pinned_user_key"] is None and len(matching) == 1:
                    db.execute(
                        "UPDATE allow_entries SET pinned_user_key = ?"
                        " WHERE id = ? AND pinned_user_key IS NULL",
                        (matching[0].user_key, row["id"]),
                    )
                else:
                    matching = []
            else:
                matching = [
                    r for r in trusted
                    if access.entry_matches(entry.kind, entry.value, user_key=r.user_key,
                                            verdict=access.AUTH_PASS)
                ]
            for request in matching:
                self._begin_allow(db, request, ALLOWED_BY_ENTRY, now)
            row = db.execute(
                "SELECT id, connection_id, kind, value, pinned_user_key, created_at"
                " FROM allow_entries WHERE id = ?", (row["id"],),
            ).fetchone()
        return AllowEntry(**dict(row)), [r.id for r in matching]

    def delete_entry(self, connection_id: str, entry_id: str) -> bool:
        """Deleting a ``@username`` entry drops its pin; adding it again pins afresh."""
        with self._tx() as db:
            cur = db.execute(
                "DELETE FROM allow_entries WHERE id = ? AND connection_id = ?",
                (entry_id, connection_id),
            )
        return cur.rowcount == 1

    # ── access control: the Requests queue ───────────────────────────────

    @staticmethod
    def _request_from_row(row: sqlite3.Row) -> ChannelRequest:
        data = dict(row)
        data["allow_plan"] = [AllowPlanItem(**p) for p in json.loads(data["allow_plan"] or "[]")]
        return ChannelRequest(**data)

    def _request(self, db: sqlite3.Connection, request_id: str) -> Optional[ChannelRequest]:
        row = db.execute("SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
        return self._request_from_row(row) if row else None

    def _open_request(
        self, db: sqlite3.Connection, connection_id: str, user_key: str,
    ) -> Optional[ChannelRequest]:
        row = db.execute(
            "SELECT * FROM requests WHERE connection_id = ? AND user_key = ? AND state IN (?, ?)",
            (connection_id, user_key, *OPEN_REQUEST_STATES),
        ).fetchone()
        return self._request_from_row(row) if row else None

    def get_request(self, request_id: str) -> Optional[ChannelRequest]:
        return self._request(self._db(), request_id)

    def list_requests(self, connection_id: str) -> list[ChannelRequest]:
        rows = self._db().execute(
            "SELECT * FROM requests WHERE connection_id = ? ORDER BY created_at DESC, rowid DESC",
            (connection_id,),
        ).fetchall()
        return [self._request_from_row(r) for r in rows]

    def allowing_requests(self) -> list[ChannelRequest]:
        rows = self._db().execute(
            "SELECT * FROM requests WHERE state = ?", (REQUEST_ALLOWING,),
        ).fetchall()
        return [self._request_from_row(r) for r in rows]

    def allowing_request_for(
        self, connection_id: str, contact_ids: list[str],
    ) -> Optional[ChannelRequest]:
        """The Allow in progress for any of these senders, if one is."""
        if not contact_ids:
            return None
        marks = ",".join("?" * len(contact_ids))
        row = self._db().execute(
            f"SELECT * FROM requests WHERE connection_id = ? AND state = ?"
            f" AND contact_id IN ({marks})",
            (connection_id, REQUEST_ALLOWING, *contact_ids),
        ).fetchone()
        return self._request_from_row(row) if row else None

    def held_for_request(self, request_id: str) -> list[HeldMessage]:
        rows = self._db().execute(
            "SELECT message_id, request_id, connection_id, conversation_key, event_id, text,"
            " truncated, received_at FROM held_messages WHERE request_id = ?"
            " ORDER BY received_at, rowid", (request_id,),
        ).fetchall()
        return [HeldMessage(**{**dict(r), "truncated": bool(r["truncated"])}) for r in rows]

    def _begin_allow(
        self, db: sqlite3.Connection, request: ChannelRequest, allowed_by: str, now: float,
    ) -> bool:
        """Allow's first step, inside the caller's transaction: the intent.

        ``pending → allowing`` is a compare-and-set. The plan fixes, per
        conversation the held messages came in, the combined message's id; a
        conversation with no thread mapping yet gets one written as a
        ``creating`` intent naming its project id (the same intent the burst
        flush writes), so whoever finishes the Allow — the owner's click, a
        second click, the next flush, or boot recovery — creates THAT project.
        A sender who already has a thread for the conversation gets the
        combined message there.
        """
        keys = [
            r["conversation_key"] for r in db.execute(
                "SELECT DISTINCT conversation_key FROM held_messages WHERE request_id = ?"
                " ORDER BY conversation_key", (request.id,),
            ).fetchall()
        ]
        plan = [AllowPlanItem(conversation_key=k, message_id=str(uuid.uuid4())) for k in keys]
        cur = db.execute(
            "UPDATE requests SET state = ?, allowed_by = ?, allow_plan = ?"
            " WHERE id = ? AND state = ?",
            (REQUEST_ALLOWING, allowed_by, _plan_json(plan), request.id, REQUEST_PENDING),
        )
        if cur.rowcount == 0:
            return False
        for key in keys:
            db.execute(
                "INSERT OR IGNORE INTO threads (connection_id, conversation_key, contact_id,"
                " project_id, project_name, state, created_at) VALUES (?,?,?,?,?,?,?)",
                (request.connection_id, key, request.contact_id, str(uuid.uuid4()),
                 new_thread_slug(request.connection_id), THREAD_CREATING, now),
            )
        return True

    def begin_allow(self, request_id: str, *, now: float) -> Optional[ChannelRequest]:
        """The owner's Allow, step one. Returns the request as it now stands
        (already ``allowing``/``allowed``: unchanged; ``blocked``: unchanged)."""
        with self._tx() as db:
            request = self._request(db, request_id)
            if request is None:
                return None
            if request.state == REQUEST_PENDING:
                self._begin_allow(db, request, ALLOWED_BY_OWNER, now)
            return self._request(db, request_id)

    def set_allow_base(self, request_id: str, conversation_key: str, version: int) -> None:
        with self._tx() as db:
            request = self._request(db, request_id)
            assert request is not None
            plan = [
                AllowPlanItem(p.conversation_key, p.message_id, version)
                if p.conversation_key == conversation_key else p
                for p in request.allow_plan
            ]
            db.execute(
                "UPDATE requests SET allow_plan = ? WHERE id = ?", (_plan_json(plan), request_id),
            )

    def complete_allow(self, request_id: str, *, now: float) -> None:
        """Allow's last step, ONE commit: the held messages go (their events
        move from ``held_for_approval`` to ``accepted``), the Request is
        ``allowed``, and — when the owner clicked Allow — the sender gets an
        allow entry on their stable id (never their username, so a rename
        keeps them in and a takeover of the name does not)."""
        with self._tx() as db:
            request = self._request(db, request_id)
            if request is None or request.state != REQUEST_ALLOWING:
                return
            db.execute(
                "UPDATE inbound_events SET current_state = ? WHERE current_state = ?"
                " AND (connection_id, event_id) IN"
                " (SELECT connection_id, event_id FROM held_messages WHERE request_id = ?)",
                (EVENT_ACCEPTED, EVENT_HELD_FOR_APPROVAL, request_id),
            )
            db.execute("DELETE FROM held_messages WHERE request_id = ?", (request_id,))
            self.hook("allow.after_held_deleted")
            db.execute(
                "UPDATE requests SET state = ?, decided_at = ? WHERE id = ?",
                (REQUEST_ALLOWED, now, request_id),
            )
            if request.allowed_by == ALLOWED_BY_OWNER:
                db.execute(
                    "INSERT OR IGNORE INTO allow_entries (id, connection_id, kind, value,"
                    " created_at) VALUES (?,?,?,?,?)",
                    (uuid.uuid4().hex, request.connection_id, access.USER_ID,
                     request.user_key, now),
                )

    def block_request(self, request_id: str, *, now: float) -> Optional[ChannelRequest]:
        """Block, ONE commit: held messages deleted, the Request ``blocked``,
        and a block on the sender's stable id (a rename does not escape it).
        Only a pending Request can be blocked; the caller answers 409 for one
        that is being or has been allowed."""
        with self._tx() as db:
            request = self._request(db, request_id)
            if request is None or request.state != REQUEST_PENDING:
                return request
            db.execute("DELETE FROM held_messages WHERE request_id = ?", (request_id,))
            db.execute(
                "UPDATE requests SET state = ?, decided_at = ? WHERE id = ?",
                (REQUEST_BLOCKED, now, request_id),
            )
            db.execute(
                "INSERT OR IGNORE INTO blocks (connection_id, user_key, created_at)"
                " VALUES (?,?,?)", (request.connection_id, request.user_key, now),
            )
            return self._request(db, request_id)

    def unblock(self, connection_id: str, user_key: str) -> bool:
        """The sender's next message is judged afresh — an unknown sender opens
        a new Request, which gets the fixed reply again (the mark is per
        Request, not per sender)."""
        with self._tx() as db:
            cur = db.execute(
                "DELETE FROM blocks WHERE connection_id = ? AND user_key = ?",
                (connection_id, user_key),
            )
        return cur.rowcount == 1

    def is_blocked(self, connection_id: str, user_key: str) -> bool:
        return self._db().execute(
            "SELECT 1 FROM blocks WHERE connection_id = ? AND user_key = ?",
            (connection_id, user_key),
        ).fetchone() is not None

    # ── email: threading state + the Message-ID index ────────────────────

    def email_conversation_for(
        self, connection_id: str, user_key: str, message_ids: list[str],
    ) -> Optional[str]:
        """The conversation the first of ``message_ids`` (already in lookup
        order: In-Reply-To, then References newest first) that THIS sender has
        seen or been sent belongs to. A Message-ID known only from another
        contact's thread does not count."""
        if not message_ids:
            return None
        marks = ",".join("?" * len(message_ids))
        rows = self._db().execute(
            f"SELECT message_id, conversation_key FROM email_message_ids"
            f" WHERE connection_id = ? AND user_key = ? AND message_id IN ({marks})",
            (connection_id, user_key, *message_ids),
        ).fetchall()
        found = {r["message_id"]: r["conversation_key"] for r in rows}
        for message_id in message_ids:
            if message_id in found:
                return found[message_id]
        return None

    def record_email_inbound(
        self, db: sqlite3.Connection, *, connection_id: str, conversation_key: str,
        user_key: str, agent_address: str, subject: str, message_id: Optional[str],
        references: list[str], trusted: bool, now: float,
    ) -> None:
        """Inside ``accept_inbound``'s transaction (its ``on_kept``): the
        conversation's reply state and the inbound Message-ID in the index.

        A mail that failed the sender check creates the state of a NEW
        conversation (a Request the owner may still allow needs somewhere to
        reply) but never changes an existing one: a forged mail must not
        re-point the subject or threading of a real contact's thread."""
        chain = [i for i in references if i != message_id]
        if message_id:
            chain.append(message_id)
        if len(chain) > MAX_REFERENCES:
            chain = chain[:1] + chain[-(MAX_REFERENCES - 1):]
        exists = db.execute(
            "SELECT 1 FROM email_threads WHERE connection_id = ? AND conversation_key = ?",
            (connection_id, conversation_key),
        ).fetchone()
        if exists is None:
            db.execute(
                "INSERT INTO email_threads (connection_id, conversation_key, user_key,"
                " agent_address, subject, last_message_id, references_chain, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (connection_id, conversation_key, user_key, agent_address, subject,
                 message_id, json.dumps(chain), now),
            )
        elif trusted:
            db.execute(
                "UPDATE email_threads SET subject = ?, last_message_id = COALESCE(?, last_message_id),"
                " references_chain = CASE WHEN ? IS NULL THEN references_chain ELSE ? END,"
                " updated_at = ? WHERE connection_id = ? AND conversation_key = ?",
                (subject, message_id, message_id, json.dumps(chain), now, connection_id,
                 conversation_key),
            )
        if message_id:
            db.execute(
                "INSERT OR IGNORE INTO email_message_ids (connection_id, user_key, message_id,"
                " conversation_key, created_at) VALUES (?,?,?,?,?)",
                (connection_id, user_key, message_id, conversation_key, now),
            )

    def note_email_received(self, db: sqlite3.Connection, connection_id: str, now: float) -> None:
        """Inside ``accept_inbound``'s transaction (its ``on_accept``): the
        connection's "last mail received" time — for every mail, kept or
        dropped, since it proves MX and Inbound Parse work."""
        db.execute(
            "UPDATE connections SET last_inbound_at = ? WHERE id = ?", (now, connection_id),
        )

    def _index_outbound(
        self, db: sqlite3.Connection, connection_id: str, conversation_key: str,
        retry_key: str, now: float,
    ) -> None:
        """Record the Message-ID an outbox row will be sent with, when the row
        is created. Only conversations with email state have one."""
        row = db.execute(
            "SELECT user_key, agent_address FROM email_threads"
            " WHERE connection_id = ? AND conversation_key = ?",
            (connection_id, conversation_key),
        ).fetchone()
        if row is None:
            return
        domain = row["agent_address"].rpartition("@")[2]
        db.execute(
            "INSERT OR IGNORE INTO email_message_ids (connection_id, user_key, message_id,"
            " conversation_key, created_at) VALUES (?,?,?,?,?)",
            (connection_id, row["user_key"], outbound_message_id(retry_key, domain),
             conversation_key, now),
        )

    def _unindex_outbound(self, db: sqlite3.Connection, row_ids: list[str]) -> None:
        """Forget the Message-IDs of outbox rows that ended never sent, so no
        later mail threads onto a message the contact never got."""
        if not row_ids:
            return
        for row in db.execute(
            "SELECT o.connection_id, o.conversation_key, o.retry_key, t.agent_address"
            " FROM outbox o JOIN email_threads t ON t.connection_id = o.connection_id"
            " AND t.conversation_key = o.conversation_key"
            f" WHERE o.id IN ({','.join('?' * len(row_ids))})", row_ids,
        ).fetchall():
            db.execute(
                "DELETE FROM email_message_ids WHERE connection_id = ? AND conversation_key = ?"
                " AND message_id = ?",
                (row["connection_id"], row["conversation_key"],
                 outbound_message_id(row["retry_key"], row["agent_address"].rpartition("@")[2])),
            )

    def email_state(self, connection_id: str, conversation_key: str) -> Optional[EmailThreadState]:
        row = self._db().execute(
            "SELECT connection_id, conversation_key, user_key, agent_address, subject,"
            " last_message_id, references_chain FROM email_threads"
            " WHERE connection_id = ? AND conversation_key = ?",
            (connection_id, conversation_key),
        ).fetchone()
        if row is None:
            return None
        data = dict(row)
        data["references"] = json.loads(data.pop("references_chain") or "[]")
        return EmailThreadState(**data)

    def email_message_ids(self, connection_id: str) -> list[tuple[str, str, str]]:
        """(sender, Message-ID, conversation) rows of a connection (tests)."""
        rows = self._db().execute(
            "SELECT user_key, message_id, conversation_key FROM email_message_ids"
            " WHERE connection_id = ? ORDER BY created_at, rowid", (connection_id,),
        ).fetchall()
        return [(r["user_key"], r["message_id"], r["conversation_key"]) for r in rows]

    def outbox_row_by_retry_key(self, retry_key: str) -> Optional[OutboxRow]:
        row = self._db().execute(
            f"SELECT {_OUTBOX_COLUMNS} FROM outbox WHERE retry_key = ?", (retry_key,),
        ).fetchone()
        return _outbox_row(row) if row else None

    def agent_replies_sent_since(
        self, connection_id: str, conversation_key: str, since: float,
    ) -> int:
        """Agent reply rows sent (or being sent, or forwarded to the hub and
        awaiting a receipt: the reply has left) after ``since`` to the contact
        of this conversation, across all of their email threads — an
        auto-responder that sends no threading headers starts a new thread
        with every mail, so a per-thread count would never reach the cap."""
        return self._db().execute(
            "SELECT COUNT(*) FROM outbox WHERE connection_id = ?"
            " AND (conversation_key = ? OR conversation_key IN ("
            "   SELECT t2.conversation_key FROM email_threads t1 JOIN email_threads t2"
            "   ON t2.connection_id = t1.connection_id AND t2.user_key = t1.user_key"
            "   WHERE t1.connection_id = ? AND t1.conversation_key = ?))"
            " AND kind = ? AND from_agent = 1 AND state IN (?, ?, ?) AND updated_at > ?",
            (connection_id, conversation_key, connection_id, conversation_key,
             KIND_REPLY, SENT, SENDING, AWAITING_RECEIPT, since),
        ).fetchone()[0]

    def set_status_for_channel(
        self, channel: str, status: Optional[str], *, now: float, detail: Optional[str] = None,
    ) -> None:
        """One health status (with the provider's own text, if any) on every
        connection of a channel whose credential is the server's own (email's
        SendGrid key)."""
        with self._tx() as db:
            db.execute(
                "UPDATE connections SET status = ?, status_detail = ?, status_count = NULL,"
                " status_at = ? WHERE channel = ?", (status, detail, now, channel),
            )

    def connection_for_agent(self, channel: str, agent_id: str) -> Optional[ChannelConnection]:
        row = self._db().execute(
            f"SELECT {_CONNECTION_COLUMNS} FROM connections WHERE channel = ? AND agent_id = ?",
            (channel, agent_id),
        ).fetchone()
        return ChannelConnection(**dict(row)) if row else None


    # ── web chat widget ──────────────────────────────────────────────────

    def create_grant(
        self, *, connection_id: str, kind: str, label: str, origins: list[str],
        key: str, key_hash: str, fernet: MultiFernet, now: float,
    ) -> WebchatGrant:
        grant_id = uuid.uuid4().hex
        with self._tx() as db:
            db.execute(
                "INSERT INTO webchat_grants (id, connection_id, kind, label, key_hash,"
                " key_ciphertext, key_prefix, origins, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (grant_id, connection_id, kind, label, key_hash,
                 fernet.encrypt(key.encode("utf-8")), key[:8], json.dumps(origins), now),
            )
        grant = self.get_grant(grant_id)
        assert grant is not None
        return grant

    @staticmethod
    def _grant_from_row(row: sqlite3.Row) -> WebchatGrant:
        return WebchatGrant(
            id=row["id"], connection_id=row["connection_id"], kind=row["kind"],
            label=row["label"], key_prefix=row["key_prefix"],
            origins=tuple(json.loads(row["origins"])), created_at=row["created_at"],
            revoked_at=row["revoked_at"],
        )

    _GRANT_COLUMNS = (
        "id, connection_id, kind, label, key_prefix, origins, created_at, revoked_at"
    )

    def get_grant(self, grant_id: str) -> Optional[WebchatGrant]:
        row = self._db().execute(
            f"SELECT {self._GRANT_COLUMNS} FROM webchat_grants WHERE id = ?", (grant_id,),
        ).fetchone()
        return self._grant_from_row(row) if row else None

    def grant_by_key_hash(self, key_hash: str) -> Optional[WebchatGrant]:
        """The live grant with this key, or None (revoked grants never match)."""
        row = self._db().execute(
            f"SELECT {self._GRANT_COLUMNS} FROM webchat_grants"
            " WHERE key_hash = ? AND revoked_at IS NULL", (key_hash,),
        ).fetchone()
        return self._grant_from_row(row) if row else None

    def list_grants(self, connection_id: str) -> list[WebchatGrant]:
        """The connection's live grants, oldest first."""
        rows = self._db().execute(
            f"SELECT {self._GRANT_COLUMNS} FROM webchat_grants"
            " WHERE connection_id = ? AND revoked_at IS NULL ORDER BY created_at, rowid",
            (connection_id,),
        ).fetchall()
        return [self._grant_from_row(r) for r in rows]

    def grant_key(self, grant_id: str, fernet: MultiFernet) -> SecretStr:
        row = self._db().execute(
            "SELECT key_ciphertext FROM webchat_grants WHERE id = ?", (grant_id,),
        ).fetchone()
        if row is None:
            raise KeyError(grant_id)
        return SecretStr(fernet.decrypt(row["key_ciphertext"]).decode("utf-8"))

    def update_grant(
        self, grant_id: str, *, label: Optional[str] = None,
        origins: Optional[list[str]] = None,
    ) -> Optional[WebchatGrant]:
        with self._tx() as db:
            if label is not None:
                db.execute("UPDATE webchat_grants SET label = ? WHERE id = ?", (label, grant_id))
            if origins is not None:
                db.execute(
                    "UPDATE webchat_grants SET origins = ? WHERE id = ?",
                    (json.dumps(origins), grant_id),
                )
        return self.get_grant(grant_id)

    def revoke_grant(self, grant_id: str, *, now: float) -> bool:
        with self._tx() as db:
            cur = db.execute(
                "UPDATE webchat_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
                (now, grant_id),
            )
        return cur.rowcount > 0

    def webchat_post(
        self, *, connection_id: str, visitor_id: str, text: str, retry_key: str, now: float,
    ) -> None:
        """Put one reply in a visitor's mailbox; a retry with the same key is a no-op."""
        with self._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO webchat_messages"
                " (connection_id, visitor_id, retry_key, text, created_at) VALUES (?,?,?,?,?)",
                (connection_id, visitor_id, retry_key, text, now),
            )

    def webchat_since(
        self, connection_id: str, visitor_id: str, after: int, *, limit: int = 100,
    ) -> list[WebchatMessage]:
        rows = self._db().execute(
            "SELECT seq, text, created_at FROM webchat_messages"
            " WHERE connection_id = ? AND visitor_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            (connection_id, visitor_id, after, limit),
        ).fetchall()
        return [WebchatMessage(seq=r["seq"], text=r["text"], created_at=r["created_at"]) for r in rows]


def _plan_json(plan: list[AllowPlanItem]) -> str:
    return json.dumps([
        {"conversation_key": p.conversation_key, "message_id": p.message_id,
         "base_version": p.base_version}
        for p in plan
    ])


def new_thread_slug(connection_id: str) -> str:
    """A channel thread's project name. Opaque: no ``-fd-`` and nothing the
    contact chose, so no name-based rule (``Project.fd_requester_name``, the
    frontend's FRONT_DESK_NAME_RE) can ever read a username out of it."""
    return f"ch-{connection_id[:8]}-{uuid.uuid4().hex[:8]}"


def rollback_schema_v9(data_dir: Path) -> bool:
    """Take ``channels.db`` back from version 9 to 8, with the server stopped.
    True if it did. Version 9 only added two ``hub_channels`` columns and
    ``hub_dispatch_counts``, which version-8 code never reads: nothing is
    dropped, only the version changes."""
    path = data_dir / "channels" / "channels.db"
    if not path.exists():
        return False
    db = sqlite3.connect(path, isolation_level=None)
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] != 9:
            return False
        db.execute("PRAGMA user_version = 8")
        return True
    finally:
        db.close()


def rollback_schema_v8(data_dir: Path) -> bool:
    """Take ``channels.db`` back from version 8 to 7, with the server stopped.
    True if it did. Version 8 only added ``hub_owners``, which version-7 code
    never reads: nothing is dropped, only the version changes."""
    path = data_dir / "channels" / "channels.db"
    if not path.exists():
        return False
    db = sqlite3.connect(path, isolation_level=None)
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] != 8:
            return False
        db.execute("PRAGMA user_version = 7")
        return True
    finally:
        db.close()


def rollback_schema_v7(data_dir: Path) -> bool:
    """Take ``channels.db`` back from version 7 to 6, with the server stopped.
    True if it did.

    Version 7 only added ``hub_retained``, which version-6 code never reads,
    so nothing is dropped: only the version changes, and opening the file
    with version-7 code again reuses the retained rows as they were. A file
    that is not at version 7 is left alone (returns False)."""
    path = data_dir / "channels" / "channels.db"
    if not path.exists():
        return False
    db = sqlite3.connect(path, isolation_level=None)
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] != 7:
            return False
        db.execute("PRAGMA user_version = 6")
        return True
    finally:
        db.close()


def rollback_schema_v6(data_dir: Path) -> bool:
    """Take ``channels.db`` back from version 6 to 5, with the server stopped.
    True if it did.

    Version 6 only added tables (the hub client's threads, channels and
    caches), which version-5 code never reads, so nothing is dropped and no
    row is closed: only the version changes. Opening the file with version-6
    code again reuses the tables as they were. A file that is not at version 6
    is left alone (returns False)."""
    path = data_dir / "channels" / "channels.db"
    if not path.exists():
        return False
    db = sqlite3.connect(path, isolation_level=None)
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] not in (6, 7, 8, 9):
            return False
        db.execute("PRAGMA user_version = 5")
        return True
    finally:
        db.close()


def rollback_schema_v5(data_dir: Path, *, now: float) -> int:
    """Take ``channels.db`` back from version 5 (or 6 or 7) to 4, with the server stopped.
    Returns the number of outbox rows it closed.

    Nothing is dropped. Version-4 code reads only the columns it names and
    ignores tables it does not know, so the hub tables (the identity and its
    reporter secret, pins, blocks, stand-ins) and the new columns stay in
    place, and opening the file with version-5 code again reuses them (the
    upgrade adds only what is missing). Only the rows version-4 code could
    never finish are closed, ``failed`` with ``schema_rollback``: every row in
    a waiting state, and every unsent row of a hub connection (version 4 has
    no hub adapter and would fail them as ``no_adapter``). Held rows stop
    being probed. A version-6 or -7 file is taken back the same way (those
    versions only added tables, which stay too). A file at any other version is left alone
    (returns 0).
    """
    path = data_dir / "channels" / "channels.db"
    if not path.exists():
        return 0
    db = sqlite3.connect(path, isolation_level=None)
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] not in (5, 6, 7, 8, 9):
            return 0
        db.execute("BEGIN IMMEDIATE")
        try:
            closed = db.execute(
                "UPDATE outbox SET state = ?, reason = ?, updated_at = ?"
                f" WHERE state IN ({_marks(WAITING_STATES)})"
                " OR (state IN (?, ?) AND connection_id IN"
                "     (SELECT id FROM connections WHERE channel = ?))",
                (FAILED, REASON_SCHEMA_ROLLBACK, now, *WAITING_STATES, PENDING, SENDING,
                 HUB_CHANNEL),
            ).rowcount
            db.execute("UPDATE outbox SET probe_due_at = NULL WHERE probe_due_at IS NOT NULL")
            db.execute("PRAGMA user_version = 4")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")
        return closed
    finally:
        db.close()
