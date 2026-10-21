# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/public_requests.py

Public requests: the user asks once in plain words, the server ranks every
public agent for it and sends it to the best few. User JWT only: a request is
sent as the user.

- ``POST /me/public-requests`` ``{text, send_count}``: rank, store, send to
  the top ``send_count``. Answers the full request.
- ``GET /me/public-requests``: summaries, newest first.
- ``GET /me/public-requests/{id}``: the full request with each match's status.
- ``POST /me/public-requests/{id}/send`` ``{count?, agent_refs?}``: send to
  the named matches, else to the next ``count`` unsent ones ("load more").
- ``PUT|DELETE /me/public-requests/{id}/dismissed/{agent_ref}``.

Replies go to each match's thread through the routes every thread uses;
retaining goes through ``/api/hub/agents/{agent_ref}/retain``.
"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel, Field

from clawmeets.models import public_request as store
from clawmeets.models.public_request import PublicRequest, RequestMatch
from clawmeets.server.agent_visibility import retainers_of
from clawmeets.server.public_requests import dispatch, ranking
from clawmeets.server.public_requests.candidates import hub_candidates, local_candidates

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

DEFAULT_SEND = 3


class CreateRequestBody(BaseModel):
    text: str = Field(max_length=store.MAX_TEXT)
    send_count: int = Field(DEFAULT_SEND, ge=1, le=ranking.MAX_MATCHES)


class SendBody(BaseModel):
    count: Optional[int] = Field(None, ge=1, le=ranking.MAX_MATCHES)
    agent_refs: Optional[list[str]] = None


class MatchOut(RequestMatch):
    status: dispatch.Status
    #: When the agent first answered (epoch seconds); None until it has.
    responded_at: Optional[float] = None


class RequestSummary(BaseModel):
    id: str
    text: str
    created_at: float
    matched: int
    sent: int
    responded: int


class RequestOut(RequestSummary):
    matches: list[MatchOut]


def create_public_requests_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["public-requests"])
    locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
    base_dir = ctx.model_ctx.base_dir

    def _out(request: PublicRequest) -> RequestOut:
        matches = []
        for m in request.matches:
            status, responded_at = dispatch.thread_state(ctx, m)
            out = MatchOut(**m.model_dump(), status=status, responded_at=responded_at)
            if m.agent_id is not None:
                # Live, unlike the rest of the snapshot: retaining one is
                # what this page asks the user to do.
                out.retained_count = len(retainers_of(ctx, m.agent_id))
            matches.append(out)
        return RequestOut(
            id=request.id, text=request.text, created_at=request.created_at,
            matched=len(matches), sent=sum(1 for m in matches if m.status != "not_sent"),
            responded=sum(1 for m in matches if m.status == "responded"), matches=matches,
        )

    def _load(user_id: str, request_id: str) -> PublicRequest:
        request = store.load(base_dir, user_id, request_id)
        if request is None:
            raise HTTPException(404, "No such request")
        return request

    async def _send(user, request: PublicRequest, matches: list[RequestMatch]) -> None:
        await asyncio.gather(*(dispatch.send(ctx, user, request, m) for m in matches))

    @router.post("/me/public-requests", response_model=RequestOut, status_code=201)
    async def create_request(body: CreateRequestBody, authorization: str = Header(default="")):
        user = await ctx.auth.get_current_user(authorization)
        text = body.text.strip()
        if not text:
            raise HTTPException(400, "Write what you need done first")
        shaped = local_candidates(ctx, user) + await hub_candidates(ctx, user, text)
        by_ref = {s.candidate.agent_ref: s for s in shaped}
        matches = []
        for r in ranking.rank((s.candidate for s in shaped), text):
            s = by_ref[r.candidate.agent_ref]
            c = r.candidate
            matches.append(RequestMatch(
                agent_ref=c.agent_ref, kind=s.kind, agent_id=s.agent_id, name=c.name,
                display_name=s.display_name, owner=s.owner, deployment_name=s.deployment_name,
                description=c.description, expertise=list(c.expertise), teams=list(c.teams),
                retained_count=c.retained_count, online=c.online,
                fit=r.fit, rep=r.rep, score=r.score, why=r.why,
            ))
        request = PublicRequest(id=store.new_id(), user_id=user.id, text=text,
                                created_at=time.time(), matches=matches)
        async with locks[user.id]:
            store.save(base_dir, request)
            await _send(user, request, matches[:body.send_count])
            store.save(base_dir, request)
        return _out(request)

    @router.get("/me/public-requests", response_model=list[RequestSummary])
    async def list_requests(authorization: str = Header(default="")):
        user = await ctx.auth.get_current_user(authorization)
        out = []
        for request in store.list_for(base_dir, user.id):
            full = _out(request)
            out.append(RequestSummary(**full.model_dump(exclude={"matches"})))
        return out

    @router.get("/me/public-requests/{request_id}", response_model=RequestOut)
    async def get_request(request_id: str, authorization: str = Header(default="")):
        user = await ctx.auth.get_current_user(authorization)
        return _out(_load(user.id, request_id))

    @router.post("/me/public-requests/{request_id}/send", response_model=RequestOut)
    async def send_more(request_id: str, body: SendBody = Body(default_factory=SendBody),
                        authorization: str = Header(default="")):
        user = await ctx.auth.get_current_user(authorization)
        async with locks[user.id]:
            request = _load(user.id, request_id)
            if body.agent_refs:
                picked = []
                for ref in body.agent_refs:
                    match = request.match(ref)
                    if match is None:
                        raise HTTPException(404, f"{ref!r} is not a match for this request")
                    picked.append(match)
            else:
                unsent = [m for m in request.matches if m.project_id is None and m.send_error is None]
                picked = unsent[:body.count or DEFAULT_SEND]
            await _send(user, request, picked)
            store.save(base_dir, request)
        return _out(request)

    async def _set_dismissed(request_id: str, agent_ref: str, authorization: str, value: bool) -> RequestOut:
        user = await ctx.auth.get_current_user(authorization)
        async with locks[user.id]:
            request = _load(user.id, request_id)
            match = request.match(agent_ref)
            if match is None:
                raise HTTPException(404, f"{agent_ref!r} is not a match for this request")
            match.dismissed = value
            store.save(base_dir, request)
        return _out(request)

    @router.put("/me/public-requests/{request_id}/dismissed/{agent_ref:path}", response_model=RequestOut)
    async def dismiss(request_id: str, agent_ref: str, authorization: str = Header(default="")):
        return await _set_dismissed(request_id, agent_ref, authorization, True)

    @router.delete("/me/public-requests/{request_id}/dismissed/{agent_ref:path}", response_model=RequestOut)
    async def undismiss(request_id: str, agent_ref: str, authorization: str = Header(default="")):
        return await _set_dismissed(request_id, agent_ref, authorization, False)

    return router
