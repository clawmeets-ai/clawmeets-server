# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/hub_store.py
The hub's records in ``channels.db``: this deployment's registration, the hub
keys it trusts, the browser's send keys, other deployments' pinned key chains,
blocked deployments, the stand-ins for remote agents, and the outbox methods
only hub rows use.

On ChannelStore's own connection and transactions (``store._tx()``), so a hub
write and an outbox or dedupe write can commit together. The tables are in
``store._SCHEMA``; see "Hub rows" and "Signed objects" in ``store.py``.

**Pins are written only after ``verify_key_chain``.** ``pin_chain`` runs the
check itself and writes nothing when it fails. A fingerprint is the primary
key of ``hub_pins`` and appears once, ever, under one genesis: a stored chain
can only be extended, never rewritten or shortened, so no deployment can
rotate back to a key it held before. (Binding the chain's head to the hub's
statement is the caller's check, ``verify_deployment_key`` in the hub client.)

**Deployment blocks** are keyed by the blocked deployment's GENESIS
fingerprint, never its current key: a block made against the key it used
then still holds after it rotates. ``scope`` is the hub connection the owner
blocked it on, or ``'*'`` for the whole server (``'*'`` rather than NULL, which
SQLite would let repeat in a primary key).

**Hub outbox rows.** A requester's message to a remote agent is one row of
kind ``hub_request``; a host's reply to a requester is an ordinary reply row
on the hub connection. Either way the row's ``conversation_key`` starts with
the TARGET deployment's genesis fingerprint (``<target fp>/...``), so the
rows waiting for one deployment can be woken, or counted, together. The
signed envelope is stored once, at the first send, and every re-relay sends
it byte for byte.

**The hub client's records** (schema version 6). ``hub_threads`` maps each
requester project to its stand-in and records how it closed: the first close
wins and is never reopened. ``hub_channels`` is one local agent's Hub
channel; its daily run count is claimed in one transaction against the cap
(``bump_runs_today``). The directory cache answers for at most
``DIRECTORY_CACHE_S``; the avatar cache keeps one re-encode, or the refusal,
per listing refresh, so an avatar is decoded at most once per refresh.

**Retained agents** (schema version 7). ``hub_retained`` is one row per
(user, stand-in) the user chose to retain, with its state: ``active`` until a
signed statement says otherwise (``unlisted`` for an agent_delisted,
``identity_changed`` for a revoked key of its root). A statement only ever
moves a row away from ``active``; only a new retain sets it back.

**Trusted hub keys** keep each key's validity window and, for a key a key set
admitted, the trusted kid whose signature admitted it (``accepted_via``), so
withdrawing a kid also withdraws every key it vouched for, at any depth.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal, Mapping, Optional

from cryptography.fernet import MultiFernet

from clawmeets.hub_protocol.canonical import Purpose, b64url_decode
from clawmeets.hub_protocol.frames import verify_key_chain
from clawmeets.hub_protocol.ids import MIN_REPORTER_SECRET_BYTES, agent_ref, display_label
from clawmeets.hub_protocol.keys import HubKeyEntry, TrustedKey

from . import hub_delivery
from .store import (
    AWAITING_RECEIPT,
    EXPIRED,
    FAILED,
    HUB_CHANNEL,
    KIND_HUB_REQUEST,
    OPEN_STATES,
    PARKED,
    PENDING,
    REASON_EXPIRED_72H,
    REASON_HELD_EXPIRED,
    REASON_KEY_REVOKED,
    REQUEST_PENDING,
    SENDING,
    SENT,
    THREAD_LIVE,
    ChannelStore,
    OutboxRow,
    _OUTBOX_COLUMNS,
    _marks,
    _outbox_row,
)

#: Reasons a row ended that a later reply or receipt can still overturn: the
#: target may have had it all along (``mark_delivered_late``).
LATE_DELIVERY_REASONS = (REASON_EXPIRED_72H, REASON_HELD_EXPIRED, REASON_KEY_REVOKED)

#: The scope of a block that applies to every hub connection on this server.
SERVER_WIDE = "*"
#: How long a search or agent answer may be served from the cache.
DIRECTORY_CACHE_S = 24 * 3600

#: ``hub_retained.state``.
RETAIN_ACTIVE = "active"
RETAIN_UNLISTED = "unlisted"
RETAIN_IDENTITY_CHANGED = "identity_changed"
RetainState = Literal["active", "unlisted", "identity_changed"]

HubLink = Literal["connected", "unreachable", "untrusted", "off"]
RegistrationStatus = Literal["none", "pending_email", "active", "suspended", "held_for_reclaim"]
#: ``hub_owners.status``: one user, as an owner of agents listed on one hub.
OwnerStatus = Literal["code_sent", "verified", "banned"]


@dataclass(frozen=True)
class HubOwner:
    """One user's standing as an agent owner with one hub (server/hub/enroll.py)."""

    hub_url: str
    user_id: str
    owner_ref: str
    status: OwnerStatus
    via_registration: bool
    email_hash: Optional[str]
    code_sent_at: Optional[float]
    verified_at: Optional[float]
    updated_at: float


def _dumps(obj: Mapping[str, Any]) -> str:
    """A signed object as stored: the dict as received, keys in their order."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class HubRegistration:
    """This deployment on one hub (keyed by the canonical hub URL). The
    reporter secret is never on this object (``HubStore.reporter_secret``)."""

    hub_url: str
    created_at: float
    updated_at: float
    deployment_id: Optional[str] = None
    name: Optional[str] = None
    label: str = ""
    public_url: Optional[str] = None
    status: RegistrationStatus = "none"
    genesis_fp: Optional[str] = None
    current_fp: Optional[str] = None
    #: The hub connection row (``agent_id='__deployment__'``) holding the identity key.
    identity_connection_id: Optional[str] = None
    contact_email_hash: Optional[str] = None
    #: The hub-signed registration statement, verbatim (``Purpose.STATEMENT``).
    statement: Optional[dict] = None
    hub_link: HubLink = "off"
    last_connected_at: Optional[float] = None


@dataclass(frozen=True)
class BlockedDeployment:
    scope: str
    genesis_fp: str
    deployment_name: str
    created_at: float


class PinResult(str, Enum):
    NEW = "new"                 # first chain seen for this genesis
    EXTENDED = "extended"       # the stored chain is a prefix of this one
    UNCHANGED = "unchanged"     # this chain is (a prefix of) the stored one
    CONFLICT = "conflict"       # disagrees with what is pinned: nothing written


class ChainRejected(ValueError):
    """``verify_key_chain`` refused the chain; nothing was pinned."""


@dataclass(frozen=True)
class Pin:
    """One key of another deployment's verified chain."""

    fingerprint: str
    genesis_fp: str
    seq: int
    pubkey: bytes
    is_head: bool
    deployment_id: Optional[str]
    deployment_name: Optional[str]
    revoked_at: Optional[float]
    #: Set when the deployment's identity changed (a key revoked): the whole
    #: root is closed, whatever key signs.
    identity_changed_at: Optional[float]


@dataclass(frozen=True)
class RemoteAgent:
    """A stand-in for an agent on another deployment."""

    id: str                     # agent_ref(genesis_fp, agent_name)
    genesis_fp: str
    agent_name: str
    current_fp: Optional[str]
    deployment_id: Optional[str]
    deployment_name: str
    display: str
    cert: Optional[dict]
    cert_serial: Optional[str]
    cert_not_after: Optional[int]


@dataclass(frozen=True)
class HubThread:
    """The requester's side of one hub conversation: a Front Desk project
    whose coordinator is the stand-in ``stand_in_id``."""

    project_id: str
    user_id: str
    client_thread_key: str
    stand_in_id: str            # agent_ref(genesis_fp, agent_name)
    genesis_fp: str
    agent_name: str
    created_at: float
    closed_reason: Optional[str] = None
    closed_at: Optional[float] = None
    #: Set only when an owner disabled the agent: replies to earlier messages
    #: are still accepted until then.
    drain_until: Optional[float] = None
    #: The owned agent that opened this thread (agent send), or None for a
    #: thread the user started in the browser. Replies wake it in the thread.
    started_by_agent_id: Optional[str] = None
    wake_day: Optional[str] = None
    wake_count: int = 0
    #: ``dm`` (a conversation the user or an agent started) or ``room_bridge``
    #: (a hidden thread carrying one workroom's relays to one stand-in).
    kind: str = "dm"
    bound_project_id: Optional[str] = None
    bound_room: Optional[str] = None


@dataclass(frozen=True)
class BridgeRelay:
    """One room message relayed (or waiting, or refused) to a stand-in."""

    room_project_id: str
    room: str
    room_message_id: str
    stand_in_id: str
    user_id: str
    thread_project_id: Optional[str]
    hub_message_id: Optional[str]
    state: str          # queued | relayed | delivered | answered | failed | cancelled
    reason: Optional[str]
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class RetainedRow:
    """One user's retained remote agent, joined with its stand-in."""

    user_id: str
    stand_in_id: str
    retained_at: float
    state: str
    description: str
    capabilities: list[str]
    agent_name: str
    genesis_fp: str
    deployment_name: str


@dataclass(frozen=True)
class HubChannelState:
    """One local agent's Hub channel, as stored. ``cert`` is the AgentCert
    verbatim (purpose ``AGENT_CERT``)."""

    agent_id: str
    owner_id: str
    created_at: float
    updated_at: float
    connection_id: Optional[str] = None
    enabled: bool = False
    status: str = "off"
    status_detail: Optional[str] = None
    reject_reason: Optional[str] = None
    enable_request_id: Optional[str] = None
    cert: Optional[dict] = None
    cert_serial: Optional[str] = None
    cert_not_after: Optional[int] = None
    rotate_by: Optional[float] = None
    last_success_at: Optional[float] = None
    next_retry_at: Optional[float] = None
    disabled_at: Optional[float] = None
    stop_now: bool = False
    unregister_pending: bool = False
    daily_run_cap: int = 200
    runs_today: int = 0
    runs_reset_at: Optional[float] = None


@dataclass(frozen=True)
class CachedAnswer:
    body: dict
    cached_at: float


@dataclass(frozen=True)
class CachedAvatar:
    hub_agent_id: str
    refreshed_at: int
    png: Optional[bytes]        # exactly one of png and refusal is set
    refusal: Optional[str]


_CHANNEL_COLUMNS = (
    "agent_id", "owner_id", "connection_id", "enabled", "status", "status_detail", "reject_reason",
    "enable_request_id", "cert", "cert_serial", "cert_not_after", "rotate_by", "last_success_at",
    "next_retry_at", "disabled_at", "stop_now", "unregister_pending", "daily_run_cap", "runs_today",
    "runs_reset_at", "created_at", "updated_at",
)


class HubStore:
    """The hub tables of one ``ChannelStore``."""

    def __init__(self, store: ChannelStore) -> None:
        self._store = store

    # ── registration ─────────────────────────────────────────────────────

    def registration(self, hub_url: str) -> Optional[HubRegistration]:
        row = self._store._db().execute(
            "SELECT * FROM hub_registration WHERE hub_url = ?", (hub_url,),
        ).fetchone()
        if row is None:
            return None
        data = dict(row)
        data.pop("reporter_secret_ciphertext")
        data.pop("statement_purpose")
        data["statement"] = json.loads(data["statement"]) if data["statement"] else None
        return HubRegistration(**data)

    def save_registration(
        self, reg: HubRegistration, *, fernet: MultiFernet, reporter_secret: Optional[bytes] = None,
        replaces_identity: Optional[str] = None,
    ) -> None:
        """Insert or update the registration. A new one gets ``reporter_secret``
        (or a fresh random one), stored encrypted; an existing one keeps its
        secret unless one is given. The statement is stored with its purpose.

        ``replaces_identity``: the connection row of the identity key this
        registration stops using (a reclaim's new key), deleted in the same
        commit, so the swap is all or nothing. An identity row has no
        contacts, threads or outbox rows of its own."""
        if reporter_secret is not None and len(reporter_secret) < MIN_REPORTER_SECRET_BYTES:
            raise ValueError(f"reporter secret must be at least {MIN_REPORTER_SECRET_BYTES} bytes")
        statement = _dumps(reg.statement) if reg.statement is not None else None
        purpose = Purpose.STATEMENT.value if statement is not None else None
        with self._store._tx() as db:
            exists = db.execute(
                "SELECT 1 FROM hub_registration WHERE hub_url = ?", (reg.hub_url,),
            ).fetchone()
            if exists is None:
                secret = reporter_secret or secrets.token_bytes(MIN_REPORTER_SECRET_BYTES)
                db.execute(
                    "INSERT INTO hub_registration (hub_url, reporter_secret_ciphertext,"
                    " created_at, updated_at) VALUES (?,?,?,?)",
                    (reg.hub_url, fernet.encrypt(secret), reg.created_at, reg.updated_at),
                )
            elif reporter_secret is not None:
                db.execute(
                    "UPDATE hub_registration SET reporter_secret_ciphertext = ? WHERE hub_url = ?",
                    (fernet.encrypt(reporter_secret), reg.hub_url),
                )
            db.execute(
                "UPDATE hub_registration SET deployment_id = ?, name = ?, label = ?, public_url = ?,"
                " status = ?, genesis_fp = ?, current_fp = ?, identity_connection_id = ?,"
                " contact_email_hash = ?, statement = ?, statement_purpose = ?, hub_link = ?,"
                " last_connected_at = ?, updated_at = ? WHERE hub_url = ?",
                (reg.deployment_id, reg.name, reg.label, reg.public_url, reg.status,
                 reg.genesis_fp, reg.current_fp, reg.identity_connection_id,
                 reg.contact_email_hash, statement, purpose, reg.hub_link,
                 reg.last_connected_at, reg.updated_at, reg.hub_url),
            )
            if replaces_identity is not None and replaces_identity != reg.identity_connection_id:
                db.execute(
                    "DELETE FROM connections WHERE id = ? AND channel = ?",
                    (replaces_identity, HUB_CHANNEL),
                )

    def reporter_secret(self, hub_url: str, fernet: MultiFernet) -> bytes:
        row = self._store._db().execute(
            "SELECT reporter_secret_ciphertext FROM hub_registration WHERE hub_url = ?", (hub_url,),
        ).fetchone()
        if row is None:
            raise KeyError(hub_url)
        return fernet.decrypt(row["reporter_secret_ciphertext"])

    # ── owners (server/hub/enroll.py) ───────────────────────────────────

    def owner_ref(self, hub_url: str, fernet: MultiFernet, user_id: str) -> str:
        """The opaque id the hub knows ``user_id`` by: stable per (deployment,
        user), derived from the reporter secret so it means nothing anywhere
        else and never carries the username or email. KeyError before the
        registration row (and so the secret) exists."""
        digest = hmac.new(self.reporter_secret(hub_url, fernet), b"owner:" + user_id.encode("utf-8"),
                          hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:22]

    def owner(self, hub_url: str, user_id: str) -> Optional[HubOwner]:
        row = self._store._db().execute(
            "SELECT * FROM hub_owners WHERE hub_url = ? AND user_id = ?", (hub_url, user_id),
        ).fetchone()
        return _owner(row) if row is not None else None

    def owner_by_ref(self, hub_url: str, owner_ref: str) -> Optional[HubOwner]:
        row = self._store._db().execute(
            "SELECT * FROM hub_owners WHERE hub_url = ? AND owner_ref = ?", (hub_url, owner_ref),
        ).fetchone()
        return _owner(row) if row is not None else None

    def owner_code_sent(
        self, hub_url: str, user_id: str, owner_ref: str, *, email_hash: str,
        via_registration: bool, now: float,
    ) -> None:
        """A code is on its way to this user (a verified owner stays verified).
        With ``via_registration`` the deployment's own code is now theirs: any
        other user still waiting on it (whose wait was taken over) is dropped."""
        with self._store._tx() as db:
            if via_registration:
                db.execute(
                    "DELETE FROM hub_owners WHERE hub_url = ? AND user_id != ? AND via_registration = 1"
                    " AND status = 'code_sent'", (hub_url, user_id),
                )
            db.execute(
                "INSERT INTO hub_owners (hub_url, user_id, owner_ref, status, via_registration, email_hash,"
                " code_sent_at, updated_at) VALUES (?, ?, ?, 'code_sent', ?, ?, ?, ?)"
                " ON CONFLICT (hub_url, user_id) DO UPDATE SET owner_ref = excluded.owner_ref,"
                " status = CASE WHEN status = 'verified' THEN status ELSE 'code_sent' END,"
                " via_registration = excluded.via_registration, email_hash = excluded.email_hash,"
                " code_sent_at = excluded.code_sent_at, updated_at = excluded.updated_at",
                (hub_url, user_id, owner_ref, int(via_registration), email_hash, now, now),
            )

    def set_owner_status(self, hub_url: str, user_id: str, status: OwnerStatus, *, now: float) -> None:
        with self._store._tx() as db:
            db.execute(
                "UPDATE hub_owners SET status = ?, via_registration = 0, updated_at = ?,"
                " verified_at = CASE WHEN ? = 'verified' THEN ? ELSE verified_at END"
                " WHERE hub_url = ? AND user_id = ?",
                (status, now, status, now, hub_url, user_id),
            )

    def registration_verified_owners(self, hub_url: str, *, now: float) -> int:
        """The deployment's own code was right: the owner whose code it was
        (``via_registration``) is verified with it. Returns how many."""
        with self._store._tx() as db:
            cur = db.execute(
                "UPDATE hub_owners SET status = 'verified', verified_at = ?, updated_at = ?,"
                " via_registration = 0 WHERE hub_url = ? AND via_registration = 1 AND status = 'code_sent'",
                (now, now, hub_url),
            )
            return cur.rowcount

    def set_hub_link(self, hub_url: str, link: HubLink, *, now: float) -> None:
        with self._store._tx() as db:
            db.execute(
                "UPDATE hub_registration SET hub_link = ?, updated_at = ?,"
                " last_connected_at = CASE WHEN ? = 'connected' THEN ? ELSE last_connected_at END"
                " WHERE hub_url = ?",
                (link, now, link, now, hub_url),
            )

    # ── trusted hub keys ─────────────────────────────────────────────────

    def trusted_keys(self, hub_url: str) -> dict[str, TrustedKey]:
        """The kid -> key map ``accept_key_set`` and the hello check take."""
        rows = self._store._db().execute(
            "SELECT kid, pubkey, not_before, not_after FROM hub_trusted_keys WHERE hub_url = ?",
            (hub_url,),
        ).fetchall()
        return {
            r["kid"]: TrustedKey(pub=bytes(r["pubkey"]), not_before=r["not_before"], not_after=r["not_after"])
            for r in rows
        }

    def seed_trusted_keys(
        self, hub_url: str, keys: Mapping[str, TrustedKey], *,
        source: Literal["pinned", "configured"], now: float,
    ) -> int:
        """Trust the keys shipped for ``hub_url`` (``pinned_trust``) or set by
        the operator. A kid already trusted is left as it is. Returns how many
        were added."""
        with self._store._tx() as db:
            return sum(
                db.execute(
                    "INSERT OR IGNORE INTO hub_trusted_keys (hub_url, kid, pubkey, not_before,"
                    " not_after, source, accepted_at) VALUES (?,?,?,?,?,?,?)",
                    (hub_url, kid, key.pub, key.not_before, key.not_after, source, now),
                ).rowcount
                for kid, key in keys.items()
            )

    def withdraw_configured_keys(self, hub_url: str, keep: Mapping[str, TrustedKey]) -> list[str]:
        """The operator's keys (``source='configured'``) are owned by the env:
        withdraw every one no longer in ``keep`` or whose public key changed,
        with every key admitted through it (``purge_trusted_keys_through``).
        Pinned and key-set rows under a kept key are untouched. Returns the
        kids deleted."""
        rows = self._store._db().execute(
            "SELECT kid, pubkey FROM hub_trusted_keys WHERE hub_url = ? AND source = 'configured'",
            (hub_url,),
        ).fetchall()
        stale = frozenset(
            r["kid"] for r in rows if r["kid"] not in keep or bytes(r["pubkey"]) != keep[r["kid"]].pub
        )
        return self.purge_trusted_keys_through(hub_url, stale)

    def add_trusted_keys(
        self, hub_url: str, entries: list[HubKeyEntry], *, accepted_via: str, now: float,
    ) -> int:
        """Trust the entries ``accept_key_set`` returned, recording the kid
        whose set signature admitted them. ``accepted_via`` must itself be
        trusted for ``hub_url`` (ValueError otherwise)."""
        with self._store._tx() as db:
            if db.execute(
                "SELECT 1 FROM hub_trusted_keys WHERE hub_url = ? AND kid = ?", (hub_url, accepted_via),
            ).fetchone() is None:
                raise ValueError("accepted_via is not a trusted kid for this hub")
            return sum(
                db.execute(
                    "INSERT OR IGNORE INTO hub_trusted_keys (hub_url, kid, pubkey, not_before,"
                    " not_after, source, accepted_via, accepted_at) VALUES (?,?,?,?,?,'key_set',?,?)",
                    (hub_url, e.kid, b64url_decode(e.pub, length=32), e.not_before, e.not_after,
                     accepted_via, now),
                ).rowcount
                for e in entries
            )

    def purge_trusted_keys_through(self, hub_url: str, kids: frozenset[str]) -> list[str]:
        """Withdraw ``kids`` and every key admitted through one of them, at any
        depth (``REVOKED_HUB_KIDS``, a withdrawn operator key). Returns the
        kids deleted."""
        if not kids:
            return []
        marks = ", ".join("?" * len(kids))
        with self._store._tx() as db:
            doomed = [r[0] for r in db.execute(
                "WITH RECURSIVE doomed(kid) AS ("
                f"  SELECT kid FROM hub_trusted_keys WHERE hub_url = ? AND kid IN ({marks})"
                "  UNION SELECT k.kid FROM hub_trusted_keys k JOIN doomed d ON k.accepted_via = d.kid"
                "  WHERE k.hub_url = ?"
                ") SELECT kid FROM doomed",
                (hub_url, *sorted(kids), hub_url),
            )]
            db.executemany(
                "DELETE FROM hub_trusted_keys WHERE hub_url = ? AND kid = ?",
                [(hub_url, kid) for kid in doomed],
            )
        return sorted(doomed)

    # ── the browser's sends ──────────────────────────────────────────────

    def claim_send(
        self, user_id: str, project_id: str, client_message_id: str, message_id: str, *, now: float,
    ) -> str:
        """The message id for the browser's retry key: ``message_id`` the first
        time, the ORIGINAL one on every repeat (so a retried send is one message)."""
        with self._store._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO hub_sends (user_id, project_id, client_message_id,"
                " message_id, created_at) VALUES (?,?,?,?,?)",
                (user_id, project_id, client_message_id, message_id, now),
            )
            return db.execute(
                "SELECT message_id FROM hub_sends WHERE user_id = ? AND project_id = ?"
                " AND client_message_id = ?", (user_id, project_id, client_message_id),
            ).fetchone()[0]

    def claimed_send(self, user_id: str, project_id: str, client_message_id: str) -> Optional[str]:
        """The message id already claimed for the browser's retry key, if any."""
        row = self._store._db().execute(
            "SELECT message_id FROM hub_sends WHERE user_id = ? AND project_id = ?"
            " AND client_message_id = ?", (user_id, project_id, client_message_id),
        ).fetchone()
        return row[0] if row is not None else None

    # ── pins ─────────────────────────────────────────────────────────────

    def pin_chain(
        self, raw: Mapping[str, Any], *, aud: str, deployment_id: Optional[str],
        deployment_name: Optional[str], now: float,
    ) -> PinResult:
        """Pin a ``deployment_key`` reply's chain, as received. The ONLY writer
        of ``hub_pins``: it runs ``verify_key_chain`` itself and raises
        :class:`ChainRejected`, writing nothing, when that fails. Then, in one
        transaction, against what is pinned for the chain's genesis:

        - a key already pinned under ANOTHER genesis, or a stored chain that is
          not a prefix of this one and this one not a prefix of it: CONFLICT,
          nothing written;
        - this chain no longer than the stored one: UNCHANGED (a truncated
          chain never moves the head back);
        - otherwise the new links are added: NEW or EXTENDED.

        The reply's ``revoked`` list is the hub's word, not the deployment's:
        it is never written here (only a deployment-signed revoke is, through
        ``keys.apply_key_revoked``); ``keys.pin_deployment_key`` refuses to
        pin a chain whose head the hub calls revoked. A link added after a
        pinned link of the same chain was revoked is stored revoked too: a
        revoke covers the named key and every descendant, including ones
        met later."""
        verified = verify_key_chain(raw, aud=aud, deployment_id=deployment_id)
        if verified is None:
            raise ChainRejected("the key chain did not verify")
        reply = verified.model
        chain = list(raw["chain"])
        fps = [link["fingerprint"] for link in chain]
        genesis = reply.genesis_fp
        with self._store._tx() as db:
            marks = ", ".join("?" * len(fps))
            if db.execute(
                f"SELECT 1 FROM hub_pins WHERE fingerprint IN ({marks}) AND genesis_fp != ?",
                (*fps, genesis),
            ).fetchone():
                return PinResult.CONFLICT
            stored = [r[0] for r in db.execute(
                "SELECT fingerprint FROM hub_pins WHERE genesis_fp = ? ORDER BY seq", (genesis,),
            )]
            shared = min(len(stored), len(fps))
            if stored[:shared] != fps[:shared]:
                return PinResult.CONFLICT
            revoked_above = db.execute(
                "SELECT MIN(revoked_at) FROM hub_pins WHERE genesis_fp = ? AND revoked_at IS NOT NULL",
                (genesis,),
            ).fetchone()[0]
            for seq in range(len(stored), len(fps)):
                link = chain[seq]
                rotation = link.get("rotation")
                db.execute(
                    "INSERT INTO hub_pins (fingerprint, genesis_fp, seq, prev_fp, pubkey, rotation,"
                    " rotation_purpose, rotation_ts, deployment_id, deployment_name, first_seen_at,"
                    " revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (link["fingerprint"], genesis, seq, link.get("prev"),
                     b64url_decode(link["pubkey"], length=32),
                     _dumps(rotation) if rotation is not None else None,
                     Purpose.KEY_ROTATE.value if rotation is not None else None,
                     rotation.get("ts") if rotation is not None else None,
                     deployment_id, deployment_name, now,
                     now if revoked_above is not None else None),
                )
            if deployment_name is not None:
                db.execute(
                    "UPDATE hub_pins SET deployment_name = ? WHERE genesis_fp = ?",
                    (deployment_name, genesis),
                )
        if not stored:
            return PinResult.NEW
        return PinResult.EXTENDED if len(fps) > len(stored) else PinResult.UNCHANGED

    def pin_for(self, fingerprint: str) -> Optional[Pin]:
        row = self._store._db().execute(
            "SELECT p.*, (SELECT MAX(seq) FROM hub_pins h WHERE h.genesis_fp = p.genesis_fp) AS head,"
            " (SELECT identity_changed_at FROM hub_pins g WHERE g.genesis_fp = p.genesis_fp"
            "   AND g.seq = 0) AS root_changed"
            " FROM hub_pins p WHERE p.fingerprint = ?", (fingerprint,),
        ).fetchone()
        if row is None:
            return None
        return Pin(
            fingerprint=row["fingerprint"], genesis_fp=row["genesis_fp"], seq=row["seq"],
            pubkey=bytes(row["pubkey"]), is_head=row["seq"] == row["head"],
            deployment_id=row["deployment_id"], deployment_name=row["deployment_name"],
            revoked_at=row["revoked_at"], identity_changed_at=row["root_changed"],
        )

    def first_seen(self, genesis_fp: str) -> Optional[float]:
        """When this deployment first pinned the chain rooted at ``genesis_fp``."""
        row = self._store._db().execute(
            "SELECT first_seen_at FROM hub_pins WHERE genesis_fp = ? AND seq = 0", (genesis_fp,),
        ).fetchone()
        return row[0] if row else None

    def chain(self, genesis_fp: str) -> list[Pin]:
        """Every key pinned under ``genesis_fp``, genesis first."""
        fps = [r[0] for r in self._store._db().execute(
            "SELECT fingerprint FROM hub_pins WHERE genesis_fp = ? ORDER BY seq", (genesis_fp,),
        )]
        return [pin for pin in (self.pin_for(fp) for fp in fps) if pin is not None]

    def genesis_of(self, fingerprint: str) -> Optional[str]:
        row = self._store._db().execute(
            "SELECT genesis_fp FROM hub_pins WHERE fingerprint = ?", (fingerprint,),
        ).fetchone()
        return row[0] if row else None

    def revoke_pins(self, genesis_fp: str, fingerprints: list[str], *, now: float) -> None:
        with self._store._tx() as db:
            self._revoke(db, genesis_fp, fingerprints, now)

    def _revoke(self, db, genesis_fp: str, fingerprints: list[str], now: float) -> None:
        if not fingerprints:
            return
        marks = ", ".join("?" * len(fingerprints))
        cur = db.execute(
            "UPDATE hub_pins SET revoked_at = COALESCE(revoked_at, ?)"
            f" WHERE genesis_fp = ? AND fingerprint IN ({marks})",
            (now, genesis_fp, *fingerprints),
        )
        if cur.rowcount:
            db.execute(
                "UPDATE hub_pins SET identity_changed_at = COALESCE(identity_changed_at, ?)"
                " WHERE genesis_fp = ? AND seq = 0", (now, genesis_fp),
            )

    # ── deployment blocks ────────────────────────────────────────────────

    def block_deployment(
        self, scope: str, fingerprint: str, *, deployment_name: str, now: float,
    ) -> str:
        """Block a deployment on ``scope`` (a hub connection id, or
        ``SERVER_WIDE``) by any key it has used: stored under its genesis
        fingerprint, so the block survives its rotations. Idempotent; returns
        the genesis fingerprint stored."""
        genesis = self.genesis_of(fingerprint) or fingerprint
        with self._store._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO hub_blocked_deployments"
                " (scope, genesis_fp, deployment_name, created_at) VALUES (?,?,?,?)",
                (scope, genesis, deployment_name, now),
            )
        return genesis

    def unblock_deployment(self, scope: str, fingerprint: str) -> bool:
        genesis = self.genesis_of(fingerprint) or fingerprint
        with self._store._tx() as db:
            cur = db.execute(
                "DELETE FROM hub_blocked_deployments WHERE scope = ? AND genesis_fp = ?",
                (scope, genesis),
            )
        return cur.rowcount == 1

    def blocked_deployments(self, scope: str) -> list[BlockedDeployment]:
        rows = self._store._db().execute(
            "SELECT scope, genesis_fp, deployment_name, created_at FROM hub_blocked_deployments"
            " WHERE scope = ? ORDER BY created_at", (scope,),
        ).fetchall()
        return [BlockedDeployment(**dict(r)) for r in rows]

    def is_deployment_blocked(self, scope: str, genesis_fp: str) -> bool:
        """Blocked on this connection, or server-wide."""
        return self._store._db().execute(
            "SELECT 1 FROM hub_blocked_deployments WHERE genesis_fp = ? AND scope IN (?, ?)",
            (genesis_fp, scope, SERVER_WIDE),
        ).fetchone() is not None

    # ── stand-ins ────────────────────────────────────────────────────────

    def upsert_remote_agent(
        self, *, genesis_fp: str, agent_name: str, deployment_name: str,
        current_fp: Optional[str] = None, deployment_id: Optional[str] = None,
        cert: Optional[Mapping[str, Any]] = None, now: float,
    ) -> RemoteAgent:
        """The stand-in for ``agent_name`` on the deployment rooted at
        ``genesis_fp``. Its id is ``agent_ref(genesis_fp, agent_name)`` and
        never changes when that deployment rotates; the rest is refreshed.
        ``cert`` is the last full AgentCert seen, stored verbatim with its purpose."""
        agent_id = agent_ref(genesis_fp, agent_name)
        cert_text = _dumps(cert) if cert is not None else None
        with self._store._tx() as db:
            db.execute(
                "INSERT INTO remote_agents (id, genesis_fp, agent_name, current_fp, deployment_id,"
                " deployment_name, display, cert, cert_purpose, cert_serial, cert_not_after,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET"
                "  current_fp = COALESCE(excluded.current_fp, current_fp),"
                "  deployment_id = COALESCE(excluded.deployment_id, deployment_id),"
                "  deployment_name = excluded.deployment_name, display = excluded.display,"
                "  cert = COALESCE(excluded.cert, cert),"
                "  cert_purpose = COALESCE(excluded.cert_purpose, cert_purpose),"
                "  cert_serial = COALESCE(excluded.cert_serial, cert_serial),"
                "  cert_not_after = COALESCE(excluded.cert_not_after, cert_not_after),"
                "  updated_at = excluded.updated_at",
                (agent_id, genesis_fp, agent_name, current_fp, deployment_id, deployment_name,
                 display_label(agent_name, deployment_name), cert_text,
                 Purpose.AGENT_CERT.value if cert_text is not None else None,
                 cert.get("serial") if cert is not None else None,
                 cert.get("not_after") if cert is not None else None, now, now),
            )
        agent = self.remote_agent(agent_id)
        assert agent is not None
        return agent

    def remote_agent(self, agent_id: str) -> Optional[RemoteAgent]:
        row = self._store._db().execute(
            "SELECT id, genesis_fp, agent_name, current_fp, deployment_id, deployment_name,"
            " display, cert, cert_serial, cert_not_after FROM remote_agents WHERE id = ?",
            (agent_id,),
        ).fetchone()
        if row is None:
            return None
        data = dict(row)
        data["cert"] = json.loads(data["cert"]) if data["cert"] else None
        return RemoteAgent(**data)

    def remote_agents_of_root(self, genesis_fp: str) -> list[RemoteAgent]:
        ids = [r[0] for r in self._store._db().execute(
            "SELECT id FROM remote_agents WHERE genesis_fp = ?", (genesis_fp,))]
        return [a for a in (self.remote_agent(i) for i in ids) if a is not None]

    # ── outbox: hub rows ─────────────────────────────────────────────────

    def enqueue_hub_request(
        self, *, connection_id: str, target_genesis_fp: str, project_id: str,
        message_id: str, envelope: Mapping[str, Any], now: float,
    ) -> str:
        """Queue a requester's signed envelope for the agent it names. Its
        conversation is ``<target genesis>/<the envelope's conversation key>``.
        A repeat (same project and message id) returns the first row's id."""
        row_id = uuid.uuid4().hex
        body = envelope.get("body")
        text = body.get("text", "") if isinstance(body, Mapping) else ""
        with self._store._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO outbox (id, connection_id, conversation_key, kind,"
                " project_id, message_id, part_index, retry_key, text, state, attempts,"
                " next_attempt_at, created_at, updated_at, envelope, envelope_purpose)"
                " VALUES (?,?,?,?,?,?,0,?,?,?,0,?,?,?,?,?)",
                (row_id, connection_id, f"{target_genesis_fp}/{envelope['conversation_key']}",
                 KIND_HUB_REQUEST, project_id, message_id, f"{row_id}:0", text, PENDING,
                 now, now, now, _dumps(envelope), Purpose.ENVELOPE.value),
            )
            return db.execute(
                "SELECT id FROM outbox WHERE project_id = ? AND message_id = ? AND part_index = 0",
                (project_id, message_id),
            ).fetchone()[0]

    def set_reply_envelope(self, row_id: str, envelope: Mapping[str, Any]) -> bool:
        """A host's reply row, signed once at its first send: store the
        envelope (with its purpose) unless the row already has one, so a
        re-relay never re-signs. True if it was stored now."""
        with self._store._tx() as db:
            cur = db.execute(
                "UPDATE outbox SET envelope = ?, envelope_purpose = ? WHERE id = ? AND envelope IS NULL",
                (_dumps(envelope), Purpose.ENVELOPE.value, row_id),
            )
        return cur.rowcount == 1

    def mark_forwarded(self, row_id: str, *, now: float) -> None:
        """The relay frame was written to the hub's socket: the FIRST time
        only, and never reset. From now on the target may have the message."""
        with self._store._tx() as db:
            db.execute(
                "UPDATE outbox SET forwarded_at = COALESCE(forwarded_at, ?) WHERE id = ?",
                (now, row_id),
            )

    def await_receipt(self, row_id: str, *, now: float) -> None:
        """The hub took the relay: ``sending`` -> ``awaiting_receipt``, one more
        relay counted, and the next re-relay due after the back-off."""
        with self._store._tx() as db:
            row = db.execute("SELECT relay_count FROM outbox WHERE id = ?", (row_id,)).fetchone()
            if row is None:
                return
            count = row["relay_count"] + 1
            db.execute(
                "UPDATE outbox SET state = ?, relay_count = ?, receipt_due_at = ?, reason = NULL,"
                " detail = NULL, updated_at = ? WHERE id = ? AND state = ?",
                (AWAITING_RECEIPT, count, now + hub_delivery.re_relay_delay(count), now,
                 row_id, SENDING),
            )

    def park(self, row_id: str, *, reason: str, until: Optional[float], now: float) -> None:
        """Wait for the target, the hub or ``until`` (a ``retry_after``),
        with ``reason`` showing why. No attempt is counted."""
        with self._store._tx() as db:
            db.execute(
                "UPDATE outbox SET state = ?, reason = ?, parked_until = ?, updated_at = ?"
                " WHERE id = ? AND state IN (?, ?)",
                (PARKED, reason, until, now, row_id, PENDING, SENDING),
            )

    def wake(self, *, connection_id: str, conversation_prefix: Optional[str], now: float) -> int:
        """Something changed for these rows' target (it came online, the hub
        reconnected): every parked row not waiting on a ``retry_after`` goes
        back to ``pending``, due now."""
        sql = (
            "UPDATE outbox SET state = ?, next_attempt_at = ?, parked_until = NULL, updated_at = ?"
            " WHERE connection_id = ? AND state = ? AND (parked_until IS NULL OR parked_until <= ?)"
        )
        args: list = [PENDING, now, now, connection_id, PARKED, now]
        if conversation_prefix is not None:
            sql += " AND substr(conversation_key, 1, ?) = ?"
            args += [len(conversation_prefix), conversation_prefix]
        with self._store._tx() as db:
            return db.execute(sql, args).rowcount

    def wake_due(self, *, now: float, re_relay_limit: Optional[int] = None) -> int:
        """Rows whose wait is over go back to ``pending``, due now: an
        ``awaiting_receipt`` row past ``receipt_due_at`` (its re-relay; at most
        ``re_relay_limit`` of them, the longest overdue first, so a backlog
        stays ``awaiting_receipt`` until the relay bucket can send it) and a
        ``parked`` row past ``parked_until``."""
        limit = -1 if re_relay_limit is None else re_relay_limit
        with self._store._tx() as db:
            woken = db.execute(
                "UPDATE outbox SET state = ?, next_attempt_at = ?, receipt_due_at = NULL,"
                " updated_at = ? WHERE id IN (SELECT id FROM outbox WHERE state = ?"
                " AND receipt_due_at <= ? ORDER BY receipt_due_at LIMIT ?)",
                (PENDING, now, now, AWAITING_RECEIPT, now, limit),
            ).rowcount
            woken += db.execute(
                "UPDATE outbox SET state = ?, next_attempt_at = ?, parked_until = NULL,"
                " updated_at = ? WHERE state = ? AND parked_until <= ?",
                (PENDING, now, now, PARKED, now),
            ).rowcount
        return woken

    def hub_row_for_message(self, message_id: str) -> Optional[OutboxRow]:
        """The hub row (on any hub connection) carrying ``message_id``: what a
        receipt from the hub names. The newest when two connections have one."""
        row = self._store._db().execute(
            f"SELECT {', '.join('o.' + c.strip() for c in _OUTBOX_COLUMNS.split(','))}"
            " FROM outbox o JOIN connections c ON c.id = o.connection_id AND c.channel = ?"
            " WHERE o.message_id = ? ORDER BY o.part_index, o.created_at DESC LIMIT 1",
            (HUB_CHANNEL, message_id),
        ).fetchone()
        return _outbox_row(row) if row is not None else None

    def wake_hub_rows(
        self, *, now: float, reasons: Optional[tuple[str, ...]] = None,
        conversation_prefix: Optional[str] = None,
    ) -> int:
        """``wake`` across every hub connection: parked rows not waiting on a
        ``retry_after``, optionally only those parked for one of ``reasons``
        or bound for one target (``<its genesis fp>/``), go back to
        ``pending``, due now."""
        sql = (
            "UPDATE outbox SET state = ?, next_attempt_at = ?, parked_until = NULL, updated_at = ?"
            " WHERE state = ? AND (parked_until IS NULL OR parked_until <= ?)"
            " AND connection_id IN (SELECT id FROM connections WHERE channel = ?)"
        )
        args: list = [PENDING, now, now, PARKED, now, HUB_CHANNEL]
        if reasons is not None:
            sql += f" AND reason IN ({_marks(reasons)})"
            args += list(reasons)
        if conversation_prefix is not None:
            sql += " AND substr(conversation_key, 1, ?) = ?"
            args += [len(conversation_prefix), conversation_prefix]
        with self._store._tx() as db:
            return db.execute(sql, args).rowcount

    def rearm_awaiting(self, *, now: float) -> int:
        """The socket came back: every ``awaiting_receipt`` hub row is due for
        one re-relay now (``wake_due`` still paces them through the relay
        bucket). Its relay count, so its back-off, is unchanged."""
        with self._store._tx() as db:
            return db.execute(
                "UPDATE outbox SET receipt_due_at = ? WHERE state = ? AND receipt_due_at > ?"
                " AND connection_id IN (SELECT id FROM connections WHERE channel = ?)",
                (now, AWAITING_RECEIPT, now, HUB_CHANNEL),
            ).rowcount

    def parked_targets(self, reason: str) -> list[str]:
        """The target genesis fingerprints of hub rows parked for ``reason``."""
        rows = self._store._db().execute(
            "SELECT DISTINCT substr(o.conversation_key, 1, instr(o.conversation_key, '/') - 1)"
            " FROM outbox o JOIN connections c ON c.id = o.connection_id AND c.channel = ?"
            " WHERE o.state = ? AND o.reason = ?",
            (HUB_CHANNEL, PARKED, reason),
        ).fetchall()
        return [r[0] for r in rows if r[0]]

    def genesis_for_deployment(self, deployment_id: str) -> Optional[str]:
        """The root a deployment signs with now. After a reclaim two roots are
        pinned under one deployment id: the one whose identity has not
        changed wins, the newest first; a changed root only when nothing else is."""
        row = self._store._db().execute(
            "SELECT p.genesis_fp FROM hub_pins p WHERE p.deployment_id = ? AND p.seq = 0"
            " ORDER BY (p.identity_changed_at IS NOT NULL), p.first_seen_at DESC LIMIT 1", (deployment_id,),
        ).fetchone()
        return row[0] if row else None

    def deployment_ids_for(self, genesis_fps: list[str]) -> dict[str, str]:
        """deployment id -> genesis fp, for the pinned chains named."""
        if not genesis_fps:
            return {}
        rows = self._store._db().execute(
            f"SELECT DISTINCT deployment_id, genesis_fp FROM hub_pins WHERE genesis_fp IN ({_marks(tuple(genesis_fps))})"
            " AND deployment_id IS NOT NULL", tuple(genesis_fps),
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    def _hub_row(self, db, connection_id: str, message_id: str):
        return db.execute(
            f"SELECT {_OUTBOX_COLUMNS} FROM outbox WHERE connection_id = ? AND message_id = ?"
            " ORDER BY part_index LIMIT 1", (connection_id, message_id),
        ).fetchone()

    def apply_receipt(
        self, connection_id: str, message_id: str, t: "hub_delivery.RowTransition", *, now: float,
    ) -> Optional[OutboxRow]:
        """Apply a verified receipt's transition to the row it answers, if
        that row has not ended (a held row counts as not ended for
        ``picked_up``). Returns the row as it is now, or None when nothing
        changed (no such row, it ended already, or ``unchanged``)."""
        with self._store._tx() as db:
            row = self._hub_row(db, connection_id, message_id)
            if row is None or t.kind == "unchanged":
                return None
            held = row["state"] == SENT and row["last_receipt"] in hub_delivery.HELD_RECEIPTS
            if row["state"] not in OPEN_STATES and not held:
                return None
            if t.kind == "held" and held:
                if t.last_receipt == row["last_receipt"] and t.delivery_detail != row["delivery_detail"]:
                    # Still held, for a new reason (the runner came back but
                    # cannot isolate): the probe clock runs on.
                    db.execute("UPDATE outbox SET delivery_detail = ?, updated_at = ? WHERE id = ?",
                               (t.delivery_detail, now, row["id"]))
                    return _outbox_row(self._hub_row(db, connection_id, message_id))
                return None                               # still held: the probe clock runs on
            if t.kind == "sent":
                db.execute(
                    "UPDATE outbox SET state = ?, last_receipt = ?, reason = NULL, detail = NULL,"
                    " receipt_due_at = NULL, parked_until = NULL, probe_due_at = NULL,"
                    " updated_at = ? WHERE id = ?",
                    (SENT, t.last_receipt, now, row["id"]),
                )
            elif t.kind == "held":
                db.execute(
                    "UPDATE outbox SET state = ?, last_receipt = ?, reason = NULL, detail = NULL,"
                    " delivery_detail = ?, receipt_due_at = NULL, parked_until = NULL, probe_due_at = ?,"
                    " updated_at = ? WHERE id = ?",
                    (SENT, t.last_receipt, t.delivery_detail, now + hub_delivery.PROBE_SECONDS, now, row["id"]),
                )
            else:
                db.execute(
                    "UPDATE outbox SET state = ?, last_receipt = ?, reason = ?,"
                    " delivery_detail = ?, retry_at = ?, receipt_due_at = NULL,"
                    " parked_until = NULL, probe_due_at = NULL, updated_at = ? WHERE id = ?",
                    (FAILED, t.last_receipt, t.reason, t.delivery_detail, t.retry_at, now, row["id"]),
                )
            return _outbox_row(self._hub_row(db, connection_id, message_id))

    def mark_delivered_late(
        self, connection_id: str, message_id: str, *, last_receipt: str, now: float,
        project_id: Optional[str] = None,
    ) -> Optional[OutboxRow]:
        """The target had it after all (a reply, or an accepted / picked-up
        receipt, for a row that ended ``expired_72h`` / ``held_expired`` /
        ``key_revoked``): ``sent``, ``delivered_late``, with ``last_receipt``;
        its reason and ``created_at`` stay, so what the requester was told and
        when it expired do not change. ``project_id`` (a reply): only a row of
        that thread, never one in another conversation the reply names."""
        with self._store._tx() as db:
            row = self._hub_row(db, connection_id, message_id)
            if row is None or row["state"] not in (EXPIRED, FAILED) or (
                row["reason"] not in LATE_DELIVERY_REASONS
            ) or (project_id is not None and row["project_id"] != project_id):
                return None
            db.execute(
                "UPDATE outbox SET state = ?, delivered_late = 1, last_receipt = ?, updated_at = ?"
                " WHERE id = ?", (SENT, last_receipt, now, row["id"]),
            )
            return _outbox_row(self._hub_row(db, connection_id, message_id))

    def requests_delivered_since(self, since: float) -> list[tuple[OutboxRow, float]]:
        """Requests the target has (``sent``, not held), changed since
        ``since``: the ones whose reply may still be awaited. Each with when
        it last changed (its receipt)."""
        rows = self._store._db().execute(
            f"SELECT {_OUTBOX_COLUMNS}, updated_at AS changed_at FROM outbox WHERE kind = ? AND state = ?"
            " AND updated_at >= ?"
            f" AND (last_receipt IS NULL OR last_receipt NOT IN ({_marks(tuple(hub_delivery.HELD_RECEIPTS))}))"
            " ORDER BY created_at, rowid",
            (KIND_HUB_REQUEST, SENT, since, *sorted(hub_delivery.HELD_RECEIPTS)),
        ).fetchall()
        return [(_outbox_row({k: r[k] for k in r.keys() if k != "changed_at"}), r["changed_at"]) for r in rows]

    def request_row(self, project_id: str, message_id: str) -> Optional[OutboxRow]:
        """A requester's row, by its project and message id."""
        row = self._store._db().execute(
            f"SELECT {_OUTBOX_COLUMNS} FROM outbox WHERE project_id = ? AND message_id = ? AND kind = ?"
            " ORDER BY part_index LIMIT 1", (project_id, message_id, KIND_HUB_REQUEST),
        ).fetchone()
        return _outbox_row(row) if row is not None else None

    def request_rows(self, project_id: str) -> list[OutboxRow]:
        """A requester thread's rows, oldest first: one per message sent."""
        rows = self._store._db().execute(
            f"SELECT {_OUTBOX_COLUMNS} FROM outbox WHERE project_id = ? AND kind = ?"
            " ORDER BY created_at, rowid", (project_id, KIND_HUB_REQUEST),
        ).fetchall()
        return [_outbox_row(r) for r in rows]

    def hub_rows_open(self) -> list[OutboxRow]:
        """Every hub row not ended, held rows included: what the hub client
        re-opens (pending work, pushes) at boot."""
        rows = self._store._db().execute(
            f"SELECT {', '.join('o.' + c.strip() for c in _OUTBOX_COLUMNS.split(','))}"
            " FROM outbox o JOIN connections c ON c.id = o.connection_id AND c.channel = ?"
            f" WHERE o.state IN ({_marks(OPEN_STATES)})"
            "    OR (o.state = ? AND o.last_receipt IN (?, ?))"
            " ORDER BY o.created_at, o.rowid",
            (HUB_CHANNEL, *OPEN_STATES, SENT, *sorted(hub_delivery.HELD_RECEIPTS)),
        ).fetchall()
        return [_outbox_row(r) for r in rows]

    def hub_demand(self, *, now: float) -> Optional[str]:
        """Why this server needs its hub socket now (server/hub/demand.py), or
        None: an agent channel on (or an unregister still to send), an active
        retained agent, a requester thread open or draining, or a hub row not
        ended (held rows included)."""
        db = self._store._db()
        checks = (
            ("channel", "SELECT 1 FROM hub_channels WHERE enabled = 1 OR unregister_pending = 1 LIMIT 1", ()),
            ("retained", "SELECT 1 FROM hub_retained WHERE state = ? LIMIT 1", (RETAIN_ACTIVE,)),
            ("thread", "SELECT 1 FROM hub_threads WHERE closed_at IS NULL OR drain_until > ? LIMIT 1", (now,)),
            ("outbox",
             "SELECT 1 FROM outbox o JOIN connections c ON c.id = o.connection_id AND c.channel = ?"
             f" WHERE o.state IN ({_marks(OPEN_STATES)}) OR (o.state = ? AND o.last_receipt IN (?, ?)) LIMIT 1",
             (HUB_CHANNEL, *OPEN_STATES, SENT, *sorted(hub_delivery.HELD_RECEIPTS))),
        )
        for reason, sql, args in checks:
            if db.execute(sql, args).fetchone() is not None:
                return reason
        return None

    def end_held(self, row_id: str, *, reason: str, now: float) -> bool:
        """End a held row (``sent``, ``last_receipt`` held_*) ``failed`` with
        ``reason``; ``last_receipt`` is kept, so the requester's view still
        knows it was held. False if it is no longer held."""
        with self._store._tx() as db:
            return db.execute(
                "UPDATE outbox SET state = ?, reason = ?, probe_due_at = NULL, updated_at = ?"
                f" WHERE id = ? AND state = ? AND last_receipt IN ({_marks(tuple(hub_delivery.HELD_RECEIPTS))})",
                (FAILED, reason, now, row_id, SENT, *sorted(hub_delivery.HELD_RECEIPTS)),
            ).rowcount == 1

    def fail_open_rows(self, connection_id: str, *, reason: str, now: float,
                       project_ids: Optional[list[str]] = None) -> list[str]:
        """End every row of one hub connection that has not ended (held rows
        are not open), optionally only those of ``project_ids``, ``failed``
        with ``reason``. Returns their ids."""
        sql = f"SELECT id FROM outbox WHERE connection_id = ? AND state IN ({_marks(OPEN_STATES)})"
        args: list = [connection_id, *OPEN_STATES]
        if project_ids is not None:
            if not project_ids:
                return []
            sql += f" AND project_id IN ({_marks(tuple(project_ids))})"
            args += list(project_ids)
        with self._store._tx() as db:
            ids = [r[0] for r in db.execute(sql, args)]
            db.executemany(
                "UPDATE outbox SET state = ?, reason = ?, receipt_due_at = NULL, parked_until = NULL,"
                " updated_at = ? WHERE id = ?", [(FAILED, reason, now, i) for i in ids],
            )
        return ids

    def set_probe_due(self, row_id: str, at: float) -> None:
        with self._store._tx() as db:
            db.execute("UPDATE outbox SET probe_due_at = ? WHERE id = ?", (at, row_id))

    def replace_envelope(self, row_id: str, envelope: Mapping[str, Any], purpose: Purpose) -> bool:
        """A re-signed envelope, written with its purpose in one statement,
        for a row that has not ended (held rows are never re-signed)."""
        with self._store._tx() as db:
            return db.execute(
                "UPDATE outbox SET envelope = ?, envelope_purpose = ?"
                f" WHERE id = ? AND state IN ({_marks(OPEN_STATES)})",
                (_dumps(envelope), purpose.value, row_id, *OPEN_STATES),
            ).rowcount == 1

    # ── held hub messages (host side) ────────────────────────────────────

    def inbound_event_waiting(self, connection_id: str, event_id: str) -> bool:
        """Whether a received message still waits to reach its thread: held in
        a Request, or buffered and not yet flushed."""
        db = self._store._db()
        return db.execute(
            "SELECT 1 FROM held_messages WHERE connection_id = ? AND event_id = ?"
            " UNION ALL SELECT 1 FROM inbound_buffer WHERE connection_id = ? AND event_id = ?"
            " AND flushed = 0 LIMIT 1", (connection_id, event_id, connection_id, event_id),
        ).fetchone() is not None

    def expire_held_requests(self, *, held_before: float) -> list[tuple[str, str]]:
        """Drop the messages held before ``held_before`` in PENDING Requests on
        hub connections, and every such Request left holding nothing, in one
        commit. A Request being allowed is never touched. Returns the
        (connection id, event id) of each message dropped."""
        with self._store._tx() as db:
            rows = db.execute(
                "SELECT h.message_id, h.connection_id, h.event_id, h.request_id FROM held_messages h"
                " JOIN requests r ON r.id = h.request_id"
                " JOIN connections c ON c.id = h.connection_id AND c.channel = ?"
                " WHERE r.state = ? AND h.received_at < ?",
                (HUB_CHANNEL, REQUEST_PENDING, held_before),
            ).fetchall()
            db.executemany("DELETE FROM held_messages WHERE message_id = ?",
                           [(r["message_id"],) for r in rows])
            for request_id in {r["request_id"] for r in rows}:
                db.execute(
                    "DELETE FROM requests WHERE id = ? AND state = ? AND NOT EXISTS"
                    " (SELECT 1 FROM held_messages WHERE request_id = ?)",
                    (request_id, REQUEST_PENDING, request_id),
                )
        return [(r["connection_id"], r["event_id"]) for r in rows]

    # ── which of a remote person's agents sent their newest message ──────

    def note_via_agent(
        self, connection_id: str, user_key: str, via_agent: Optional[str], *, sent_at: float,
    ) -> None:
        """Record who sent this person's message: one of their own agents
        (``via_agent``, already cleaned) or they themselves (None). Only a
        newer message replaces what is stored, so a late re-relay of an older
        one does not relabel them."""
        with self._store._tx() as db:
            db.execute(
                "INSERT INTO hub_sender_via_agent (connection_id, user_key, via_agent, sent_at)"
                " VALUES (?,?,?,?) ON CONFLICT (connection_id, user_key) DO UPDATE SET"
                " via_agent = excluded.via_agent, sent_at = excluded.sent_at"
                " WHERE excluded.sent_at >= hub_sender_via_agent.sent_at",
                (connection_id, user_key, via_agent, sent_at),
            )

    def via_agent_for(self, connection_id: Optional[str], user_key: Optional[str]) -> Optional[str]:
        """The agent that sent this person's newest kept message, or None."""
        if not connection_id or not user_key:
            return None
        row = self._store._db().execute(
            "SELECT via_agent FROM hub_sender_via_agent WHERE connection_id = ? AND user_key = ?",
            (connection_id, user_key),
        ).fetchone()
        return row["via_agent"] if row is not None else None

    # ── requester threads ────────────────────────────────────────────────

    def open_thread(
        self, *, user_id: str, client_thread_key: str, project_id: str, stand_in: RemoteAgent, now: float,
        started_by_agent_id: Optional[str] = None,
    ) -> HubThread:
        """Record ``project_id`` as the user's thread with ``stand_in`` for the
        browser's ``client_thread_key``. Deduped on (user, key): a repeat
        returns the thread already there, whatever ``project_id`` it was given."""
        with self._store._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO hub_threads (project_id, user_id, client_thread_key,"
                " stand_in_id, genesis_fp, agent_name, created_at, started_by_agent_id)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (project_id, user_id, client_thread_key, stand_in.id, stand_in.genesis_fp,
                 stand_in.agent_name, now, started_by_agent_id),
            )
        thread = self.thread_for_key(user_id, client_thread_key)
        assert thread is not None
        return thread

    # ── the room bridge ──────────────────────────────────────────────────

    @staticmethod
    def bridge_key(bound_project_id: str, bound_room: str, stand_in_id: str) -> str:
        return f"bridge:{bound_project_id}/{bound_room}/{stand_in_id}"

    def open_bridge_thread(
        self, *, user_id: str, project_id: str, stand_in: RemoteAgent, bound_project_id: str,
        bound_room: str, now: float,
    ) -> HubThread:
        """The user's hidden bridge thread for (workroom, stand-in); deduped,
        a repeat returns the thread already there."""
        key = self.bridge_key(bound_project_id, bound_room, stand_in.id)
        with self._store._tx() as db:
            db.execute(
                "INSERT OR IGNORE INTO hub_threads (project_id, user_id, client_thread_key,"
                " stand_in_id, genesis_fp, agent_name, created_at, kind, bound_project_id, bound_room)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (project_id, user_id, key, stand_in.id, stand_in.genesis_fp, stand_in.agent_name, now,
                 "room_bridge", bound_project_id, bound_room),
            )
        thread = self.thread_for_key(user_id, key)
        assert thread is not None
        return thread

    def bridge_thread(self, user_id: str, bound_project_id: str, bound_room: str,
                      stand_in_id: str) -> Optional[HubThread]:
        return self.thread_for_key(user_id, self.bridge_key(bound_project_id, bound_room, stand_in_id))

    def bridge_project_ids(self) -> set[str]:
        """Every bridge thread's project: plumbing, kept out of project lists."""
        rows = self._store._db().execute(
            "SELECT project_id FROM hub_threads WHERE kind = 'room_bridge'").fetchall()
        return {r[0] for r in rows}

    def live_bridge_rooms(self, user_id: str, stand_in_id: str) -> int:
        rows = self._store._db().execute(
            "SELECT COUNT(*) FROM hub_threads WHERE kind = 'room_bridge' AND user_id = ?"
            " AND stand_in_id = ? AND closed_at IS NULL", (user_id, stand_in_id)).fetchone()
        return int(rows[0])

    def bridge_threads_for(self, user_id: str, stand_in_id: str) -> list[HubThread]:
        return self._threads("kind = 'room_bridge' AND user_id = ? AND stand_in_id = ?", (user_id, stand_in_id))

    def claim_relay(self, *, room_project_id: str, room: str, room_message_id: str, stand_in_id: str,
                    user_id: str, state: str, reason: Optional[str], now: float) -> bool:
        """Record a relay decision for (room message, stand-in) once. True if
        this call recorded it (a replay of the same message is False)."""
        with self._store._tx() as db:
            return db.execute(
                "INSERT OR IGNORE INTO hub_bridge_relays (room_project_id, room, room_message_id,"
                " stand_in_id, user_id, state, reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (room_project_id, room, room_message_id, stand_in_id, user_id, state, reason, now, now),
            ).rowcount == 1

    def set_relay(self, room_message_id: str, stand_in_id: str, *, state: str, reason: Optional[str],
                  now: float, thread_project_id: Optional[str] = None,
                  hub_message_id: Optional[str] = None) -> None:
        with self._store._tx() as db:
            db.execute(
                "UPDATE hub_bridge_relays SET state = ?, reason = ?, updated_at = ?,"
                " thread_project_id = COALESCE(?, thread_project_id),"
                " hub_message_id = COALESCE(?, hub_message_id)"
                " WHERE room_message_id = ? AND stand_in_id = ?",
                (state, reason, now, thread_project_id, hub_message_id, room_message_id, stand_in_id),
            )

    def _relays(self, where: str, args: tuple) -> list[BridgeRelay]:
        rows = self._store._db().execute(
            f"SELECT * FROM hub_bridge_relays WHERE {where} ORDER BY created_at, rowid", args).fetchall()
        return [BridgeRelay(**dict(r)) for r in rows]

    def relay_row(self, room_message_id: str, stand_in_id: str) -> Optional[BridgeRelay]:
        found = self._relays("room_message_id = ? AND stand_in_id = ?", (room_message_id, stand_in_id))
        return found[0] if found else None

    def relay_for_hub_message(self, hub_message_id: str) -> Optional[BridgeRelay]:
        found = self._relays("hub_message_id = ?", (hub_message_id,))
        return found[0] if found else None

    def relays_for_room(self, room_project_id: str, room: str) -> list[BridgeRelay]:
        return self._relays("room_project_id = ? AND room = ?", (room_project_id, room))

    def cancel_bridge_sends(self, db, user_id: str, stand_in_id: str, *, now: float) -> list[str]:
        """Inside an unretain's transaction: every not-yet-sent request of the
        user's bridge threads with this stand-in ends ``failed`` /
        ``cancelled_unretained``, and its relay row ``cancelled``. Returns the
        outbox row ids."""
        threads = [r[0] for r in db.execute(
            "SELECT project_id FROM hub_threads WHERE kind = 'room_bridge' AND user_id = ? AND stand_in_id = ?",
            (user_id, stand_in_id))]
        if not threads:
            return []
        marks = ",".join("?" * len(threads))
        ids = [r[0] for r in db.execute(
            f"SELECT id FROM outbox WHERE kind = ? AND project_id IN ({marks}) AND forwarded_at IS NULL"
            " AND state IN (?, ?)", (KIND_HUB_REQUEST, *threads, PENDING, PARKED))]
        if ids:
            id_marks = ",".join("?" * len(ids))
            db.execute(
                f"UPDATE outbox SET state = ?, reason = ?, updated_at = ? WHERE id IN ({id_marks})",
                (FAILED, "cancelled_unretained", now, *ids))
        db.execute(
            "UPDATE hub_bridge_relays SET state = 'cancelled', reason = 'cancelled_unretained', updated_at = ?"
            " WHERE user_id = ? AND stand_in_id = ? AND state = 'queued'", (now, user_id, stand_in_id))
        return ids

    def take_wake(self, project_id: str, *, day: str, cap: int) -> bool:
        """Count one reply wake of an agent-started thread for ``day``; False
        (and nothing counted) once ``cap`` wakes happened that day."""
        with self._store._tx() as db:
            row = db.execute("SELECT wake_day, wake_count FROM hub_threads WHERE project_id = ?",
                             (project_id,)).fetchone()
            if row is None:
                return False
            count = row["wake_count"] if row["wake_day"] == day else 0
            if count >= cap:
                return False
            db.execute("UPDATE hub_threads SET wake_day = ?, wake_count = ? WHERE project_id = ?",
                       (day, count + 1, project_id))
        return True

    def _threads(self, where: str, args: tuple) -> list[HubThread]:
        rows = self._store._db().execute(
            f"SELECT * FROM hub_threads WHERE {where} ORDER BY created_at, rowid", args,
        ).fetchall()
        return [HubThread(**dict(r)) for r in rows]

    def thread_for_key(self, user_id: str, client_thread_key: str) -> Optional[HubThread]:
        found = self._threads("user_id = ? AND client_thread_key = ?", (user_id, client_thread_key))
        return found[0] if found else None

    def thread_for_project(self, project_id: str) -> Optional[HubThread]:
        found = self._threads("project_id = ?", (project_id,))
        return found[0] if found else None

    def threads_for_stand_in(self, stand_in_id: str) -> list[HubThread]:
        return self._threads("stand_in_id = ?", (stand_in_id,))

    def close_thread(
        self, project_id: str, *, reason: str, now: float, drain_until: Optional[float] = None,
    ) -> bool:
        """Close an open thread with ``reason`` (the first close wins; a closed
        thread is never reopened). True if it closed now."""
        with self._store._tx() as db:
            return db.execute(
                "UPDATE hub_threads SET closed_reason = ?, closed_at = ?, drain_until = ?"
                " WHERE project_id = ? AND closed_at IS NULL",
                (reason, now, drain_until, project_id),
            ).rowcount == 1

    def close_threads_for_root(self, genesis_fp: str, *, reason: str, now: float) -> list[str]:
        """Close every open thread with any agent of the deployment rooted at
        ``genesis_fp`` (its identity changed). Returns their project ids."""
        with self._store._tx() as db:
            ids = [r[0] for r in db.execute(
                "SELECT project_id FROM hub_threads WHERE genesis_fp = ? AND closed_at IS NULL",
                (genesis_fp,),
            )]
            db.executemany(
                "UPDATE hub_threads SET closed_reason = ?, closed_at = ? WHERE project_id = ?",
                [(reason, now, pid) for pid in ids],
            )
        return ids

    # ── retained agents ──────────────────────────────────────────────────

    def retain(
        self, *, user_id: str, stand_in_id: str, description: str, capabilities: list[str], now: float,
    ) -> RetainedRow:
        """Retain ``stand_in_id`` (it must exist in ``remote_agents``) for the
        user, or refresh the listing snapshot of a row already there. A row
        already ``active`` keeps its ``retained_at``; any other row becomes
        ``active`` with ``retained_at`` = now (the user retained it again)."""
        with self._store._tx() as db:
            db.execute(
                "INSERT INTO hub_retained (user_id, stand_in_id, retained_at, state, description,"
                " capabilities) VALUES (?,?,?,?,?,?)"
                " ON CONFLICT(user_id, stand_in_id) DO UPDATE SET"
                "  retained_at = CASE WHEN state = ? THEN retained_at ELSE excluded.retained_at END,"
                "  state = excluded.state, description = excluded.description,"
                "  capabilities = excluded.capabilities",
                (user_id, stand_in_id, now, RETAIN_ACTIVE, description, json.dumps(list(capabilities)),
                 RETAIN_ACTIVE),
            )
        row = self.retained_row(user_id, stand_in_id)
        assert row is not None
        return row

    def delete_retained(self, user_id: str, stand_in_id: str, *, also=None) -> bool:
        """Delete the user's retained row. ``also(db)`` runs in the same
        transaction after the delete, only when a row was deleted (the room
        bridge's unretain effects). True if a row was deleted."""
        with self._store._tx() as db:
            deleted = db.execute(
                "DELETE FROM hub_retained WHERE user_id = ? AND stand_in_id = ?", (user_id, stand_in_id),
            ).rowcount == 1
            if deleted and also is not None:
                also(db)
        return deleted

    def _retained(self, where: str, args: tuple) -> list[RetainedRow]:
        rows = self._store._db().execute(
            "SELECT r.user_id, r.stand_in_id, r.retained_at, r.state, r.description, r.capabilities,"
            " a.agent_name, a.genesis_fp, a.deployment_name"
            " FROM hub_retained r JOIN remote_agents a ON a.id = r.stand_in_id"
            f" WHERE {where} ORDER BY r.retained_at, r.stand_in_id", args,
        ).fetchall()
        out = []
        for r in rows:
            data = dict(r)
            data["capabilities"] = json.loads(data["capabilities"] or "[]")
            out.append(RetainedRow(**data))
        return out

    def retained_row(self, user_id: str, stand_in_id: str) -> Optional[RetainedRow]:
        found = self._retained("r.user_id = ? AND r.stand_in_id = ?", (user_id, stand_in_id))
        return found[0] if found else None

    def retained_for(self, user_id: str) -> list[RetainedRow]:
        return self._retained("r.user_id = ?", (user_id,))

    def retain_local(self, user_id: str, agent_id: str, *, now: float) -> float:
        """Pin a local agent for the user (``local_retained``); idempotent, a
        row already there keeps its ``retained_at``. Returns it."""
        with self._store._tx() as db:
            db.execute(
                "INSERT INTO local_retained (user_id, agent_id, retained_at) VALUES (?,?,?)"
                " ON CONFLICT(user_id, agent_id) DO NOTHING", (user_id, agent_id, now))
            return db.execute("SELECT retained_at FROM local_retained WHERE user_id = ? AND agent_id = ?",
                              (user_id, agent_id)).fetchone()[0]

    def delete_local_retained(self, user_id: str, agent_id: str) -> bool:
        with self._store._tx() as db:
            return db.execute("DELETE FROM local_retained WHERE user_id = ? AND agent_id = ?",
                              (user_id, agent_id)).rowcount == 1

    def local_retained_for(self, user_id: str) -> list[tuple[str, float]]:
        """``(agent_id, retained_at)`` of every local agent the user retained, oldest first."""
        return [(r[0], r[1]) for r in self._store._db().execute(
            "SELECT agent_id, retained_at FROM local_retained WHERE user_id = ?"
            " ORDER BY retained_at, agent_id", (user_id,)).fetchall()]

    def local_retainers(self, agent_id: str) -> list[str]:
        """The users who retained this local agent."""
        return [r[0] for r in self._store._db().execute(
            "SELECT user_id FROM local_retained WHERE agent_id = ? ORDER BY user_id", (agent_id,)).fetchall()]

    def active_retained_ids(self, user_id: str, stand_in_ids: list[str]) -> set[str]:
        """Which of ``stand_in_ids`` the user has retained, ``active``."""
        if not stand_in_ids:
            return set()
        rows = self._store._db().execute(
            "SELECT stand_in_id FROM hub_retained WHERE user_id = ? AND state = ?"
            f" AND stand_in_id IN ({_marks(tuple(stand_in_ids))})",
            (user_id, RETAIN_ACTIVE, *stand_in_ids),
        ).fetchall()
        return {r[0] for r in rows}

    def mark_retained(
        self, state: str, *, stand_in_id: Optional[str] = None, genesis_fp: Optional[str] = None,
    ) -> list[str]:
        """Move retained rows of one stand-in (or of every agent of the root
        ``genesis_fp``) to ``state``: ``unlisted`` only from ``active``;
        ``identity_changed`` from any other state (it is the stronger one).
        Never back to ``active``. Returns the user ids whose rows changed."""
        if (stand_in_id is None) == (genesis_fp is None) or state == RETAIN_ACTIVE:
            raise ValueError("mark one stand-in or one root, away from active")
        if stand_in_id is not None:
            target, args = "stand_in_id = ?", (stand_in_id,)
        else:
            target, args = "stand_in_id IN (SELECT id FROM remote_agents WHERE genesis_fp = ?)", (genesis_fp,)
        from_states = (RETAIN_ACTIVE,) if state == RETAIN_UNLISTED else (RETAIN_ACTIVE, RETAIN_UNLISTED)
        where = f"{target} AND state IN ({_marks(from_states)})"
        with self._store._tx() as db:
            users = sorted({r[0] for r in db.execute(
                f"SELECT user_id FROM hub_retained WHERE {where}", (*args, *from_states))})
            db.execute(f"UPDATE hub_retained SET state = ? WHERE {where}", (state, *args, *from_states))
        return users

    # ── local agents' Hub channels ───────────────────────────────────────

    def channel_state(self, agent_id: str) -> Optional[HubChannelState]:
        row = self._store._db().execute(
            f"SELECT {', '.join(_CHANNEL_COLUMNS)} FROM hub_channels WHERE agent_id = ?", (agent_id,),
        ).fetchone()
        if row is None:
            return None
        data = dict(row)
        data["cert"] = json.loads(data["cert"]) if data["cert"] else None
        for flag in ("enabled", "stop_now", "unregister_pending"):
            data[flag] = bool(data[flag])
        return HubChannelState(**data)

    def channel_states(self) -> list[HubChannelState]:
        """Every local agent's Hub channel, oldest first."""
        rows = self._store._db().execute(
            "SELECT agent_id FROM hub_channels ORDER BY created_at, rowid",
        ).fetchall()
        return [s for s in (self.channel_state(r[0]) for r in rows) if s is not None]

    def channel_for_connection(self, connection_id: str) -> Optional[HubChannelState]:
        row = self._store._db().execute(
            "SELECT agent_id FROM hub_channels WHERE connection_id = ?", (connection_id,),
        ).fetchone()
        return self.channel_state(row[0]) if row is not None else None

    def set_channel_state(self, state: HubChannelState) -> None:
        """Insert or replace the whole row. The run count is left as stored
        (it changes only through ``bump_runs_today``) unless the row is new."""
        cert = _dumps(state.cert) if state.cert is not None else None
        values = {
            **{c: getattr(state, c) for c in _CHANNEL_COLUMNS},
            "cert": cert,
            "cert_serial": state.cert.get("serial") if state.cert is not None else None,
            "cert_not_after": state.cert.get("not_after") if state.cert is not None else None,
        }
        columns = (*_CHANNEL_COLUMNS, "cert_purpose")
        values["cert_purpose"] = Purpose.AGENT_CERT.value if cert is not None else None
        kept = {"agent_id", "created_at", "runs_today", "runs_reset_at"}
        updates = ", ".join(f"{c} = excluded.{c}" for c in columns if c not in kept)
        with self._store._tx() as db:
            db.execute(
                f"INSERT INTO hub_channels ({', '.join(columns)}) VALUES ({_marks(columns)})"
                f" ON CONFLICT(agent_id) DO UPDATE SET {updates}",
                tuple(values[c] for c in columns),
            )

    def channel_counts(self, connection_id: Optional[str]) -> tuple[int, int]:
        """(open conversations, messages in flight) of one agent's Hub
        connection: its live threads, and its rows that have not ended."""
        if connection_id is None:
            return 0, 0
        db = self._store._db()
        threads = db.execute(
            "SELECT COUNT(*) FROM threads WHERE connection_id = ? AND state = ?", (connection_id, THREAD_LIVE),
        ).fetchone()[0]
        rows = db.execute(
            f"SELECT COUNT(*) FROM outbox WHERE connection_id = ? AND state IN ({_marks(OPEN_STATES)})",
            (connection_id, *OPEN_STATES),
        ).fetchone()[0]
        return threads, rows

    def bump_runs_today(self, agent_id: str, *, now: float, next_reset_at: float) -> Optional[int]:
        """Claim one run of today's cap, in one transaction. A count whose
        reset time has passed starts again (with ``next_reset_at``). Returns
        the count with this run, or None when the cap is reached (nothing
        counted) or the agent has no Hub channel."""
        with self._store._tx() as db:
            return self.claim_run(db, agent_id, now=now, next_reset_at=next_reset_at)

    @staticmethod
    def claim_run(db, agent_id: str, *, now: float, next_reset_at: float) -> Optional[int]:
        """``bump_runs_today`` inside a transaction the caller holds (the
        store's accept transaction, so the claim and the acceptance are one
        commit)."""
        row = db.execute(
            "SELECT daily_run_cap, runs_today, runs_reset_at FROM hub_channels WHERE agent_id = ?",
            (agent_id,),
        ).fetchone()
        if row is None:
            return None
        fresh = row["runs_reset_at"] is None or now >= row["runs_reset_at"]
        count = 0 if fresh else row["runs_today"]
        if count >= row["daily_run_cap"]:
            return None
        db.execute(
            "UPDATE hub_channels SET runs_today = ?, runs_reset_at = ? WHERE agent_id = ?",
            (count + 1, next_reset_at if fresh else row["runs_reset_at"], agent_id),
        )
        return count + 1

    # ── directory cache ──────────────────────────────────────────────────

    def _cache_put(self, kind: str, key: str, body: Mapping[str, Any], now: float) -> None:
        with self._store._tx() as db:
            db.execute(
                "INSERT INTO hub_directory_cache (kind, cache_key, body, cached_at) VALUES (?,?,?,?)"
                " ON CONFLICT(kind, cache_key) DO UPDATE SET body = excluded.body,"
                " cached_at = excluded.cached_at",
                (kind, key, _dumps(body), now),
            )

    def _cache_get(self, kind: str, key: str, now: float) -> Optional[CachedAnswer]:
        row = self._store._db().execute(
            "SELECT body, cached_at FROM hub_directory_cache WHERE kind = ? AND cache_key = ?"
            " AND cached_at > ?", (kind, key, now - DIRECTORY_CACHE_S),
        ).fetchone()
        return CachedAnswer(body=json.loads(row["body"]), cached_at=row["cached_at"]) if row else None

    def cache_search(self, query_key: str, body: Mapping[str, Any], *, now: float) -> None:
        self._cache_put("search", query_key, body, now)

    def cached_search(self, query_key: str, *, now: float) -> Optional[CachedAnswer]:
        """The cached answer for a search, if under ``DIRECTORY_CACHE_S`` old."""
        return self._cache_get("search", query_key, now)

    def cache_agent(self, hub_agent_id: str, body: Mapping[str, Any], *, now: float) -> None:
        self._cache_put("agent", hub_agent_id, body, now)

    def cached_agent(self, hub_agent_id: str, *, now: float) -> Optional[CachedAnswer]:
        return self._cache_get("agent", hub_agent_id, now)

    def drop_cached_agent(self, hub_agent_id: str) -> None:
        with self._store._tx() as db:
            db.execute("DELETE FROM hub_directory_cache WHERE kind = 'agent' AND cache_key = ?", (hub_agent_id,))

    def drop_cached_agents_refreshed_before(self, refreshed: Mapping[str, int]) -> int:
        """Drop each cached agent item (by hub_agent_id) whose listing refresh
        is older than the one given: a live search saw a newer listing.
        Returns how many went."""
        with self._store._tx() as db:
            return sum(db.execute(
                "DELETE FROM hub_directory_cache WHERE kind = 'agent' AND cache_key = ?"
                " AND CAST(json_extract(body, '$.item.refreshed_at') AS INTEGER) < ?", (agent_id, int(at)),
            ).rowcount for agent_id, at in refreshed.items())

    def prune_directory_cache(self, *, now: float) -> int:
        with self._store._tx() as db:
            return db.execute(
                "DELETE FROM hub_directory_cache WHERE cached_at <= ?", (now - DIRECTORY_CACHE_S,),
            ).rowcount

    # ── avatar cache ─────────────────────────────────────────────────────

    def _avatars(self, where: str, args: tuple) -> Optional[CachedAvatar]:
        row = self._store._db().execute(
            "SELECT hub_agent_id, refreshed_at, png, refusal FROM hub_avatar_cache"
            f" WHERE {where} ORDER BY refreshed_at DESC LIMIT 1", args,
        ).fetchone()
        if row is None:
            return None
        return CachedAvatar(
            hub_agent_id=row["hub_agent_id"], refreshed_at=row["refreshed_at"],
            png=bytes(row["png"]) if row["png"] is not None else None, refusal=row["refusal"],
        )

    def avatar_for(self, hub_agent_id: str, refreshed_at: int) -> Optional[CachedAvatar]:
        """The re-encode (or refusal) for this listing refresh, if decoded already."""
        return self._avatars("hub_agent_id = ? AND refreshed_at = ?", (hub_agent_id, refreshed_at))

    def latest_avatar(self, hub_agent_id: str) -> Optional[CachedAvatar]:
        """The newest cached entry, whatever its refresh: what the read-only
        avatar route serves while the hub cannot be asked."""
        return self._avatars("hub_agent_id = ?", (hub_agent_id,))

    def _put_avatar(self, hub_agent_id: str, refreshed_at: int, png: Optional[bytes],
                    refusal: Optional[str], now: float) -> None:
        with self._store._tx() as db:
            db.execute(
                "INSERT OR REPLACE INTO hub_avatar_cache (hub_agent_id, refreshed_at, png, refusal,"
                " created_at) VALUES (?,?,?,?,?)", (hub_agent_id, refreshed_at, png, refusal, now),
            )
            db.execute(                     # an older refresh is never served again
                "DELETE FROM hub_avatar_cache WHERE hub_agent_id = ? AND refreshed_at < ?",
                (hub_agent_id, refreshed_at),
            )

    def put_avatar(self, hub_agent_id: str, refreshed_at: int, png: bytes, *, now: float) -> None:
        self._put_avatar(hub_agent_id, refreshed_at, png, None, now)

    def put_avatar_refusal(self, hub_agent_id: str, refreshed_at: int, reason: str, *, now: float) -> None:
        """A decode refused: cached like a success, so it is not retried."""
        self._put_avatar(hub_agent_id, refreshed_at, None, reason, now)


def _owner(row: Any) -> HubOwner:
    return HubOwner(
        hub_url=row["hub_url"], user_id=row["user_id"], owner_ref=row["owner_ref"], status=row["status"],
        via_registration=bool(row["via_registration"]), email_hash=row["email_hash"],
        code_sent_at=row["code_sent_at"], verified_at=row["verified_at"], updated_at=row["updated_at"],
    )
