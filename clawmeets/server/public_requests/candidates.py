# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/public_requests/candidates.py

Every public agent a user could send a request to, in one shape
(``ranking.Candidate`` plus what the request record snapshots).

- **This server:** every discoverable agent another account owns (never the
  user's own, never an assistant). Its retain count is ``local_retainers``.
- **Other servers:** the hub directory. The hub matches a substring of its
  query, so the whole request would match nothing; it is asked once per
  strongest term (at most ``HUB_LOOKUPS``, inside the directory's per-user
  limit) and the pages are merged. A hub that is off, unreachable or rate
  limited just contributes nothing.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from clawmeets.models.agent import Agent
from clawmeets.models.user import User
from clawmeets.server.hub.browser import HubError
from clawmeets.server.hub.retain import local_hub_id
from clawmeets.server.public_requests import ranking

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

HUB_LOOKUPS = 3


@dataclass(frozen=True)
class Shaped:
    """A candidate plus the card fields the request record keeps."""

    candidate: ranking.Candidate
    kind: str                       # "local" | "hub"
    agent_id: Optional[str]
    display_name: str
    owner: str
    deployment_name: Optional[str] = None


def _genesis(ctx: "ServerContext") -> Optional[str]:
    runtime = getattr(ctx, "hub_runtime", None)
    reg = runtime.registration() if runtime is not None else None
    return reg.genesis_fp if reg is not None and reg.genesis_fp else None


def local_candidates(ctx: "ServerContext", user: User) -> list[Shaped]:
    from clawmeets.server.agent_visibility import retainers_of

    genesis = _genesis(ctx)
    owners: dict[str, Optional[User]] = {}
    out: list[Shaped] = []
    for card in Agent.list_all_cards(ctx.model_ctx):
        owner_id = card.get("registered_by")
        name = card.get("name") or ""
        if (not owner_id or owner_id == user.id or not card.get("discoverable_through_registry", True)
                or name.endswith("-assistant")):
            continue
        if owner_id not in owners:
            owners[owner_id] = User.get(owner_id, ctx.model_ctx)
        owner = owners[owner_id]
        if owner is None:
            continue
        agent = Agent.get(card["id"], ctx.model_ctx)
        if agent is None:
            continue
        short = name[len(owner.username) + 1:] if name.startswith(f"{owner.username}-") else name
        chat = agent.public_chat
        candidate = ranking.Candidate(
            agent_ref=local_hub_id(agent, genesis),
            name=short,
            description=card.get("description") or "",
            expertise=[c for c in card.get("capabilities") or [] if isinstance(c, str)],
            teams=[t for t in card.get("user_teams") or [] if isinstance(t, str)],
            starter_questions=chat["starter_questions"],
            retained_count=len(retainers_of(ctx, agent.id)),
            online=ctx.ws_hub.is_connected(agent.id),
        )
        out.append(Shaped(candidate=candidate, kind="local", agent_id=agent.id,
                          display_name=chat["display_name"] or short, owner=owner.username))
    return out


async def hub_candidates(ctx: "ServerContext", user: User, request: str) -> list[Shaped]:
    from clawmeets.server.hub.browser import HubAgentSearch

    runtime = getattr(ctx, "hub_runtime", None)
    if runtime is None:
        return []
    # The longest terms are the most specific ones.
    lookups = sorted(ranking.terms(request), key=len, reverse=True)[:HUB_LOOKUPS]
    seen: dict[str, Shaped] = {}
    for term in lookups:
        try:
            page = await runtime.directory.search(user.id, HubAgentSearch(q=term, limit=20))
        except HubError as exc:
            logger.info("Public request: hub search for %r skipped (%s)", term, exc.code)
            break
        for a in page.agents:
            if a.is_local or not a.accepting_messages or a.hub_agent_id in seen:
                continue
            candidate = ranking.Candidate(
                agent_ref=a.hub_agent_id, name=a.name, description=a.description,
                expertise=list(a.capabilities), online=a.agent_online and a.deployment_connected,
            )
            seen[a.hub_agent_id] = Shaped(candidate=candidate, kind="hub", agent_id=None,
                                          display_name=a.name, owner=a.deployment_label or a.deployment_name,
                                          deployment_name=a.deployment_name)
    return list(seen.values())
