# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/trust.py
Which hub keys this deployment trusts, and checking what the hub signs.

The trusted set (``hub_trusted_keys``) starts from the keys shipped for the
default hub (``pinned_trust``) or, for any other hub, the operator's
``CLAWMEETS_HUB_PUBKEY``. Every later key comes only through the hub's key set,
signed by a key already trusted (``accept_key_set``), and is stored with the
kid that admitted it. Before anything is accepted, the kids an emergency
release withdrew (``REVOKED_HUB_KIDS``) are purged with every key they
admitted, at any depth.

A hub URL with only a placeholder pinned is refused here, before any I/O:
nothing that trusts it can be built.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import CanonicalError, Purpose, signing_payload, verify_signature, verify_then_parse
from clawmeets.hub_protocol.frames import Hello, verify_route
from clawmeets.hub_protocol.http import Statement
from clawmeets.hub_protocol.keys import (
    KEY_SET_SIG_FIELDS,
    REVOKED_HUB_KIDS,
    KeySetError,
    TrustedKey,
    accept_key_set,
    pinned_trust,
)
from clawmeets.server.channels.config import HubConfig
from clawmeets.server.channels.hub_store import HubStore

from .http import HubHttp


class HubUntrusted(Exception):
    """This deployment cannot trust the hub, or what it signed. ``reason``:
    ``placeholder_pin``, ``broken_chain``, ``unknown_signer``,
    ``bad_signature``, ``bad_statement`` or ``wrong_subject``."""

    def __init__(self, reason: str, detail: str = "") -> None:
        self.reason = reason
        self.detail = detail
        super().__init__(f"{reason}: {detail}" if detail else reason)


@dataclass(frozen=True)
class TrustRefresh:
    added: list[str] = field(default_factory=list)      # kids the key set added
    purged: list[str] = field(default_factory=list)     # kids withdrawn (REVOKED_HUB_KIDS, CLAWMEETS_HUB_PUBKEY)


def _revoked(config: HubConfig) -> frozenset[str]:
    return REVOKED_HUB_KIDS.get(config.hub_url, frozenset())


# Seed the trusted set for config.hub_url (pins on the default hub, the
# operator's keys elsewhere; a kid already trusted is left as it is), then
# purge REVOKED_HUB_KIDS and everything admitted through them. Off the default
# hub the operator's keys follow CLAWMEETS_HUB_PUBKEY: one removed from it, or
# whose public key changed, is withdrawn first with everything it admitted.
# Returns the purged kids. HubUntrusted("placeholder_pin") first, before any
# read or write.
def seed_trust(hub: HubStore, config: HubConfig, *, now: float) -> list[str]:
    if config.refusal is not None:
        raise HubUntrusted(config.refusal, f"{config.hub_url} has only a placeholder key pinned")
    withdrawn: list[str] = []
    if config.is_default:
        hub.seed_trusted_keys(config.hub_url, pinned_trust(config.hub_url), source="pinned", now=now)
    else:
        withdrawn = hub.withdraw_configured_keys(config.hub_url, config.configured_keys)
        hub.seed_trusted_keys(config.hub_url, dict(config.configured_keys), source="configured", now=now)
    return sorted(set(withdrawn) | set(hub.purge_trusted_keys_through(config.hub_url, _revoked(config))))


# The kid of the first set_sig that verifies under a trusted, unrevoked key
# valid at now: the key that vouches for the set (accept_key_set's own rule).
def _signing_kid(raw: Mapping[str, Any], trusted: Mapping[str, TrustedKey],
                 revoked: frozenset[str], now: int) -> Optional[str]:
    try:
        payload = signing_payload(raw, purpose=Purpose.KEY_SET, exclude=KEY_SET_SIG_FIELDS)
    except CanonicalError:
        return None
    sigs = raw.get("set_sig")
    for item in sigs if isinstance(sigs, list) else ():
        kid = item.get("kid") if isinstance(item, Mapping) else None
        if (isinstance(kid, str) and kid in trusted and kid not in revoked
                and trusted[kid].valid_at(now) and verify_signature(payload, item.get("sig"), trusted[kid].pub)):
            return kid
    return None


# Accept a key set as received (the raw dict: from the well-known URL, or the
# hub_key_set a welcome carries) against the trusted set. HubUntrusted
# ("broken_chain") — nothing stored — when no trusted, unrevoked key valid now
# signed it, or it names another hub. Otherwise the new keys are stored with
# accepted_via = the kid that signed. Returns the kids added.
def accept_pushed_key_set(hub: HubStore, config: HubConfig, raw: Any, *, now: float) -> list[str]:
    trusted = hub.trusted_keys(config.hub_url)
    revoked = _revoked(config)
    try:
        entries = accept_key_set(raw, url=config.hub_url, trusted=trusted, revoked=revoked, now=int(now))
    except (KeySetError, ValidationError) as exc:
        raise HubUntrusted("broken_chain", type(exc).__name__ if isinstance(exc, ValidationError) else str(exc)) from None
    if entries:
        kid = _signing_kid(raw, trusted, revoked, int(now))
        assert kid is not None  # accept_key_set just found one
        hub.add_trusted_keys(config.hub_url, entries, accepted_via=kid, now=now)
    return [e.kid for e in entries]


# seed_trust, then fetch the hub's key set and accept it (accept_pushed_key_set).
# Returns the kids added and purged. HubUnreachable / HubRefused from the
# fetch propagate.
def refresh_trust(hub: HubStore, config: HubConfig, client: HubHttp, *, now: float) -> TrustRefresh:
    purged = seed_trust(hub, config, now=now)
    added = accept_pushed_key_set(hub, config, client.key_set(), now=now)
    return TrustRefresh(added=added, purged=purged)


# A hub statement, as received: signed by a trusted kid that is not revoked
# and valid at now, for this hub, of `kind`, about `fingerprint` (and
# `deployment_id`, when given). Else HubUntrusted. Returns the parsed model.
def verify_statement(
    raw: Any, *, hub: HubStore, config: HubConfig, now: float, kind: str,
    fingerprint: str, deployment_id: Optional[str] = None,
) -> Statement:
    kid = raw.get("kid") if isinstance(raw, Mapping) else None
    key = hub.trusted_keys(config.hub_url).get(kid) if isinstance(kid, str) else None
    if key is None or kid in _revoked(config) or not key.valid_at(int(now)):
        raise HubUntrusted("unknown_signer", "the statement is not signed by a trusted hub key")
    try:
        verified = verify_then_parse(raw, Statement, key.pub)
    except ValidationError:
        raise HubUntrusted("bad_statement", "the statement does not fit its schema") from None
    if verified is None:
        raise HubUntrusted("bad_signature", "the statement's signature does not verify")
    statement = verified.model
    if statement.hub_url != config.hub_url:
        raise HubUntrusted("wrong_subject", "the statement names another hub")
    if statement.kind != kind:
        raise HubUntrusted("wrong_subject", f"the statement is not {kind}")
    if statement.subject_fingerprint != fingerprint:
        raise HubUntrusted("wrong_subject", "the statement names another identity key")
    if deployment_id is not None and statement.subject_deployment_id != deployment_id:
        raise HubUntrusted("wrong_subject", "the statement names another deployment")
    return statement


# The hub's hello, as received: signed by a trusted kid that is not revoked and
# valid at now. Else HubUntrusted ("unknown_signer", "bad_signature" or
# "bad_statement" for a hello that does not fit its schema). Whether it names
# this hub and its clock is close enough is the caller's check (those are not
# trust failures). Returns the parsed model.
def verify_hello(raw: Any, *, hub: HubStore, config: HubConfig, now: float) -> Hello:
    kid = raw.get("kid") if isinstance(raw, Mapping) else None
    key = hub.trusted_keys(config.hub_url).get(kid) if isinstance(kid, str) else None
    if key is None or kid in _revoked(config) or not key.valid_at(int(now)):
        raise HubUntrusted("unknown_signer", "the hello is not signed by a trusted hub key")
    try:
        verified = verify_then_parse(raw, Hello, key.pub)
    except ValidationError:
        raise HubUntrusted("bad_statement", "the hello does not fit its schema") from None
    if verified is None:
        raise HubUntrusted("bad_signature", "the hello's signature does not verify")
    return verified.model


# A deliver frame's route stamp, as received: hub_sig by a trusted kid valid
# at now, over the stamp bound to the envelope it came with. Never raises.
def verify_deliver_route(data: Any, *, hub: HubStore, config: HubConfig, now: float) -> bool:
    route = data.get("route") if isinstance(data, Mapping) else None
    kid = route.get("kid") if isinstance(route, Mapping) else None
    key = hub.trusted_keys(config.hub_url).get(kid) if isinstance(kid, str) else None
    if key is None or kid in _revoked(config) or not key.valid_at(int(now)):
        return False
    return verify_route(data, key.pub)
