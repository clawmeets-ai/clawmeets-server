# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/public_agents.py
An account's public agents: the account page and each agent's hosted chat.
No authentication — both are for anonymous visitors and may be iframed. Who
counts as public is ``server/public_profile.py``.

- ``GET /users/{username}/agents/`` — the account page (the ``public.html``
  Vite entry). It opens chats in the web chat widget's dock, so the listing
  carries each agent's ``chat_key``: the key that lists this server, public by
  design and usable only from this server's origin.
- ``GET /users/{username}/agents/{agent}/chat`` — the hosted chat: the same
  page, which mounts the web chat widget full-page under that agent's key.
- ``GET /api/public/users/{username}/agents`` — ``{account, teams, agents,
  default_agent}``.

Pages answer 404 (with the same page) when nothing is public.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from pydantic import BaseModel

from clawmeets.models.user import User
from clawmeets.server import public_profile
from clawmeets.server.channels.gateway import ConnectionSetupError, provider_gateway

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

_NO_CACHE = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
_NOT_FOUND_PAGE = (
    "<!doctype html><meta charset=utf-8><title>Not found</title>"
    "<p style=\"font-family:system-ui;margin:3rem\">This page is not available.</p>"
)


class PublicAccount(BaseModel):
    handle: str
    display_name: str
    bio: str = ""
    website: Optional[str] = None
    avatar_url: Optional[str] = None


class PublicTeam(BaseModel):
    id: str
    name: str
    description: str = ""


class PublicAgent(BaseModel):
    id: str
    display_name: str
    team_id: Optional[str] = None
    description: str = ""
    skills: list[str] = []
    takes_direct_requests: bool = True
    online: bool = False
    starter_questions: list[str] = []
    #: The widget key the account page opens this agent's chat with.
    chat_key: str


class PublicDirectory(BaseModel):
    account: PublicAccount
    teams: list[PublicTeam]
    agents: list[PublicAgent]
    #: Handle of the agent "Ask <account>" opens; None when none takes requests.
    default_agent: Optional[str] = None


def create_public_agents_router(
    ctx: "ServerContext", page: Optional[Path] = None,
) -> APIRouter:
    router = APIRouter(tags=["public"])

    def _owner(username: str) -> Optional[User]:
        return User.get_by_username(username, ctx.model_ctx)

    def _directory(owner: User) -> Optional[PublicDirectory]:
        refs = public_profile.public_agents(ctx, owner)
        if not refs:
            return None
        gateway = provider_gateway(ctx)
        teams: list[PublicTeam] = []
        agents: list[PublicAgent] = []
        for ref in refs:
            card = public_profile.agent_card(ctx, ref)
            team = card["team_id"]
            if team and all(t.id != team for t in teams):
                teams.append(PublicTeam(id=team, name=team))
            try:
                key = gateway.grant_key(ref.grant)
            except ConnectionSetupError:
                continue
            agents.append(PublicAgent(**card, chat_key=key))
        if not agents:
            return None
        return PublicDirectory(
            account=PublicAccount(**{
                k: v for k, v in public_profile.account(ctx, owner).items() if k != "url"
            }),
            teams=teams, agents=agents,
            default_agent=public_profile.default_agent([a.model_dump() for a in agents]),
        )

    @router.get("/api/public/users/{username}/agents", response_model=PublicDirectory)
    async def list_public_agents(username: str):
        owner = _owner(username)
        directory = _directory(owner) if owner else None
        if directory is None:
            raise HTTPException(404, "No public agents")
        return directory

    # ── pages ────────────────────────────────────────────────────────────

    @router.get("/users/{username}/agents", include_in_schema=False)
    async def account_page_bare(username: str):
        return RedirectResponse(f"/users/{quote(username)}/agents/", status_code=308)

    def _page(found: bool):
        if page is None or not page.is_file():
            return HTMLResponse(_NOT_FOUND_PAGE, status_code=200 if found else 404,
                                headers=_NO_CACHE)
        return FileResponse(page, status_code=200 if found else 404, headers=_NO_CACHE)

    @router.get("/users/{username}/agents/", include_in_schema=False)
    async def account_page(username: str):
        owner = _owner(username)
        return _page(bool(owner and public_profile.public_agents(ctx, owner)))

    @router.get("/users/{username}/agents/{agent_name}/chat", include_in_schema=False)
    async def chat_page(username: str, agent_name: str):
        owner = _owner(username)
        found = owner is not None and any(
            r.handle == agent_name for r in public_profile.public_agents(ctx, owner)
        )
        return _page(found)

    return router


