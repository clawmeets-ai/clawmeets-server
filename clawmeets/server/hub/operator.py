# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/operator.py
What ``clawmeets server hub register | verify | status`` do, as plain
functions over the server's data dir (the directory ``create_app`` gets,
holding ``channels/channels.db``). The CLI only prints what they return, so
every rule here is tested without a terminal.

- ``register``: first registration, or (``reclaim=True``) the email-verified
  new-key reclaim. Refreshes the trusted hub keys, signs a RegisterRequest
  with the identity key, checks the hub's statement, saves the registration.
- ``verify``: always checks the hub key chain; with a code, also submits the
  emailed code (signed) and marks the registration active.
- ``status``: read-only, in every mode. Never touches the network, never
  decrypts anything, and never creates a file: ``channels.db`` is opened
  read-only, and only if it already exists.

Only ``register`` and ``verify`` make requests, and never before the config
is known to allow it: with the hub mode ``off`` or the config invalid they
stop with exit 3, and against a placeholder-pinned hub with exit 4, before
any read, write or request.

A running server re-reads the registration every 5 seconds
(``runtime.REGISTRATION_POLL_SECONDS``), so what ``register`` and ``verify``
write is picked up with no restart.

- ``rotate``: a chained rotation to a new identity key. ``key_rotate`` is a
  socket frame and a second socket would displace the server's own, so the
  command hands the request to the RUNNING server through a request file
  (``{server_dir}/hub/operator/rotate.request.json``), which the runtime's
  5-second poll picks up and answers in ``rotate.result.json``. Exit 7 when no
  server picks it up within ``--timeout`` (the request is removed).
- ``revoke``: the owner's sessionless identity revoke (a thief may hold the
  socket), straight to the hub over HTTP; no running server is needed. The
  registration is then ``held_for_reclaim`` until ``register --reclaim``.

``same_key_reclaim`` / ``accept_same_key_reclaim`` are not commands: they are
the hub client's one automatic re-registration after close code 4004 (the
hub no longer knows this deployment), under the SAME identity key, with
``reclaim`` and no email, built with ``register``'s own request builder.

Failures are :class:`OperatorError` with the CLI's exit code:
3 config, 4 untrusted, 5 local state, 6 the hub refused, 7 unreachable,
2 usage (an argument the wire schema refuses), 1 internal.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Mapping, Optional

import httpx
from cryptography.fernet import InvalidToken
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import b64url, public_key_bytes, sign_object, to_wire
from clawmeets.hub_protocol.codes import RegisterStatus, StatementKind
from clawmeets.hub_protocol.constants import PROTOCOL_VERSION, TOS_URL, TOS_VERSION
from clawmeets.hub_protocol.http import (
    RegisterRequest,
    RegisterResponse,
    VerifyEmailRequest,
    VerifyEmailResponse,
)
from clawmeets.hub_protocol.keys import REVOKED_HUB_KIDS, pinned_trust
from clawmeets.server.channels.config import (
    HubConfig,
    HubConfigError,
    inspect_hub_config,
    validate_hub_only,
)
from clawmeets.server.channels.hub_store import HubRegistration, HubStore
from clawmeets.server.channels.store import HUB_CHANNEL, OPEN_STATES, ChannelStore, SchemaMismatch

from . import keys
from .http import HubHttp, HubRefused, HubUnreachable
from .identity import create_identity, drop_identity, key_fingerprint, load_identity
from .trust import HubUntrusted, refresh_trust, verify_statement

# TOS_VERSION / TOS_URL: the terms ``--accept-tos`` accepts. The hub refuses
# an outdated one (``tos_outdated``, exit 6): upgrade clawmeets, register again.

EXIT_OK = 0
EXIT_INTERNAL = 1
EXIT_USAGE = 2
EXIT_CONFIG = 3
EXIT_UNTRUSTED = 4
EXIT_STATE = 5
EXIT_REFUSED = 6
EXIT_UNREACHABLE = 7
#: The running server took a rotate request but no answer came: it may have
#: rotated. Never reported as "nothing was changed".
EXIT_UNKNOWN = 8

RESTART_HINT = "A running server picks this up within 5 seconds; no restart is needed."


class OperatorError(Exception):
    def __init__(self, exit_code: int, code: str, message: str, *, retry_after: Optional[int] = None) -> None:
        self.exit_code = exit_code
        self.code = code
        self.message = message
        self.retry_after = retry_after
        super().__init__(f"{code}: {message}")

    def to_json(self) -> dict:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.retry_after is not None:
            error["retry_after"] = self.retry_after
        return {"ok": False, "error": error}


def fp_tail(fp: Optional[str]) -> Optional[str]:
    """How a fingerprint is shown: its last eight characters."""
    return f"…{fp[-8:]}" if fp else None


@dataclass(frozen=True)
class RegisterResult:
    hub_url: str
    deployment_id: str
    name: str
    status: str
    fingerprint: str
    reclaimed: bool

    def to_json(self) -> dict:
        return {"ok": True, **asdict(self), "fingerprint": fp_tail(self.fingerprint)}


@dataclass(frozen=True)
class VerifyResult:
    hub_url: str
    chain: str                          # "ok": anything else is an OperatorError
    added_kids: list[str]
    purged_kids: list[str]
    status: str                         # the registration's status afterwards
    deployment_id: Optional[str]
    code_submitted: bool

    def to_json(self) -> dict:
        return {"ok": True, **asdict(self)}


@dataclass(frozen=True)
class StatusReport:
    mode: str
    hub_url: Optional[str]
    hub_url_is_default: bool
    config_problems: list[str]
    warnings: list[str]
    trust: str                          # placeholder | pinned | configured | none
    trusted_kids: list[str]
    revoked_kids: list[str]
    registration: dict
    hub_link: str
    last_connected_at: Optional[float]
    open_hub_rows: dict[str, int]
    db_problem: Optional[str] = None

    def to_json(self) -> dict:
        data = {"ok": True, **asdict(self)}
        if data["db_problem"] is None:
            del data["db_problem"]
        return data


@dataclass(frozen=True)
class RotateResult:
    hub_url: str
    deployment_id: str
    fingerprint: str                    # the new current key
    resigned: int                       # open rows re-signed under it

    def to_json(self) -> dict:
        return {"ok": True, **asdict(self), "fingerprint": fp_tail(self.fingerprint)}


@dataclass(frozen=True)
class RevokeResult:
    hub_url: str
    deployment_id: str
    revoked: list[str]                  # fingerprints the hub revoked (tails when shown)
    status: str                         # held_for_reclaim

    def to_json(self) -> dict:
        return {"ok": True, **asdict(self), "revoked": [fp_tail(f) for f in self.revoked]}


# ── shared steps ──────────────────────────────────────────────────────────

def _hub_config(env: Optional[Mapping[str, str]], server_dir: Optional[Path] = None) -> HubConfig:
    """The config register and verify may act on, or exit 3 / 4 before any I/O.
    In mode ``auto`` the server's generated key file stands in for an unset
    CLAWMEETS_CHANNEL_SECRET_KEY."""
    seen = inspect_hub_config(env)
    mode_ok = not any(p.startswith("CLAWMEETS_HUB_MODE") for p in seen.problems)
    if mode_ok and seen.mode == "off":
        raise OperatorError(
            EXIT_CONFIG, "hub_off_on_server",
            "CLAWMEETS_HUB_MODE is off on this server; unset it (auto) or set discover_only or full "
            "(in the server's environment) first",
        )
    try:
        config = validate_hub_only(env, require_key=True,
                                   data_dir=Path(server_dir) if server_dir is not None else None)
    except HubConfigError as exc:
        raise OperatorError(EXIT_CONFIG, "config_invalid", "; ".join(exc.problems)) from None
    if config.refusal is not None:
        raise OperatorError(
            EXIT_UNTRUSTED, "hub_untrusted",
            f"{config.hub_url} has only a placeholder key pinned in this release; "
            "this server will not contact it",
        )
    return config


def _open_store(server_dir: Path) -> ChannelStore:
    if not server_dir.is_dir():
        raise OperatorError(
            EXIT_INTERNAL, "internal",
            f"server data dir not found: {server_dir} (run 'clawmeets server init', or pass --data-dir)",
        )
    store = ChannelStore(server_dir)
    try:
        store.check_schema()
    except SchemaMismatch as exc:
        store.close()
        raise OperatorError(
            EXIT_INTERNAL, "internal", f"channels.db has schema version {exc.found}; this server needs another",
        ) from None
    return store


def _hub_failure(exc: Exception) -> OperatorError:
    if isinstance(exc, HubUntrusted):
        return OperatorError(EXIT_UNTRUSTED, "hub_untrusted", f"cannot trust the hub: {exc}")
    if isinstance(exc, HubRefused):
        message = exc.message or "the hub refused the request"
        return OperatorError(EXIT_REFUSED, exc.code, message, retry_after=exc.retry_after)
    if isinstance(exc, HubUnreachable):
        return OperatorError(EXIT_UNREACHABLE, "hub_unreachable", f"no usable answer from the hub ({exc.reason})")
    if isinstance(exc, ValidationError):
        return OperatorError(EXIT_UNREACHABLE, "hub_unreachable", "no usable answer from the hub (bad_body)")
    raise exc


_HUB_ERRORS = (HubUntrusted, HubRefused, HubUnreachable, ValidationError)


def _email_hash(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def _register_request(
    config: HubConfig, pubkey: str, *, name: str, label: str, email: str,
    public_url: Optional[str], reclaim: bool, now: float, owner_ref: Optional[str] = None,
) -> RegisterRequest:
    try:
        return RegisterRequest(
            v=PROTOCOL_VERSION, aud=config.hub_url, name=name, label=label,
            identity_pubkey=pubkey, contact_email=email,
            tos_version=TOS_VERSION, public_url=public_url, reclaim=True if reclaim else None,
            owner_ref=owner_ref, ts=int(now),
        )
    except ValidationError as exc:
        fields = sorted({str(e["loc"][0]) for e in exc.errors() if e.get("loc")})
        raise OperatorError(
            EXIT_USAGE, "usage",
            "invalid " + ", ".join(f"--{f.replace('contact_email', 'email').replace('_', '-')}" for f in fields)
            + " (name: 3-63 of a-z 0-9 . -; label: 1-80 characters; public URL: https)",
        ) from None


def _signed_register(key: Ed25519PrivateKey, config: HubConfig, **fields: Any) -> dict:
    request = _register_request(config, b64url(public_key_bytes(key)), **fields)
    return sign_object(to_wire(request), key, purpose=RegisterRequest.SIGNING_PURPOSE)


def _accepted(
    raw: dict, *, store_hub: HubStore, config: HubConfig, key: Ed25519PrivateKey, now: float,
) -> tuple[RegisterResponse, dict]:
    response = RegisterResponse.model_validate(raw)
    if response.status not in (RegisterStatus.PENDING_EMAIL, RegisterStatus.ACTIVE):
        raise HubUnreachable("unknown_status")
    statement = raw["statement"]
    verify_statement(
        statement, hub=store_hub, config=config, now=now, kind=StatementKind.REGISTRATION_ACCEPTED,
        fingerprint=key_fingerprint(key), deployment_id=response.deployment_id,
    )
    return response, statement


# ── register ──────────────────────────────────────────────────────────────

def register(
    server_dir: Path, *, name: str, email: str, label: Optional[str] = None,
    public_url: Optional[str] = None, reclaim: bool = False,
    env: Optional[Mapping[str, str]] = None, transport: Optional[httpx.BaseTransport] = None,
    now: Optional[float] = None,
) -> RegisterResult:
    """First registration (``reclaim=False``) or the new-key reclaim."""
    config = _hub_config(env, server_dir)
    assert config.fernet is not None                    # require_key=True
    now = time.time() if now is None else now
    label = label or name
    # The arguments first, against the wire schema (any key will do): a usage
    # error must not cost a request, a key or a row.
    _register_request(config, "A" * 43, name=name, label=label, email=email,
                      public_url=public_url, reclaim=reclaim, now=now)
    store = _open_store(Path(server_dir))
    try:
        hub = HubStore(store)
        reg = hub.registration(config.hub_url)
        registered = reg is not None and reg.status != "none"
        # Waiting for the email code: registering again under the same key and
        # name is the resend (the hub mails a fresh code, to this --email).
        resend = registered and not reclaim and reg.status == "pending_email"
        if resend and reg.name and reg.name != name:
            raise OperatorError(
                EXIT_STATE, "pending_other_name",
                f"this server's registration as {reg.name!r} is waiting for its email code; "
                f"re-run with --name {reg.name} to send a new code",
            )
        if registered and not reclaim and not resend:
            raise OperatorError(
                EXIT_STATE, "already_registered",
                f"this server is already registered with {config.hub_url} (status {reg.status}); "
                "use --reclaim to register it again under a new key",
            )
        if reclaim and not registered:
            raise OperatorError(
                EXIT_STATE, "not_registered",
                f"this server has no registration with {config.hub_url} to reclaim; register without --reclaim",
            )
        with HubHttp(config.hub_url, transport=transport) as client:
            try:
                refresh_trust(hub, config, client, now=now)
            except _HUB_ERRORS as exc:
                raise _hub_failure(exc) from None
            if reclaim:
                assert reg is not None
                return _reclaim(store, hub, config, client, reg, name=name, label=label,
                                email=email, public_url=public_url, now=now)
            return _first_register(store, hub, config, client, reg, name=name, label=label,
                                   email=email, public_url=public_url, now=now)
    finally:
        store.close()


def _first_register(
    store: ChannelStore, hub: HubStore, config: HubConfig, client: HubHttp,
    reg: Optional[HubRegistration], *, name: str, label: str, email: str,
    public_url: Optional[str], now: float,
) -> RegisterResult:
    pending, key, body = prepare_first_register(store, hub, config, reg, name=name, label=label, email=email,
                                                public_url=public_url, now=now)
    try:
        raw = client.register(body)
    except _HUB_ERRORS as exc:
        raise _hub_failure(exc) from None
    return finish_first_register(hub, config, pending, key, raw, now=now)


def prepare_first_register(
    store: ChannelStore, hub: HubStore, config: HubConfig, reg: Optional[HubRegistration], *,
    name: str, label: str, email: str, public_url: Optional[str], now: float,
    owner_user_id: Optional[str] = None,
) -> tuple[HubRegistration, Ed25519PrivateKey, dict]:
    """The store half before the request: the identity key (a retried first
    registration keeps its key, so a hub that took the first attempt sees the
    same key again), the pending row, and the signed body. ``owner_user_id``:
    the user enrolling this server from the browser (server/hub/enroll.py);
    their owner_ref rides in the request, so the code that activates the
    deployment verifies them as an owner too.

    A row the hub already answered (``pending_email``) is NOT rewritten here:
    only the hub's next answer (finish_first_register) changes it. Saving it as
    ``none`` before a request whose answer is lost would forget that the hub
    holds this key under this name, and every later attempt would pick a new
    name the hub refuses (the key is taken)."""
    fernet = config.fernet
    assert fernet is not None
    connection_id = reg.identity_connection_id if reg is not None else None
    if connection_id is not None and store.get_connection(connection_id) is not None:
        try:
            key = load_identity(store, connection_id, fernet)
        except InvalidToken:
            raise OperatorError(
                EXIT_CONFIG, "config_invalid",
                "CLAWMEETS_CHANNEL_SECRET_KEY does not decrypt this server's hub identity key",
            ) from None
    else:
        connection_id, key = create_identity(store, hub_url=config.hub_url, fernet=fernet, now=now)
    fp = key_fingerprint(key)
    base = reg or HubRegistration(hub_url=config.hub_url, created_at=now, updated_at=now)
    answered = reg is not None and reg.status == "pending_email"
    pending = replace(
        base, name=name, label=label, public_url=public_url, status=reg.status if answered else "none",
        genesis_fp=fp, current_fp=fp, identity_connection_id=connection_id,
        contact_email_hash=_email_hash(email), updated_at=now,
    )
    if not answered:
        hub.save_registration(pending, fernet=fernet)    # the reporter secret is made here, once
    owner_ref = hub.owner_ref(config.hub_url, fernet, owner_user_id) if owner_user_id else None
    body = _signed_register(key, config, name=name, label=label, email=email,
                            public_url=public_url, reclaim=False, now=now, owner_ref=owner_ref)
    return pending, key, body


def finish_first_register(
    hub: HubStore, config: HubConfig, pending: HubRegistration, key: Ed25519PrivateKey, raw: dict, *,
    now: float,
) -> RegisterResult:
    """The store half after the hub's answer: its statement checked, the
    deployment id and status saved."""
    assert config.fernet is not None
    try:
        response, statement = _accepted(raw, store_hub=hub, config=config, key=key, now=now)
    except _HUB_ERRORS as exc:
        raise _hub_failure(exc) from None
    hub.save_registration(replace(
        pending, deployment_id=response.deployment_id, status=str(response.status),
        statement=statement, updated_at=now,
    ), fernet=config.fernet)
    return RegisterResult(
        hub_url=config.hub_url, deployment_id=response.deployment_id, name=pending.name or "",
        status=str(response.status), fingerprint=pending.genesis_fp or "", reclaimed=False,
    )


def _reclaim(
    store: ChannelStore, hub: HubStore, config: HubConfig, client: HubHttp,
    reg: HubRegistration, *, name: str, label: str, email: str,
    public_url: Optional[str], now: float,
) -> RegisterResult:
    """The new-key reclaim: a new, unchained key in a NEW connection row. Only
    once the hub accepts it does one commit swap it in (genesis = current =
    the new key) and delete the old row. Any failure deletes the new row and
    leaves everything else exactly as it was. The reporter secret is kept."""
    fernet = config.fernet
    assert fernet is not None
    new_connection_id, key = create_identity(store, hub_url=config.hub_url, fernet=fernet, now=now)
    try:
        body = _signed_register(key, config, name=name, label=label, email=email,
                                public_url=public_url, reclaim=True, now=now)
        response, statement = _accepted(client.register(body), store_hub=hub, config=config, key=key, now=now)
    except BaseException as exc:
        drop_identity(store, new_connection_id, now=now)
        if isinstance(exc, _HUB_ERRORS):
            raise _hub_failure(exc) from None
        raise
    fp = key_fingerprint(key)
    hub.save_registration(replace(
        reg, deployment_id=response.deployment_id, name=name, label=label, public_url=public_url,
        status=str(response.status), genesis_fp=fp, current_fp=fp,
        identity_connection_id=new_connection_id, contact_email_hash=_email_hash(email),
        statement=statement, updated_at=now,
    ), fernet=fernet, replaces_identity=reg.identity_connection_id)
    return RegisterResult(
        hub_url=config.hub_url, deployment_id=response.deployment_id, name=name,
        status=str(response.status), fingerprint=fp, reclaimed=True,
    )


# ── the automatic same-key reclaim (close code 4004) ──────────────────────

def same_key_reclaim(config: HubConfig, reg: HubRegistration, key: Ed25519PrivateKey, *, now: float) -> dict:
    """The signed RegisterRequest for the automatic reclaim: this deployment's
    name, label and public URL, its CURRENT identity key, reclaim, no email."""
    request = RegisterRequest(
        v=PROTOCOL_VERSION, aud=config.hub_url, name=reg.name or "", label=reg.label or reg.name or "",
        identity_pubkey=b64url(public_key_bytes(key)), contact_email=None,
        tos_version=TOS_VERSION, public_url=reg.public_url, reclaim=True, ts=int(now),
    )
    return sign_object(to_wire(request), key, purpose=RegisterRequest.SIGNING_PURPOSE)


def accept_same_key_reclaim(
    hub: HubStore, config: HubConfig, reg: HubRegistration, key: Ed25519PrivateKey,
    raw: dict, *, now: float,
) -> HubRegistration:
    """The hub's answer to ``same_key_reclaim``: its statement checked like a
    registration's, then the registration saved with the (possibly new)
    deployment id and status. The key, genesis and identity row are kept.
    HubUntrusted / ValidationError / HubUnreachable when the answer is not
    usable; nothing is saved then."""
    assert config.fernet is not None
    response, statement = _accepted(raw, store_hub=hub, config=config, key=key, now=now)
    saved = replace(reg, deployment_id=response.deployment_id, status=str(response.status),
                    statement=statement, updated_at=now)
    hub.save_registration(saved, fernet=config.fernet)
    return saved


# ── verify ────────────────────────────────────────────────────────────────

def _verify_request(config: HubConfig, deployment_id: str, code: str, now: float) -> VerifyEmailRequest:
    try:
        return VerifyEmailRequest(aud=config.hub_url, deployment_id=deployment_id, code=code, ts=int(now))
    except ValidationError:
        raise OperatorError(EXIT_USAGE, "usage", "invalid --code (4-16 letters or digits)") from None


def verify(
    server_dir: Path, *, code: Optional[str] = None, env: Optional[Mapping[str, str]] = None,
    transport: Optional[httpx.BaseTransport] = None, now: Optional[float] = None,
) -> VerifyResult:
    """Check the pinned hub key chain; with ``code``, submit the emailed code."""
    config = _hub_config(env, server_dir)
    fernet = config.fernet
    assert fernet is not None
    now = time.time() if now is None else now
    if code is not None:
        _verify_request(config, "deployment", code, now)       # a bad --code: exit 2 before any I/O
    store = _open_store(Path(server_dir))
    try:
        hub = HubStore(store)
        reg = hub.registration(config.hub_url)
        if code is not None:
            if reg is None or reg.status == "none" or reg.deployment_id is None:
                raise OperatorError(
                    EXIT_STATE, "not_registered",
                    f"this server has no registration with {config.hub_url}; run 'hub register' first",
                )
            if reg.status != "pending_email":
                raise OperatorError(
                    EXIT_STATE, "not_pending",
                    f"the registration is {reg.status}, not waiting for an email code",
                )
            try:
                key = load_identity(store, reg.identity_connection_id or "", fernet)
            except KeyError:
                raise OperatorError(EXIT_STATE, "not_registered", "this server's hub identity key is missing") from None
            except InvalidToken:
                raise OperatorError(
                    EXIT_CONFIG, "config_invalid",
                    "CLAWMEETS_CHANNEL_SECRET_KEY does not decrypt this server's hub identity key",
                ) from None
            request = _verify_request(config, reg.deployment_id, code, now)
        with HubHttp(config.hub_url, transport=transport) as client:
            try:
                refreshed = refresh_trust(hub, config, client, now=now)
                if code is None:
                    return VerifyResult(
                        hub_url=config.hub_url, chain="ok", added_kids=refreshed.added,
                        purged_kids=refreshed.purged, status=reg.status if reg else "none",
                        deployment_id=reg.deployment_id if reg else None, code_submitted=False,
                    )
                assert reg is not None
                submit_code(hub, config, client, reg, key, request, now=now)
            except _HUB_ERRORS as exc:
                raise _hub_failure(exc) from None
        return VerifyResult(
            hub_url=config.hub_url, chain="ok", added_kids=refreshed.added, purged_kids=refreshed.purged,
            status="active", deployment_id=reg.deployment_id, code_submitted=True,
        )
    finally:
        store.close()


def submit_code(
    hub: HubStore, config: HubConfig, client: HubHttp, reg: HubRegistration, key: Ed25519PrivateKey,
    request: VerifyEmailRequest, *, now: float,
) -> HubRegistration:
    """Send the registration's emailed code; on the hub's signed yes, save the
    registration active (and verify the owner whose code it was, if one
    enrolled it from the browser). Raises the hub errors (_HUB_ERRORS)."""
    assert config.fernet is not None and reg.deployment_id is not None
    body = sign_object(to_wire(request), key, purpose=VerifyEmailRequest.SIGNING_PURPOSE)
    raw = client.verify_email(reg.deployment_id, body)
    response = VerifyEmailResponse.model_validate(raw)
    if response.status != RegisterStatus.ACTIVE:
        raise HubUnreachable("unknown_status")
    statement = raw["statement"]
    verify_statement(
        statement, hub=hub, config=config, now=now, kind=StatementKind.REGISTRATION_ACCEPTED,
        fingerprint=reg.current_fp or "", deployment_id=reg.deployment_id,
    )
    saved = replace(reg, status="active", statement=statement, updated_at=now)
    hub.save_registration(saved, fernet=config.fernet)
    hub.registration_verified_owners(config.hub_url, now=now)
    return saved


# ── status ────────────────────────────────────────────────────────────────

def status(server_dir: Path, *, env: Optional[Mapping[str, str]] = None) -> StatusReport:
    """Read-only, in every mode: no network, no decryption, no file created."""
    config = inspect_hub_config(env)
    server_dir = Path(server_dir)
    if server_dir.exists() and not os.access(server_dir, os.R_OK | os.X_OK):
        raise OperatorError(EXIT_INTERNAL, "internal", f"cannot read the server data dir: {server_dir}")
    url = config.hub_url
    revoked = sorted(REVOKED_HUB_KIDS.get(url, frozenset())) if url else []
    warnings = list(config.warnings)
    if url and not config.is_default:
        warnings.append(f"CLAWMEETS_HUB_URL is not the default hub ({url})")

    registration: dict[str, Any] = {"status": "none"}
    stored_kids: list[str] = []
    hub_link, last_connected = "off", None
    open_rows: dict[str, int] = {}
    db_problem: Optional[str] = None
    db_path = server_dir / "channels" / "channels.db"
    if url and db_path.exists():
        try:
            registration, stored_kids, hub_link, last_connected, open_rows = _read_db(db_path, url)
        except sqlite3.DatabaseError as exc:
            if not os.access(db_path, os.R_OK):
                raise OperatorError(EXIT_INTERNAL, "internal", f"cannot read {db_path}") from None
            db_problem = f"channels.db could not be read ({type(exc).__name__})"

    if config.refusal is not None:
        trust, kids = "placeholder", []
    elif not url:
        trust, kids = "none", []
    elif config.is_default:
        trust, kids = "pinned", stored_kids or sorted(pinned_trust(url))
    elif config.configured_keys or stored_kids:
        trust, kids = "configured", stored_kids or sorted(config.configured_keys)
    else:
        trust, kids = "none", []
    if config.mode == "off":
        hub_link = "off"
    elif config.refusal is not None:
        hub_link = "untrusted"
    return StatusReport(
        mode=config.mode, hub_url=url or None, hub_url_is_default=config.is_default,
        config_problems=list(config.problems), warnings=warnings, trust=trust,
        trusted_kids=kids, revoked_kids=revoked, registration=registration,
        hub_link=hub_link, last_connected_at=last_connected, open_hub_rows=open_rows,
        db_problem=db_problem,
    )


def _read_db(db_path: Path, url: str) -> tuple[dict, list[str], str, Optional[float], dict[str, int]]:
    db = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        row = db.execute(
            "SELECT status, deployment_id, name, label, public_url, genesis_fp, current_fp,"
            " hub_link, last_connected_at FROM hub_registration WHERE hub_url = ?", (url,),
        ).fetchone()
        registration: dict[str, Any] = {"status": "none"}
        hub_link, last_connected = "off", None
        if row is not None:
            registration = {
                "status": row["status"], "deployment_id": row["deployment_id"], "name": row["name"],
                "label": row["label"], "public_url": row["public_url"],
                "genesis_fp": fp_tail(row["genesis_fp"]), "current_fp": fp_tail(row["current_fp"]),
            }
            hub_link, last_connected = row["hub_link"], row["last_connected_at"]
        kids = sorted(r[0] for r in db.execute(
            "SELECT kid FROM hub_trusted_keys WHERE hub_url = ?", (url,)))
        marks = ", ".join("?" * len(OPEN_STATES))
        open_rows = {r[0]: r[1] for r in db.execute(
            "SELECT o.state, COUNT(*) FROM outbox o JOIN connections c ON c.id = o.connection_id"
            f" AND c.channel = ? WHERE o.state IN ({marks}) GROUP BY o.state ORDER BY o.state",
            (HUB_CHANNEL, *OPEN_STATES),
        )}
        return registration, kids, hub_link, last_connected, open_rows
    finally:
        db.close()


# ── rotate (handed to the running server) ─────────────────────────────────

#: Under the server dir: where ``rotate`` leaves its request and finds the answer.
OPERATOR_REQUEST_DIR = Path("hub") / "operator"
ROTATE_REQUEST = "rotate.request.json"
ROTATE_RESULT = "rotate.result.json"
#: A request older than this is ignored by the server (a CLI long gone).
REQUEST_MAX_AGE_S = 60.0
#: How often ``rotate`` looks for the answer.
RESULT_POLL_S = 0.25


def operator_dir(server_dir: Path) -> Path:
    return Path(server_dir) / OPERATOR_REQUEST_DIR


def _write_private(path: Path, data: dict) -> None:
    """Atomically, mode 0600, in a 0700 directory."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


def _read_json(path: Path) -> Optional[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _rotation_allowed(store: ChannelStore, config: HubConfig) -> HubRegistration:
    reg = HubStore(store).registration(config.hub_url)
    if reg is None or reg.status != "active" or reg.deployment_id is None:
        raise OperatorError(EXIT_STATE, "not_active",
                            f"this server has no active registration with {config.hub_url}")
    if keys.pending_rotations(store, config, reg):
        raise OperatorError(EXIT_STATE, "rotation_pending",
                            "an earlier rotation is not settled yet; it settles on the server's next connect")
    return reg


def rotate(
    server_dir: Path, *, env: Optional[Mapping[str, str]] = None, timeout_s: float = 30.0,
    now: Optional[float] = None, sleep=time.sleep,
) -> RotateResult:
    """Ask the running server to rotate its identity key (``keys.rotate_chained``
    over its own socket), and wait up to ``timeout_s`` for the answer."""
    config = _hub_config(env, server_dir)
    server_dir = Path(server_dir)
    store = _open_store(server_dir)
    try:
        reg = _rotation_allowed(store, config)
    finally:
        store.close()
    folder = operator_dir(server_dir)
    request_path, result_path = folder / ROTATE_REQUEST, folder / ROTATE_RESULT
    nonce = secrets.token_hex(16)
    result_path.unlink(missing_ok=True)
    _write_private(request_path, {"nonce": nonce, "ts": time.time() if now is None else now,
                                  "hub_url": config.hub_url})
    deadline = time.monotonic() + timeout_s
    while True:
        answer = _read_json(result_path)
        if answer is not None and answer.get("nonce") == nonce:
            result_path.unlink(missing_ok=True)
            break
        if time.monotonic() >= deadline:
            current = _read_json(request_path)
            if current is not None and current.get("nonce") == nonce:
                request_path.unlink(missing_ok=True)
                raise OperatorError(
                    EXIT_UNREACHABLE, "no_server",
                    f"no running server picked up the request within {timeout_s:g} s "
                    "(start the server with the hub on, then run this again); nothing was changed",
                )
            # Claimed: the server is (or was) rotating, and may have committed.
            raise OperatorError(
                EXIT_UNKNOWN, "outcome_unknown",
                f"the running server took the request but did not answer within {timeout_s:g} s; "
                "the rotation may have happened. Run `clawmeets server hub status` to see the current key",
            )
        sleep(RESULT_POLL_S)
    if answer.get("ok"):
        return RotateResult(hub_url=config.hub_url, deployment_id=reg.deployment_id or "",
                            fingerprint=str(answer.get("fingerprint") or ""),
                            resigned=int(answer.get("resigned") or 0))
    code, message = str(answer.get("code") or "internal"), str(answer.get("message") or "")
    exit_code = {"state": EXIT_STATE, "refused": EXIT_REFUSED, "unreachable": EXIT_UNREACHABLE,
                 "unknown": EXIT_UNKNOWN}.get(str(answer.get("kind")), EXIT_INTERNAL)
    raise OperatorError(exit_code, code, message or code)


def take_rotate_request(server_dir: Path, *, hub_url: str, now: float) -> Optional[str]:
    """The server's side: claim a waiting request (it is removed), and return
    its nonce, or None when there is none, it is older than
    ``REQUEST_MAX_AGE_S``, or it is for another hub."""
    request_path = operator_dir(server_dir) / ROTATE_REQUEST
    if not request_path.exists():
        return None
    claimed = request_path.with_name(f".{ROTATE_REQUEST}.claimed")
    try:
        os.replace(request_path, claimed)
    except OSError:
        return None
    request = _read_json(claimed)
    claimed.unlink(missing_ok=True)
    if (request is None or not isinstance(request.get("nonce"), str) or request.get("hub_url") != hub_url
            or not isinstance(request.get("ts"), (int, float)) or abs(now - request["ts"]) > REQUEST_MAX_AGE_S):
        return None
    return request["nonce"]


def answer_rotate_request(server_dir: Path, nonce: str, answer: dict) -> None:
    """The server's answer for the waiting ``rotate``."""
    _write_private(operator_dir(server_dir) / ROTATE_RESULT, {**answer, "nonce": nonce})


# ── revoke (sessionless) ──────────────────────────────────────────────────

def revoke(
    server_dir: Path, *, env: Optional[Mapping[str, str]] = None,
    transport: Optional[httpx.BaseTransport] = None, now: Optional[float] = None,
) -> RevokeResult:
    """Revoke this server's current identity key at the hub, sessionless
    (``keys.revoke_own_identity``). Needs no running server."""
    config = _hub_config(env, server_dir)
    now = time.time() if now is None else now
    store = _open_store(Path(server_dir))
    try:
        reg = HubStore(store).registration(config.hub_url)
        if reg is not None and reg.status == "held_for_reclaim":
            raise OperatorError(
                EXIT_STATE, "already_revoked",
                "this server's key is already revoked; run 'clawmeets server hub register --reclaim'",
            )
        if reg is None or reg.deployment_id is None or reg.status == "none":
            raise OperatorError(EXIT_STATE, "not_registered",
                                f"this server has no registration with {config.hub_url}")
        with HubHttp(config.hub_url, transport=transport) as client:
            try:
                revoked = keys.revoke_own_identity(store, config, client, now=now)
            except keys.RevokeRefused as exc:
                raise OperatorError(EXIT_REFUSED, exc.code, exc.detail or exc.code) from None
            except _HUB_ERRORS as exc:
                raise _hub_failure(exc) from None
        return RevokeResult(hub_url=config.hub_url, deployment_id=reg.deployment_id, revoked=revoked,
                            status="held_for_reclaim")
    finally:
        store.close()
