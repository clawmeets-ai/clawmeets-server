# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/frames.py

Every WebSocket frame on wss://{hub}/v1/connect: the frame shape, one payload
model per frame type, the registry, and parse_frame / make_frame.

A text frame is always ``{"v", "id", "type", "data"}``. A reply echoes the
request's id; a pushed frame gets a fresh one. Where a frame carries a signed
object, ``data`` IS that object (an Envelope, a Statement, a RevokeBody), so it
can be forwarded verbatim inside another frame without touching transport
fields: the deliver_ack inside a delivery_receipt, a deployment's revoke
inside a key_revoked statement.

Signed payloads, their signers and purpose tags (canonical.Purpose). Every
payload is canonical(purpose tag + the fields below), so a signature made for
one kind never verifies as another:
  hello              hub key `kid`        HELLO             data minus sig
  auth               identity key         AUTH              data minus sig (aud and nonce inside)
  agent_register     agent key            LISTING           listing_signing_payload(aud, agent_name, cert.issuer_fp, listing)
  agent_unregister   identity key         AGENT_UNREGISTER  data minus sig
  relay / deliver    sender               ENVELOPE          the Envelope minus sig
  deliver.route      hub key `kid`        ROUTE             route_signing_payload(route, envelope.sig)
  delivery_probe     identity key         DELIVERY_PROBE    data minus sig
  deliver_ack        receiver identity    DELIVER_ACK       data minus sig
  key_rotate         old AND new key      KEY_ROTATE        data minus (sig_old, sig_new)
  statement          hub key `kid`        STATEMENT         data minus sig
  revoke             signer_fp's key      REVOKE            data minus sig
  dispatch_ask       identity key         DISPATCH_ASK      data minus sig
  dispatch_deliver.stamp  hub key `kid`   DISPATCH_STAMP    dispatch_stamp_signing_payload(stamp, ask.sig)
  dispatch_outcome   identity key         DISPATCH_OUTCOME  data minus sig
The agent cert (AGENT_CERT), register and verify-email bodies, and the hub key
set (KEY_SET) follow the same rule.

Verify on the raw ``data`` dict parse_frame returns, never on a re-dump of
the model, and parse a signed object only after it verified. The purpose
comes from the type being verified (each signed model's SIGNING_PURPOSE),
never from the message. agent_register and deliver.route sign more than the
object (DETACHED_PAYLOAD), so verify_then_parse refuses them; check them with
verify_listing and verify_route. A dispatch stamp is the same: verify_dispatch_stamp.

Hub-ranked dispatch. A requester signs ONE DispatchAsk carrying the request,
an expiry and 1..MAX_DISPATCH_SLOTS reply slots: the requester_project_ids of
the threads it will open, so the slot count caps how many agents can be asked
and every reply still binds through today's conversation key
``{genesis}/{slot}``. The hub ranks, answers the asker with a DispatchPlan,
then pushes each picked host a DispatchDeliver: the ask verbatim plus a
DispatchStamp naming one agent and one slot, signed over the ask's signature.
The hub can choose who reads the ask but cannot alter it, extend it, or get a
reply accepted from an agent its plan did not name.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Annotated, Any, ClassVar, Literal, Mapping, NamedTuple

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import (
    BaseModel,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from clawmeets.hub_protocol.canonical import (
    CanonicalError,
    Purpose,
    Verified,
    b64url,
    b64url_decode,
    canonical_bytes,
    fingerprint,
    loads_strict,
    tagged_bytes,
    to_wire,
    verify_object,
    verify_signature,
)
from clawmeets.hub_protocol.codes import ErrorCode, WireCode
from clawmeets.hub_protocol.constants import (
    DISPATCH_TTL_S,
    MAX_AVATAR_BYTES,
    MAX_CAPABILITIES,
    MAX_CAPABILITY_CHARS,
    MAX_DISPATCH_EXCLUDE,
    MAX_DISPATCH_SHOWN,
    MAX_DISPATCH_SLOTS,
    MAX_DISPATCH_TEXT_BYTES,
    MAX_JSON_FRAME_BYTES,
    MAX_NOTE_CHARS,
    MAX_OUTCOME_EVENTS,
    MAX_SEARCH_LIMIT,
    MAX_WATCH_IDS,
    MIN_SUPPORTED_VERSION,
    PROTOCOL_VERSION,
)
from clawmeets.hub_protocol.envelope import AgentCert, Envelope, UserPrincipal
from clawmeets.hub_protocol.http import (
    ErrorDetail,
    ProtocolInfo,
    RevokeBody,
    RevokedResponse,
    Statement,
)
from clawmeets.hub_protocol.ids import (
    AgentName,
    Count,
    DeploymentName,
    EpochFloat,
    EpochS,
    Fingerprint,
    HubUrl,
    MessageId,
    NonceB64,
    OpaqueId,
    PublicKeyB64,
    Sha256Hex,
    SignatureB64,
    WireModel,
    canonical_hub_url,
    dispatched_message_id,
)
from clawmeets.hub_protocol.keys import HubKeySet

FrameId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
Capability = Annotated[str, StringConstraints(min_length=1, max_length=MAX_CAPABILITY_CHARS)]
Description = Annotated[str, StringConstraints(max_length=500)]
Label = Annotated[str, StringConstraints(max_length=80)]
AvatarType = Literal["image/png", "image/jpeg", "image/webp"]
# base64url of at most MAX_AVATAR_BYTES, unpadded.
AvatarB64 = Annotated[str, StringConstraints(min_length=1, max_length=-(-MAX_AVATAR_BYTES * 4 // 3))]

ROTATE_SIG_FIELDS: tuple[str, ...] = ("sig_old", "sig_new")
ROUTE_SIG_FIELDS: tuple[str, ...] = ("hub_sig",)
DISPATCH_STAMP_SIG_FIELDS: tuple[str, ...] = ("hub_sig",)


class Frame(WireModel):
    v: Annotated[int, Field(ge=0)]
    id: FrameId
    type: Annotated[str, StringConstraints(pattern=r"^[a-z_]{1,40}$")]
    data: dict[str, Any]


# --------------------------------------------------------------------------
# Handshake and presence
# --------------------------------------------------------------------------

class Hello(WireModel):
    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.HELLO

    hub_url: HubUrl
    nonce: NonceB64
    hub_time: EpochFloat
    protocol: ProtocolInfo
    kid: OpaqueId
    sig: SignatureB64 | None = None


class Auth(WireModel):
    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.AUTH

    v: Annotated[int, Field(ge=1)]
    aud: HubUrl
    nonce: NonceB64                 # hello.nonce, echoed inside the signature
    deployment_id: OpaqueId
    fingerprint: Fingerprint
    client_version: Annotated[str, StringConstraints(min_length=1, max_length=40)]
    ts: EpochS
    sig: SignatureB64 | None = None


class Deprecation(WireModel):
    sunset_at: EpochS


class Welcome(WireModel):
    session_id: OpaqueId
    accepted_v: Annotated[int, Field(ge=1)]
    heartbeat_s: Count
    deprecation: Deprecation | None = None
    pending_statements: list[Statement]
    hub_key_set: HubKeySet


class Heartbeat(WireModel):
    seq: Count
    agents_online: list[AgentName]


class HeartbeatAck(WireModel):
    seq: Count
    hub_time: EpochFloat


class AgentPresence(WireModel):
    agent_name: AgentName
    online: bool


class DeploymentPresence(WireModel):
    deployment_id: OpaqueId
    connected: bool
    at: EpochS


# --------------------------------------------------------------------------
# Listings
# --------------------------------------------------------------------------

class Listing(WireModel):
    description: Description
    capabilities: Annotated[list[Capability], Field(max_length=MAX_CAPABILITIES)]
    needs_approval: bool
    accepting_messages: bool
    avatar_sha256: Sha256Hex | None = None      # inside listing_sig, so the image cannot be swapped
    # The owner opted this agent in to hub-dispatched requests. Sent only when
    # True, so a listing that never opted in keeps its exact signed bytes.
    accepts_dispatch: bool | None = None


class AgentRegister(WireModel):
    """listing_sig: the agent key over listing_signing_payload(aud, agent_name,
    cert.issuer_fp, listing). The cert is signed separately by the identity key."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.LISTING
    DETACHED_PAYLOAD: ClassVar[bool] = True     # not "object minus sig": verify with verify_listing

    aud: HubUrl
    agent_name: AgentName
    cert: AgentCert
    listing: Listing
    avatar_b64: AvatarB64 | None = None
    avatar_content_type: AvatarType | None = None
    listing_sig: SignatureB64 | None = None
    # The agent's owner (http.OwnerVerifyStart). Outside listing_signing_payload,
    # so it changes no listing signature; the deployment's session vouches for it.
    owner_ref: OpaqueId | None = None

    @model_validator(mode="after")
    def _consistent(self) -> "AgentRegister":
        if self.cert.agent_name != self.agent_name:
            raise ValueError("cert.agent_name must equal agent_name")
        if (self.avatar_b64 is None) != (self.avatar_content_type is None):
            raise ValueError("avatar_b64 and avatar_content_type come together")
        if self.avatar_b64 is not None:
            raw = b64url_decode(self.avatar_b64)
            if len(raw) > MAX_AVATAR_BYTES:
                raise ValueError(f"avatar exceeds {MAX_AVATAR_BYTES} bytes")
            if self.listing.avatar_sha256 != hashlib.sha256(raw).hexdigest():
                raise ValueError("listing.avatar_sha256 does not match the avatar")
        elif self.listing.avatar_sha256 is not None:
            raise ValueError("listing.avatar_sha256 set without an avatar")
        return self


class AgentRegistered(WireModel):
    deployment_fingerprint: Fingerprint
    agent_name: AgentName
    listed_at: EpochS
    statement: Statement


class AgentRejected(WireModel):
    reason: WireCode


class AgentUnregister(WireModel):
    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.AGENT_UNREGISTER

    aud: HubUrl
    deployment_id: OpaqueId
    agent_name: AgentName
    reason: WireCode                    # UnregisterReason
    disabled_at: EpochS                 # when the owner disabled; inside the signature
    stop_now: bool | None = None
    ts: EpochS
    sig: SignatureB64 | None = None


class AgentUnregistered(WireModel):
    delisted_at: EpochS
    drain_until: EpochS | None = None


class Search(WireModel):
    q: Annotated[str, StringConstraints(max_length=200)]
    capabilities: Annotated[list[Capability], Field(max_length=MAX_CAPABILITIES)]
    online_only: bool
    cursor: Annotated[str, StringConstraints(max_length=200)] | None = None
    limit: Annotated[int, Field(ge=1, le=MAX_SEARCH_LIMIT)]


class AgentSummary(WireModel):
    deployment_fingerprint: Fingerprint
    agent_name: AgentName
    deployment_name: DeploymentName
    deployment_label: Label
    public_url_verified: bool
    public_url: Annotated[str, StringConstraints(max_length=200)] | None = None
    description: Description
    capabilities: Annotated[list[Capability], Field(max_length=MAX_CAPABILITIES)]
    has_avatar: bool
    agent_online: bool
    deployment_connected: bool
    accepting_messages: bool
    needs_approval: bool
    last_seen_at: EpochS | None = None
    listed_at: EpochS
    refreshed_at: EpochS


class SearchResult(WireModel):
    agents: Annotated[list[AgentSummary], Field(max_length=MAX_SEARCH_LIMIT)]
    next_cursor: Annotated[str, StringConstraints(max_length=200)] | None = None


class AgentGet(WireModel):
    deployment_fingerprint: Fingerprint
    agent_name: AgentName


class AvatarGet(WireModel):
    deployment_fingerprint: Fingerprint
    agent_name: AgentName


class AgentItem(WireModel):
    """agent_get reply. Carries the raw listing so the caller can check
    listing_sig with cert.agent_pubkey against its own hub URL."""

    item: AgentSummary
    cert: AgentCert
    listing: Listing
    listing_sig: SignatureB64

    @model_validator(mode="after")
    def _consistent(self) -> "AgentItem":
        if self.cert.agent_name != self.item.agent_name:
            raise ValueError("cert.agent_name must equal item.agent_name")
        return self


class Avatar(WireModel):
    content_type: AvatarType
    avatar_b64: AvatarB64


# --------------------------------------------------------------------------
# Keys
# --------------------------------------------------------------------------

class KeyRotate(WireModel):
    """Signed twice over data minus (sig_old, sig_new): by the old key and by the new one."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.KEY_ROTATE

    aud: HubUrl
    deployment_id: OpaqueId
    new_pubkey: PublicKeyB64
    ts: EpochS
    sig_old: SignatureB64 | None = None
    sig_new: SignatureB64 | None = None


class KeyRotated(WireModel):
    fingerprint: Fingerprint
    statement: Statement


class KeyLookup(WireModel):
    deployment_id: OpaqueId | None = None
    fingerprint: Fingerprint | None = None

    @model_validator(mode="after")
    def _exactly_one(self) -> "KeyLookup":
        if (self.deployment_id is None) == (self.fingerprint is None):
            raise ValueError("give exactly one of deployment_id and fingerprint")
        return self


class ChainLink(WireModel):
    """One key in a deployment's chain. Every key after the genesis key carries
    the deployment's own signed key_rotate verbatim; the receiver checks its
    sig_old with the previous key and its sig_new with this one
    (verify_key_chain)."""

    fingerprint: Fingerprint
    pubkey: PublicKeyB64
    prev: Fingerprint | None = None
    rotation: KeyRotate | None = None

    @model_validator(mode="after")
    def _genesis_or_rotated(self) -> "ChainLink":
        if self.fingerprint != fingerprint(b64url_decode(self.pubkey, length=32)):
            raise ValueError("fingerprint must be the fingerprint of pubkey")
        if (self.prev is None) != (self.rotation is None):
            raise ValueError("a non-genesis link carries prev and its rotation")
        if self.rotation is not None:
            if self.rotation.new_pubkey != self.pubkey:
                raise ValueError("rotation.new_pubkey must equal pubkey")
            if self.rotation.sig_old is None or self.rotation.sig_new is None:
                raise ValueError("a rotation carries both sig_old and sig_new")
        return self


class DeploymentKey(WireModel):
    """key_lookup reply. Check the chain's signatures with verify_key_chain;
    the validator checks only that the links join up, that no key appears
    twice and that each rotation is later than the one before it.

    The chain alone proves only that each key was handed on by the one before
    it. It does not prove the head is the deployment's CURRENT key: a hub can
    serve A->B->C truncated as A->B with B as current. Nor does it tie a
    genesis-only chain to any deployment_id, since there is no rotation to
    carry one. The reply's hub `statement` is what closes both gaps; checking
    it against aud, genesis_fp, fingerprint, deployment_id and revoked is owed
    by the server-client step (verify_deployment_key), not done here."""

    genesis_fp: Fingerprint
    fingerprint: Fingerprint            # current
    pubkey: PublicKeyB64
    chain: Annotated[list[ChainLink], Field(min_length=1)]      # genesis first
    revoked: list[Fingerprint]
    statement: Statement

    @model_validator(mode="after")
    def _chain_joins_up(self) -> "DeploymentKey":
        first, last = self.chain[0], self.chain[-1]
        if first.prev is not None or first.fingerprint != self.genesis_fp:
            raise ValueError("the chain starts with the genesis key")
        if (last.fingerprint, last.pubkey) != (self.fingerprint, self.pubkey):
            raise ValueError("the chain ends with the current key")
        if len({link.fingerprint for link in self.chain}) != len(self.chain):
            raise ValueError("a key appears at most once in the chain")
        for before, link in zip(self.chain, self.chain[1:]):
            if link.prev != before.fingerprint:
                raise ValueError("each link's prev is the link before it")
            if before.rotation is not None and link.rotation.ts <= before.rotation.ts:  # type: ignore[union-attr]
                raise ValueError("each rotation is later than the one before it")
        return self


class Watch(WireModel):
    deployment_ids: Annotated[list[OpaqueId], Field(max_length=MAX_WATCH_IDS)]


class PresenceItem(DeploymentPresence):
    """One deployment in watch_ack: the same fields as a deployment_presence push."""


class WatchAck(WireModel):
    presence: list[PresenceItem]


# --------------------------------------------------------------------------
# Relay and delivery
# --------------------------------------------------------------------------

class RelayAck(WireModel):
    message_id: MessageId
    result: WireCode                    # RelayAckResult


class RelayRejected(WireModel):
    message_id: MessageId
    reason: WireCode
    detail: WireCode | None = None
    retry_after: Count | None = None


class DeliveryProbe(WireModel):
    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.DELIVERY_PROBE

    v: Annotated[int, Field(ge=1)]
    aud: HubUrl
    message_id: MessageId
    from_deployment: OpaqueId
    to_deployment: OpaqueId
    to_agent: AgentName | None = None
    ts: EpochS
    sig: SignatureB64 | None = None


class DeliverProbe(WireModel):
    """The hub forwards A's delivery_probe to B verbatim."""

    probe: DeliveryProbe


class RouteStamp(WireModel):
    """Signed by the hub key `kid` over route_signing_payload(route, envelope.sig)."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.ROUTE
    DETACHED_PAYLOAD: ClassVar[bool] = True     # covers envelope.sig too: verify with verify_route

    hub_msg_id: OpaqueId
    received_at: EpochS
    kid: OpaqueId
    hub_sig: SignatureB64 | None = None


class Deliver(WireModel):
    envelope: Envelope
    route: RouteStamp


class DeliverAck(WireModel):
    """Signed by the receiver's identity key over the whole ack minus sig, so
    the hub cannot alter result, detail, retry_after or original_result."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.DELIVER_ACK

    aud: HubUrl
    message_id: MessageId
    to_deployment: OpaqueId             # = the original sender
    result: WireCode                    # DeliverResult
    detail: WireCode | None = None
    retry_after: Count | None = None
    original_result: WireCode | None = None
    current_state: WireCode | None = None
    at: EpochS
    from_fingerprint: Fingerprint
    sig: SignatureB64 | None = None

    @model_validator(mode="after")
    def _duplicate_says_what_happened(self) -> "DeliverAck":
        if self.result == "duplicate" and (self.original_result is None or self.current_state is None):
            raise ValueError("a duplicate carries original_result and current_state")
        return self


class DeliveryReceipt(WireModel):
    """The receiver's signed deliver_ack, pushed to the sender verbatim."""

    message_id: MessageId
    ack: DeliverAck

    @model_validator(mode="after")
    def _same_message(self) -> "DeliveryReceipt":
        if self.ack.message_id != self.message_id:
            raise ValueError("ack.message_id must equal message_id")
        return self


# --------------------------------------------------------------------------
# Hub-ranked dispatch
# --------------------------------------------------------------------------

class AgentAddress(WireModel):
    """An agent on the wire (ids.AgentRef as a payload field)."""

    deployment_fingerprint: Fingerprint
    agent_name: AgentName


class DispatchAsk(WireModel):
    """One request the hub may route to up to len(slots) agents. Signed by the
    requester's identity key over the ask minus sig."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.DISPATCH_ASK

    v: Annotated[int, Field(ge=1)]
    aud: HubUrl
    ask_id: MessageId
    from_deployment: OpaqueId
    from_fingerprint: Fingerprint
    from_principal: UserPrincipal
    text: Annotated[str, StringConstraints(min_length=1)]
    # The requester_project_ids of the threads the requester will open, one per
    # agent the hub may pick. Pre-committed so the conversation key stays
    # "{genesis}/{slot}" and the hub never mints ids in the requester's space.
    slots: Annotated[list[OpaqueId], Field(min_length=1, max_length=MAX_DISPATCH_SLOTS)]
    exclude: Annotated[list[AgentAddress], Field(max_length=MAX_DISPATCH_EXCLUDE)]
    sent_at: EpochFloat
    expires_at: EpochS
    sig: SignatureB64 | None = None

    @model_validator(mode="after")
    def _shape(self) -> "DispatchAsk":
        if len(self.text.encode("utf-8", "surrogatepass")) > MAX_DISPATCH_TEXT_BYTES:
            raise ValueError(f"text exceeds {MAX_DISPATCH_TEXT_BYTES} UTF-8 bytes")
        if len(set(self.slots)) != len(self.slots):
            raise ValueError("slots must be unique")
        if not self.sent_at < self.expires_at <= self.sent_at + DISPATCH_TTL_S:
            raise ValueError(f"expires_at must be after sent_at and at most {DISPATCH_TTL_S}s later")
        return self


class DispatchPick(WireModel):
    """One agent the hub chose, bound to one of the ask's slots."""

    slot: OpaqueId
    agent: AgentAddress
    to_deployment: OpaqueId
    deployment_name: DeploymentName
    local: bool                         # the agent is on the asker's own deployment: the hub sends nothing
    p_fit: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    score: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    rank: Annotated[int, Field(ge=1, le=MAX_DISPATCH_SHOWN)]


class DispatchPlan(WireModel):
    """The hub's answer to a dispatch_ask, sent before any delivery so the
    requester's threads exist before a reply can arrive."""

    ask_id: MessageId
    plan_id: OpaqueId
    picks: Annotated[list[DispatchPick], Field(max_length=MAX_DISPATCH_SLOTS)]
    answer_yourself: bool               # nobody clearly fits: the requester's own model answers
    shown: Annotated[list[AgentAddress], Field(max_length=MAX_DISPATCH_SHOWN)]

    @model_validator(mode="after")
    def _consistent(self) -> "DispatchPlan":
        if self.answer_yourself and self.picks:
            raise ValueError("answer_yourself carries no picks")
        if len({p.slot for p in self.picks}) != len(self.picks):
            raise ValueError("each pick takes its own slot")
        return self


class DispatchStamp(WireModel):
    """The hub's word that it routed one slot of one ask to one agent. Signed
    by the hub key `kid` over dispatch_stamp_signing_payload(stamp, ask.sig)."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.DISPATCH_STAMP
    DETACHED_PAYLOAD: ClassVar[bool] = True     # covers the ask's sig: verify with verify_dispatch_stamp

    ask_id: MessageId
    slot: OpaqueId
    to_deployment: OpaqueId
    to_agent: AgentName
    message_id: MessageId               # ids.dispatched_message_id(ask_id, slot)
    hub_msg_id: OpaqueId
    received_at: EpochS
    kid: OpaqueId
    hub_sig: SignatureB64 | None = None


class DispatchDeliver(WireModel):
    """Pushed to a picked agent's deployment: the requester's ask verbatim and
    the hub's stamp naming this agent and slot."""

    ask: DispatchAsk
    stamp: DispatchStamp

    @model_validator(mode="after")
    def _stamp_fits_ask(self) -> "DispatchDeliver":
        if self.stamp.ask_id != self.ask.ask_id:
            raise ValueError("stamp.ask_id must equal ask.ask_id")
        if self.stamp.slot not in self.ask.slots:
            raise ValueError("stamp.slot must be one of ask.slots")
        if self.stamp.message_id != dispatched_message_id(self.ask.ask_id, self.stamp.slot):
            raise ValueError("stamp.message_id must be dispatched_message_id(ask_id, slot)")
        return self


class OutcomeEvent(WireModel):
    slot: OpaqueId | None = None
    agent: AgentAddress
    kind: WireCode                      # OutcomeKind
    at: EpochS


class DispatchOutcome(WireModel):
    """What the requester did with a plan's replies: ids and kinds only, never
    text. Signed by the requester's identity key over the outcome minus sig."""

    SIGNING_PURPOSE: ClassVar[Purpose] = Purpose.DISPATCH_OUTCOME

    v: Annotated[int, Field(ge=1)]
    aud: HubUrl
    ask_id: MessageId
    plan_id: OpaqueId
    from_deployment: OpaqueId
    from_fingerprint: Fingerprint
    events: Annotated[list[OutcomeEvent], Field(min_length=1, max_length=MAX_OUTCOME_EVENTS)]
    ts: EpochS
    sig: SignatureB64 | None = None


class DispatchOutcomeAck(WireModel):
    ask_id: MessageId
    accepted: Count


# --------------------------------------------------------------------------
# Moderation and errors
# --------------------------------------------------------------------------

class Report(WireModel):
    deployment_fingerprint: Fingerprint
    agent_name: AgentName
    reason: WireCode                    # ReportReason
    note: Annotated[str, StringConstraints(max_length=MAX_NOTE_CHARS)] | None = None
    reporter: Sha256Hex                 # ids.reporter_id()


class ReportAck(WireModel):
    pass


class ErrorFrame(ErrorDetail):
    """The reply to any request that failed with a code no named reject frame
    carries. The same fields as an HTTP error's detail."""


# --------------------------------------------------------------------------
# Signed sub-payloads that are not "object minus sig", and key chains
# --------------------------------------------------------------------------

# The bytes listing_sig covers: canonical({LISTING tag, aud, agent_name, issuer_fp, listing}).
def listing_signing_payload(
    aud: str, agent_name: str, issuer_fp: str, listing: Mapping[str, Any]
) -> bytes:
    return tagged_bytes(
        {"aud": aud, "agent_name": agent_name, "issuer_fp": issuer_fp, "listing": dict(listing)},
        Purpose.LISTING,
    )


# listing_sig for an agent_register body, by the agent's own key.
def sign_listing(
    key: Ed25519PrivateKey, *, aud: str, agent_name: str, issuer_fp: str, listing: Mapping[str, Any]
) -> str:
    return b64url(key.sign(listing_signing_payload(aud, agent_name, issuer_fp, listing)))


# Check listing_sig on a raw agent_register body or agent_item reply against
# the agent key, for hub `aud`. Never raises.
def verify_listing(raw: Mapping[str, Any], agent_pubkey: bytes, *, aud: str) -> bool:
    try:
        cert, listing = raw["cert"], raw["listing"]
        if not isinstance(cert, Mapping) or not isinstance(listing, Mapping):
            return False
        agent_name = raw["agent_name"] if "agent_name" in raw else raw["item"]["agent_name"]
        payload = listing_signing_payload(aud, agent_name, cert["issuer_fp"], listing)
    except (KeyError, TypeError, CanonicalError):
        return False
    return verify_signature(payload, raw.get("listing_sig"), agent_pubkey)


# The bytes route.hub_sig covers: canonical({ROUTE tag, route minus hub_sig,
# envelope_sig}), which binds the stamp to exactly one envelope.
def route_signing_payload(route: Mapping[str, Any], envelope_sig: str) -> bytes:
    body = {k: v for k, v in route.items() if k not in ROUTE_SIG_FIELDS}
    body["envelope_sig"] = envelope_sig
    return tagged_bytes(body, Purpose.ROUTE)


# Check route.hub_sig on a raw deliver body against the hub key, over the
# envelope that came with it (route_signing_payload(route, envelope.sig)).
# The only way to verify a route stamp: verify_then_parse refuses RouteStamp,
# since a stamp checked on its own could carry any envelope's sig. Never raises.
def verify_route(raw: Any, hub_pubkey: bytes) -> bool:
    try:
        route, envelope = raw["route"], raw["envelope"]
        if not isinstance(route, Mapping) or not isinstance(envelope, Mapping):
            return False
        envelope_sig = envelope["sig"]
        if not isinstance(envelope_sig, str):
            return False
        payload = route_signing_payload(route, envelope_sig)
    except (KeyError, TypeError, CanonicalError):
        return False
    return verify_signature(payload, route.get("hub_sig"), hub_pubkey)


# The bytes a dispatch stamp's hub_sig covers: canonical({DISPATCH_STAMP tag,
# stamp minus hub_sig, ask_sig}), which binds the stamp to exactly one ask.
def dispatch_stamp_signing_payload(stamp: Mapping[str, Any], ask_sig: str) -> bytes:
    body = {k: v for k, v in stamp.items() if k not in DISPATCH_STAMP_SIG_FIELDS}
    body["ask_sig"] = ask_sig
    return tagged_bytes(body, Purpose.DISPATCH_STAMP)


# hub_sig for a dispatch stamp, by the hub key named in stamp["kid"].
def sign_dispatch_stamp(key: Ed25519PrivateKey, stamp: Mapping[str, Any], ask_sig: str) -> str:
    return b64url(key.sign(dispatch_stamp_signing_payload(stamp, ask_sig)))


# Check stamp.hub_sig on a raw dispatch_deliver body against the hub key, over
# the ask that came with it. The only way to verify a dispatch stamp:
# verify_then_parse refuses DispatchStamp, since a stamp checked on its own
# could carry any ask's sig. Never raises.
def verify_dispatch_stamp(raw: Any, hub_pubkey: bytes) -> bool:
    try:
        stamp, ask = raw["stamp"], raw["ask"]
        if not isinstance(stamp, Mapping) or not isinstance(ask, Mapping):
            return False
        ask_sig = ask["sig"]
        if not isinstance(ask_sig, str):
            return False
        payload = dispatch_stamp_signing_payload(stamp, ask_sig)
    except (KeyError, TypeError, CanonicalError):
        return False
    return verify_signature(payload, stamp.get("hub_sig"), hub_pubkey)


# Check both signatures of a raw key_rotate: sig_old by old_pubkey, sig_new by
# the new_pubkey it names. Never raises.
def verify_key_rotate(raw: Any, old_pubkey: bytes) -> bool:
    if not isinstance(raw, Mapping):
        return False
    try:
        new_pubkey = b64url_decode(raw.get("new_pubkey"), length=32)
    except ValueError:
        return False
    return all(
        verify_object(raw, pub, purpose=Purpose.KEY_ROTATE, field=field, exclude=ROTATE_SIG_FIELDS)
        for field, pub in (("sig_old", old_pubkey), ("sig_new", new_pubkey))
    )


# Check a raw deployment_key reply's chain on the dicts as received, then
# parse it. Each link's fingerprint is recomputed from its pubkey and no key
# may appear twice; each rotation must be for hub `aud`, name this link's
# pubkey, follow the link before it, be strictly later than the rotation
# before it, carry one deployment_id throughout (`deployment_id`, when given)
# and pass verify_key_rotate under the previous key. None if any check fails;
# a pydantic ValidationError if a verified chain does not fit the schema.
#
# This does NOT bind the head: a truncated chain (A->B->C served as A->B)
# passes, and a genesis-only chain carries no deployment_id to check. The
# reply's hub statement closes both gaps and is checked by the caller (owed by
# the server-client step), never here.
def verify_key_chain(
    raw: Any, *, aud: str, deployment_id: str | None = None
) -> Verified[DeploymentKey] | None:
    try:
        aud = canonical_hub_url(aud)
        chain = raw["chain"]
        if not isinstance(chain, list) or not chain:
            return None
        deployment_ids = {deployment_id} - {None}
        prev_fp, prev_pub, prev_ts = None, b"", None
        seen: set[str] = set()
        for link in chain:
            pub = b64url_decode(link["pubkey"], length=32)
            if link["fingerprint"] != fingerprint(pub) or link.get("prev") != prev_fp:
                return None
            if link["fingerprint"] in seen:
                return None
            seen.add(link["fingerprint"])
            rotation = link.get("rotation")
            if prev_fp is None:
                if rotation is not None:
                    return None
            elif not (
                isinstance(rotation, Mapping)
                and rotation.get("aud") == aud
                and rotation.get("new_pubkey") == link["pubkey"]
                and verify_key_rotate(rotation, prev_pub)
            ):
                return None
            else:
                ts = rotation.get("ts")
                if type(ts) is not int or (prev_ts is not None and ts <= prev_ts):
                    return None
                prev_ts = ts
                deployment_ids.add(rotation.get("deployment_id"))
            prev_fp, prev_pub = link["fingerprint"], pub
        if len(deployment_ids) > 1:
            return None
    except (KeyError, TypeError, ValueError):
        return None
    return Verified(model=DeploymentKey.model_validate(raw), raw=raw)


# --------------------------------------------------------------------------
# Registry, parse and build
# --------------------------------------------------------------------------

Direction = Literal["dep_to_hub", "hub_to_dep"]


@dataclass(frozen=True)
class FrameSpec:
    model: type[BaseModel]
    direction: Direction


FRAME_TYPES: Mapping[str, FrameSpec] = {
    # deployment -> hub
    "auth": FrameSpec(Auth, "dep_to_hub"),
    "heartbeat": FrameSpec(Heartbeat, "dep_to_hub"),
    "agent_presence": FrameSpec(AgentPresence, "dep_to_hub"),
    "agent_register": FrameSpec(AgentRegister, "dep_to_hub"),
    "agent_unregister": FrameSpec(AgentUnregister, "dep_to_hub"),
    "search": FrameSpec(Search, "dep_to_hub"),
    "agent_get": FrameSpec(AgentGet, "dep_to_hub"),
    "avatar_get": FrameSpec(AvatarGet, "dep_to_hub"),
    "key_lookup": FrameSpec(KeyLookup, "dep_to_hub"),
    "watch": FrameSpec(Watch, "dep_to_hub"),
    "relay": FrameSpec(Envelope, "dep_to_hub"),
    "delivery_probe": FrameSpec(DeliveryProbe, "dep_to_hub"),
    "deliver_ack": FrameSpec(DeliverAck, "dep_to_hub"),
    "key_rotate": FrameSpec(KeyRotate, "dep_to_hub"),
    "revoke": FrameSpec(RevokeBody, "dep_to_hub"),
    "report": FrameSpec(Report, "dep_to_hub"),
    "dispatch_ask": FrameSpec(DispatchAsk, "dep_to_hub"),
    "dispatch_outcome": FrameSpec(DispatchOutcome, "dep_to_hub"),
    # hub -> deployment
    "hello": FrameSpec(Hello, "hub_to_dep"),
    "welcome": FrameSpec(Welcome, "hub_to_dep"),
    "heartbeat_ack": FrameSpec(HeartbeatAck, "hub_to_dep"),
    "agent_registered": FrameSpec(AgentRegistered, "hub_to_dep"),
    "agent_rejected": FrameSpec(AgentRejected, "hub_to_dep"),
    "agent_unregistered": FrameSpec(AgentUnregistered, "hub_to_dep"),
    "search_result": FrameSpec(SearchResult, "hub_to_dep"),
    "agent_item": FrameSpec(AgentItem, "hub_to_dep"),
    "avatar": FrameSpec(Avatar, "hub_to_dep"),
    "deployment_key": FrameSpec(DeploymentKey, "hub_to_dep"),
    "watch_ack": FrameSpec(WatchAck, "hub_to_dep"),
    "deployment_presence": FrameSpec(DeploymentPresence, "hub_to_dep"),
    "relay_ack": FrameSpec(RelayAck, "hub_to_dep"),
    "relay_rejected": FrameSpec(RelayRejected, "hub_to_dep"),
    "deliver_probe": FrameSpec(DeliverProbe, "hub_to_dep"),
    "deliver": FrameSpec(Deliver, "hub_to_dep"),
    "delivery_receipt": FrameSpec(DeliveryReceipt, "hub_to_dep"),
    "statement": FrameSpec(Statement, "hub_to_dep"),
    "key_rotated": FrameSpec(KeyRotated, "hub_to_dep"),
    "revoked": FrameSpec(RevokedResponse, "hub_to_dep"),
    "report_ack": FrameSpec(ReportAck, "hub_to_dep"),
    "dispatch_plan": FrameSpec(DispatchPlan, "hub_to_dep"),        # reply to dispatch_ask
    "dispatch_deliver": FrameSpec(DispatchDeliver, "hub_to_dep"),  # pushed to each picked host
    "dispatch_outcome_ack": FrameSpec(DispatchOutcomeAck, "hub_to_dep"),
    "error": FrameSpec(ErrorFrame, "hub_to_dep"),
}


class FrameError(ValueError):
    """A frame this end cannot accept. `code` is what the error frame (or the
    close) reports; `frame_id` is the request id when it could be read."""

    def __init__(self, code: ErrorCode, message: str, frame_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.frame_id = frame_id


class ParsedFrame(NamedTuple):
    frame: Frame
    model: BaseModel
    data: dict[str, Any]        # the raw data dict: verify THIS, never a re-dump of `model`


# Strict-load (size cap, no duplicate keys), validate the frame shape, check
# the version and that the type is one this end receives (`direction` is the
# direction of the frame being parsed), then validate data into its model.
# Unknown or wrong-direction type -> FrameError(unsupported); v outside
# [MIN_SUPPORTED_VERSION, PROTOCOL_VERSION] -> FrameError(client_too_old);
# anything else malformed -> FrameError(invalid_frame).
def parse_frame(raw: bytes | str, *, direction: Direction) -> ParsedFrame:
    try:
        obj = loads_strict(raw, max_bytes=MAX_JSON_FRAME_BYTES)
    except CanonicalError as exc:
        raise FrameError(ErrorCode.INVALID_FRAME, str(exc)) from exc
    frame_id = obj.get("id") if isinstance(obj, dict) and isinstance(obj.get("id"), str) else None
    try:
        frame = Frame.model_validate(obj)
    except ValidationError as exc:
        raise FrameError(ErrorCode.INVALID_FRAME, f"bad frame: {exc.error_count()} error(s)", frame_id) from exc
    if not MIN_SUPPORTED_VERSION <= frame.v <= PROTOCOL_VERSION:
        raise FrameError(ErrorCode.CLIENT_TOO_OLD, f"protocol v{frame.v} not supported", frame.id)
    spec = FRAME_TYPES.get(frame.type)
    if spec is None or spec.direction != direction:
        raise FrameError(ErrorCode.UNSUPPORTED, f"frame type {frame.type!r} not accepted here", frame.id)
    try:
        model = spec.model.model_validate(frame.data)
    except (ValidationError, ValueError) as exc:
        raise FrameError(ErrorCode.INVALID_FRAME, f"bad {frame.type} data: {exc}", frame.id) from exc
    return ParsedFrame(frame=frame, model=model, data=obj["data"])


# Build {v, id, type, data} as bytes. `data` is an already-signed wire dict,
# sent verbatim, or a model, dumped once with to_wire.
def make_frame(
    type: str, data: BaseModel | Mapping[str, Any], *, id: str, v: int = PROTOCOL_VERSION
) -> bytes:
    if type not in FRAME_TYPES:
        raise ValueError(f"unknown frame type {type!r}")
    body = to_wire(data) if isinstance(data, BaseModel) else dict(data)
    out = canonical_bytes({"v": v, "id": id, "type": type, "data": body})
    if len(out) > MAX_JSON_FRAME_BYTES:
        raise ValueError(f"frame of {len(out)} bytes exceeds {MAX_JSON_FRAME_BYTES}")
    return out
