# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/webchat.py
The web chat widget's HTTP surface: the embeddable script, the visitor's
calls and the owner's grants.

With the kill switch off (``ctx.channel_gateway is None``) every route here
answers 404. The channel itself lives in ``channels/webchat.py``.

Visitor routes (public; called cross-origin from the host page):

- ``GET /api/channels/widget.js`` — the widget.
- ``POST /api/channels/webchat/session`` — ``{key, visitor?, token?}``; a new
  visitor id and token, or the same ones back when they are still valid.
- ``POST /api/channels/webchat/messages`` — ``{key, visitor, token, id, text}``.
  ``id`` is the widget's own id for the message (a resend is a duplicate).
- ``GET /api/channels/webchat/messages?key&visitor&token&after`` — the replies
  after sequence number ``after`` (polling).
- ``GET /api/channels/webchat/stream?key&visitor&token&after`` — the same as
  server-sent events; resumes from ``Last-Event-ID``.
- ``GET /api/channels/webchat/profile?key`` — the agent's name, description,
  presence, starters and account (``server/public_profile.widget_profile``), so
  the widget can draw a chat head before anyone chats. Creates no visitor.
  ``session`` returns the same ``profile``.

They are all "simple" CORS requests (``text/plain`` bodies, no custom headers,
no cookies), so a browser sends no preflight and the server's own CORS
allowlist never has to list the owner's sites. Each answer carries
``Access-Control-Allow-Origin`` for the caller's origin only when that origin
is on the grant; every other caller is refused (403) before anything is read
or written. Checked in this order: kill switch (404) → the grant (403: unknown
or revoked key) → the origin (403) → the connection (404: removed or
disabled) → the visitor token (403).

Owner routes (``/me/channels/connections/{id}/...``, 404 for anyone else's):

- ``GET .../widget`` — the script URL, the hosted chat page's URL and whether
  it is public (some key lists this server), and every live key with its
  ready-to-paste snippet.
- ``POST .../grants`` ``{label, origins}``, ``PATCH .../grants/{grant_id}``,
  ``DELETE .../grants/{grant_id}`` (revoke: the key stops working at once).
The hosted chat page (``/users/{username}/agents/{agent}/chat``) and the
account page are served by ``routes/public_agents.py``; they run the same
widget under the key that lists this server.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from clawmeets.models.agent import Agent
from clawmeets.models.user import User
from clawmeets.server import public_profile
from clawmeets.server.channels import webchat
from clawmeets.server.channels.gateway import ChannelGateway, ConnectionSetupError, provider_gateway
from clawmeets.server.channels.store import ChannelConnection, WebchatGrant

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

WIDGET_JS = Path(__file__).resolve().parent.parent / "channels" / "webchat_widget.js"
SCRIPT_PATH = "/api/channels/widget.js"
#: A stream is closed after this long; the browser reconnects with Last-Event-ID.
STREAM_SECONDS = 300.0
STREAM_PING_SECONDS = 20.0
MAX_BODY_BYTES = 32 * 1024


class GrantBody(BaseModel):
    label: str = ""
    origins: list[str] = []


class GrantPatchBody(BaseModel):
    label: Optional[str] = None
    origins: Optional[list[str]] = None


class GrantResponse(BaseModel):
    id: str
    label: str
    #: The key itself: it is public by design (it sits in the host page's source).
    key: str
    origins: list[str]
    snippet: str
    created_at: float


class WidgetResponse(BaseModel):
    script_url: str
    chat_page_url: str
    chat_page_public: bool
    grants: list[GrantResponse]


def snippet_for(script_url: str, key: str) -> str:
    return f'<script src="{script_url}" data-key="{key}" async></script>'


def create_webchat_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["channels"])

    def _gateway() -> ChannelGateway:
        gateway = provider_gateway(ctx)
        if gateway is None or webchat.CHANNEL not in gateway.adapters:
            raise HTTPException(404, "Not Found")
        return gateway

    def _script_url(gateway: ChannelGateway) -> str:
        return f"{gateway.config.server_url}{SCRIPT_PATH}"

    def _chat_page_url(connection: ChannelConnection) -> str:
        owner = User.get(connection.owner_id, ctx.model_ctx)
        agent = Agent.get(connection.agent_id, ctx.model_ctx)
        if owner is None or agent is None:
            return ""
        return public_profile.chat_url(ctx, owner.username, agent.short_name_for(owner.username))

    # ── visitor side ─────────────────────────────────────────────────────

    def _answer(origin: Optional[str], status: int, body: dict) -> JSONResponse:
        headers = {"Vary": "Origin", "Cache-Control": "no-store"}
        if origin:
            headers["Access-Control-Allow-Origin"] = origin
        return JSONResponse(body, status_code=status, headers=headers)

    class _Refused(Exception):
        def __init__(self, status: int, error: str, origin: Optional[str] = None) -> None:
            self.status, self.error, self.origin = status, error, origin

    def _resolve(origin: Optional[str], key: str):
        """The grant and its connection for a visitor call, or :class:`_Refused`.
        The origin is echoed back only once the grant allows it."""
        gateway = provider_gateway(ctx)
        if gateway is None or webchat.CHANNEL not in gateway.adapters:
            raise _Refused(404, "off")
        grant = gateway.store.grant_by_key_hash(webchat.key_hash(key)) if key else None
        if grant is None:
            raise _Refused(403, "unknown_key")
        if not webchat.origin_allowed(grant, origin):
            raise _Refused(403, "origin_not_allowed")
        connection = gateway.store.get_connection(grant.connection_id)
        if connection is None or connection.disabled:
            raise _Refused(404, "off", origin)
        return gateway, grant, connection

    def _check_visitor(gateway, grant, connection, origin, visitor: str, token: str) -> None:
        if not webchat.check_visitor(gateway.webchat_signing_key(connection), grant.id,
                                     visitor, token):
            raise _Refused(403, "bad_visitor", origin)

    async def _json_body(request: Request) -> dict:
        body = await request.body()
        if len(body) > MAX_BODY_BYTES:
            raise _Refused(413, "too_large")
        try:
            data = json.loads(body)
        except ValueError:
            raise _Refused(400, "not_json") from None
        if not isinstance(data, dict):
            raise _Refused(400, "not_json")
        return data

    def _str(data: dict, name: str) -> str:
        value = data.get(name, "")
        return value if isinstance(value, str) else ""

    @router.get(SCRIPT_PATH, include_in_schema=False)
    async def widget_js():
        _gateway()
        return Response(
            WIDGET_JS.read_bytes(), media_type="application/javascript; charset=utf-8",
            headers={"Cache-Control": "public, max-age=300",
                     "X-Content-Type-Options": "nosniff"},
        )

    @router.post("/api/channels/webchat/session", include_in_schema=False)
    async def session(request: Request):
        origin = request.headers.get("origin")
        try:
            data = await _json_body(request)
            gateway, grant, connection = _resolve(origin, _str(data, "key"))
            visitor, token = _str(data, "visitor"), _str(data, "token")
            signing_key = gateway.webchat_signing_key(connection)
            if not webchat.check_visitor(signing_key, grant.id, visitor, token):
                visitor = webchat.new_visitor_id()
                token = webchat.visitor_token(signing_key, grant.id, visitor)
        except _Refused as exc:
            return _answer(exc.origin, exc.status, {"error": exc.error})
        except ConnectionSetupError:
            return _answer(origin, 503, {"error": "unavailable"})
        profile = public_profile.widget_profile(ctx, connection)
        return _answer(origin, 200, {
            "visitor": visitor, "token": token,
            "title": profile["display_name"] if profile else "Chat",
            "max_chars": webchat.MAX_TEXT_CHARS, "profile": profile,
        })

    @router.get("/api/channels/webchat/profile", include_in_schema=False)
    async def profile(request: Request):
        origin = request.headers.get("origin")
        gateway = provider_gateway(ctx)
        if not origin and gateway is not None:
            origin = gateway.server_origin()  # same-origin GET: see _visitor_query
        try:
            _, _, connection = _resolve(origin, request.query_params.get("key", ""))
        except _Refused as exc:
            return _answer(exc.origin, exc.status, {"error": exc.error})
        body = public_profile.widget_profile(ctx, connection)
        if body is None:
            return _answer(origin, 404, {"error": "off"})
        return _answer(origin, 200, {"profile": body, "max_chars": webchat.MAX_TEXT_CHARS})

    @router.post("/api/channels/webchat/messages", include_in_schema=False)
    async def post_message(request: Request):
        origin = request.headers.get("origin")
        try:
            data = await _json_body(request)
            gateway, grant, connection = _resolve(origin, _str(data, "key"))
            visitor, token = _str(data, "visitor"), _str(data, "token")
            _check_visitor(gateway, grant, connection, origin, visitor, token)
            text, client_id = _str(data, "text"), _str(data, "id")
            if not webchat.valid_client_id(client_id) or not text.strip():
                raise _Refused(400, "bad_message", origin)
            if len(text) > webchat.MAX_TEXT_CHARS:
                raise _Refused(413, "too_long", origin)
        except _Refused as exc:
            return _answer(exc.origin, exc.status, {"error": exc.error})
        except ConnectionSetupError:
            return _answer(origin, 503, {"error": "unavailable"})
        # The gateway gets a body built here, never the visitor's bytes.
        canonical = json.dumps({
            "key": _str(data, "key"), "visitor": visitor, "token": token,
            "id": client_id, "text": text, "origin": webchat.normalize_origin(origin),
        }).encode("utf-8")
        status = await gateway.handle_webhook(
            webchat.CHANNEL, connection.id, request.headers, canonical,
        )
        if status != 200:
            return _answer(origin, status, {"error": "refused"})
        return _answer(origin, 200, {"ok": True})

    def _visitor_query(request: Request):
        # A browser sends no Origin on a same-origin GET (the hosted pages'
        # poll, EventSource and profile read). A caller that omits it is therefore either this
        # server's own page or not a browser — and a non-browser can send any
        # Origin anyway — so it counts as this server's origin: only the
        # keys that list this server accept it, and the visitor token is still
        # required where one is.
        origin = request.headers.get("origin")
        gateway = provider_gateway(ctx)
        if not origin and gateway is not None:
            origin = gateway.server_origin()
        q = request.query_params
        gateway, grant, connection = _resolve(origin, q.get("key", ""))
        visitor = q.get("visitor", "")
        _check_visitor(gateway, grant, connection, origin, visitor, q.get("token", ""))
        after = request.headers.get("last-event-id") or q.get("after") or "0"
        try:
            after_seq = max(0, int(after))
        except ValueError:
            after_seq = 0
        return origin, gateway, connection, visitor, after_seq

    def _wire(message) -> dict:
        return {"seq": message.seq, "text": message.text, "at": message.created_at}

    @router.get("/api/channels/webchat/messages", include_in_schema=False)
    async def poll_messages(request: Request):
        try:
            origin, gateway, connection, visitor, after = _visitor_query(request)
        except _Refused as exc:
            return _answer(exc.origin, exc.status, {"error": exc.error})
        except ConnectionSetupError:
            return _answer(request.headers.get("origin"), 503, {"error": "unavailable"})
        rows = gateway.store.webchat_since(connection.id, visitor, after)
        return _answer(origin, 200, {"messages": [_wire(m) for m in rows]})

    @router.get("/api/channels/webchat/stream", include_in_schema=False)
    async def stream(request: Request):
        try:
            origin, gateway, connection, visitor, after = _visitor_query(request)
        except _Refused as exc:
            return _answer(exc.origin, exc.status, {"error": exc.error})
        except ConnectionSetupError:
            return _answer(request.headers.get("origin"), 503, {"error": "unavailable"})
        adapter = gateway.adapters[webchat.CHANNEL]
        clock = asyncio.get_running_loop().time

        async def events():
            cursor = after
            deadline = clock() + STREAM_SECONDS
            yield "retry: 3000\n\n"
            while clock() < deadline:
                rows = gateway.store.webchat_since(connection.id, visitor, cursor)
                for message in rows:
                    cursor = message.seq
                    yield f"id: {message.seq}\ndata: {json.dumps(_wire(message))}\n\n"
                if rows:
                    continue
                if await request.is_disconnected():
                    return
                await adapter.wait(connection.id, visitor, STREAM_PING_SECONDS)
                yield ": ping\n\n"

        headers = {
            "Cache-Control": "no-store", "X-Accel-Buffering": "no", "Vary": "Origin",
        }
        if origin:
            headers["Access-Control-Allow-Origin"] = origin
        return StreamingResponse(events(), media_type="text/event-stream", headers=headers)

    # ── owner side ───────────────────────────────────────────────────────

    async def _owned_widget(connection_id: str, authorization: str):
        gateway = _gateway()
        user = await ctx.auth.resolve_user_from_credential(authorization)
        connection = gateway.store.get_connection(connection_id)
        if (connection is None or connection.owner_id != user.id
                or connection.channel != webchat.CHANNEL):
            raise HTTPException(404, "Connection not found")
        return gateway, connection

    def _owned_grant(gateway: ChannelGateway, connection: ChannelConnection,
                     grant_id: str) -> WebchatGrant:
        grant = gateway.store.get_grant(grant_id)
        if grant is None or grant.connection_id != connection.id or grant.revoked_at is not None:
            raise HTTPException(404, "Key not found")
        return grant

    def _grant_view(gateway: ChannelGateway, grant: WebchatGrant) -> GrantResponse:
        key = gateway.grant_key(grant)
        return GrantResponse(
            id=grant.id, label=grant.label, key=key, origins=list(grant.origins),
            snippet=snippet_for(_script_url(gateway), key), created_at=grant.created_at,
        )

    def _clean(body_label: Optional[str], body_origins: Optional[list[str]]):
        label = None if body_label is None else body_label.strip()[:webchat.MAX_LABEL_CHARS]
        origins = None
        if body_origins is not None:
            try:
                origins = webchat.normalize_origins(body_origins)
            except webchat.OriginError as exc:
                raise HTTPException(400, str(exc)) from None
        return label, origins

    def _with_errors(fn):
        try:
            return fn()
        except ConnectionSetupError as exc:
            raise HTTPException(exc.status, exc.reason) from None

    @router.get("/me/channels/connections/{connection_id}/widget", response_model=WidgetResponse)
    async def get_widget(connection_id: str, authorization: str = Header(default="")):
        gateway, connection = await _owned_widget(connection_id, authorization)
        grants = gateway.store.list_grants(connection.id)
        return WidgetResponse(
            script_url=_script_url(gateway),
            chat_page_url=_chat_page_url(connection),
            chat_page_public=gateway.hosted_grant(connection) is not None,
            grants=_with_errors(lambda: [_grant_view(gateway, g) for g in grants]),
        )

    @router.post("/me/channels/connections/{connection_id}/grants", response_model=GrantResponse)
    async def create_grant(connection_id: str, body: GrantBody,
                           authorization: str = Header(default="")):
        gateway, connection = await _owned_widget(connection_id, authorization)
        label, origins = _clean(body.label, body.origins)
        if not origins:
            raise HTTPException(400, "Add at least one site, e.g. https://acme.com")
        grant = gateway.create_grant(connection, label=label or "", origins=origins)
        return _with_errors(lambda: _grant_view(gateway, grant))

    @router.patch("/me/channels/connections/{connection_id}/grants/{grant_id}",
                  response_model=GrantResponse)
    async def update_grant(connection_id: str, grant_id: str, body: GrantPatchBody,
                           authorization: str = Header(default="")):
        gateway, connection = await _owned_widget(connection_id, authorization)
        grant = _owned_grant(gateway, connection, grant_id)
        label, origins = _clean(body.label, body.origins)
        if origins is not None and not origins:
            raise HTTPException(400, "Add at least one site, or revoke the key instead")
        updated = gateway.store.update_grant(grant.id, label=label, origins=origins)
        return _with_errors(lambda: _grant_view(gateway, updated))

    @router.delete("/me/channels/connections/{connection_id}/grants/{grant_id}")
    async def revoke_grant(connection_id: str, grant_id: str,
                           authorization: str = Header(default="")):
        gateway, connection = await _owned_widget(connection_id, authorization)
        grant = _owned_grant(gateway, connection, grant_id)
        gateway.store.revoke_grant(grant.id, now=gateway.options.clock())
        return {"revoked": grant.id}

    return router


