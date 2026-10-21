# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/keys.py
Identity keys over time: revoking one, rotating to a successor, and re-keying
after a revoke. Both ends of each rule live here: what this deployment signs
and sends, and how it checks what other deployments signed.

**The revoke rule** (design revision 3). An identity revoke names a key
(``fingerprint``) and is signed by ``signer_fp``. It is valid only if the
signer is the named key or an ANCESTOR of it in the SAME signed chain (a
superseded ancestor qualifies), the signer is not already revoked, and the
signature verifies under the signer's pinned key. It revokes the named key
and every descendant: so an owner whose stolen key k was rotated to a thief's
k' first can still revoke k, and k' with it. A reclaim with a new key starts
a NEW chain (a new genesis), so no key of the earlier chain is an ancestor of
anything in it: an old key can never revoke the reclaimed identity.

A receiver checks the revoke the hub forwards (``key_revoked``'s
``deployment_revoke``) against the chain IT has pinned, never against the
hub's own ``revoked_fps``, so a hostile hub cannot forge a revocation. Then
the whole genesis root is marked ``identity_changed`` and its threads close.

**Re-keying** re-signs the outbox through ``ChannelGateway.resign_after_rekey``:

- a chained rotation (``rotate_chained``: the old key signs its successor)
  re-signs every open row, keeping ``message_id`` and ``sent_at``; the
  genesis, so every conversation key, is unchanged;
- an unchained re-key (``rekey_unchained``: after a revoke and the
  email-verified reclaim, a new genesis) re-signs only rows never written to
  the hub's socket (``forwarded_at IS NULL``); forwarded rows fail
  ``key_revoked`` ("may have been delivered"), since the target would see a
  new root and could run them twice. A host's reply envelope (signed by the
  agent's key under a certificate from the old identity) cannot be carried
  into a new root at all, and fails ``key_revoked`` too.

**Agent certificates** are issued by the identity key for 30 days and renewed
when fewer than 7 days are left.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, Mapping, Optional, Protocol

from cryptography.fernet import InvalidToken
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import (
    Purpose,
    b64url,
    public_key_bytes,
    sign_object,
    to_wire,
    verify_object,
)
from clawmeets.hub_protocol.codes import ErrorCode, StatementKind
from clawmeets.hub_protocol.envelope import AgentCert
from clawmeets.hub_protocol.frames import ROTATE_SIG_FIELDS, KeyRotate, KeyRotated, verify_key_chain
from clawmeets.hub_protocol.http import DeploymentDocument, RevokeBody, RevokedResponse
from clawmeets.server.channels.config import HubConfig
from clawmeets.server.channels.gateway import CannotResign, Resigner, ResignReport
from clawmeets.server.channels.hub_store import ChainRejected, HubRegistration, HubStore, Pin, PinResult
from clawmeets.server.channels.store import HUB_CHANNEL, ChannelStore

from .http import HubHttp, HubRefused
from .identity import DEPLOYMENT_AGENT_ID, create_identity, drop_identity, key_fingerprint, load_identity
from .trust import HubUntrusted, verify_statement

#: How long an agent certificate is valid, and when it is renewed.
AGENT_CERT_LIFETIME_S = 30 * 86400
AGENT_CERT_RENEW_S = 7 * 86400

#: The hub's answers to a revoke that mean "this revoke is wrong", not "try again".
_REVOKE_REFUSALS = frozenset({
    ErrorCode.REVOKE_NOT_AUTHORIZED, ErrorCode.SIGNER_REVOKED, ErrorCode.STALE,
    ErrorCode.INVALID_SIGNATURE, ErrorCode.UNKNOWN_DEPLOYMENT,
})


class RevokeRefused(Exception):
    """A revoke that is not valid. ``code``: ``revoke_not_authorized`` (the
    signer is not the named key or its ancestor in the same chain),
    ``signer_revoked``, ``invalid_signature``, ``unknown_chain`` (no pinned
    chain holds the named key), or a hub refusal (``stale``,
    ``unknown_deployment``)."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


# ── the chain a deployment has pinned ─────────────────────────────────────

@dataclass(frozen=True)
class PinnedChain:
    """Another deployment's key chain as pinned here, genesis first."""

    genesis_fp: str
    keys: tuple[Pin, ...]

    def index(self, fingerprint: str) -> Optional[int]:
        return next((i for i, k in enumerate(self.keys) if k.fingerprint == fingerprint), None)


# The pinned chain that holds `fingerprint`, or None if no chain does.
def pinned_chain(hub: HubStore, fingerprint: str) -> Optional[PinnedChain]:
    genesis = hub.genesis_of(fingerprint)
    if genesis is None:
        return None
    return PinnedChain(genesis_fp=genesis, keys=tuple(hub.chain(genesis)))


# ── the revoke rule (receiver side) ───────────────────────────────────────

# Check an identity revoke (the raw dict, as received) against `chain`.
# Valid only if revoke.signer_fp is revoke.fingerprint or an ancestor of it in
# the SAME chain (a superseded ancestor qualifies), the signer is not already
# revoked, aud is this hub, and the sig verifies under the signer's pinned key.
# A chain started by a reclaim has a new genesis, so no key of the earlier
# chain is its ancestor: revoke_not_authorized. Returns the named fingerprint
# and every descendant pinned in the chain. RevokeRefused otherwise.
def check_identity_revoke(chain: PinnedChain, raw: Mapping[str, Any], *, aud: str) -> list[str]:
    try:
        revoke = RevokeBody.model_validate(raw)
    except ValidationError:
        raise RevokeRefused(ErrorCode.INVALID_SIGNATURE.value, "the revoke does not fit its schema") from None
    if revoke.kind != "identity":
        raise RevokeRefused(ErrorCode.REVOKE_NOT_AUTHORIZED.value, "not an identity revoke")
    target = chain.index(revoke.fingerprint or "")
    if target is None:
        raise RevokeRefused("unknown_chain", "the revoked key is not in this chain")
    deployment_ids = {k.deployment_id for k in chain.keys} - {None}
    if deployment_ids and deployment_ids != {revoke.deployment_id}:
        raise RevokeRefused("unknown_chain", "the revoke names another deployment")
    signer = chain.index(revoke.signer_fp)
    if signer is None or signer > target:
        raise RevokeRefused(
            ErrorCode.REVOKE_NOT_AUTHORIZED.value,
            "the signer is not the revoked key or an ancestor of it in the same chain",
        )
    signer_key = chain.keys[signer]
    if signer_key.revoked_at is not None:
        raise RevokeRefused(ErrorCode.SIGNER_REVOKED.value, "the signer is already revoked")
    if revoke.aud != aud or not verify_object(raw, signer_key.pubkey, purpose=Purpose.REVOKE):
        raise RevokeRefused(ErrorCode.INVALID_SIGNATURE.value, "the revoke's signature does not verify")
    return [k.fingerprint for k in chain.keys[target:]]


# A key_revoked statement, as received: the hub's signature is checked
# (trust.verify_statement, its subject bound to the forwarded revoke's key),
# then the deployment's own revoke inside it against the chain pinned here.
# The named key and its descendants are marked revoked, the whole root
# identity_changed, and every requester thread with that root closes
# identity_changed. Returns the fingerprints revoked. An agent_cert revoke is
# not an identity change and returns [] (the requester side handles it).
# HubUntrusted for a bad statement, RevokeRefused for a bad revoke: nothing
# is written in either case.
def apply_key_revoked(
    hub: HubStore, config: HubConfig, raw_statement: Mapping[str, Any], *, now: float,
) -> list[str]:
    inner = raw_statement.get("deployment_revoke") if isinstance(raw_statement, Mapping) else None
    if not isinstance(inner, Mapping):
        raise RevokeRefused(ErrorCode.INVALID_SIGNATURE.value, "the statement carries no revoke")
    if inner.get("kind") != "identity":
        return []
    target_fp = inner.get("fingerprint")
    verify_statement(
        raw_statement, hub=hub, config=config, now=now, kind=StatementKind.KEY_REVOKED,
        fingerprint=target_fp if isinstance(target_fp, str) else "",
    )
    chain = pinned_chain(hub, target_fp)
    if chain is None:
        raise RevokeRefused("unknown_chain", "no pinned chain holds the revoked key")
    revoked = check_identity_revoke(chain, inner, aud=config.hub_url)
    hub.revoke_pins(chain.genesis_fp, revoked, now=now)
    hub.close_threads_for_root(chain.genesis_fp, reason="identity_changed", now=now)
    return revoked


# ── revoking this deployment's own key (signer side) ──────────────────────

# This deployment's identity revoke of target_fp, signed by `signer`.
def sign_identity_revoke(
    signer: Ed25519PrivateKey, *, deployment_id: str, target_fp: str, hub_url: str, now: float,
) -> dict:
    body = RevokeBody(
        aud=hub_url, deployment_id=deployment_id, kind="identity", fingerprint=target_fp,
        signer_fp=key_fingerprint(signer), ts=int(now),
    )
    return sign_object(to_wire(body), signer, purpose=Purpose.REVOKE)


# The owner's sessionless revoke: POST /v1/deployments/{id}/revoke, used
# because a key thief may hold the socket. A refusal that names the revoke
# itself (revoke_not_authorized, signer_revoked, stale, invalid_signature,
# unknown_deployment) is RevokeRefused; HubUnreachable and other HubRefused
# propagate. Returns the hub's answer.
def revoke_sessionless(http: HubHttp, deployment_id: str, body: Mapping[str, Any]) -> RevokedResponse:
    try:
        raw = http.revoke(deployment_id, body)
    except HubRefused as exc:
        if exc.code in _REVOKE_REFUSALS:
            raise RevokeRefused(exc.code, exc.message) from None
        raise
    return RevokedResponse.model_validate(raw)


# Revoke this deployment's current identity key (and every descendant the hub
# knows), sessionless. Never sends from a key already revoked here (status
# held_for_reclaim): RevokeRefused(signer_revoked) before any request. On
# success the registration is held_for_reclaim until the email-verified
# reclaim. Returns the fingerprints the hub revoked.
def revoke_own_identity(
    store: ChannelStore, config: HubConfig, http: HubHttp, *, now: float,
) -> list[str]:
    assert config.fernet is not None
    hub = HubStore(store)
    reg = hub.registration(config.hub_url)
    if reg is None or reg.deployment_id is None or reg.current_fp is None or reg.identity_connection_id is None:
        raise RevokeRefused(ErrorCode.UNKNOWN_DEPLOYMENT.value, "this server is not registered")
    if reg.status == "held_for_reclaim":
        raise RevokeRefused(ErrorCode.SIGNER_REVOKED.value, "this server's key is already revoked")
    key = load_identity(store, reg.identity_connection_id, config.fernet)
    body = sign_identity_revoke(
        key, deployment_id=reg.deployment_id, target_fp=reg.current_fp, hub_url=config.hub_url, now=now,
    )
    answer = revoke_sessionless(http, reg.deployment_id, body)
    if reg.current_fp not in answer.revoked_fps:
        raise RevokeRefused(ErrorCode.INVALID_SIGNATURE.value, "the hub did not revoke the named key")
    hub.save_registration(replace(reg, status="held_for_reclaim", updated_at=now), fernet=config.fernet)
    return list(answer.revoked_fps)


# ── rotation and re-key ───────────────────────────────────────────────────

class RekeyGateway(Protocol):
    async def resign_after_rekey(self, *, chained: bool, resign: Resigner,
                                 current_fp: Optional[str] = None) -> ResignReport: ...


@dataclass(frozen=True)
class RotateReport:
    fingerprint: str            # the new current key
    resign: ResignReport


# A key_rotate from `old` to `new`, signed by both (sig_old, then sig_new;
# neither signature covers the other).
def sign_key_rotate(
    old: Ed25519PrivateKey, new: Ed25519PrivateKey, *, hub_url: str, deployment_id: str, now: float,
) -> dict:
    body = to_wire(KeyRotate(
        aud=hub_url, deployment_id=deployment_id, new_pubkey=b64url(public_key_bytes(new)), ts=int(now),
    ))
    body = sign_object(body, old, purpose=Purpose.KEY_ROTATE, field="sig_old", exclude=ROTATE_SIG_FIELDS)
    return sign_object(body, new, purpose=Purpose.KEY_ROTATE, field="sig_new", exclude=ROTATE_SIG_FIELDS)


# Re-signs a stored envelope under `key`. A requester's envelope (from a user)
# gets from_fingerprint = the new key and conversation_key re-rooted at
# genesis_fp (unchanged by a chained rotation); message_id and sent_at are
# kept. A host's reply envelope (from an agent) is signed by the agent's key,
# not the identity key: a chained rotation leaves it as it is (its
# certificate's issuer is still in the chain), and an unchained re-key cannot
# carry it into the new root (CannotResign: it fails key_revoked).
def envelope_resigner(key: Ed25519PrivateKey, *, genesis_fp: str, chained: bool) -> Resigner:
    fp = key_fingerprint(key)

    def resign(old: Mapping[str, Any], purpose: Purpose) -> dict:
        principal = old.get("from_principal")
        if isinstance(principal, Mapping) and principal.get("kind") == "agent":
            if chained:
                return dict(old)
            raise CannotResign("a reply signed under the old identity cannot follow a new root")
        new = {k: v for k, v in old.items() if k != "sig"}
        new["from_fingerprint"] = fp
        new["conversation_key"] = f"{genesis_fp}/{old['requester_project_id']}"
        return sign_object(new, key, purpose=purpose)

    return resign


class RotationRefused(Exception):
    """The hub explicitly refused a ``key_rotate`` (an ``error`` frame): it
    did not switch, so the new key can go."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


# The `send_rotate` for rotate_chained over the hub socket: an `error` frame is
# RotationRefused (the only answer that drops the new key); anything else that
# goes wrong -- a timeout, a lost connection, an unexpected frame -- leaves the
# rotation pending. Returns the key_rotated body.
def socket_rotate(request: Callable[[str, Mapping[str, Any]], Awaitable[Any]]):
    async def send(body: dict) -> Mapping[str, Any]:
        reply = await request("key_rotate", body)
        if reply.frame.type == "error":
            raise RotationRefused(str(reply.data.get("code") or "error"))
        if reply.frame.type != "key_rotated":
            raise ValueError(f"key_rotate answered {reply.frame.type}")
        return reply.data

    return send


# Chained rotation. A new key in a new identity row; key_rotate (signed by
# the old key and the new) goes to the hub through `send_rotate` (the socket's
# request, which answers key_rotated); the hub's statement must name this
# deployment and the new key, and be of kind ``key_rotated`` (a registration
# statement no longer completes a rotation). Then one commit makes the new key current
# (genesis unchanged) and deletes the old row, and every open outbox row is
# re-signed (chained).
#
# The new key is dropped ONLY when the hub explicitly refused (RotationRefused).
# On a timeout, a lost connection, a cancellation or a local check that fails,
# the hub may already have switched to it, so it is KEPT, as a pending
# rotation: an identity row of this hub that the registration does not use.
# settle_rotation, run on the next connect, asks the hub (key_lookup on this
# deployment) and commits or drops it. The registration is untouched until then.
async def rotate_chained(
    store: ChannelStore, config: HubConfig, gateway: RekeyGateway,
    send_rotate: Callable[[dict], Awaitable[Mapping[str, Any]]], *, now: float,
) -> RotateReport:
    assert config.fernet is not None
    hub = HubStore(store)
    reg = hub.registration(config.hub_url)
    if reg is None or reg.status != "active" or reg.deployment_id is None or reg.genesis_fp is None:
        raise RevokeRefused(ErrorCode.UNKNOWN_DEPLOYMENT.value, "this server has no active registration")
    if pending_rotations(store, config, reg):
        raise RevokeRefused("rotation_pending", "an earlier rotation is not settled yet")
    old = load_identity(store, reg.identity_connection_id or "", config.fernet)
    new_connection_id, new = create_identity(store, hub_url=config.hub_url, fernet=config.fernet, now=now)
    new_fp = key_fingerprint(new)
    try:
        body = sign_key_rotate(old, new, hub_url=config.hub_url, deployment_id=reg.deployment_id, now=now)
        raw = await send_rotate(body)
    except RotationRefused:
        drop_identity(store, new_connection_id, now=now)
        raise
    rotated = KeyRotated.model_validate(raw)
    if rotated.fingerprint != new_fp:
        raise RevokeRefused(ErrorCode.INVALID_SIGNATURE.value, "the hub rotated to another key")
    statement = dict(raw["statement"])
    verify_statement(
        statement, hub=hub, config=config, now=now, kind=StatementKind.KEY_ROTATED,
        fingerprint=new_fp, deployment_id=reg.deployment_id,
    )
    return await _commit_rotation(store, config, gateway, reg, new_connection_id, new, statement, now=now)


async def _commit_rotation(
    store: ChannelStore, config: HubConfig, gateway: RekeyGateway, reg: HubRegistration,
    new_connection_id: str, new: Ed25519PrivateKey, statement: dict, *, now: float,
) -> RotateReport:
    assert config.fernet is not None and reg.genesis_fp is not None
    new_fp = key_fingerprint(new)
    HubStore(store).save_registration(replace(
        reg, current_fp=new_fp, identity_connection_id=new_connection_id, statement=statement, updated_at=now,
    ), fernet=config.fernet, replaces_identity=reg.identity_connection_id)
    report = await gateway.resign_after_rekey(
        chained=True, resign=envelope_resigner(new, genesis_fp=reg.genesis_fp, chained=True), current_fp=new_fp,
    )
    return RotateReport(fingerprint=new_fp, resign=report)


# The identity rows of this hub that the registration does not use: rotations
# whose answer never arrived (or did not check out). Their ids.
def pending_rotations(store: ChannelStore, config: HubConfig, reg: HubRegistration) -> list[str]:
    rows = store._db().execute(
        "SELECT id FROM connections WHERE agent_id = ? AND channel = ? AND label = ?",
        (DEPLOYMENT_AGENT_ID, HUB_CHANNEL, config.hub_url),
    ).fetchall()
    return [r[0] for r in rows if r[0] != reg.identity_connection_id]


# The one pending rotation's key, as the identity a dial can sign auth with:
# the hub's head after a key_rotate whose answer was lost (HubClient dials
# with it once after a 4001, so settle_rotation can run). None unless exactly
# one pending rotation exists and its key loads.
def pending_identity(store: ChannelStore, config: HubConfig, reg: Optional[HubRegistration]):
    from .client import HubIdentity

    if (reg is None or reg.status != "active" or reg.deployment_id is None or reg.genesis_fp is None
            or config.fernet is None):
        return None
    pending = pending_rotations(store, config, reg)
    if len(pending) != 1:
        return None
    try:
        key = load_identity(store, pending[0], config.fernet)
    except (KeyError, InvalidToken):
        return None
    return HubIdentity(deployment_id=reg.deployment_id, key=key, genesis_fp=reg.genesis_fp)


# Settle pending rotations against the hub's own record of this deployment
# (key_lookup through `request`, the socket's request, on the next connect).
# A pending key that is the hub's head, one link after the current key in the
# same chain (verified, statement included), is committed exactly as
# rotate_chained would have. A pending key the hub's chain does not hold is
# dropped. If the lookup cannot be made or does not verify, nothing changes and
# the next connect asks again. Returns the commit's report, or None.
async def settle_rotation(
    store: ChannelStore, config: HubConfig, gateway: RekeyGateway,
    request: Callable[[str, Mapping[str, Any]], Awaitable[Any]], *, now: float,
) -> Optional[RotateReport]:
    assert config.fernet is not None
    hub = HubStore(store)
    reg = hub.registration(config.hub_url)
    if reg is None or reg.status != "active" or reg.deployment_id is None or reg.genesis_fp is None:
        return None
    pending = pending_rotations(store, config, reg)
    if not pending:
        return None
    reply = await request("key_lookup", {"deployment_id": reg.deployment_id})
    if reply.frame.type != "deployment_key":
        return None
    raw = reply.data
    try:
        verified = verify_key_chain(raw, aud=config.hub_url, deployment_id=reg.deployment_id)
        if verified is None:
            return None
        fps = [link["fingerprint"] for link in raw["chain"]]
        statement = dict(raw["statement"])
        verify_statement(statement, hub=hub, config=config, now=now, kind=StatementKind.REGISTRATION_ACCEPTED,
                         fingerprint=fps[-1], deployment_id=reg.deployment_id)
    except (KeyError, TypeError, ValidationError, HubUntrusted):
        return None
    if fps[0] != reg.genesis_fp:
        return None
    report = None
    for connection_id in pending:
        try:
            key = load_identity(store, connection_id, config.fernet)
        except (KeyError, InvalidToken):
            continue
        fp = key_fingerprint(key)
        if fp == fps[-1] and len(fps) >= 2 and fps[-2] == reg.current_fp and report is None:
            report = await _commit_rotation(store, config, gateway, reg, connection_id, key, statement, now=now)
        elif fp not in fps:
            drop_identity(store, connection_id, now=now)
    return report


# Unchained re-key, after an identity revoke and the email-verified reclaim
# (operator.register(reclaim=True) then verify): the registration's genesis is
# the new key. Rows never forwarded are re-signed under it (and re-rooted);
# forwarded rows, and every reply row, fail key_revoked.
#
# The evidence of a reclaim is in the rows themselves: an open row signed by a
# key other than the current one, while the registration's chain is just its
# genesis (a chained rotation keeps the genesis and is refused here). A
# deployment that never rotated has no such row, so this does nothing to it.
# A row already signed by the current key is skipped, so a repeat, or a retry
# after a crash partway through, fails nothing that was re-signed. The runtime
# runs it before every (re)connect (HubRuntime.reconcile).
async def rekey_unchained(store: ChannelStore, config: HubConfig, gateway: RekeyGateway) -> ResignReport:
    assert config.fernet is not None
    reg = HubStore(store).registration(config.hub_url)
    if reg is None or reg.genesis_fp is None or reg.genesis_fp != reg.current_fp:
        raise RevokeRefused(ErrorCode.UNKNOWN_DEPLOYMENT.value, "no reclaimed identity to re-key to")
    key = load_identity(store, reg.identity_connection_id or "", config.fernet)
    return await gateway.resign_after_rekey(
        chained=False, resign=envelope_resigner(key, genesis_fp=reg.genesis_fp, chained=False),
        current_fp=reg.current_fp,
    )


# ── meeting another deployment ────────────────────────────────────────────

class ChainUnverified(Exception):
    """A key_lookup answer that does not check out: nothing was pinned."""


# Pin a raw deployment_key answer (key_lookup), as received. Its head must be
# the last link of the chain, the hub's registration statement must name that
# head and the deployment, and its genesis_fp (when given) the chain's
# genesis; then HubStore.pin_chain verifies the chain itself. A chain that
# conflicts with what is pinned is refused. The answer's `revoked` list is the
# hub's word, unsigned by the deployment: it is ADVISORY. When it names a key
# of this chain (so, by the revoke rule, the head too), the chain is not
# pinned at all (ChainUnverified) -- a key the hub calls revoked is never newly
# trusted -- but nothing is marked revoked: only the deployment's own signed
# revoke does that (apply_key_revoked), so a hostile hub can withhold trust
# but can neither forge a revocation nor block the owner's genuine one.
# Returns the pinned head.
def pin_deployment_key(
    hub: HubStore, config: HubConfig, raw: Mapping[str, Any], *, deployment_name: Optional[str],
    now: float,
) -> Pin:
    try:
        chain = raw["chain"]
        head = raw["fingerprint"]
        if not isinstance(chain, list) or not chain or chain[-1].get("fingerprint") != head:
            raise ChainUnverified("the answer's head is not the end of its chain")
        statement = verify_statement(
            raw.get("statement"), hub=hub, config=config, now=now,
            kind=StatementKind.REGISTRATION_ACCEPTED, fingerprint=head,
        )
    except (KeyError, TypeError, AttributeError, HubUntrusted) as exc:
        raise ChainUnverified(f"the key_lookup answer does not verify ({type(exc).__name__})") from None
    if statement.genesis_fp is not None and statement.genesis_fp != raw.get("genesis_fp"):
        raise ChainUnverified("the statement names another genesis")
    flagged = raw.get("revoked")
    if isinstance(flagged, list) and {link.get("fingerprint") for link in chain} & {
            f for f in flagged if isinstance(f, str)}:
        raise ChainUnverified("the hub lists a key of this chain as revoked")
    try:
        result = hub.pin_chain(raw, aud=config.hub_url, deployment_id=statement.subject_deployment_id,
                               deployment_name=deployment_name, now=now)
    except (ChainRejected, ValidationError) as exc:
        raise ChainUnverified(f"the chain does not verify ({type(exc).__name__})") from None
    if result is PinResult.CONFLICT:
        raise ChainUnverified("the chain conflicts with the one pinned here")
    pin = hub.pin_for(head)
    assert pin is not None
    return pin


# The key a deployment signs with now, pinned here: asks the hub (key_lookup
# through `request`, the socket's request) when `fingerprint` is not pinned
# yet, or `deployment_id` names a deployment never met. Returns the pin of
# `fingerprint` (or of the chain's head), or raises ChainUnverified.
async def look_up_and_pin(
    request: Callable[[str, Mapping[str, Any]], Awaitable[Any]], hub: HubStore, config: HubConfig, *,
    now: float, deployment_id: Optional[str] = None, fingerprint: Optional[str] = None,
    deployment_name: Optional[str] = None,
) -> Pin:
    if fingerprint is not None:
        pin = hub.pin_for(fingerprint)
        if pin is not None and (deployment_id is None or pin.deployment_id == deployment_id):
            return pin
    query = {"deployment_id": deployment_id} if deployment_id is not None else {"fingerprint": fingerprint}
    reply = await request("key_lookup", query)
    if reply.frame.type != "deployment_key":
        raise ChainUnverified(f"key_lookup answered {reply.frame.type}")
    head = pin_deployment_key(hub, config, reply.data, deployment_name=deployment_name, now=now)
    if deployment_id is not None and head.deployment_id != deployment_id:
        raise ChainUnverified("the chain belongs to another deployment")
    if fingerprint is not None:
        pin = hub.pin_for(fingerprint)
        if pin is None or pin.genesis_fp != head.genesis_fp:
            raise ChainUnverified("the key is not in the deployment's chain")
        return pin
    return head


# ── the deployment document ───────────────────────────────────────────────

# This deployment's signed DeploymentDocument for `public_url`, signed by its
# current identity key (Purpose.DEPLOYMENT_DOC, so it never verifies as any
# other signed kind). deployment_id and genesis_fp are None before the first
# registration is answered. Returns the signed wire dict.
def sign_deployment_document(
    key: Ed25519PrivateKey, *, hub_url: str, public_url: str, deployment_id: Optional[str],
    genesis_fp: Optional[str], now: float,
) -> dict:
    doc = DeploymentDocument(
        aud=hub_url, public_url=public_url, fingerprint=key_fingerprint(key), genesis_fp=genesis_fp,
        deployment_id=deployment_id, ts=int(now),
    )
    return sign_object(to_wire(doc), key, purpose=Purpose.DEPLOYMENT_DOC)


# ── agent certificates ────────────────────────────────────────────────────

# A certificate for `agent_name`'s key, signed by the identity key, valid for
# AGENT_CERT_LIFETIME_S. Returns the signed wire dict.
def issue_agent_cert(
    identity: Ed25519PrivateKey, agent_key: Ed25519PrivateKey, *, agent_name: str, hub_url: str, now: float,
) -> dict:
    cert = AgentCert(
        serial=secrets.token_hex(8), agent_name=agent_name,
        agent_pubkey=b64url(public_key_bytes(agent_key)), hub_url=hub_url,
        not_after=int(now) + AGENT_CERT_LIFETIME_S, issuer_fp=key_fingerprint(identity),
    )
    return sign_object(to_wire(cert), identity, purpose=Purpose.AGENT_CERT)


# True when the cert has expired or has fewer than AGENT_CERT_RENEW_S left.
def cert_needs_renewal(cert: Optional[Mapping[str, Any]], *, now: float) -> bool:
    if not cert or not isinstance(cert.get("not_after"), int):
        return True
    return cert["not_after"] - now < AGENT_CERT_RENEW_S
