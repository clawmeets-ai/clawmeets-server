# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/demand.py
The one answer to "does this server need its hub socket now?".

In the explicit modes (``discover_only``, ``full``) the answer is always yes,
as before. In ``auto`` the socket opens only on demand and closes when
nothing needs it any more (``HubRuntime._reconcile`` asks on every poll):

- something durable in ``channels.db`` (``HubStore.hub_demand``): an agent's
  Hub channel on, or its unregister still to send; an active retained agent;
  a requester thread open or draining; a hub row not ended. While any agent
  channel is on the socket never closes: that is what makes the server
  reachable for inbound messages at all.
- a browser's hub search or agent detail, or a finished enrollment, in the
  last ``RECENT_USE_S`` seconds (``Demand.touch``), so a user browsing the
  directory keeps one connection instead of a connect per query.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .runtime import HubRuntime

#: How long a search or agent detail keeps the socket wanted.
RECENT_USE_S = 30 * 60.0


class Demand:
    def __init__(self, runtime: "HubRuntime") -> None:
        self._runtime = runtime
        self._last_use: Optional[float] = None

    def touch(self, now: float) -> None:
        """A browser used the directory now."""
        self._last_use = now

    def reason(self, now: float) -> Optional[str]:
        """Why the socket is wanted, or None (only ever None in ``auto``)."""
        runtime = self._runtime
        if not runtime.config.lazy:
            return "mode"
        if self._last_use is not None and now - self._last_use < RECENT_USE_S:
            return "recent_use"
        return runtime.hub.hub_demand(now=now)

    def wanted(self, now: float) -> bool:
        return self.reason(now) is not None
