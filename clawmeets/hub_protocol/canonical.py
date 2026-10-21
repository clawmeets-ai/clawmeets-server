# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/canonical.py

The one canonical byte form, and Ed25519 signing and verification over it.

Rule for every signed object on the hub wire: Ed25519 over
``canonical(purpose tag + object minus its signature fields)``, i.e.
``canonical_bytes({"_purpose": "clawmeets-hub/v1/<kind>", **object minus sig
fields})``. The tag names what kind of object the bytes are, so one key's
signature on one kind (a requester's Envelope) never verifies as another (a
delivery_probe), whatever fields either kind gains later. The tag is never on
the wire: a verifier takes it from the type it is verifying (``Purpose``, or
a model's SIGNING_PURPOSE), never from the message, and refuses an object
that carries a ``_purpose`` field of its own.

Canonical form: ``json.dumps(obj, sort_keys=True, separators=(",", ":"),
ensure_ascii=False, allow_nan=False)`` encoded as UTF-8, after a walk that
accepts only dict (ASCII str keys), list, str, int, float, bool and None:

  - keys sorted by code point at every depth (ASCII keys, so also byte order);
  - at most MAX_JSON_DEPTH levels of nested objects and arrays;
  - ints within +/-(2**53 - 1); floats as Python's shortest repr, NaN and inf
    refused; an int stays an int and a float stays a float;
  - strings as UTF-8, escaped only where JSON must; no Unicode normalisation;
    a lone surrogate is refused;
  - None is written as null. Senders never put one on the wire (``to_wire``
    drops them), but a received null is verified exactly as sent.

Verification always runs on the dict as received (``loads_strict``), never on
a pydantic re-dump, so no pydantic upgrade can break a signature between two
deployments. This module does not import pydantic: ``to_wire`` and
``verify_then_parse`` only call methods on the model they are given.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import Any, Generic, Mapping, TypeVar

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from clawmeets.hub_protocol.constants import (
    MAX_JSON_DEPTH,
    MAX_JSON_FRAME_BYTES,
    MAX_SAFE_INT,
)

T = TypeVar("T")

SIG_FIELDS: tuple[str, ...] = ("sig",)

# The signing-domain tag's key in the signed bytes. Never sent.
PURPOSE_FIELD = "_purpose"


class Purpose(str, Enum):
    """What a signature is for: one value per kind of signed object."""

    AUTH = "clawmeets-hub/v1/auth"
    AGENT_UNREGISTER = "clawmeets-hub/v1/agent_unregister"
    DELIVERY_PROBE = "clawmeets-hub/v1/delivery_probe"
    DELIVER_ACK = "clawmeets-hub/v1/deliver_ack"
    KEY_ROTATE = "clawmeets-hub/v1/key_rotate"
    REVOKE = "clawmeets-hub/v1/revoke"
    REGISTER = "clawmeets-hub/v1/register"
    VERIFY_EMAIL = "clawmeets-hub/v1/verify_email"
    OWNER_VERIFY_START = "clawmeets-hub/v1/owner_verify_start"
    OWNER_VERIFY_CONFIRM = "clawmeets-hub/v1/owner_verify_confirm"
    AGENT_CERT = "clawmeets-hub/v1/agent_cert"
    ENVELOPE = "clawmeets-hub/v1/envelope"
    LISTING = "clawmeets-hub/v1/listing"
    DEPLOYMENT_DOC = "clawmeets-hub/v1/deployment_doc"
    # Signed by the hub.
    HELLO = "clawmeets-hub/v1/hello"
    STATEMENT = "clawmeets-hub/v1/statement"
    KEY_SET = "clawmeets-hub/v1/key_set"
    ROUTE = "clawmeets-hub/v1/route"


# Purposes whose signed bytes are not "object minus sig": a listing covers
# aud, agent_name and issuer_fp beside it, a route stamp covers its envelope's
# sig. signing_payload refuses them, so sign_object, verify_object and
# verify_then_parse cannot check one cut loose from what it binds; use
# frames.listing_signing_payload / route_signing_payload and their verifiers.
# Exactly the SIGNING_PURPOSE of the DETACHED_PAYLOAD models.
DETACHED_PURPOSES: frozenset[Purpose] = frozenset({Purpose.LISTING, Purpose.ROUTE})

_B64URL_RE = re.compile(r"[A-Za-z0-9_-]*")
# A JSON string literal (escapes included), and any character that is not a bracket.
_JSON_STRING_RE = re.compile(r'"[^"\\]*(?:\\.[^"\\]*)*"')
_NOT_BRACKET_RE = re.compile(r"[^\[\]{}]")
# No safe int has more digits than this, so a longer literal is refused before int() runs.
_MAX_INT_DIGITS = len(str(MAX_SAFE_INT))


class CanonicalError(ValueError):
    """A value with no canonical form (NaN/inf, lone surrogate, unsafe int,
    non-str or non-ASCII key, non-JSON type, nesting deeper than
    MAX_JSON_DEPTH), or wire bytes ``loads_strict`` refuses (duplicate key,
    oversize, too deep, an integer literal too long, invalid UTF-8 or JSON)."""


def _check(value: Any, path: str, depth: int = 0) -> None:
    if isinstance(value, (list, dict)) and depth >= MAX_JSON_DEPTH:
        raise CanonicalError(f"{path}: nested deeper than {MAX_JSON_DEPTH} levels")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, int):
        if not -MAX_SAFE_INT <= value <= MAX_SAFE_INT:
            raise CanonicalError(f"{path}: integer outside +/-(2**53 - 1)")
        return
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise CanonicalError(f"{path}: NaN or infinity")
        return
    if isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise CanonicalError(f"{path}: lone surrogate in string") from exc
        return
    if isinstance(value, list):
        for i, item in enumerate(value):
            _check(item, f"{path}[{i}]", depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or not key.isascii():
                raise CanonicalError(f"{path}: key {key!r} is not an ASCII string")
            _check(item, f"{path}.{key}", depth + 1)
        return
    raise CanonicalError(f"{path}: {type(value).__name__} is not a JSON value")


# The canonical bytes of a plain JSON object (spec in the module docstring).
def canonical_bytes(obj: Mapping[str, Any]) -> bytes:
    if not isinstance(obj, Mapping):
        raise CanonicalError("a signed object must be a JSON object")
    obj = dict(obj)
    _check(obj, "$")
    return json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


# canonical_bytes of body with the purpose tag added. CanonicalError if body
# already has a _purpose field: a message never names its own purpose.
def tagged_bytes(body: Mapping[str, Any], purpose: Purpose) -> bytes:
    if not isinstance(purpose, Purpose):
        raise TypeError("purpose must be a Purpose, chosen by the caller")
    if not isinstance(body, Mapping):
        raise CanonicalError("a signed object must be a JSON object")
    if PURPOSE_FIELD in body:
        raise CanonicalError(f"a signed object may not carry {PURPOSE_FIELD!r}")
    return canonical_bytes({PURPOSE_FIELD: purpose.value, **body})


# TypeError unless purpose is a Purpose whose signed bytes are the object
# minus its signature fields (not in DETACHED_PURPOSES).
def _check_object_purpose(purpose: Any) -> None:
    if not isinstance(purpose, Purpose):
        raise TypeError("purpose must be a Purpose, chosen by the caller")
    if purpose in DETACHED_PURPOSES:
        raise TypeError(f"{purpose.value} signs more than the object; use its own verifier")


# The bytes to sign or verify: the purpose tag plus obj without the named
# signature fields. Never mutates obj. TypeError for a DETACHED_PURPOSES
# purpose, whose bytes are not built from obj alone.
def signing_payload(
    obj: Mapping[str, Any], *, purpose: Purpose, exclude: tuple[str, ...] = SIG_FIELDS
) -> bytes:
    _check_object_purpose(purpose)
    if not isinstance(obj, Mapping):
        raise CanonicalError("a signed object must be a JSON object")
    return tagged_bytes({k: v for k, v in obj.items() if k not in exclude}, purpose)


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise CanonicalError(f"duplicate key {key!r}")
        out[key] = value
    return out


def _no_constant(name: str) -> Any:
    raise CanonicalError(f"{name} is not valid JSON")


def _safe_int(literal: str) -> int:
    if len(literal.lstrip("-")) > _MAX_INT_DIGITS:
        raise CanonicalError(f"integer literal of more than {_MAX_INT_DIGITS} digits")
    return int(literal)


# Refuse text nested deeper than MAX_JSON_DEPTH before json.loads recurses
# into it. Brackets inside string literals do not count; malformed text is
# left for json.loads to refuse.
def _check_depth(text: str) -> None:
    depth = 0
    for bracket in _NOT_BRACKET_RE.sub("", _JSON_STRING_RE.sub("", text)):
        depth += 1 if bracket in "[{" else -1
        if depth > MAX_JSON_DEPTH:
            raise CanonicalError(f"nested deeper than {MAX_JSON_DEPTH} levels")


# json.loads that refuses duplicate keys, NaN/Infinity, invalid UTF-8,
# anything over max_bytes, nesting deeper than MAX_JSON_DEPTH and integer
# literals longer than any safe int. Raises only CanonicalError. Returns plain dicts. The ONLY loader for anything
# that will be verified.
def loads_strict(raw: bytes | str, *, max_bytes: int = MAX_JSON_FRAME_BYTES) -> Any:
    if isinstance(raw, str):
        try:
            data = raw.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise CanonicalError("lone surrogate in input") from exc
    elif isinstance(raw, (bytes, bytearray)):
        data = bytes(raw)
    else:
        raise CanonicalError(f"cannot load {type(raw).__name__}")
    if len(data) > max_bytes:
        raise CanonicalError(f"{len(data)} bytes exceeds the {max_bytes}-byte cap")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CanonicalError("input is not UTF-8") from exc
    _check_depth(text)
    try:
        return json.loads(
            text, object_pairs_hook=_no_duplicates, parse_constant=_no_constant, parse_int=_safe_int
        )
    except CanonicalError:
        raise
    except json.JSONDecodeError as exc:
        raise CanonicalError(f"invalid JSON: {exc.msg}") from exc


# base64url without padding.
def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


# Inverse of b64url. Refuses padding, other alphabets, non-canonical trailing
# bits and (when given) a decoded length other than `length`.
def b64url_decode(s: str, *, length: int | None = None) -> bytes:
    if not isinstance(s, str) or not _B64URL_RE.fullmatch(s) or len(s) % 4 == 1:
        raise ValueError("not unpadded base64url")
    try:
        raw = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (binascii.Error, ValueError) as exc:
        raise ValueError("not unpadded base64url") from exc
    if b64url(raw) != s:
        raise ValueError("non-canonical base64url")
    if length is not None and len(raw) != length:
        raise ValueError(f"decodes to {len(raw)} bytes, expected {length}")
    return raw


# Key fingerprint: lowercase RFC 4648 base32 of sha256(raw 32-byte public key), first 16 chars.
def fingerprint(public_key: bytes) -> str:
    if len(public_key) != 32:
        raise ValueError("an Ed25519 public key is 32 bytes")
    return base64.b32encode(hashlib.sha256(public_key).digest()).decode("ascii").lower()[:16]


# Raw 32-byte public key of a private or public Ed25519 key.
def public_key_bytes(key: Ed25519PrivateKey | Ed25519PublicKey) -> bytes:
    if isinstance(key, Ed25519PrivateKey):
        key = key.public_key()
    return key.public_bytes(Encoding.Raw, PublicFormat.Raw)


# Sign the exact dict that will be sent: returns a NEW dict = obj plus
# {field: b64url(sig)}. `field` must be one of `exclude`, so a second
# signature (key_rotate's sig_new) never covers the first.
def sign_object(
    obj: Mapping[str, Any],
    key: Ed25519PrivateKey,
    *,
    purpose: Purpose,
    field: str = "sig",
    exclude: tuple[str, ...] = SIG_FIELDS,
) -> dict[str, Any]:
    if field not in exclude:
        raise ValueError(f"signature field {field!r} must be excluded from the payload")
    signed = dict(obj)
    signed[field] = b64url(key.sign(signing_payload(obj, purpose=purpose, exclude=exclude)))
    return signed


# Verify a base64url signature over payload bytes. Never raises.
def verify_signature(payload: bytes, sig: Any, public_key: bytes) -> bool:
    try:
        raw_sig = b64url_decode(sig, length=64)
        pub = Ed25519PublicKey.from_public_bytes(bytes(public_key))
        pub.verify(raw_sig, payload)
        return True
    # InvalidSignature, a malformed sig or key, or whatever error this OpenSSL
    # build raises for an off-curve key (at load on some, at verify on others).
    except Exception:
        return False


# Verify obj[field] over signing_payload(obj, purpose, exclude). `purpose` is
# the kind the caller expects, never read from obj. Never raises on input: a
# malformed object, key, signature or encoding returns False. TypeError (a
# caller error) for a purpose that is not a Purpose or is in DETACHED_PURPOSES.
def verify_object(
    obj: Any,
    public_key: bytes,
    *,
    purpose: Purpose,
    field: str = "sig",
    exclude: tuple[str, ...] = SIG_FIELDS,
) -> bool:
    _check_object_purpose(purpose)
    if not isinstance(obj, Mapping) or field not in exclude:
        return False
    try:
        payload = signing_payload(obj, purpose=purpose, exclude=exclude)
    except CanonicalError:
        return False
    return verify_signature(payload, obj.get(field), public_key)


# A parsed payload kept together with the dict its signature was checked on,
# so later code stores or forwards the exact signed object, never a re-dump.
@dataclass(frozen=True)
class Verified(Generic[T]):
    model: T
    raw: Mapping[str, Any]


# Verify first, then parse: model_cls.model_validate(raw) runs only on a raw
# dict whose signature already checked out, under model_cls.SIGNING_PURPOSE
# (the type being parsed decides the purpose). None if the signature fails;
# a pydantic ValidationError if a verified object does not fit the schema.
# A model whose signature covers more than the object minus its signature
# fields (DETACHED_PAYLOAD) is refused with TypeError: checked here, its
# signature would verify over bytes the caller assembled from the object
# itself, cut loose from what it was meant to bind. Use its own verifier.
def verify_then_parse(
    raw: Any,
    model_cls: type[T],
    public_key: bytes,
    *,
    field: str = "sig",
    exclude: tuple[str, ...] = SIG_FIELDS,
) -> Verified[T] | None:
    purpose = getattr(model_cls, "SIGNING_PURPOSE", None)
    if not isinstance(purpose, Purpose):
        raise TypeError(f"{getattr(model_cls, '__name__', model_cls)!r} has no SIGNING_PURPOSE")
    if getattr(model_cls, "DETACHED_PAYLOAD", False):
        raise TypeError(f"{model_cls.__name__} signs more than the object; use its own verifier")
    if not verify_object(raw, public_key, purpose=purpose, field=field, exclude=exclude):
        return None
    return Verified(model=model_cls.model_validate(raw), raw=raw)  # type: ignore[attr-defined]


# A model as the wire dict, once: model_dump(mode="json", by_alias=True,
# exclude_none=True). Sign this dict and send this dict.
def to_wire(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", by_alias=True, exclude_none=True)
