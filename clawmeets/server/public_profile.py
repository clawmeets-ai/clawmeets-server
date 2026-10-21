# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/public_profile.py
What an anonymous visitor may know about an account's public agents — one
builder for the account page's listing and the chat widget's header.

An agent is public when its web chat widget is on, enabled, and one of its keys
lists this server among its allowed sites (``ChannelGateway.hosted_grant``):
the key the server's own pages chat with. So "listed" and "chattable here"
never disagree.

URLs are absolute (``CLAWMEETS_SERVER_URL``): the widget renders them on other
people's sites.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional
from urllib.parse import quote

from clawmeets.models.agent import Agent
from clawmeets.models.user import User
from clawmeets.server.channels import webchat
from clawmeets.server.channels.gateway import provider_gateway
from clawmeets.server.channels.store import ChannelConnection, WebchatGrant

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext


@dataclass(frozen=True)
class PublicAgentRef:
    agent: Agent
    connection: ChannelConnection
    grant: WebchatGrant
    #: The short name — the handle in the agent's chat URL.
    handle: str


def account_url(ctx: "ServerContext", username: str) -> str:
    return f"{_base(ctx)}/users/{quote(username)}/agents/"


def chat_url(ctx: "ServerContext", username: str, handle: str) -> str:
    return f"{_base(ctx)}/users/{quote(username)}/agents/{quote(handle)}/chat"


def _base(ctx: "ServerContext") -> str:
    gateway = provider_gateway(ctx)
    return gateway.config.server_url.rstrip("/") if gateway is not None else ""


def public_agents(ctx: "ServerContext", owner: User) -> list[PublicAgentRef]:
    """The owner's public agents, by name."""
    gateway = provider_gateway(ctx)
    if gateway is None or webchat.CHANNEL not in gateway.adapters:
        return []
    out: list[PublicAgentRef] = []
    for connection in gateway.store.list_connections(owner.id):
        if connection.channel != webchat.CHANNEL or connection.disabled:
            continue
        grant = gateway.hosted_grant(connection)
        if grant is None:
            continue
        agent = Agent.get(connection.agent_id, ctx.model_ctx)
        if agent is None or agent.registered_by != owner.id:
            continue
        out.append(PublicAgentRef(agent, connection, grant, agent.short_name_for(owner.username)))
    out.sort(key=lambda ref: ref.agent.name)
    return out


def account(ctx: "ServerContext", owner: User) -> dict:
    return {
        "handle": owner.username,
        "display_name": owner.display_name or owner.username,
        "bio": "",
        "website": None,
        "avatar_url": owner.avatar_url,
        "url": account_url(ctx, owner.username),
    }


def agent_card(ctx: "ServerContext", ref: PublicAgentRef) -> dict:
    """One agent as the listing shows it (no key, no account)."""
    agent = ref.agent
    profile = agent.public_chat
    teams = agent.user_teams
    return {
        "id": ref.handle,
        "display_name": profile["display_name"] or ref.handle,
        "team_id": teams[0] if teams else None,
        "description": agent.description,
        "skills": list(agent.capabilities or []),
        "takes_direct_requests": profile["takes_direct_requests"],
        "online": ctx.ws_hub.is_connected(agent.id),
        "starter_questions": profile["starter_questions"],
    }


def default_agent(cards: list[dict]) -> Optional[str]:
    """The agent "Ask <account>" opens: the first that takes requests."""
    return next((c["id"] for c in cards if c["takes_direct_requests"]), None)


def request_taker(cards: list[dict], card: dict) -> Optional[dict]:
    """Where a visitor goes to start real work when ``card`` only answers
    questions: the first agent in its team that takes requests, else the
    account's default."""
    if card["takes_direct_requests"]:
        return None
    others = [c for c in cards if c["id"] != card["id"] and c["takes_direct_requests"]]
    same_team = [c for c in others if card["team_id"] and c["team_id"] == card["team_id"]]
    if same_team:
        return same_team[0]
    default = default_agent(cards)
    return next((c for c in others if c["id"] == default), None)


def widget_profile(ctx: "ServerContext", connection: ChannelConnection) -> Optional[dict]:
    """What the chat widget draws in its header and intro for one key's agent.
    None when the agent or its owner is gone."""
    owner = User.get(connection.owner_id, ctx.model_ctx)
    agent = Agent.get(connection.agent_id, ctx.model_ctx)
    if owner is None or agent is None:
        return None
    handle = agent.short_name_for(owner.username)
    gateway = provider_gateway(ctx)
    grant = gateway.hosted_grant(connection) if gateway is not None else None
    card = agent_card(ctx, PublicAgentRef(agent, connection, grant, handle))
    # The request-taker link and the account page only exist while public.
    refs = public_agents(ctx, owner)
    is_public = any(r.handle == handle for r in refs)
    taker = None
    if is_public:
        taker = request_taker([agent_card(ctx, r) for r in refs], card)
    return {
        **card,
        "handle": handle,
        "account": {
            "handle": owner.username,
            "display_name": owner.display_name or owner.username,
            "url": account_url(ctx, owner.username) if is_public else None,
        },
        "request_taker": taker and {
            "display_name": taker["display_name"],
            "chat_url": chat_url(ctx, owner.username, taker["id"]),
        },
    }
