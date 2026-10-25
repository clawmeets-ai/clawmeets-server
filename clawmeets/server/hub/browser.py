# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/browser.py
The browser contract of the hub (design section 5): every request and
response body of ``/api/hub/*`` and ``/me/channels/hub/*``, the two WebSocket
events, and the error codes. The frontend builds against this file, so a field
added, renamed or retyped here is a contract change:
``tests/server/test_hub_browser_contract.py`` pins every model's fields to
``tests/server/hub_contract_snapshot.json``.

Three rules from section 5 that every model here follows:

- **Timestamps** on hub objects are ``EpochSeconds``: a float of seconds since
  the epoch (UTC), never an ISO string. The frontend converts with one helper.
- **Fingerprints** named ``deployment_fingerprint`` are always the GENESIS
  fingerprint, so a key rotation changes none of them. ``current_fingerprint``
  is a label only, and is left out of the JSON when the deployment never
  rotated (``_AbsentWhenNone``), not sent as null.
- **Masking**: no field is a secret, a private key, a seed or a signature. The
  only key material shown is ``key_last4``, the fingerprint's tail.

Every error body is ``{"detail": {"code", "message", ...extra}}`` (``HubError``).
"""
from __future__ import annotations

from typing import Annotated, Any, ClassVar, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_serializer

from clawmeets.hub_protocol.constants import MAX_NOTE_CHARS, MAX_SEARCH_LIMIT
from clawmeets.models.chatroom import ParticipantHub, ParticipantInfo, RoomFlow

#: Seconds since the epoch, UTC, possibly fractional. The JSON schema carries
#: ``format: epoch-seconds`` so the snapshot pins which fields are timestamps.
EpochSeconds = Annotated[float, Field(ge=0, json_schema_extra={"format": "epoch-seconds"})]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _AbsentWhenNone(_Model):
    """A model whose ``ABSENT_WHEN_NONE`` fields are left out of the JSON when
    they are None ("optional, absent when the deployment never rotated"),
    while every other None is sent as null."""

    ABSENT_WHEN_NONE: ClassVar[frozenset[str]] = frozenset({"current_fingerprint"})

    @model_serializer(mode="wrap")
    def _drop_absent(self, handler: Any) -> dict[str, Any]:
        data = handler(self)
        for name in self.ABSENT_WHEN_NONE:
            if data.get(name, ...) is None:
                del data[name]
        return data


# ── vocabularies ──────────────────────────────────────────────────────────

HubMode = Literal["off", "auto", "discover_only", "full"]
#: ``held_for_reclaim`` is shown as ``none``; the frontend treats an unknown value like none.
RegistrationState = Literal["none", "pending_email", "active", "suspended"]
HubLinkState = Literal["connected", "unreachable", "untrusted", "off"]
HubChannelStatus = Literal[
    "off", "enabling", "connected", "hub_unreachable", "key_revoked", "key_rotation_pending",
    "hub_cannot_reach_deployment", "rejected", "hub_off_on_server", "agent_not_public",
    "hub_untrusted", "hub_not_registered",
]
RejectReason = Literal[
    "name_conflict", "deployment_suspended", "over_quota", "client_too_old", "invalid_name",
    "invalid_listing", "delisted_by_hub", "owner_unverified", "owner_banned",
]
DeliveryState = Literal["sent_to_hub", "waiting_for_target", "delivered", "failed"]
WaitingReason = Literal["agent_offline", "deployment_offline", "hub_unreachable", "isolation_unavailable"]
FailedReason = Literal[
    "expired_72h", "held_expired", "blocked_by_target", "agent_unlisted", "key_revoked",
    "too_large", "rejected_by_hub", "retries_exhausted", "sender_untrusted", "not_accepting",
]
#: Only with ``not_accepting``. An open vocabulary: an unknown value falls to
#: the generic line in the browser, so the type is a string, not a Literal.
NOT_ACCEPTING_DETAILS = ("channel_off", "browse_only", "daily_cap", "requests_full")
ClosedReason = Literal[
    "agent_unlisted", "key_revoked", "deployment_suspended", "conversation_closed",
    "hub_off_on_server", "identity_changed",
]
SendWarning = Literal["agent_offline", "deployment_offline"]
ReportReason = Literal["impersonation", "spam", "harmful", "other"]
ServedFrom = Literal["live", "cache"]
PayloadLimit = Literal["file", "files", "envelope", "text"]

#: The daily run cap of an agent's Hub channel. Read-only in v1: section 5
#: has no route to edit it (a recorded deviation).
DAILY_RUN_CAP = 200


# ── config ────────────────────────────────────────────────────────────────

class HubConfigOut(_Model):
    """GET /api/hub/config. Read-only: never a hub-state error."""

    mode: HubMode
    hub_url: str
    hub_url_is_default: bool
    deployment_id: Optional[str]
    deployment_connected: bool
    last_connected_at: Optional[EpochSeconds]
    protocol_version: int
    deployment_fingerprint: Optional[str]           # genesis
    deployment_name: Optional[str]
    registration: RegistrationState
    hub_link: HubLinkState
    channels_enabled: bool
    sender_label: str
    max_file_bytes: int
    max_files: int
    max_envelope_bytes: int
    max_text_bytes: int


# ── an agent's Hub channel (owner) ────────────────────────────────────────

class HubChannel(_Model):
    """GET /me/channels/hub/{agent_full_name}; also the enable and disable
    answers and the hub_channel_status payload."""

    enabled: bool
    status: HubChannelStatus
    status_detail: Optional[str]                    # the hub's words, shown as text
    reject_reason: Optional[RejectReason]
    eligible: bool
    ineligible_reason: Optional[str]
    listed_as: Optional[str]                        # name@deployment_name
    key_last4: Optional[str]
    rotate_by: Optional[EpochSeconds]               # renewal failed: the cert expires then
    last_success_at: Optional[EpochSeconds]
    next_retry_at: Optional[EpochSeconds]
    hub_url: str
    hub_url_is_default: bool
    open_conversations: int
    in_flight_messages: int
    daily_run_cap: int
    runs_today: int
    runs_reset_at: EpochSeconds                     # the server's next local midnight
    isolation: Literal["sandboxed", "unavailable"] = "unavailable"   # the agent's CURRENT runners
    held_conversations: int = 0                     # waiting for a capable runner
    # People on THIS server with a conversation with the agent: turning the
    # switch off (which makes the agent private) stops their replies.
    local_conversations: int = 0
    owner_isolated: bool = False                    # turning off ends it too
    # The agent is public. Off and public is an agent shared on this server
    # before the switch became the one sharing control: the card offers
    # Make private.
    public: bool = False
    # Hub-ranked dispatch: the owner's opt-in to requests the hub routes to
    # this agent, its daily cap, and how many it took today.
    accept_dispatch: bool = False
    dispatch_daily_cap: int = 20
    dispatched_today: int = 0


class DispatchSettingsRequest(_Model):
    """PUT /me/channels/hub/{agent_full_name}/dispatch."""

    accept: StrictBool
    daily_cap: StrictInt = Field(ge=1, le=200)


# ── enrollment: this server on the hub, and the user as an agent owner ────

#: ``none``: not on the hub yet (starting registers it; one code does both).
#: ``pending``: the registration waits for its emailed code. ``operator_only``:
#: only the operator may register it, or it needs the operator (suspended,
#: held for reclaim). ``off``: CLAWMEETS_HUB_MODE=off.
EnrollServerState = Literal["none", "pending", "active", "operator_only", "off"]
EnrollOwnerState = Literal["none", "code_sent", "verified"]


class HubEnrollment(_Model):
    """GET / POST /me/channels/hub/enrollment and POST …/confirm
    (server/hub/enroll.py)."""

    server: EnrollServerState
    owner: EnrollOwnerState
    email_masked: Optional[str]                    # the user's own address, masked: where the code goes
    becomes_contact: bool                          # server none: you become this server's hub contact
    contact_is_you: bool
    tos_version: str
    tos_url: str
    code_expires_at: Optional[EpochSeconds]


class EnrollRequest(_Model):
    """POST /me/channels/hub/enrollment: accepting the hub terms sends the code."""

    accept_tos_version: Annotated[str, Field(min_length=1, max_length=40)]


class EnrollConfirm(_Model):
    code: Annotated[str, Field(min_length=4, max_length=16)]


class EnableRequest(_Model):
    """POST /me/channels/hub/{agent}/enable: idempotent per agent and request id."""

    client_request_id: Annotated[str, Field(min_length=1, max_length=100)]


class DisableRequest(_Model):
    """POST /me/channels/hub/{agent}/disable. ``confirm`` must be true
    (confirm_required otherwise). ``stop_now`` fails the remaining replies at
    once instead of draining them for 10 minutes."""

    confirm: bool = False
    stop_now: bool = False


class BlockRequest(_Model):
    """POST …/blocked_deployments. A current fingerprint is resolved to its genesis."""

    deployment_fingerprint: str


class BlockedDeployment(_AbsentWhenNone):
    deployment_fingerprint: str                     # genesis
    current_fingerprint: Optional[str] = None
    deployment_name: str
    created_at: EpochSeconds


class BlockedList(_Model):
    """GET, POST and DELETE …/blocked_deployments all answer this."""

    blocked: list[BlockedDeployment]


# ── the directory ─────────────────────────────────────────────────────────

class HubAgentSearch(_Model):
    """GET /api/hub/agents query parameters."""

    q: Annotated[str, Field(max_length=200)] = ""
    capabilities: list[str] = Field(default_factory=list)
    online_only: bool = False
    cursor: Optional[Annotated[str, Field(max_length=200)]] = None
    limit: Annotated[int, Field(ge=1, le=MAX_SEARCH_LIMIT)] = 20


class HubAgent(_AbsentWhenNone):
    """One agents[] item."""

    hub_agent_id: str                               # {genesis fp16}~{agent_name}, opaque
    name: str
    deployment_name: str
    deployment_label: str
    deployment_fingerprint: str                     # genesis
    current_fingerprint: Optional[str] = None
    deployment_url: Optional[str]                   # null unless verified
    deployment_url_verified: bool
    first_contact: bool
    description: str
    capabilities: list[str]
    avatar_url: Optional[str]                       # the proxy path, or null
    agent_online: bool
    deployment_connected: bool
    accepting_messages: bool
    needs_approval: bool
    last_seen_at: Optional[EpochSeconds]
    listed_at: EpochSeconds
    listing_refreshed_at: EpochSeconds
    listing_age_s: float
    is_local: bool
    retained: bool = False                          # the caller retained it (state active)


class HubAgentPage(_Model):
    """GET /api/hub/agents."""

    agents: list[HubAgent]
    next_cursor: Optional[str]
    served_from: ServedFrom
    cache_age_s: Optional[float]                    # null when live
    cached_at: Optional[EpochSeconds]


class HubAgentDetail(HubAgent):
    """GET /api/hub/agents/{hub_agent_id}: one item plus listed."""

    listed: bool
    served_from: ServedFrom


class ReportRequest(_Model):
    """POST /api/hub/agents/{hub_agent_id}/report."""

    reason: ReportReason
    note: Optional[Annotated[str, Field(max_length=MAX_NOTE_CHARS)]] = None


class ReportAccepted(_Model):
    """202 {}."""


# ── retained agents ───────────────────────────────────────────────────────

RetainState = Literal["active", "unlisted", "identity_changed"]


class RetainedAgent(_Model):
    """One retained remote agent: POST /api/hub/agents/{hub_agent_id}/retain
    answers it, GET /api/hub/retained lists them. ``description`` and
    ``capabilities`` are the listing as it was when the user retained it."""

    hub_agent_id: str
    name: str
    deployment_name: str
    deployment_fingerprint: str                     # genesis
    description: str
    capabilities: list[str]
    retained_at: EpochSeconds
    state: RetainState
    live_rooms: int                                 # workrooms it is bridged into
    # A stand-in has no runner here: /agents/{id}/fs/* answers remote_agent.
    home_folder_browsable: Literal[False] = False
    # An agent of THIS server (another account's): no stand-in, no hub
    # thread. ``agent_id`` is the local agent; messaging it opens the
    # ordinary DM. ``state`` is ``unlisted`` once it is no longer public.
    is_local: bool = False
    agent_id: Optional[str] = None


class RetainedList(_Model):
    """GET /api/hub/retained."""

    agents: list[RetainedAgent]
    # This server retains its own agents too (``is_local`` rows): a runner
    # lists another account's agents only when retained. An older server's
    # answer lacks it, and its runners list every public agent as before.
    local_retains: bool = True


BridgeDeliveryState = Literal["queued", "relayed", "delivered", "answered", "failed", "cancelled"]


class BridgeDelivery(_Model):
    """One room message's relay to a retained agent (the room bridge). The
    delivery line under a message that addresses a stand-in. ``reason``
    includes ``held``, ``blocked`` and ``flow_stopped``; an open vocabulary."""

    room_message_id: str
    hub_agent_id: str
    state: BridgeDeliveryState
    reason: Optional[str] = None


class BridgeDeliveryList(_Model):
    """GET /api/hub/bridges/{project_id}/{chatroom_name}/deliveries."""

    deliveries: list[BridgeDelivery]


class HubBridgeDeliveryPayload(_Model):
    project_id: str
    chatroom_name: str
    delivery: BridgeDelivery


class HubBridgeDeliveryEvent(_Model):
    """WS ``hub_bridge_delivery`` (user sockets)."""

    type: Literal["hub_bridge_delivery"]
    payload: HubBridgeDeliveryPayload


# ── conversations (requester side) ────────────────────────────────────────

class HubTarget(_AbsentWhenNone):
    """``hub_target`` on project responses; null on every non-hub project."""

    hub_agent_id: str
    display: str                                    # name@deployment_name
    name: str
    deployment_name: str
    deployment_label: str
    deployment_fingerprint: str                     # genesis
    current_fingerprint: Optional[str] = None
    deployment_url: Optional[str]
    deployment_url_verified: bool
    listed: bool
    closed_reason: Optional[ClosedReason]
    closed_at: Optional[EpochSeconds]               # null while the thread is open


class HubProjectFields(_Model):
    """What the hub adds to GET /projects, /projects/{id} and
    /participants/{id}/projects. Every other project field is unchanged."""

    hub_target: Optional[HubTarget]


class StartConversationRequest(_Model):
    """POST /api/hub/conversations: deduped on (user, client_thread_key)."""

    hub_agent_id: str
    client_thread_key: Annotated[str, Field(min_length=1, max_length=100)]


class ConversationTarget(_AbsentWhenNone):
    agent_online: bool
    deployment_connected: bool
    send_warning: Optional[SendWarning]
    deployment_name: str
    deployment_fingerprint: str                     # genesis
    current_fingerprint: Optional[str] = None
    deployment_url: Optional[str]
    deployment_url_verified: bool
    first_contact: bool


class StartConversationResponse(BaseModel):
    """The new (or existing) Front Desk project, as the project routes return
    it, plus ``target``. Only the hub-specific fields are pinned here; the
    rest of the project body passes through unchanged (``extra="allow"``)."""

    model_config = ConfigDict(extra="allow")

    id: str
    surface: Literal["frontdesk"]
    hub_target: HubTarget
    target: ConversationTarget


class SendMessageRequest(_Model):
    """POST /api/hub/conversations/{project_id}/messages. A repeated
    ``client_message_id`` returns the original result with 200."""

    text: str
    client_message_id: Annotated[str, Field(min_length=1, max_length=100)]
    confirm_offline: bool = False
    file_ids: list[str] = Field(default_factory=list)


class Delivery(_Model):
    """One message's delivery, as the requester sees it."""

    message_id: str
    state: DeliveryState
    waiting_reason: Optional[WaitingReason]
    failed_reason: Optional[FailedReason]
    detail: Optional[str]                           # NOT_ACCEPTING_DETAILS, only with not_accepting
    retry_at: Optional[EpochSeconds]
    held_for_approval: bool
    delivered_late: bool
    attempts: int
    state_at: EpochSeconds
    expires_at: EpochSeconds


class SendMessageResponse(_Model):
    message_id: str                                 # server-minted, = the local ChatMessage.id
    delivery: Delivery


class DeliveryList(_Model):
    """GET …/{project_id}/deliveries: a JSON array of Delivery (this wrapper
    names it for the snapshot; the route answers the bare list)."""

    deliveries: list[Delivery]


# ── generic connection and thread rows ────────────────────────────────────

class HubContactFields(_Model):
    """What request rows and hub thread rows carry on the existing channel
    routes, as separate fields, so the browser never parses contact_name."""

    remote_username: Optional[str]
    deployment_name: Optional[str]
    deployment_fingerprint: Optional[str]           # genesis
    #: "sent by their agent X": which of the person's own agents sent their
    #: newest message (signed by their deployment), plain text, cleaned like
    #: remote_username; null when they sent it themselves.
    via_agent: Optional[str] = None


# ── WebSocket events on the user's socket ─────────────────────────────────

class HubDeliveryStatePayload(_Model):
    project_id: str
    delivery: Delivery


class HubDeliveryStateEvent(_Model):
    type: Literal["hub_delivery_state"] = "hub_delivery_state"
    payload: HubDeliveryStatePayload


class HubChannelStatusPayload(_Model):
    agent_full_name: str
    channel: HubChannel                             # the full, masked object


class HubChannelStatusEvent(_Model):
    type: Literal["hub_channel_status"] = "hub_channel_status"
    payload: HubChannelStatusPayload


# ── errors ────────────────────────────────────────────────────────────────

class PayloadTooLarge(_Model):
    """payload_too_large [413] extras."""

    limit: PayloadLimit
    max: int
    actual: int
    file_id: Optional[str] = None


class LocalAgentDetail(_Model):
    """local_agent [409] extras: the browser goes to /dm/{agent_name}."""

    use_path: str
    agent_name: str                                 # the local agent's full name


class RateLimitedDetail(_Model):
    """rate_limited [429] extras: whole seconds to wait, 1 to 3600."""

    retry_after: int


class TargetOfflineDetail(_Model):
    """target_offline_confirm_required [409] extras: why the send wants a confirm."""

    send_warning: SendWarning


class SendUnreachableDetail(_Model):
    """hub_unreachable [503] extras on send only: when this server last had
    the hub (null when it never connected)."""

    last_connected_at: Optional[EpochSeconds]


class FileNotFoundDetail(_Model):
    """file_not_found [404] extras: the first file_ids entry not in the conversation."""

    file_id: str


#: The error codes whose body carries extras, and the model of those extras
#: (``detail`` minus ``code`` and ``message``). ``hub_unreachable`` has them
#: only on send; every other route sends it bare.
ERROR_DETAILS: dict[str, type[BaseModel]] = {
    "payload_too_large": PayloadTooLarge,
    "local_agent": LocalAgentDetail,
    "rate_limited": RateLimitedDetail,
    "agent_send_cap": RateLimitedDetail,
    "target_offline_confirm_required": TargetOfflineDetail,
    "hub_unreachable": SendUnreachableDetail,
    "file_not_found": FileNotFoundDetail,
}


#: Every error code of section 5, with its usual HTTP status. A route may
#: answer a code with another status where the table says so (agent_unlisted
#: is 404 on agent detail and 410 on start and send).
ERROR_STATUS: dict[str, int] = {
    "unauthorized": 401,
    "hub_off_on_server": 503,
    "hub_not_registered": 409,
    "hub_discover_only": 409,
    "hub_untrusted": 503,
    "hub_unreachable": 503,
    "not_owner": 403,
    "agent_not_found": 404,
    "agent_not_public": 409,
    "confirm_required": 400,
    "use_hub_routes": 409,
    "use_hub_send": 409,
    "query_too_broad": 400,
    "rate_limited": 429,
    "invalid_agent_id": 400,
    "agent_unlisted": 410,
    "avatar_not_set": 404,
    "avatar_unavailable": 404,
    "local_agent": 409,
    "own_agent": 403,
    "target_offline_confirm_required": 409,
    "key_revoked": 409,
    "identity_changed": 409,
    "conversation_closed": 409,
    "payload_too_large": 413,
    "file_not_found": 404,
    "project_not_found": 404,
    "isolation_unavailable": 409,
    "room_flow_stopped": 409,
    "agent_send_cap": 429,
    "user_only": 403,
    "agent_name_unsupported": 409,
    "turn_scope": 403,
    "not_retained": 409,
    "owner_isolation_refused": 409,   # plan-owner-isolation: the setting cannot be turned on
    "serving_only_agent": 403,        # plan-owner-isolation 5d: an owner-isolated agent's own token
    "foreign_coordinator": 403,       # plan-owner-isolation 4: only the account's own agents coordinate
    # Enrollment (server/hub/enroll.py)
    "hub_owner_unverified": 409,      # enable: verify yourself as an owner first (the UI opens the dialog)
    "enroll_busy": 409,               # another member is confirming this server's registration
    "enroll_operator_only": 409,
    "enroll_code_invalid": 400,
    "enroll_code_expired": 400,
    "enroll_email_unverified": 409,   # the user's own ClawMeets email is not verified
    "enroll_refused": 409,            # any other hub refusal; the message carries the hub's words
    "tos_outdated": 409,
    "owner_banned": 403,
}

#: The hub-state errors. Only search, agent detail, start, send, report and
#: enable return them (``HubRuntime.require``); config, deliveries, avatar and
#: disable never do.
HUB_STATE_ERRORS = frozenset({
    "hub_off_on_server", "hub_not_registered", "hub_discover_only", "hub_untrusted", "hub_unreachable",
})


class HubError(Exception):
    """A browser-facing error: ``{"detail": {"code", "message", **extra}}``
    with ``status`` (the code's usual status unless given)."""

    def __init__(self, code: str, message: str = "", *, status: Optional[int] = None, **extra: Any) -> None:
        if code not in ERROR_STATUS:
            raise ValueError(f"unknown hub error code {code!r}")
        super().__init__(code)
        self.code = code
        self.message = message
        self.status = status if status is not None else ERROR_STATUS[code]
        self.extra = extra

    def body(self) -> dict[str, Any]:
        return {"detail": {"code": self.code, "message": self.message, **self.extra}}


# ── agent send (plan-agent-access 4.1) ────────────────────────────────────

class HubMessage(_Model):
    """One message of a hub conversation as GET …/messages lists it. ``text``
    is None whenever the caller may not see remote text."""

    id: str
    author_kind: Literal["user", "agent", "remote"]
    ts: EpochSeconds
    state: Optional[str] = None
    text: Optional[str] = None


class HubMessagePage(_Model):
    """GET /api/hub/conversations/{id}/messages."""

    messages: list[HubMessage]
    text_withheld: bool


class UsageWindowOut(_Model):
    name: str
    used: int
    limit: int
    resets_at: EpochSeconds


class AgentUsage(_Model):
    """GET /api/hub/agents-usage/{agent_id}: an agent's hub send windows."""

    windows: list[UsageWindowOut]


# ── room flow (plan-agent-access 4.6) ─────────────────────────────────────
# ``RoomFlow`` (chatroom ``flow``) and ``ParticipantInfo`` (chatroom
# ``participant_info``) live with the Chatroom model; they are registered
# below so the snapshot freezes them too.

class ChatroomFlowChangedPayload(_Model):
    project_id: str
    chatroom_name: str
    flow: RoomFlow


class ChatroomFlowChangedEvent(_Model):
    """WS ``chatroom_flow_changed`` (the owner's user sockets)."""

    type: Literal["chatroom_flow_changed"]
    payload: ChatroomFlowChangedPayload


#: Why a send was held: the room's inbound flow is stopped; the inspector
#: held it (its own reason is the owner's to see); the inspector failed or
#: timed out; the conversation has no requester key yet. A closed set.
HeldReason = Literal["flow_stopped", "held", "inspector_error", "requester_key_pending"]


class HeldForReview(_Model):
    """202 body of a send that was HELD rather than refused: a Front Desk
    requester's direct post that any inspection hold caught. It is delivered
    on release (or dropped at expiry), so the client must not resend. A
    refused send answers 409 ``room_flow_stopped``; a blocked one 403."""

    held: Literal[True]
    reason: HeldReason
    message: str


# ── owner isolation (plan-owner-isolation section 8, frozen) ──────────────

#: Why "runs in its own environment" cannot be turned on, or is not in effect.
OwnerIsolationRefusalCode = Literal[
    "not_public",                  # the agent is not discoverable
    "cohosted_with_non_isolated",  # its host can read a credential of an agent without the setting
    "owner_login_on_host",         # a ClawMeets login is saved on its host
    "runner_unreported",           # no host report from a runner that knows owner isolation
]


class OwnerIsolationRefusal(_Model):
    code: OwnerIsolationRefusalCode
    message: str
    #: cohosted only: short names of THIS owner's offending agents (other accounts are never named).
    agents: list[str] = []


class OwnerIsolationConfirm(_Model):
    """Server-written copy, rendered verbatim."""

    title: str
    body: list[str]
    acknowledge: str
    action: str


class OwnerIsolationStatus(_Model):
    """GET/PUT /agents/{id}/owner-isolation, POST …/owner-isolation/clear-host."""

    agent_id: str
    enabled: bool                  # the owner's stored choice
    effective: bool                # the next serving turn runs without the system sandbox
    eligible: bool                 # can be turned on right now
    refusals: list[OwnerIsolationRefusal]
    model_key_shared: Optional[bool] = None   # warning only; None = unknown
    host_exposed: bool = False     # ran without the sandbox on a host not yet confirmed wiped
    blocked_agents: list[str] = []  # this owner's agents refused on that host since
    confirm: OwnerIsolationConfirm
    clear_host_confirm: OwnerIsolationConfirm


class OwnerIsolationRequest(_Model):
    enabled: bool
    acknowledged: bool = False


class ClearHostRequest(_Model):
    acknowledged: bool = False


class OwnerIsolationRefusedDetail(_Model):
    """409 ``owner_isolation_refused`` body (inside ``detail``)."""

    code: Literal["owner_isolation_refused"]
    message: str
    refusals: list[OwnerIsolationRefusal]


#: Contract models defined beside the data they describe, not in this module.
SHARED_MODELS: tuple[type[BaseModel], ...] = (RoomFlow, ParticipantInfo, ParticipantHub)

#: Every model of the contract, by name: what the snapshot and the static
#: masking test walk. A model added above must be added here.
BROWSER_MODELS: dict[str, type[BaseModel]] = {
    m.__name__: m for m in (
        BridgeDelivery, BridgeDeliveryList, HubBridgeDeliveryPayload, HubBridgeDeliveryEvent,
        HubConfigOut, HubChannel, EnableRequest, DisableRequest, DispatchSettingsRequest, BlockRequest,
        BlockedDeployment,
        BlockedList, HubAgentSearch, HubAgent, HubAgentPage, HubAgentDetail, ReportRequest,
        ReportAccepted, RetainedAgent, RetainedList, HubTarget, HubProjectFields, StartConversationRequest, ConversationTarget,
        StartConversationResponse, SendMessageRequest, Delivery, SendMessageResponse, DeliveryList,
        HubContactFields, HubDeliveryStatePayload, HubDeliveryStateEvent, HubChannelStatusPayload,
        HubMessage, HubMessagePage, UsageWindowOut, AgentUsage,
        HubChannelStatusEvent, PayloadTooLarge, LocalAgentDetail, RateLimitedDetail,
        TargetOfflineDetail, SendUnreachableDetail, FileNotFoundDetail,
        ChatroomFlowChangedPayload, ChatroomFlowChangedEvent, HeldForReview,
        OwnerIsolationRefusal, OwnerIsolationConfirm, OwnerIsolationStatus, OwnerIsolationRequest,
        ClearHostRequest, OwnerIsolationRefusedDetail, HubEnrollment, EnrollRequest, EnrollConfirm,
        *SHARED_MODELS,
    )
}
