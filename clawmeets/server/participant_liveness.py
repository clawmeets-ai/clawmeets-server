# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/participant_liveness.py

Split a batch's expected participants into the ones that have a live runner
connection and the ones that do not, at dispatch time.

Without this, a message @mentioning an agent whose runner is down opens a
``PendingWork`` that burns its full ``timeout_seconds`` with ``responded=[]``,
while ``WorkTracker.get_processing_agents`` reports that dead runner as
*actively processing* for the whole window. The product was not slow; it was
waiting on something that could not possibly answer, and said nothing.

Deliberately a sibling of ``server/batch_timeout.py`` rather than a method on
``models/work_tracker.py``, for the same two reasons that module gives: it
needs an ``Agent.get`` card lookup, which the model layer stays ignorant of,
and ``WorkTracker`` is kept free of hub/server imports (``work_tracker.py:66-70``)
— a fact the post-open-disconnect decision in ``_open_pending_batch``'s
docstring leans on directly.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.ws_hub import WSHub

logger = logging.getLogger(__name__)


def split_by_liveness(
    expects: Iterable[str],
    *,
    ws_hub: "WSHub",
    model_ctx: "ModelContext",
) -> tuple[list[str], list[str]]:
    """Partition ``expects`` into ``(dispatched, offline)``, preserving input order.

    Offline means "**resolves to an ``Agent`` AND is not connected**", never a
    bare ``not is_connected``. ``expects`` is not guaranteed agents-only — see
    ``resolve_batch_timeout``'s docstring (``batch_timeout.py:46-48``), which
    notes that participant ids that are not agents contribute nothing — and a
    user id is also a hub key, so a user with no browser open would otherwise
    be reported as an offline *agent*. That costs one ``Agent.get``, the same
    lookup ``resolve_batch_timeout`` is already making two lines away.

    Non-agents, unresolvable ids and lookup failures all go to ``dispatched``:
    this function only ever adds to ``offline`` on positive evidence, so its
    failure mode is exactly today's behaviour.

    Never raises, same contract as ``resolve_batch_timeout``: a batch must open
    even if a card is missing or corrupt.

    A connect can race the check — an agent may come up microseconds after.
    That is the same window ``agents.py:504`` already lives with, and the
    failure mode is a spurious offline row on a message that then gets
    answered, which the chip tolerates.
    """
    from clawmeets.models.agent import Agent

    dispatched: list[str] = []
    offline: list[str] = []
    for participant_id in expects or ():
        try:
            agent = Agent.get(participant_id, model_ctx)
        except Exception:
            logger.exception(
                "participant_liveness: failed to resolve %s — treating as dispatched",
                participant_id[:8],
            )
            dispatched.append(participant_id)
            continue
        if agent is None:
            dispatched.append(participant_id)  # a user, or an id with no card
            continue
        if ws_hub.is_connected(participant_id):
            dispatched.append(participant_id)
        else:
            offline.append(participant_id)
    return dispatched, offline
