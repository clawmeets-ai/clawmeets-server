# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/keys.py

The hub signing keys a deployment trusts out of the box, and the rule for
accepting a successor key from the hub's published key set.

PINNED_HUB_KEYS holds, per canonical hub URL, the keys a fresh deployment
trusts before it has ever connected. Every other hub key is accepted only
through a set signature by a key already trusted (``accept_key_set``).

No real hub key exists yet. The default hub is pinned to a PLACEHOLDER that is
provably unusable: the first ``sha256(b"clawmeets hub placeholder pin v1|" +
str(i))`` whose 32 bytes do not decode to a point on Ed25519 (y < p, and
(y^2 - 1) / (d*y^2 + 1) has no square root mod p). No private key can exist
for it, and anyone can re-derive and check it
(tests/hub_protocol/test_keys.py does, with integer arithmetic only). While
only the placeholder is pinned, ``pins_are_placeholder`` is true and clients
refuse to connect to that URL (status hub_untrusted): fail closed. The real
public key replaces it before launch.

scripts/assert-no-hub-leak.py reads this file with ``ast`` and never executes
it: every pinned key must stay an inline base64url string literal inside the
PINNED_HUB_KEYS assignment, or the guard stops with a config error.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar, Literal, Mapping

from clawmeets.hub_protocol.canonical import (
    CanonicalError,
    Purpose,
    b64url_decode,
    signing_payload,
    verify_signature,
)
from clawmeets.hub_protocol.constants import DEFAULT_HUB_URL
from clawmeets.hub_protocol.ids import (
    EpochS,
    HubUrl,
    OpaqueId,
    PublicKeyB64,
    SignatureB64,
    WireModel,
    canonical_hub_url,
)


@dataclass(frozen=True)
class PinnedKey:
    kid: str
    pub: str            # base64url, raw 32 bytes
    not_before: int     # epoch s
    not_after: int      # epoch s


PINNED_HUB_KEYS: dict[str, tuple[PinnedKey, ...]] = {
    DEFAULT_HUB_URL: (
        PinnedKey(
            kid="placeholder-v1",
            pub="jCNDQJ0MiBUGgBrOfmQyjcbTCoe6M3F_Ezwd4M2J4gM",
            not_before=0,
            not_after=0,
        ),
    ),
}

# Kids an emergency release withdraws. Before the first connect a deployment
# deletes each one, and every key accepted through it, from its trusted set.
REVOKED_HUB_KIDS: dict[str, frozenset[str]] = {DEFAULT_HUB_URL: frozenset()}

# A successor's not_after is at most this long after its not_before.
MAX_SUCCESSOR_LIFETIME_DAYS: int = 730
# A deployment offline longer than this may hold no key still able to sign the
# current set; it shows hub_untrusted until its server is upgraded.
OFFLINE_UPGRADE_DAYS: int = 180

PLACEHOLDER_KIDS: frozenset[str] = frozenset({"placeholder-v1"})
PLACEHOLDER_PREFIX: bytes = b"clawmeets hub placeholder pin v1|"

# The key set's signatures, excluded from the object they sign.
KEY_SET_SIG_FIELDS: tuple[str, ...] = ("set_sig",)


class HubKeyEntry(WireModel):
    kid: OpaqueId
    alg: Literal["Ed25519"]
    pub: PublicKeyB64
    not_before: EpochS
    not_after: EpochS


class KidSig(WireModel):
    kid: OpaqueId
    sig: SignatureB64


class HubKeySet(WireModel):
    """GET /.well-known/clawmeets-hub-keys.json, also pushed in welcome.
    Each set_sig is a currently valid key's signature over the set minus set_sig."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.KEY_SET

    hub_url: HubUrl
    keys: list[HubKeyEntry]
    set_sig: list[KidSig]


class KeySetError(ValueError):
    """The key set is for another hub, or no trusted, unrevoked key valid at
    `now` signed it."""


@dataclass(frozen=True)
class TrustedKey:
    """A hub key a deployment trusts, with the window it may sign in."""

    pub: bytes          # raw 32 bytes
    not_before: int     # epoch s
    not_after: int      # epoch s

    # True if this key may sign at `now`: not_before <= now < not_after.
    def valid_at(self, now: int) -> bool:
        return self.not_before <= now < self.not_after

    # The trusted form of an entry accept_key_set returned.
    @classmethod
    def of(cls, entry: HubKeyEntry) -> "TrustedKey":
        return cls(pub=b64url_decode(entry.pub, length=32), not_before=entry.not_before, not_after=entry.not_after)


# True if every key pinned for url is a placeholder (no real hub key exists
# yet). Later steps refuse to open a socket to that URL while this is true.
# False for a URL with no pins at all (its key comes from configuration).
def pins_are_placeholder(url: str) -> bool:
    pins = PINNED_HUB_KEYS.get(canonical_hub_url(url), ())
    return bool(pins) and all(p.kid in PLACEHOLDER_KIDS for p in pins)


# The trusted kid -> key map a fresh deployment starts from for url.
def pinned_trust(url: str) -> dict[str, TrustedKey]:
    url = canonical_hub_url(url)
    revoked = REVOKED_HUB_KIDS.get(url, frozenset())
    return {
        p.kid: TrustedKey(pub=b64url_decode(p.pub, length=32), not_before=p.not_before, not_after=p.not_after)
        for p in PINNED_HUB_KEYS.get(url, ())
        if p.kid not in revoked
    }


# Check a received key set (the raw dict, as loaded by loads_strict) against
# the keys already trusted for url. It must name url, and at least one set_sig
# must verify under a trusted kid that is not revoked and is valid at `now`
# (a retired key signs nothing); else KeySetError, whatever the set's shape. Returns the entries newly trusted through that signature: not
# already trusted, not revoked, not expired at `now`, and not_after at most
# MAX_SUCCESSOR_LIFETIME_DAYS after not_before. The set is parsed only after
# its signature checks out. Pure; storing the keys is the caller's job.
def accept_key_set(
    raw: Mapping[str, Any],
    *,
    url: str,
    trusted: Mapping[str, TrustedKey],
    revoked: frozenset[str],
    now: int,
) -> list[HubKeyEntry]:
    if not isinstance(raw, Mapping) or raw.get("hub_url") != canonical_hub_url(url):
        raise KeySetError("key set is for another hub")
    try:
        payload = signing_payload(raw, purpose=Purpose.KEY_SET, exclude=KEY_SET_SIG_FIELDS)
    except CanonicalError as exc:
        raise KeySetError(f"key set has no canonical form: {exc}") from exc
    raw_sigs = raw.get("set_sig")
    signed_by_trusted = any(
        isinstance(item, Mapping)
        and isinstance(item.get("kid"), str)
        and item["kid"] in trusted
        and item["kid"] not in revoked
        and trusted[item["kid"]].valid_at(now)
        and verify_signature(payload, item.get("sig"), trusted[item["kid"]].pub)
        for item in (raw_sigs if isinstance(raw_sigs, list) else ())
    )
    if not signed_by_trusted:
        raise KeySetError("no trusted, unrevoked key valid now signed this key set")
    key_set = HubKeySet.model_validate(raw)     # parsed only once its signature checked out
    max_lifetime = MAX_SUCCESSOR_LIFETIME_DAYS * 86400
    return [
        entry for entry in key_set.keys
        if entry.kid not in trusted
        and entry.kid not in revoked
        and entry.not_after > now
        and entry.not_after - entry.not_before <= max_lifetime
    ]

