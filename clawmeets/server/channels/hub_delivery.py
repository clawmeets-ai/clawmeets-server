# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/hub_delivery.py
The rules a hub row's delivery follows, as pure functions: what a verified
receipt (``deliver_ack``) or a hub refusal (``relay_rejected``) does to the
row, when an unanswered relay is sent again, how fast relays may go, and what
the requester is shown. No I/O; the gateway applies the results.

**Receipts.** A row ends only on a receipt signed by the receiver (the caller
verifies it): ``accepted`` and ``picked_up`` end it ``sent``; ``held_*`` end it
``sent`` but *held* (``last_receipt`` says so, and it is probed every 6 h until
picked up or the 7-day ceiling); the refusals end it ``failed``. A
``duplicate`` is mapped on what happened the first time (``original_result``,
``current_state``). ``unknown_message`` (a probe's answer) changes nothing.

**Re-relays.** A row forwarded with no receipt is relayed again, with the SAME
signed envelope, after 120 s, then 240 s, ... capped at 30 minutes; a re-relay
is not a new attempt. All relays share 55 per minute, of which 20 are kept for
first sends, so a backlog of unanswered rows can never hold up a new message.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from typing import Literal, Optional

from clawmeets.hub_protocol.codes import CurrentState, DeliverResult, ErrorCode
from clawmeets.hub_protocol.constants import (
    HELD_CEILING_S,
    MAX_ENVELOPE_AGE_S,
    PROBE_INTERVAL_S,
    REPLY_MAX_AGE_S,
)
from clawmeets.hub_protocol.frames import DeliverAck

from .store import (
    AWAITING_RECEIPT,
    EXPIRED,
    KIND_HUB_REQUEST,
    PARKED,
    PENDING,
    SENDING,
    SENT,
    WAIT_DEPLOYMENT_OFFLINE,
    WAIT_RATE_LIMITED,
    OutboxRow,
)

#: A requester's message may wait this long for its receipt (the envelope's own age limit).
HUB_REQUEST_MAX_AGE_SECONDS = MAX_ENVELOPE_AGE_S
#: A host's reply to a requester, likewise.
HUB_REPLY_MAX_AGE_SECONDS = REPLY_MAX_AGE_S
RE_RELAY_FIRST_SECONDS = 120.0
RE_RELAY_MAX_SECONDS = 1800.0
RELAYS_PER_MINUTE = 55
FIRST_SEND_RESERVE_PER_MINUTE = 20
#: How often the sweep (expiry, the held ceiling, probes) runs.
HUB_SWEEP_SECONDS = 300.0
PROBE_SECONDS = float(PROBE_INTERVAL_S)
HELD_CEILING_SECONDS = float(HELD_CEILING_S)
#: When no ``retry_after`` came with ``rate_limited``.
DEFAULT_RATE_LIMIT_SECONDS = 60.0

#: Results that mean the message is on the receiver's side, kept.
_SENT = {DeliverResult.ACCEPTED.value, DeliverResult.PICKED_UP.value}
_HELD = {DeliverResult.HELD_AGENT_OFFLINE.value, DeliverResult.HELD_FOR_APPROVAL.value}
_REFUSED = {DeliverResult.BLOCKED.value, DeliverResult.SENDER_UNTRUSTED.value,
            DeliverResult.NOT_ACCEPTING.value, DeliverResult.TOO_LARGE.value,
            DeliverResult.STALE.value}
#: ``last_receipt`` values that mark a ``sent`` row as held on the receiver.
HELD_RECEIPTS = frozenset(_HELD)


@dataclass(frozen=True)
class RowTransition:
    """What a receipt or refusal does to a row.

    ``kind``: ``sent`` / ``held`` (state ``sent``, ``last_receipt`` held_*) /
    ``failed`` / ``unchanged``."""

    kind: Literal["sent", "held", "failed", "unchanged"]
    last_receipt: Optional[str] = None
    reason: Optional[str] = None
    delivery_detail: Optional[str] = None
    retry_at: Optional[float] = None


def receipt_transition(ack: DeliverAck, *, now: float) -> RowTransition:
    """The row's transition for a verified ``deliver_ack``."""
    result, detail = ack.result, ack.detail
    if result == DeliverResult.DUPLICATE.value:
        # Answered with the first outcome: a refusal stays a refusal; a kept
        # message is wherever it is now.
        if ack.original_result in _REFUSED:
            result = ack.original_result
        else:
            result = ack.current_state or ""
            # A held message keeps why it is held (isolation_unavailable).
            detail = detail if result in _HELD else None
    retry_at = now + ack.retry_after if ack.retry_after is not None else None
    if result in _SENT or result == CurrentState.ACCEPTED.value:
        return RowTransition("sent", last_receipt=result)
    if result in _HELD:
        return RowTransition("held", last_receipt=result, delivery_detail=detail)
    if result in _REFUSED:
        return RowTransition("failed", last_receipt=result, reason=result,
                             delivery_detail=detail, retry_at=retry_at)
    return RowTransition("unchanged")      # unknown_message, or a code this build does not know


@dataclass(frozen=True)
class ParkFor:
    """A refusal that is a wait, not a failure."""

    reason: str
    until: Optional[float]


def relay_rejected_transition(
    reason: str, detail: Optional[str], retry_after: Optional[int], *, now: float,
) -> RowTransition | ParkFor:
    """The hub's ``relay_rejected``: rate limited or the target is not
    connected -> park (no attempt counted); anything else fails the row."""
    if reason == ErrorCode.RATE_LIMITED.value:
        wait = float(retry_after) if retry_after is not None else DEFAULT_RATE_LIMIT_SECONDS
        return ParkFor(WAIT_RATE_LIMITED, now + wait)
    if reason == ErrorCode.TARGET_DISCONNECTED.value:
        return ParkFor(WAIT_DEPLOYMENT_OFFLINE, None)
    return RowTransition(
        "failed", reason=reason, delivery_detail=detail,
        retry_at=now + retry_after if retry_after is not None else None,
    )


def re_relay_delay(relay_count: int) -> float:
    """Seconds before relay number ``relay_count + 1`` (``relay_count`` relays
    already went out unanswered): 120, 240, 480, ... capped at 1800."""
    return min(RE_RELAY_MAX_SECONDS, RE_RELAY_FIRST_SECONDS * (2 ** max(0, relay_count - 1)))


def max_age(row: OutboxRow) -> float:
    return HUB_REQUEST_MAX_AGE_SECONDS if row.kind == KIND_HUB_REQUEST else HUB_REPLY_MAX_AGE_SECONDS


def is_held(row: OutboxRow) -> bool:
    return row.state == SENT and row.last_receipt in HELD_RECEIPTS


@dataclass(frozen=True)
class DeliveryView:
    """A hub row as the requester sees it."""

    state: Literal["waiting", "delivered", "held", "failed", "expired"]
    waiting_reason: Optional[str]
    failed_reason: Optional[str]
    expires_at: float
    delivered_late: bool = False


def delivery_view(row: OutboxRow) -> DeliveryView:
    expires_at = row.created_at + max_age(row)
    if row.state in (PENDING, SENDING, PARKED, AWAITING_RECEIPT):
        reason = row.reason if row.state == PARKED else None
        return DeliveryView("waiting", reason, None, expires_at)
    if is_held(row):
        return DeliveryView("held", row.last_receipt, None, expires_at)
    if row.state == SENT:
        return DeliveryView("delivered", None, None, expires_at, delivered_late=row.delivered_late)
    if row.state == EXPIRED:
        return DeliveryView("expired", None, row.reason, expires_at)
    return DeliveryView("failed", None, row.reason, expires_at)       # failed (or held_* of another channel)


class RelayBucket:
    """At most ``per_minute`` relays in any 60 s, of which re-relays may use
    at most ``per_minute - reserve``: ``reserve`` are kept for first sends."""

    def __init__(self, per_minute: int = RELAYS_PER_MINUTE,
                 reserve: int = FIRST_SEND_RESERVE_PER_MINUTE) -> None:
        self._per_minute = per_minute
        self._re_relay_cap = per_minute - reserve
        self._all: deque[float] = deque()
        self._re_relays: deque[float] = deque()

    def _prune(self, now: float) -> None:
        for window in (self._all, self._re_relays):
            while window and window[0] <= now - 60.0:
                window.popleft()

    def can_take(self, *, first_send: bool, now: Optional[float] = None) -> bool:
        now = time.time() if now is None else now
        self._prune(now)
        if len(self._all) >= self._per_minute:
            return False
        return first_send or len(self._re_relays) < self._re_relay_cap

    def re_relays_available(self, now: Optional[float] = None) -> int:
        """How many re-relays could go out now."""
        now = time.time() if now is None else now
        self._prune(now)
        return max(0, min(self._per_minute - len(self._all), self._re_relay_cap - len(self._re_relays)))

    def take(self, *, first_send: bool, now: Optional[float] = None) -> bool:
        now = time.time() if now is None else now
        if not self.can_take(first_send=first_send, now=now):
            return False
        self._all.append(now)
        if not first_send:
            self._re_relays.append(now)
        return True
