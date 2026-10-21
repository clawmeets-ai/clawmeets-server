# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/batch_timeout.py

Resolve the ``PendingWork.timeout_seconds`` for a batch from the cards of the
agents it is waiting on, and the policy for a batch whose timer is paused
while its message waits for delivery (``PendingWork.awaiting_delivery``).

Without this, an agent that raised its own ``local_settings.invoke_timeout_seconds``
would still be killed at the server's default: ``BatchTimeoutChecker`` sends
``CANCEL_LLM`` on expiry and the runner cancels the in-flight invocation, so the
runner-side window is only ever the *upper* of two bounds.

Kept out of ``models/work_tracker.py`` so the model layer stays ignorant of
agent-card lookups.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Iterable

from clawmeets.utils import invoke_timeout

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.models.work_tracker import PendingWork

logger = logging.getLogger(__name__)

#: A batch waiting on a delivery is closed this long after it began waiting,
#: whether or not its timer started (the hub's 7-day held ceiling).
AWAITING_DELIVERY_CEILING_SECONDS = 7 * 24 * 3600
#: The notes the room gets when that ceiling closes a batch.
NEVER_PICKED_UP_NOTE = "No reply: the message was never picked up."
NO_REPLY_NOTE = "No reply within 7 days."


def timer_elapsed(work: "PendingWork", now: datetime) -> float:
    """Seconds the batch's timer has run: from ``timer_started_at`` when
    ``start_timer`` moved it, else from ``created_at``."""
    return (now - (work.timer_started_at or work.created_at)).total_seconds()


def delivery_ceiling_passed(work: "PendingWork", now: datetime) -> bool:
    """A batch that began waiting on a delivery, ``awaiting_since`` more than
    ``AWAITING_DELIVERY_CEILING_SECONDS`` ago (paused or since started)."""
    return (
        work.awaiting_since is not None
        and (now - work.awaiting_since).total_seconds() > AWAITING_DELIVERY_CEILING_SECONDS
    )


def resolve_batch_timeout(
    expected_participants: Iterable[str],
    *,
    default: int,
    model_ctx: "ModelContext",
) -> int:
    """Widest window any expected agent asked for, floored at ``default``.

    Per-participant windows cannot be expressed — ``PendingWork`` carries ONE
    timeout for the whole batch — so a batch is only correct if it waits for
    its SLOWEST member. The cost is that a fast agent in a mixed batch is
    detected late; fixing that properly means a per-participant deadline map in
    ``PendingWork``.

    Participant ids that are not agents (users) and ids with no card contribute
    nothing. Agent-declared windows are capped at ``invoke_timeout.MAX_SECONDS``
    so one card cannot pin a batch open indefinitely; ``default`` is never
    lowered, since that is the operator's own ``--batch-timeout`` (or a
    deliberate per-batch extension) and outranks the cap.

    Never raises: a batch must open even if a card is missing or corrupt.
    """
    from clawmeets.models.agent import Agent

    widest = default
    for participant_id in expected_participants or ():
        try:
            agent = Agent.get(participant_id, model_ctx)
            if agent is None:
                continue  # a user, or an id with no card
            declared = invoke_timeout.resolve(
                agent._load_card().get("local_settings") or {}
            )
        except Exception:
            logger.exception(
                "batch_timeout: failed to read invoke window for %s — using default",
                participant_id[:8],
            )
            continue
        widest = max(widest, min(declared, invoke_timeout.MAX_SECONDS))
    return widest
