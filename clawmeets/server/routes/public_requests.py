# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/public_requests.py

Public requests: the user asks once in plain words, the best few public
agents get it. User JWT only: a request is sent as the user.

The hub ranks and delivers (``dispatch.ask_hub``: at most three agents, or
the user's own assistant when none clearly fits). Nothing else ranks: with
no plan the route answers ``{"detail": {"code", "message"}}`` and stores
nothing -- ``hub_required`` [409] (this server is not on the hub),
``hub_unavailable`` [503] (the hub cannot rank right now) or
``rate_limited`` [429, ``retry_after`` when known].

- ``POST /me/public-requests`` ``{text, send_count}``: ask the hub, store,
  send to its picks (at most three). Answers the full request.
- ``GET /me/public-requests``: summaries, newest first.
- ``GET /me/public-requests/{id}``: the full request with each match's status.
- ``POST /me/public-requests/{id}/send`` ``{count?}``: "ask for more", a new
  ask for up to ``count`` agents that excludes everyone already asked.
- ``POST /me/public-requests/{id}/outcome`` ``{agent_ref, kind}``: the user
  used that agent's answer (``used``) or asked again (``redone``); reported
  to the hub, ids only.
- ``PUT|DELETE /me/public-requests/{id}/dismissed/{agent_ref}`` (a dismiss is
  reported to the hub too).

Replies go to each match's thread through the routes every thread uses;
retaining goes through ``/api/hub/agents/{agent_ref}/retain``.
"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from typing import TYPE_CHECKING, Literal, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel, Field

from clawmeets.hub_protocol.constants import MAX_DISPATCH_SLOTS
from clawmeets.models import public_request as store
from clawmeets.models.public_request import PublicRequest, RequestMatch
from clawmeets.server.agent_visibility import retainers_of
from clawmeets.server.public_requests import dispatch

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

DEFAULT_SEND = MAX_DISPATCH_SLOTS


class CreateRequestBody(BaseModel):
    text: str = Field(max_length=store.MAX_TEXT)
    send_count: int = Field(DEFAULT_SEND, ge=1, le=MAX_DISPATCH_SLOTS)


class SendBody(BaseModel):
    count: int = Field(DEFAULT_SEND, ge=1, le=MAX_DISPATCH_SLOTS)


class OutcomeBody(BaseModel):
    agent_ref: str
    kind: Literal["used", "redone"]


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
    answer_yourself: bool = False
    #: The assistant DM thread that got the request when no agent fit.
    fallback_project_id: Optional[str] = None
    fallback_agent_name: Optional[str] = None


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
            answer_yourself=request.answer_yourself,
            fallback_project_id=request.fallback_project_id,
            fallback_agent_name=request.fallback_agent_name,
        )

    def _load(user_id: str, request_id: str) -> PublicRequest:
        request = store.load(base_dir, user_id, request_id)
        if request is None:
            raise HTTPException(404, "No such request")
        return request

    @router.post("/me/public-requests", response_model=RequestOut, status_code=201)
    async def create_request(body: CreateRequestBody, authorization: str = Header(default="")):
        user = await ctx.auth.get_current_user(authorization)
        text = body.text.strip()
        if not text:
            raise HTTPException(400, "Write what you need done first")
        request = PublicRequest(id=store.new_id(), user_id=user.id, text=text, created_at=time.time())
        async with locks[user.id]:
            # Raises (and nothing is stored) when the hub gives no plan.
            await dispatch.ask_hub(ctx, user, request, limit=body.send_count)
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
            # A new ask, never anyone already asked; on failure the stored
            # request is left as it was.
            await dispatch.ask_hub(ctx, user, request, limit=body.count,
                                   exclude=[m.agent_ref for m in request.matches])
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
            if value:
                _report(user, request, match, "dismissed")
            store.save(base_dir, request)
        return _out(request)

    def _report(user, request: PublicRequest, match: RequestMatch, kind: str) -> None:
        event = dispatch.outcome_events(request, match, kind)
        if event is not None:
            match.outcomes_reported.append(kind)
            dispatch.report_soon(ctx, user, request, [event])

    @router.post("/me/public-requests/{request_id}/outcome", response_model=RequestOut)
    async def outcome(request_id: str, body: OutcomeBody, authorization: str = Header(default="")):
        user = await ctx.auth.get_current_user(authorization)
        async with locks[user.id]:
            request = _load(user.id, request_id)
            match = request.match(body.agent_ref)
            if match is None:
                raise HTTPException(404, f"{body.agent_ref!r} is not a match for this request")
            if body.kind == "used":
                if match.project_id is None:
                    raise HTTPException(409, "That agent has not been sent this request")
                match.used = True
            _report(user, request, match, body.kind)
            store.save(base_dir, request)
        return _out(request)

    @router.put("/me/public-requests/{request_id}/dismissed/{agent_ref:path}", response_model=RequestOut)
    async def dismiss(request_id: str, agent_ref: str, authorization: str = Header(default="")):
        return await _set_dismissed(request_id, agent_ref, authorization, True)

    @router.delete("/me/public-requests/{request_id}/dismissed/{agent_ref:path}", response_model=RequestOut)
    async def undismiss(request_id: str, agent_ref: str, authorization: str = Header(default="")):
        return await _set_dismissed(request_id, agent_ref, authorization, False)

    return router
