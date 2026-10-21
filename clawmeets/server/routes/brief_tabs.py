# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/brief_tabs.py

Brief-tab registry routes — agent-authored, user-scoped briefing
documents the My Desk "Scheduled briefings" section composes into a tab
strip.

A briefing is ONE complete ``<!doctype html>`` document, stored and
returned **byte-verbatim**: nothing here parses, sanitizes, re-serializes
or minifies it, and nothing here injects into it. The desk's height
bootstrap is a client-side concern, injected immediately before the frame
is mounted, so it is neither stored nor counted against the cap.

Routes:

- ``GET /me/brief/tabs`` — user JWT or agent bearer + ``X-Agent-ID``.
  **Metadata only**, newest first — no ``html`` key. The desk loads the
  strip from here and fetches one document only when the user opens it.
- ``GET /me/brief/tabs/{slug}`` — same auth. The full document, behind
  ``ETag: "<generated_at>"`` + ``Cache-Control: private, no-cache``, so
  a reload of an unchanged briefing costs a 304 and one small sidecar
  read instead of 256 KB.
- ``PUT /me/brief/tabs/{slug}`` — **agent token** (``Authorization:
  Bearer <agent_token>`` + ``X-Agent-ID: <agent_id>``). Server resolves
  ``owner_user_id = Agent(agent_id).registered_by``, writes the pair,
  and pushes ``BRIEF_TAB_SYNC`` to the owner so the desk refetches.
- ``DELETE /me/brief/tabs/{slug}`` — user JWT OR the publishing agent's
  token (whichever matches the tab's ``owner_agent_id``).

The document is bounded at :data:`MAX_BRIEF_HTML_BYTES`, enforced twice
on purpose — see :class:`BriefBodyLimitMiddleware` for why one of the
two checks cannot do the other's job.
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Body, Header, HTTPException
from fastapi.responses import JSONResponse, Response

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    BriefTabSyncPayload,
)
from clawmeets.models.agent import Agent
from clawmeets.models.brief_tab import (
    MAX_BRIEF_HTML_BYTES,
    delete_tab,
    get_meta,
    get_tab,
    list_metas,
    upsert_tab,
    validate_slug,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# Envelope slack for the pre-buffer check. The document rides inside a
# JSON string, so escaping can legitimately inflate it: a pathological
# all-quotes document doubles. 2x + 8 KB never rejects a legal document
# and still bounds what we agree to buffer.
_MAX_REQUEST_BYTES = 2 * MAX_BRIEF_HTML_BYTES + 8192

# ``no-cache`` means *may store, must revalidate* — exactly the read path
# the split artifact was designed for. The client writes no ETag code; it
# leans on the browser's own HTTP cache to send ``If-None-Match`` and
# absorb the 304. An ETag with no freshness directive leaves revalidation
# to heuristic freshness, and a browser that guesses the other way serves
# a stale briefing with no request reaching us at all — nothing to log,
# nothing to diagnose. ``private`` keeps an owner-scoped document out of
# a shared cache. Goes on the 200 AND on the 304: a 304 that drops the
# directive re-opens the hole the 200 closed.
_CACHE_CONTROL = "private, no-cache"

_BRIEF_TAB_PATH_PREFIX = "/me/brief/tabs/"


class BriefBodyLimitMiddleware:
    """Refuse an oversized brief-tab upload *before* the body is buffered.

    Why middleware and not five lines in the handler: FastAPI's request
    handler reads the whole body (``body_bytes = await request.body()``)
    BEFORE it resolves dependencies or calls our function. A check inside
    the handler therefore runs *after* the buffering it exists to
    prevent — it produces a tidy status code and mitigates nothing. The
    in-handler check stays for its real job (naming the limit and the
    actual size for AC-1.3, and measuring the *field* rather than the
    envelope); this is the placement that actually refuses the bytes.

    Pure ASGI, not ``BaseHTTPMiddleware``, so nothing in the stack
    touches ``receive()`` before we decide.

    Scoped to ``PUT /me/brief/tabs/{slug}`` only. This is not the place
    to introduce an app-wide request-size policy — file upload and
    knowledge packs have their own shapes, and widening the blast radius
    to fix a briefing route is how an unrelated endpoint breaks.

    An absent or unparseable ``Content-Length`` (chunked transfer) falls
    through to the handler check. That is the honest limit of a header
    precheck, and it is why the handler check stays.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if (
            scope.get("type") != "http"
            or scope.get("method") != "PUT"
            or not scope.get("path", "").startswith(_BRIEF_TAB_PATH_PREFIX)
        ):
            await self.app(scope, receive, send)
            return

        declared = -1
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = -1
                break

        if declared > _MAX_REQUEST_BYTES:
            body = json.dumps(
                {
                    "detail": (
                        f"request body exceeds {_MAX_REQUEST_BYTES} bytes "
                        f"(got {declared}); the briefing document limit is "
                        f"{MAX_BRIEF_HTML_BYTES} bytes (256 KB)"
                    )
                }
            ).encode("utf-8")
            await send(
                {
                    "type": "http.response.start",
                    "status": 413,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return

        await self.app(scope, receive, send)


def _etag_matches(if_none_match: str, etag: str) -> bool:
    """RFC-shaped ``If-None-Match`` compare: comma list, ``*``, and a
    weak ``W/`` prefix a proxy may have added on the way out."""
    if not if_none_match:
        return False
    for candidate in if_none_match.split(","):
        cleaned = candidate.strip()
        if cleaned == "*" or cleaned == etag:
            return True
        if cleaned.startswith("W/") and cleaned[2:] == etag:
            return True
    return False


def create_brief_tabs_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["brief-tabs"])

    async def _resolve_agent_caller(
        authorization: str, x_agent_id: str
    ) -> Agent:
        if not x_agent_id:
            raise HTTPException(401, "Missing X-Agent-ID header")
        await ctx.auth.check_agent_token(x_agent_id, authorization)
        agent = Agent.get(x_agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {x_agent_id!r} not found")
        if not agent.registered_by:
            raise HTTPException(
                400, f"Agent {agent.name!r} has no owner — cannot publish tabs"
            )
        return agent

    async def _broadcast(owner_user_id: str, payload: BriefTabSyncPayload) -> None:
        envelope = ControlEnvelope(
            type=ControlMessageType.BRIEF_TAB_SYNC,
            payload=payload,
        )
        delivered = await ctx.ws_hub.send_to(owner_user_id, envelope)
        if delivered:
            logger.info(
                f"Sent BRIEF_TAB_SYNC({payload.action}) for {payload.slug!r} "
                f"to user {owner_user_id[:8]}"
            )

    @router.get("/me/brief/tabs")
    async def list_my_tabs(
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Metadata for every briefing the caller's user owns, newest
        first. Six fields per row and no ``html`` key — the desk loads
        the strip, then fetches one document when the user opens one.
        This is also what stops ``clawmeets brief list-tabs`` flooding a
        calling agent's context with full documents.

        A legacy artifact on disk is *absent* from this list, never an
        error: the loader swallows it and this route never learns it
        existed.

        Accepts user JWT (browser) OR agent bearer + ``X-Agent-ID``
        (agent CLI, e.g. so a publishing agent can check whether a peer
        already owns the slug before clobbering it). The agent path maps
        to the agent's owner.
        """
        owner_id = await ctx.auth.resolve_viewer(
            authorization, x_agent_id or None
        )
        if owner_id is None:
            raise HTTPException(401, "Authentication required")
        metas = list_metas(ctx.model_ctx.participants_dir, owner_id)
        return [m.to_wire() for m in metas]

    @router.get("/me/brief/tabs/{slug}")
    async def get_my_tab(
        slug: str,
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
        if_none_match: str = Header(default="", alias="If-None-Match"),
    ):
        """One briefing's full document.

        Order matters and is the point of the split artifact: read the
        small sidecar first, answer ``If-None-Match`` from it, and open
        the ``.html`` only on a real 200. An unchanged reload therefore
        costs one small JSON read instead of 256 KB off disk and over
        the wire.

        The ETag is the strong tag ``"<generated_at>"``. ``generated_at``
        changes on every upsert and on nothing else, which is precisely
        the freshness signal.

        Not-found and not-yours are the SAME 404: ``resolve_viewer``
        scopes the read to the caller's own user id, so user A asking
        for user B's slug reads A's directory, finds nothing, and cannot
        distinguish "B has no such briefing" from "B has one and you may
        not see it". A 403 would confirm the slug exists.
        """
        owner_id = await ctx.auth.resolve_viewer(
            authorization, x_agent_id or None
        )
        if owner_id is None:
            raise HTTPException(401, "Authentication required")
        try:
            slug_clean = validate_slug(slug)
        except ValueError as e:
            raise HTTPException(400, str(e))

        meta = get_meta(ctx.model_ctx.participants_dir, owner_id, slug_clean)
        if meta is None:
            raise HTTPException(404, f"Brief tab {slug_clean!r} not found")

        etag = f'"{meta.generated_at}"'
        headers = {"ETag": etag, "Cache-Control": _CACHE_CONTROL}
        if _etag_matches(if_none_match, etag):
            return Response(status_code=304, headers=headers)

        tab = get_tab(ctx.model_ctx.participants_dir, owner_id, slug_clean)
        if tab is None:
            raise HTTPException(404, f"Brief tab {slug_clean!r} not found")
        return JSONResponse(content=tab.model_dump(), headers=headers)

    @router.put("/me/brief/tabs/{slug}")
    async def upsert_my_tab(
        slug: str,
        title: str = Body("", embed=True),
        html: str = Body("", embed=True),
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Upsert a brief tab. Called by the publishing agent via the
        ``clawmeets brief upsert-tab`` CLI; never by the web UI.

        The cap check runs BEFORE ``upsert_tab``, and ``upsert_tab``
        writes atomically — which is the whole of AC-1.3: an over-limit
        submission cannot reach the filesystem, so the briefing already
        published is untouched by construction.

        Measures ``len(html.encode("utf-8"))`` — the author's own bytes,
        not the JSON envelope, and not the client-side height bootstrap
        (which the server neither injects nor stores). The 413 names BOTH
        numbers, because "too big" without "how big" sends a publishing
        agent into a guessing loop.

        No parsing of any kind: not a doctype check, not a ``<head>``
        check, not a tag-balance check. The server's contract is that it
        never looks inside the document. The one exception is emptiness,
        which is a presence check rather than parsing — an empty document
        is a publishing bug every time, and failing it at upload beats a
        blank frame nobody can explain.
        """
        agent = await _resolve_agent_caller(authorization, x_agent_id)
        try:
            slug_clean = validate_slug(slug)
        except ValueError as e:
            raise HTTPException(400, str(e))

        if not html.strip():
            raise HTTPException(
                400,
                "html is required — publish one complete <!doctype html> "
                "document; an empty document renders as a blank frame",
            )

        size = len(html.encode("utf-8"))
        if size > MAX_BRIEF_HTML_BYTES:
            raise HTTPException(
                413,
                f"html exceeds {MAX_BRIEF_HTML_BYTES} bytes (256 KB) — "
                f"got {size} bytes",
            )

        tab = await upsert_tab(
            ctx.model_ctx.participants_dir,
            owner_user_id=agent.registered_by,
            owner_agent_id=agent.id,
            owner_agent_name=agent.name,
            slug=slug_clean,
            title=title,
            html=html,
        )

        await _broadcast(
            agent.registered_by,
            BriefTabSyncPayload(
                action="upsert",
                slug=tab.slug,
                title=tab.title,
                generated_at=tab.generated_at,
            ),
        )
        return tab.model_dump()

    @router.delete("/me/brief/tabs/{slug}")
    async def delete_my_tab(
        slug: str,
        authorization: str = Header(default=""),
        x_agent_id: str = Header(default="", alias="X-Agent-ID"),
    ):
        """Delete a brief tab. Owner JWT, or the publishing agent's
        bearer token."""
        try:
            slug_clean = validate_slug(slug)
        except ValueError as e:
            raise HTTPException(400, str(e))

        owner_user_id: str | None = None

        # User JWT path.
        if authorization.startswith("Bearer ") and not x_agent_id:
            user = await ctx.auth.get_current_user(authorization)
            owner_user_id = user.id
        # Agent self path — only the publishing agent (by id) may delete.
        elif x_agent_id:
            agent = await _resolve_agent_caller(authorization, x_agent_id)
            # Verify the agent actually owns this tab (so foreign agents
            # can't yank another agent's tab off the user's desk). The
            # sidecar answers this — no reason to read a 256 KB document
            # off disk to compare one uuid.
            existing = get_meta(
                ctx.model_ctx.participants_dir,
                agent.registered_by,
                slug_clean,
            )
            if existing is None:
                raise HTTPException(404, f"Brief tab {slug_clean!r} not found")
            if existing.owner_agent_id != agent.id:
                raise HTTPException(
                    403,
                    "Only the publishing agent or the owning user can "
                    "delete this tab",
                )
            owner_user_id = agent.registered_by
        else:
            raise HTTPException(401, "Missing bearer token")

        existed = await delete_tab(
            ctx.model_ctx.participants_dir, owner_user_id, slug_clean
        )
        if not existed:
            raise HTTPException(404, f"Brief tab {slug_clean!r} not found")

        await _broadcast(
            owner_user_id,
            BriefTabSyncPayload(action="delete", slug=slug_clean),
        )
        return {"status": "deleted", "slug": slug_clean}

    return router
