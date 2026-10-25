# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/codes.py

Every code the hub protocol puts on the wire: error codes, WebSocket close
codes, delivery results and the other small vocabularies.

Open and closed vocabularies. A wire field that carries a result, reason,
detail, status, state or statement kind is a ``WireCode`` (a constrained
string), not an enum, so a value added by a newer peer within the same
protocol version still parses. Consumers map it with ``as_known(value, Enum,
fallback)``. Discriminators (frame type, Envelope.type, Principal.kind) are
closed ``Literal`` types instead.
"""
from __future__ import annotations

from enum import Enum, IntEnum, StrEnum
from typing import Annotated, TypeVar

from pydantic import StringConstraints

E = TypeVar("E", bound=Enum)

# An open code on the wire: lowercase snake_case, at most 40 characters.
WireCode = Annotated[str, StringConstraints(pattern=r"^[a-z0-9_]{1,40}$")]


class ErrorCode(StrEnum):
    """Every code in the Hub API table's error column, plus the two the
    generic error frame needs for a frame it cannot read."""

    RATE_LIMITED = "rate_limited"
    NAME_CONFLICT = "name_conflict"
    INVALID_NAME = "invalid_name"
    NAME_RESERVED = "name_reserved"
    NAME_REQUIRES_VERIFIED_URL = "name_requires_verified_url"
    INVALID_SIGNATURE = "invalid_signature"
    CLIENT_TOO_OLD = "client_too_old"
    REGISTRATION_CLOSED = "registration_closed"
    NAME_HELD_FOR_RECLAIM = "name_held_for_reclaim"
    BAD_CODE = "bad_code"
    EXPIRED = "expired"
    UNKNOWN_DEPLOYMENT = "unknown_deployment"
    STALE = "stale"
    REVOKE_NOT_AUTHORIZED = "revoke_not_authorized"
    SIGNER_REVOKED = "signer_revoked"
    DEPLOYMENT_SUSPENDED = "deployment_suspended"
    KEY_REVOKED = "key_revoked"
    CLOCK_SKEW = "clock_skew"
    NOT_LISTED = "not_listed"
    OVER_QUOTA = "over_quota"
    INVALID_CERT = "invalid_cert"
    INVALID_LISTING = "invalid_listing"
    DELISTED_BY_HUB = "delisted_by_hub"
    INVALID_DISABLED_AT = "invalid_disabled_at"
    QUERY_TOO_BROAD = "query_too_broad"
    AGENT_NOT_FOUND = "agent_not_found"
    AGENT_UNLISTED = "agent_unlisted"
    TOO_MANY = "too_many"
    NOT_ACCEPTING = "not_accepting"
    TOO_LARGE = "too_large"
    TARGET_DISCONNECTED = "target_disconnected"
    BLOCKED = "blocked"
    SENDER_UNTRUSTED = "sender_untrusted"
    TOS_OUTDATED = "tos_outdated"
    # An agent's owner has not verified their email with the hub (once per
    # owner per deployment), or the hub banned that owner.
    OWNER_UNVERIFIED = "owner_unverified"
    OWNER_BANNED = "owner_banned"
    # Hub-ranked dispatch: the ask is past its expiry, the hub cannot rank
    # (no scorer, or the scorer failed: the requester ranks locally instead),
    # or an ask_id was reused with different content.
    DISPATCH_EXPIRED = "dispatch_expired"
    RANKING_UNAVAILABLE = "ranking_unavailable"
    DUPLICATE_ASK = "duplicate_ask"
    # Generic error frame only: a frame that is not valid JSON or does not fit
    # its schema, and a frame type this end does not know.
    INVALID_FRAME = "invalid_frame"
    UNSUPPORTED = "unsupported"


class CloseCode(IntEnum):
    """WebSocket close codes the hub sends on /v1/connect."""

    INVALID_SIGNATURE = 4001
    DEPLOYMENT_SUSPENDED = 4003
    UNKNOWN_DEPLOYMENT = 4004
    CLIENT_TOO_OLD = 4006
    KEY_REVOKED = 4008
    CLOCK_SKEW = 4009
    RATE_LIMITED = 4029


# One retry an hour, with the reason shown. 4004 triggers one automatic reclaim instead.
TERMINAL_CLOSE_CODES: frozenset[CloseCode] = frozenset({
    CloseCode.DEPLOYMENT_SUSPENDED, CloseCode.CLIENT_TOO_OLD, CloseCode.KEY_REVOKED,
})


class DeliverResult(StrEnum):
    """deliver_ack.result: the six outcomes, then the five refusals."""

    ACCEPTED = "accepted"
    HELD_AGENT_OFFLINE = "held_agent_offline"
    HELD_FOR_APPROVAL = "held_for_approval"
    DUPLICATE = "duplicate"
    PICKED_UP = "picked_up"
    UNKNOWN_MESSAGE = "unknown_message"      # probe answers only
    BLOCKED = "blocked"
    SENDER_UNTRUSTED = "sender_untrusted"
    NOT_ACCEPTING = "not_accepting"
    TOO_LARGE = "too_large"
    STALE = "stale"


class CurrentState(StrEnum):
    """deliver_ack.current_state on a duplicate: where the message is now."""

    ACCEPTED = "accepted"
    HELD_FOR_APPROVAL = "held_for_approval"
    HELD_AGENT_OFFLINE = "held_agent_offline"
    PICKED_UP = "picked_up"


class NotAcceptingDetail(StrEnum):
    CHANNEL_OFF = "channel_off"
    BROWSE_ONLY = "browse_only"
    DAILY_CAP = "daily_cap"
    REQUESTS_FULL = "requests_full"
    # A hub-dispatched ask: the agent's owner has not opted in to routed
    # requests, or the agent's daily cap of them is spent.
    DISPATCH_NOT_ACCEPTED = "dispatch_not_accepted"
    DISPATCH_CAP_REACHED = "dispatch_cap_reached"


class RelayAckResult(StrEnum):
    ACCEPTED = "accepted"                    # forwarded to B's socket, nothing more
    TARGET_DISCONNECTED = "target_disconnected"


class ClosedReason(StrEnum):
    REQUESTER_CLOSED = "requester_closed"
    HOST_CLOSED = "host_closed"
    AGENT_UNLISTED = "agent_unlisted"
    BLOCKED = "blocked"


class UnregisterReason(StrEnum):
    OWNER_DISABLED = "owner_disabled"
    NOT_PUBLIC = "not_public"
    MODE_CHANGE = "mode_change"


class ReportReason(StrEnum):
    IMPERSONATION = "impersonation"
    SPAM = "spam"
    HARMFUL = "harmful"
    OTHER = "other"


class RegisterStatus(StrEnum):
    PENDING_EMAIL = "pending_email"
    ACTIVE = "active"


class OutcomeKind(StrEnum):
    """OutcomeEvent.kind: what the requester did with a dispatched reply."""

    USED = "used"
    REDONE = "redone"
    DISMISSED = "dismissed"
    ANSWERED = "answered"


class StatementKind(StrEnum):
    AGENT_DELISTED = "agent_delisted"
    DEPLOYMENT_SUSPENDED = "deployment_suspended"
    DEPLOYMENT_RESTORED = "deployment_restored"
    KEY_REVOKED = "key_revoked"
    KEY_ROTATED = "key_rotated"             # the key_rotated answer's statement, naming the new head
    REGISTRATION_ACCEPTED = "registration_accepted"


# The member of `enum` whose value is `value`, else `fallback`. How a consumer
# reads an open WireCode field a newer peer may have extended.
def as_known(value: str, enum: type[E], fallback: E) -> E:
    try:
        return enum(value)
    except ValueError:
        return fallback
