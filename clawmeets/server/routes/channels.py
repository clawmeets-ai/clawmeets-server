# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/channels.py
Channel gateway HTTP surface: provider webhooks and the owner's controls.

With the kill switch off (``ctx.channel_gateway is None``) every route here
answers 404 — the webhook before it reads the body or checks a signature, so
nothing is recorded.

- ``POST /api/channels/webhooks/{channel}/{connection_id}`` — provider calls.
- ``GET /api/channels/webhooks/{channel}/{connection_id}`` — the provider's
  check of the callback URL (WhatsApp: ``hub.mode=subscribe``,
  ``hub.verify_token``, ``hub.challenge``). Kill switch (404) first, then the
  connection (404; also for a channel with no such check), the credential
  (503), disabled (403), the verify token and mode (403), the challenge's shape
  (400, at most 64 of ``[0-9A-Za-z_-]``). 200 answers the challenge alone as
  ``text/plain``. The parameters are read from the raw query string, never
  declared, so a missing one can never produce a 422 that echoes the request.
- ``GET /api/channels/webhooks/file?t=<token>`` — a file the agent shared
  with an outside contact, behind its signed link (``channels/file_links``).
- ``POST /api/channels/webhooks/email`` — SendGrid Inbound Parse, one URL for
  the server. Checked in this order: kill switch (404) → the basic-auth secret
  (401, before a byte of the body is read) → ``Content-Length`` over the email
  limit (413) → the body, streamed and counted (413 past 40 MiB whatever was
  declared) → recipients. A body that can't be read, or hits a parse limit, is
  answered 200 and dropped: SendGrid retries anything else for three days.
- ``POST /me/channels/connections`` / ``GET`` — connect one of your agents to
  a channel; the credential is returned only as its last four characters (a
  derived webhook secret is never returned at all). For Telegram the token is
  checked with ``getMe`` before anything is stored, a bot already connected
  anywhere is 409, and the webhook is registered.
  For LINE the body carries two secrets, ``channel_secret`` (checks webhook
  signatures; never returned, not even partly) and ``access_token`` (sends;
  its last four are shown); the bot is looked up with ``GET /v2/bot/info``
  and the webhook URL is set with LINE. LINE connections also carry
  ``ack_text`` (``PUT .../{id}/ack-text``), the push counter (``push_used``,
  ``push_limit``, ``push_as_of`` — fetched again as the page loads when the
  last attempt is older than 15 minutes, giving up after 3 s; and
  ``push_limit_reached``, LINE's own monthly-limit answer this month) and
  ``unverified_calls`` (stops at 1000).
  For WhatsApp the body carries ``phone_number_id`` (shown in full: an
  identifier), ``access_token`` (sends; last four shown), ``app_secret``
  (checks webhook signatures; never returned, not even partly) and
  ``verify_token`` (answers Meta's subscription check; last four shown as
  ``verify_token_last4``). WhatsApp connections also carry ``handshake_ok_at``
  and ``held_window_7d`` (replies held in the last 7 days because the 24-hour
  window had closed).
- ``POST .../{id}/test`` — ask the provider and store the health status;
  ``POST .../{id}/disable`` / ``enable`` / ``reconnect``; ``DELETE .../{id}``
  removes the connection (its threads stay as history).
- ``PUT /me/channels/threads/{project_id}/pause`` — take over a conversation
  (the agent stops being triggered; your own messages still go out).
- ``GET /me/channels/threads/{project_id}`` — the thread's channel, pause
  state, and (WhatsApp) whether the 24-hour window has closed since the
  contact last wrote, with the text of each reply held because of it.
- ``GET /me/channels/threads/{project_id}/outbox`` — delivery status of every
  outbound message, including the ones that were never delivered and why.

Access control, per connection (``/me/channels/connections/{id}/...``):

- ``PUT .../mode`` — ``allowlist`` (the default) or ``anyone``. While the mode
  is ``anyone`` the connection carries ``warning: strangers_reach_full_tools``.
- ``PUT .../fixed-reply`` — the text a waiting sender gets once; empty sends
  nothing.
- ``GET|POST .../allowlist``, ``DELETE .../allowlist/{entry_id}``.
- ``GET .../requests`` — unknown senders waiting (and decided ones);
  ``POST .../requests/{id}/allow``, ``POST .../requests/{id}/block``,
  ``DELETE .../requests/{id}/block`` (unblock).

Every one of them answers 404 for a connection that is not the caller's, the
same as for one that does not exist.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Optional
from urllib.parse import parse_qsl, quote


from fastapi import APIRouter, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import AliasChoices, BaseModel, Field, SecretStr, ValidationError, model_serializer

from clawmeets.models.agent import Agent
from clawmeets.models.project import Project
from clawmeets.models.chatroom import Chatroom
from clawmeets.server.channels import access, file_links
from clawmeets.server.channels.gateway import (
    EMAIL_CHANNEL,
    MAX_WEBHOOK_BODY_BYTES,
    ChannelGateway,
    ConnectionSetupError,
    connection_status,
    provider_gateway,
)
from clawmeets.server.channels.email_adapter import check_basic_auth
from clawmeets.server.channels.email_form import (
    MAX_EMAIL_BODY_BYTES,
    FormInvalid,
    FormLimit,
    FormTooLarge,
    read_inbound_form,
)
from clawmeets.server.channels.log_redaction import WEBHOOK_PATH_PREFIX
from clawmeets.server.hub.browser import HubError
from clawmeets.server.hub.views import contact_fields, key_last4, listed_as
from clawmeets.utils.file_io import FileUtil
from clawmeets.server.channels.store import (
    HELD_WINDOW,
    HUB_CHANNEL,
    REQUEST_ALLOWED,
    REQUEST_ALLOWING,
    REQUEST_BLOCKED,
    WAITING_STATES,
    AllowEntry,
    ChannelConnection,
    ChannelRequest,
)

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext


#: The Channels page counts replies held for a closed window over this long.
HELD_WINDOW_COUNT_SECONDS = 7 * 24 * 3600

#: A fixed reply is one short message: well under every provider's limit
#: (Telegram's is 4096), so it always goes out as a single part.
MAX_FIXED_REPLY_CHARS = 1000


class ConnectionCreateBody(BaseModel):
    agent_name: str
    channel: str
    #: The credential (Telegram: the bot token; none for email, which sends
    #: with the server's key). ``SecretStr``, and the body is validated by hand
    #: so a 422 never echoes it back (FastAPI's own 422 carries each failing
    #: field's input — for a missing field, the whole body).
    secret: SecretStr = Field(
        default=SecretStr(""), validation_alias=AliasChoices("secret", "token", "access_token"),
    )
    #: LINE's second secret: the channel secret that signs its webhooks (the
    #: access token goes in ``secret`` / ``access_token``). Never returned.
    channel_secret: SecretStr = SecretStr("")
    #: WhatsApp: the Meta app secret that signs webhooks (never returned), the
    #: verify token the owner chose for Meta's subscription check (last four
    #: shown), and the phone number id (an identifier, shown in full).
    app_secret: SecretStr = SecretStr("")
    verify_token: SecretStr = SecretStr("")
    phone_number_id: str = ""
    label: str = ""


class ConnectionResponse(BaseModel):
    id: str
    agent_id: str
    channel: str
    label: str
    secret_last4: str
    webhook_url: str
    mode: str                       # allowlist | anyone
    fixed_reply: str
    #: ``strangers_reach_full_tools`` while the mode is "anyone", else None.
    warning: Optional[str] = None
    #: The provider account, e.g. the bot's ``@username``.
    account_name: str = ""
    disabled: bool = False
    #: working | token_rejected | webhook_missing | webhook_error |
    #: pending_updates | disabled | key_rotation_pending, or None before any
    #: check. ``status_detail`` is the provider's own text (render as text).
    status: Optional[str] = None
    status_detail: Optional[str] = None
    #: pending_updates: the count; webhook_error: when it happened (epoch s).
    status_count: Optional[int] = None
    status_at: Optional[float] = None
    #: When the provider last delivered a message (email: "last mail received").
    last_inbound_at: Optional[float] = None
    #: LINE: the "got it" sent on the reply token ("" = none). None elsewhere.
    ack_text: Optional[str] = None
    #: LINE: push messages used this quota month (the provider's figure at the
    #: last fetch plus pushes sent since), the monthly limit (None when none
    #: is set or never fetched), and when the figures were fetched (None:
    #: never). All None for channels without a push quota.
    push_used: Optional[int] = None
    push_limit: Optional[int] = None
    push_as_of: Optional[float] = None
    #: Webhook calls that failed the signature check since the last one that
    #: passed (LINE: a mistyped channel secret shows here).
    unverified_calls: int = 0
    #: LINE answered a push with its monthly limit this quota month (shown as
    #: reached whatever the figures or the health status say).
    push_limit_reached: bool = False
    #: WhatsApp: the phone number id (in full), the verify token's last four,
    #: when Meta's subscription check last succeeded, and how many replies
    #: were held in the last 7 days because the 24-hour window had closed.
    #: None for other channels.
    phone_number_id: Optional[str] = None
    verify_token_last4: Optional[str] = None
    handshake_ok_at: Optional[float] = None
    held_window_7d: Optional[int] = None
    #: Email: automatic mail (bounces, no-reply senders, provider notices,
    #: lists) dropped because its sender has no conversation with the agent
    #: (capped at 1,000), and the last one's time, sender domain and signal
    #: (``email_mail.AUTO_*``). None for other channels.
    automatic_dropped: Optional[int] = None
    automatic_dropped_at: Optional[float] = None
    automatic_dropped_domain: Optional[str] = None
    automatic_dropped_reason: Optional[str] = None
    #: "sandboxed" when the agent's currently connected runners can run an
    #: isolated (requester-scoped) turn, else "unavailable": this channel's
    #: conversations are then held, never run unprotected.
    isolation: str = "unavailable"
    #: Conversations of this channel waiting for a capable runner.
    held_conversations: int = 0


class ModeBody(BaseModel):
    mode: str


class FixedReplyBody(BaseModel):
    text: str


class AckTextBody(BaseModel):
    text: str


class EntryBody(BaseModel):
    value: str


class EntryResponse(BaseModel):
    id: str
    kind: str                       # user_id | username | phone | email | domain
    value: str
    #: For an @username entry: the stable sender id it is pinned to, once a
    #: sender has matched it (so a takeover attempt is explainable).
    pinned_to: Optional[str] = None


class _HubContactWhenSet(BaseModel):
    """The Hub sender fields, left out of the JSON on every other channel's
    rows (their shape is unchanged). ``via_agent``: which of the person's own
    agents sent their newest message ("sent by their agent X"), plain text."""

    remote_username: Optional[str] = None
    deployment_name: Optional[str] = None
    deployment_fingerprint: Optional[str] = None
    via_agent: Optional[str] = None

    @model_serializer(mode="wrap")
    def _hub_fields_only_when_hub(self, handler):
        data = handler(self)
        if data.get("deployment_fingerprint") is None:
            for name in ("remote_username", "deployment_name", "deployment_fingerprint", "via_agent"):
                data.pop(name, None)
        return data


class RequestResponse(_HubContactWhenSet):
    id: str
    state: str                      # pending | allowing | allowed | blocked
    display_name: str               # cleaned
    user_key: str                   # the provider's id (phone, address, numeric id); owner only
    handle: Optional[str]
    #: Plain text, exactly as sent (cut at 8 KB). Render it as text, never as markup.
    first_message: str
    held_count: int
    dropped_count: int              # messages past the cap, not kept
    unverified_count: int           # held messages whose sender check did not pass
    #: The fixed reply's delivery: None (none was sent), pending, sending,
    #: sent, failed or expired.
    fixed_reply_state: Optional[str]
    allowed_by: Optional[str]       # owner | entry | anyone
    project_ids: list[str] = []     # the thread(s) an Allow wrote into
    created_at: float
    # A Hub request's sender, as separate fields (_HubContactWhenSet): the
    # username, its deployment's name (null until known) and GENESIS fingerprint.


class PauseBody(BaseModel):
    paused: bool


class ThreadResponse(BaseModel):
    project_id: str
    paused: bool


class HeldReplyResponse(BaseModel):
    message_id: str
    part_index: int
    #: The text that was not sent. Render it as text, never as markup.
    text: str
    reason: str             # window_closed | window_closed_maybe_sent
    held_at: float


class ThreadStatusResponse(BaseModel):
    project_id: str
    channel: str
    paused: bool
    #: The contact's display name (cleaned). Render as text.
    contact_name: str
    #: WhatsApp: when a reply was first held because the 24-hour window had
    #: closed, since the contact last wrote; None while nothing is held. The
    #: contact's next message clears it (the held replies stay in the outbox).
    window_closed_at: Optional[float] = None
    held: list[HeldReplyResponse] = []


class ThreadListItem(_HubContactWhenSet):
    """One of the caller's channel threads, for the Front Desk sidebar (tabs,
    badge, contact grouping). Mirrored by ``ChannelThreadRow`` in
    ``web/frontend/src/api/endpoints/channels.ts``.

    No provider identifier, ever: ``contact_id`` is the opaque ``contacts.id``
    (not the chat id, address, LINE id or phone number). A thread whose
    connection was removed comes from its history record: no connection, no
    contact id, the contact's name as it was at removal, never paused.
    """

    project_id: str
    channel: str
    connection_id: Optional[str]
    connection_enabled: bool
    connection_removed: bool
    contact_id: Optional[str]
    #: The contact's display name (cleaned on arrival). Render as text.
    contact_name: str
    paused: bool
    # A Hub thread's contact, as separate fields (_HubContactWhenSet).


class OutboxItemResponse(BaseModel):
    message_id: str
    part_index: int
    # pending | sending | sent | failed | expired | held_paused (an agent reply
    # found while the thread was paused: never sent, not even after un-pausing)
    # | held_window (WhatsApp: the 24-hour window had closed; never sent)
    # | waiting (a hub row: parked for its target or hub, or forwarded and
    # awaiting the receipt; ``reason`` says which wait while parked)
    state: str
    # e.g. expired_never_sent, expired_maybe_sent, thread_deleted, paused,
    # channel_disabled ("Not sent: the Hub channel was turned off")
    reason: Optional[str]
    attempts: int
    #: The text, for a ``held_window`` row only (the owner sees what wasn't sent).
    text: Optional[str] = None
    #: The provider's own words for the last failure (bounded and redacted by
    #: the adapter); None when it said nothing. Render as text.
    detail: Optional[str] = None


def _webhook_answer(status: int) -> JSONResponse:
    """A webhook answer: the status, with an empty JSON body. Providers read
    only the status; the body tells the replay harness (and an operator with
    curl) that the APP answered, not nginx."""
    return JSONResponse({}, status_code=status)


def create_channels_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["channels"])

    def _gateway() -> ChannelGateway:
        gateway = provider_gateway(ctx)     # None also on a hub-only gateway
        if gateway is None:
            raise HTTPException(404, "Not Found")
        return gateway

    def _owner_gateway() -> ChannelGateway:
        """For the owner's routes: the gateway also when it is hub-only, where
        only Hub rows are served (everything else 404s exactly as before)."""
        gateway = ctx.channel_gateway
        if gateway is None:
            raise HTTPException(404, "Not Found")
        return gateway

    def _serves(gateway: ChannelGateway, channel: str) -> bool:
        return gateway.config.providers_enabled or channel == HUB_CHANNEL

    def _hub_view(gateway: ChannelGateway, connection: ChannelConnection) -> ConnectionResponse:
        """An agent's Hub row: listed_as for its label, the key's fingerprint
        tail (never the key's own characters), no webhook."""
        state = gateway.hub.channel_state(connection.agent_id)
        runtime = ctx.hub_runtime
        reg = runtime.registration() if runtime is not None else None
        agent = Agent.get(connection.agent_id, ctx.model_ctx)
        listed = listed_as(agent.name, reg) if agent is not None else None
        return ConnectionResponse(
            id=connection.id, agent_id=connection.agent_id, channel=connection.channel,
            label=listed or (agent.name if agent is not None else connection.label),
            secret_last4=key_last4(state.cert if state is not None else None) or "",
            webhook_url="", mode=connection.mode, fixed_reply=connection.fixed_reply,
            warning=access.WARNING_ANYONE if connection.mode == access.MODE_ANYONE else None,
            account_name=listed or "", disabled=not (state is not None and state.enabled),
            status=state.status if state is not None else None,
            status_detail=state.status_detail if state is not None else None,
            last_inbound_at=connection.last_inbound_at,
            **_isolation_fields(connection),
        )

    def _isolation_fields(connection: ChannelConnection) -> dict:
        gate = getattr(ctx, "isolation_gate", None)
        if gate is None:
            return {}
        prefix = f"channel:{connection.id}/"
        held = 0
        for project_id, _ in gate.held.held_for(connection.agent_id):
            try:
                project = Project.get(project_id, ctx.model_ctx)
            except ValueError:
                continue
            if (project.requester_key or "").startswith(prefix):
                held += 1
        return {
            "isolation": "sandboxed" if gate.agent_capable(connection.agent_id) else "unavailable",
            "held_conversations": held,
        }

    def _refuse_hub_row(connection: ChannelConnection) -> None:
        if connection.channel == HUB_CHANNEL:
            raise HubError("use_hub_routes", "use the Hub channel's own routes")

    def _view(gateway: ChannelGateway, connection: ChannelConnection) -> ConnectionResponse:
        if connection.channel == HUB_CHANNEL:
            return _hub_view(gateway, connection)
        adapter = gateway.adapters.get(connection.channel)
        acknowledges = hasattr(adapter, "acknowledge")
        windowed = getattr(adapter, "customer_service_window_seconds", None) is not None
        is_email = connection.channel == EMAIL_CHANNEL
        extras = gateway.store.extras(connection.id)
        usage = gateway.push_usage(connection)
        used, limit, as_of = usage if usage is not None else (None, None, None)
        return ConnectionResponse(
            **_isolation_fields(connection),
            id=connection.id,
            agent_id=connection.agent_id,
            channel=connection.channel,
            label=connection.label,
            secret_last4=connection.secret_last4,
            webhook_url=gateway.webhook_url(connection),
            mode=connection.mode,
            fixed_reply=connection.fixed_reply,
            warning=access.WARNING_ANYONE if connection.mode == access.MODE_ANYONE else None,
            account_name=connection.account_name,
            disabled=connection.disabled,
            status=connection_status(connection),
            status_detail=connection.status_detail,
            status_count=connection.status_count,
            status_at=connection.status_at,
            last_inbound_at=connection.last_inbound_at,
            ack_text=extras.ack_text if acknowledges else None,
            push_used=used,
            push_limit=limit,
            push_as_of=as_of,
            unverified_calls=extras.unverified_calls,
            push_limit_reached=gateway.quota_exhausted(connection),
            phone_number_id=connection.external_id if windowed else None,
            verify_token_last4=(extras.verify_token_last4 or "") if windowed else None,
            handshake_ok_at=extras.handshake_ok_at if windowed else None,
            held_window_7d=gateway.store.held_window_count(
                connection.id, since=gateway.options.clock() - HELD_WINDOW_COUNT_SECONDS,
            ) if windowed else None,
            automatic_dropped=extras.automatic_dropped if is_email else None,
            automatic_dropped_at=extras.automatic_dropped_at if is_email else None,
            automatic_dropped_domain=extras.automatic_dropped_domain if is_email else None,
            automatic_dropped_reason=extras.automatic_dropped_reason if is_email else None,
        )

    async def _owned_connection(connection_id: str, authorization: str):
        """The caller's own connection, or 404 (another user's looks missing;
        so does a non-Hub one on a hub-only server)."""
        gateway = _owner_gateway()
        user = await ctx.auth.resolve_user_from_credential(authorization)
        connection = gateway.store.get_connection(connection_id)
        if connection is None or connection.owner_id != user.id or not _serves(gateway, connection.channel):
            raise HTTPException(404, "Connection not found")
        return gateway, connection

    def _owned_request(gateway: ChannelGateway, connection: ChannelConnection,
                       request_id: str) -> ChannelRequest:
        request = gateway.store.get_request(request_id)
        if request is None or request.connection_id != connection.id:
            raise HTTPException(404, "Request not found")
        return request

    def _hub_contact(gateway: ChannelGateway, connection_id: Optional[str], user_key: Optional[str],
                     name: Optional[str]) -> dict:
        connection = gateway.store.get_connection(connection_id) if connection_id else None
        if connection is None or connection.channel != HUB_CHANNEL:
            return {}
        return contact_fields(gateway.hub, user_key, name, connection_id).model_dump()

    def _entry_view(entry: AllowEntry) -> EntryResponse:
        return EntryResponse(
            id=entry.id, kind=entry.kind, value=entry.value, pinned_to=entry.pinned_user_key,
        )

    def _request_view(gateway: ChannelGateway, request: ChannelRequest) -> RequestResponse:
        reply = (
            gateway.store.get_outbox_row(request.fixed_reply_outbox_id)
            if request.fixed_reply_outbox_id else None
        )
        project_ids = []
        if request.state == REQUEST_ALLOWED:
            for item in request.allow_plan:
                thread = gateway.store.get_thread(request.connection_id, item.conversation_key)
                if thread is not None:
                    project_ids.append(thread.project_id)
        return RequestResponse(
            id=request.id, state=request.state, display_name=request.display_name,
            user_key=request.user_key, handle=request.handle,
            first_message=request.first_text, held_count=request.held_count,
            dropped_count=request.dropped_count, unverified_count=request.unverified_count,
            fixed_reply_state=reply.state if reply else None,
            allowed_by=request.allowed_by, project_ids=project_ids,
            created_at=request.created_at,
            **_hub_contact(gateway, request.connection_id, request.user_key, request.display_name),
        )

    @router.post(WEBHOOK_PATH_PREFIX + "/email", include_in_schema=False)
    async def email_webhook(request: Request):
        gateway = _gateway()  # before the body is read
        if "email" not in gateway.adapters:
            return _webhook_answer(404)
        if not check_basic_auth(
            request.headers.get("authorization"), gateway.config.sendgrid_inbound_secret,
        ):
            return _webhook_answer(401)
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_EMAIL_BODY_BYTES:
            return _webhook_answer(413)
        try:
            form = await read_inbound_form(request.headers.get("content-type"), request.stream())
        except FormTooLarge:
            return _webhook_answer(413)
        except (FormInvalid, FormLimit) as exc:
            # The type only: python-multipart's messages can quote header bytes.
            logger.error("Channel email: dropped an Inbound Parse POST: %s", type(exc).__name__)
            return _webhook_answer(200)
        status = await gateway.handle_email(form)
        return _webhook_answer(status)

    @router.post(WEBHOOK_PATH_PREFIX + "/{channel}/{connection_id}", include_in_schema=False)
    async def channel_webhook(channel: str, connection_id: str, request: Request):
        gateway = _gateway()  # before the body is read
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_WEBHOOK_BODY_BYTES:
            return _webhook_answer(413)
        body = await request.body()
        if len(body) > MAX_WEBHOOK_BODY_BYTES:
            return _webhook_answer(413)
        status = await gateway.handle_webhook(channel, connection_id, request.headers, body)
        return _webhook_answer(status)

    @router.get(file_links.FILE_LINK_PATH, include_in_schema=False)
    async def channel_file(t: str = ""):
        """A file the agent shared with an outside contact, behind the signed
        link it was sent as (``file_links``). Every refusal is a bare 404 but a
        file changed since the link was made (410). Always a download, never
        rendered on this origin. Served by a hub-only gateway too, for the
        hub threads' links (``read_file_link`` refuses any other thread)."""
        gateway = ctx.channel_gateway
        link = gateway.read_file_link(t) if gateway is not None else None
        if link is None:
            raise HTTPException(404, "Not Found")
        room = Chatroom.get(link.project_id, link.chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, "Not Found")
        files_dir = room.files_dir.resolve()
        path = (files_dir / link.filename).resolve()
        if not path.is_relative_to(files_dir):
            raise HTTPException(404, "Not Found")
        content = room.get_file(link.filename)
        if content is None:
            raise HTTPException(404, "Not Found")
        if not link.matches(FileUtil.sha256(content)):
            raise HTTPException(410, "This file has changed since the link was sent")
        name = link.filename.rsplit("/", 1)[-1]
        return Response(
            content=content, media_type="application/octet-stream",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(name, safe='')}",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox; default-src 'none'",
                "Cache-Control": "private, no-store",
                "Referrer-Policy": "no-referrer",
            },
        )

    @router.get(WEBHOOK_PATH_PREFIX + "/{channel}/{connection_id}", include_in_schema=False)
    async def channel_subscription(channel: str, connection_id: str, request: Request):
        """The provider's GET check of the callback URL. The query string is
        parsed here, keeping every value of a repeated parameter."""
        gateway = _gateway()
        query: dict[str, list[str]] = {}
        for name, value in parse_qsl(request.url.query, keep_blank_values=True):
            query.setdefault(name, []).append(value)
        status, challenge = await gateway.handle_subscription(channel, connection_id, query)
        if status != 200 or challenge is None:
            return _webhook_answer(status)
        return PlainTextResponse(
            challenge, status_code=200, headers={"X-Content-Type-Options": "nosniff"},
        )

    @router.post("/me/channels/connections", response_model=ConnectionResponse)
    async def create_connection(request: Request, authorization: str = Header(default="")):
        gateway = _owner_gateway()
        user = await ctx.auth.resolve_user_from_credential(authorization)
        try:
            body = ConnectionCreateBody.model_validate(await request.json())
        except (ValidationError, ValueError) as exc:
            if not gateway.config.providers_enabled:
                raise HTTPException(404, "Not Found") from None     # a hub-only server, as before
            # Field names and messages only — never the input (it holds the token).
            errors = exc.errors(include_input=False, include_url=False, include_context=False) \
                if isinstance(exc, ValidationError) else [{"msg": "body is not JSON"}]
            return JSONResponse({"detail": errors}, status_code=422)
        if body.channel == HUB_CHANNEL:
            raise HubError("use_hub_routes", "a Hub channel is turned on from its own route")
        gateway = _gateway()
        # The caller's own ``{username}-{name}`` first: another user may own an
        # agent whose full name is exactly the short name typed here.
        agent = Agent.get_by_name(
            f"{user.username}-{body.agent_name}", ctx.model_ctx,
        ) or Agent.get_by_name(body.agent_name, ctx.model_ctx)
        if agent is None or agent.registered_by != user.id:
            raise HTTPException(404, "Agent not found")
        try:
            connection = await gateway.connect(
                agent_id=agent.id, owner_id=user.id, channel=body.channel,
                label=body.label, secret=body.secret, owner_username=user.username,
                agent_short_name=agent.short_name_for(user.username),
                credentials={
                    "channel_secret": body.channel_secret, "app_secret": body.app_secret,
                    "verify_token": body.verify_token,
                    "phone_number_id": SecretStr(body.phone_number_id),
                },
            )
        except ConnectionSetupError as exc:
            raise HTTPException(exc.status, exc.reason) from None
        return _view(gateway, connection)

    @router.get("/me/channels/connections", response_model=list[ConnectionResponse])
    async def list_connections(authorization: str = Header(default="")):
        gateway = _owner_gateway()
        user = await ctx.auth.resolve_user_from_credential(authorization)
        connections = [c for c in gateway.store.list_connections(user.id) if _serves(gateway, c.channel)]
        await asyncio.gather(*(gateway.refresh_quota_if_stale(c) for c in connections))
        return [_view(gateway, gateway.store.get_connection(c.id) or c) for c in connections]

    @router.get("/me/channels/connections/{connection_id}", response_model=ConnectionResponse)
    async def get_connection(connection_id: str, authorization: str = Header(default="")):
        gateway, connection = await _owned_connection(connection_id, authorization)
        await gateway.refresh_quota_if_stale(connection)
        return _view(gateway, gateway.store.get_connection(connection.id) or connection)

    async def _lifecycle(connection_id: str, authorization: str, action: str) -> ConnectionResponse:
        gateway, connection = await _owned_connection(connection_id, authorization)
        _refuse_hub_row(connection)
        try:
            updated = await getattr(gateway, action)(connection)
        except ConnectionSetupError as exc:
            raise HTTPException(exc.status, exc.reason) from None
        return _view(gateway, updated)

    @router.post("/me/channels/connections/{connection_id}/test", response_model=ConnectionResponse)
    async def test_connection(connection_id: str, authorization: str = Header(default="")):
        """Ask the provider how the connection looks; the status is stored with
        its time, so the page can show it without calling the provider."""
        return await _lifecycle(connection_id, authorization, "check")

    @router.post("/me/channels/connections/{connection_id}/disable",
                 response_model=ConnectionResponse)
    async def disable_connection(connection_id: str, authorization: str = Header(default="")):
        return await _lifecycle(connection_id, authorization, "disable")

    @router.post("/me/channels/connections/{connection_id}/enable",
                 response_model=ConnectionResponse)
    async def enable_connection(connection_id: str, authorization: str = Header(default="")):
        """Messages sent to the bot while it was disabled are not delivered."""
        return await _lifecycle(connection_id, authorization, "enable")

    @router.post("/me/channels/connections/{connection_id}/reconnect",
                 response_model=ConnectionResponse)
    async def reconnect_connection(connection_id: str, authorization: str = Header(default="")):
        """Register the webhook again under the current key (finishes a key
        rotation)."""
        return await _lifecycle(connection_id, authorization, "reconnect")

    @router.delete("/me/channels/connections/{connection_id}")
    async def remove_connection(connection_id: str, authorization: str = Header(default="")):
        gateway, connection = await _owned_connection(connection_id, authorization)
        _refuse_hub_row(connection)
        await gateway.remove(connection)
        return {"removed": connection.id}

    @router.put("/me/channels/connections/{connection_id}/mode", response_model=ConnectionResponse)
    async def set_mode(connection_id: str, body: ModeBody, authorization: str = Header(default="")):
        gateway, connection = await _owned_connection(connection_id, authorization)
        if body.mode not in access.MODES:
            raise HTTPException(400, f"mode must be one of {', '.join(access.MODES)}")
        gateway.store.set_mode(connection.id, body.mode)
        return _view(gateway, gateway.store.get_connection(connection.id))

    @router.put("/me/channels/connections/{connection_id}/fixed-reply",
                response_model=ConnectionResponse)
    async def set_fixed_reply(connection_id: str, body: FixedReplyBody,
                              authorization: str = Header(default="")):
        gateway, connection = await _owned_connection(connection_id, authorization)
        text = body.text.strip()
        if len(text) > MAX_FIXED_REPLY_CHARS:
            raise HTTPException(
                400, f"The reply can be at most {MAX_FIXED_REPLY_CHARS} characters",
            )
        # Whitespace only counts as empty: nothing is sent.
        gateway.store.set_fixed_reply(connection.id, text)
        return _view(gateway, gateway.store.get_connection(connection.id))

    @router.put("/me/channels/connections/{connection_id}/ack-text",
                response_model=ConnectionResponse)
    async def set_ack_text(connection_id: str, body: AckTextBody,
                           authorization: str = Header(default="")):
        """LINE's acknowledgement: sent on the reply token when a message
        reaches the agent. Empty (or whitespace) sends none."""
        gateway, connection = await _owned_connection(connection_id, authorization)
        if not hasattr(gateway.adapters.get(connection.channel), "acknowledge"):
            raise HTTPException(400, "This channel has no acknowledgement")
        text = body.text.strip()
        if len(text) > MAX_FIXED_REPLY_CHARS:
            raise HTTPException(
                400, f"The acknowledgement can be at most {MAX_FIXED_REPLY_CHARS} characters",
            )
        gateway.store.set_ack_text(connection.id, text)
        return _view(gateway, gateway.store.get_connection(connection.id))

    @router.get("/me/channels/connections/{connection_id}/allowlist",
                response_model=list[EntryResponse])
    async def list_allowlist(connection_id: str, authorization: str = Header(default="")):
        gateway, connection = await _owned_connection(connection_id, authorization)
        return [_entry_view(e) for e in gateway.store.list_entries(connection.id)]

    @router.post("/me/channels/connections/{connection_id}/allowlist",
                 response_model=EntryResponse)
    async def add_allowlist_entry(connection_id: str, body: EntryBody,
                                  authorization: str = Header(default="")):
        """Adding an entry that admits a waiting sender allows their Request —
        the same Allow as the owner's click, so their held messages arrive as
        the combined message first."""
        gateway, connection = await _owned_connection(connection_id, authorization)
        adapter = gateway.adapters.get(connection.channel)
        kinds = getattr(adapter, "allowlist_kinds", ())
        refuse = getattr(adapter, "refuse_entry", None)
        refusal = refuse(connection, body.value) if refuse is not None else None
        if refusal is not None:
            raise HTTPException(400, refusal)
        try:
            parsed = access.parse_entry(
                body.value, kinds, user_id_pattern=getattr(adapter, "user_id_pattern", None),
                user_id_error=getattr(adapter, "user_id_error", "not a valid user id"),
                phone_prefix_required=getattr(adapter, "phone_prefix_required", False),
            )
        except access.EntryError as exc:
            raise HTTPException(400, str(exc))
        entry, allowing = gateway.store.add_entry(
            connection.id, parsed, now=gateway.options.clock(),
        )
        for request_id in allowing:
            try:
                await gateway.finish_allow(request_id)
            except Exception as exc:  # noqa: BLE001 — finished by the next flush or at boot
                logger.error("Channel Allow after a new entry failed: %s", type(exc).__name__)
        return _entry_view(entry)

    @router.delete("/me/channels/connections/{connection_id}/allowlist/{entry_id}")
    async def delete_allowlist_entry(connection_id: str, entry_id: str,
                                     authorization: str = Header(default="")):
        gateway, connection = await _owned_connection(connection_id, authorization)
        if not gateway.store.delete_entry(connection.id, entry_id):
            raise HTTPException(404, "Entry not found")
        return {"deleted": entry_id}

    @router.get("/me/channels/connections/{connection_id}/requests",
                response_model=list[RequestResponse])
    async def list_requests(connection_id: str, authorization: str = Header(default="")):
        gateway, connection = await _owned_connection(connection_id, authorization)
        return [_request_view(gateway, r) for r in gateway.store.list_requests(connection.id)]

    @router.post("/me/channels/connections/{connection_id}/requests/{request_id}/allow",
                 response_model=RequestResponse)
    async def allow_request(connection_id: str, request_id: str,
                            authorization: str = Header(default="")):
        """Repeating Allow returns 200 with the same thread(s), finishing an
        interrupted Allow on the way; never a second thread."""
        gateway, connection = await _owned_connection(connection_id, authorization)
        _owned_request(gateway, connection, request_id)
        request = await gateway.allow_request(request_id)
        if request is None:  # the connection was removed meanwhile
            raise HTTPException(404, "Request not found")
        if request.state == REQUEST_BLOCKED:
            raise HTTPException(409, "This sender is blocked")
        return _request_view(gateway, request)

    @router.post("/me/channels/connections/{connection_id}/requests/{request_id}/block",
                 response_model=RequestResponse)
    async def block_request(connection_id: str, request_id: str,
                            authorization: str = Header(default="")):
        gateway, connection = await _owned_connection(connection_id, authorization)
        _owned_request(gateway, connection, request_id)
        request = gateway.block_request(request_id)
        if request is None:
            raise HTTPException(404, "Request not found")
        if request.state in (REQUEST_ALLOWING, REQUEST_ALLOWED):
            raise HTTPException(409, "This sender has already been allowed")
        return _request_view(gateway, request)

    @router.delete("/me/channels/connections/{connection_id}/requests/{request_id}/block")
    async def unblock_request(connection_id: str, request_id: str,
                              authorization: str = Header(default="")):
        """Their next message is judged afresh: a new Request, with the fixed
        reply again."""
        gateway, connection = await _owned_connection(connection_id, authorization)
        request = _owned_request(gateway, connection, request_id)
        gateway.store.unblock(connection.id, request.user_key)
        return {"unblocked": request_id}

    def _owned_thread(gateway: ChannelGateway, project_id: str, user_id: str):
        thread = gateway.store.thread_for_project(project_id)
        if thread is None:
            raise HTTPException(404, "Not a channel thread")
        connection = gateway.store.get_connection(thread.connection_id)
        if connection is not None and not _serves(gateway, connection.channel):
            raise HTTPException(404, "Not a channel thread")
        if connection is None or connection.owner_id != user_id:
            raise HTTPException(403, "Only the owner of this conversation can do that")
        return thread

    def _owned_history(gateway: ChannelGateway, project_id: str, user_id: str):
        """The project's live thread, or its history record if the connection
        was removed. 404 when it is neither; 403 when someone else owns it."""
        if gateway.store.thread_for_project(project_id) is not None:
            return _owned_thread(gateway, project_id, user_id)
        removed = gateway.store.removed_thread(project_id)
        if removed is None:
            raise HTTPException(404, "Not a channel thread")
        if removed.owner_id != user_id:
            raise HTTPException(403, "Only the owner of this conversation can do that")
        return removed

    @router.get("/me/channels/threads", response_model=list[ThreadListItem])
    async def list_threads(authorization: str = Header(default="")):
        """Every channel thread the caller owns, in one call: live threads on
        their connections, and threads whose connection was removed. Threads
        whose project was deleted are left out."""
        gateway = _owner_gateway()
        user = await ctx.auth.resolve_user_from_credential(authorization)

        def _exists(project_id: str) -> bool:
            try:
                Project.get(project_id, ctx.model_ctx)
            except ValueError:
                return False
            return True

        # The store's SQLite connection belongs to the event loop's thread;
        # only the per-project file reads go to a worker.
        live = [t for t in gateway.store.owned_threads(user.id) if _serves(gateway, t.channel)]
        removed = [r for r in gateway.store.removed_threads(user.id) if _serves(gateway, r.channel)]
        hub_fields = {}
        for t in live:
            if t.channel == HUB_CHANNEL and t.contact_id:
                contact = gateway.store.get_contact(t.contact_id)
                if contact is not None:
                    hub_fields[t.project_id] = contact_fields(
                        gateway.hub, contact.provider_user_key, contact.display_name,
                        t.connection_id).model_dump()

        def _gather() -> list[ThreadListItem]:
            out = [
                ThreadListItem(**t.model_dump(), connection_removed=False, **hub_fields.get(t.project_id, {}))
                for t in live if _exists(t.project_id)
            ]
            out.extend(
                ThreadListItem(
                    project_id=r.project_id, channel=r.channel, connection_id=None,
                    connection_enabled=False, connection_removed=True, contact_id=None,
                    contact_name=r.contact_name, paused=False,
                )
                for r in removed if _exists(r.project_id)
            )
            return out

        # Project.get reads a file per thread: off the event loop.
        return await asyncio.to_thread(_gather)

    @router.put("/me/channels/threads/{project_id}/pause", response_model=ThreadResponse)
    async def set_pause(project_id: str, body: PauseBody, authorization: str = Header(default="")):
        gateway = _owner_gateway()
        user = await ctx.auth.resolve_user_from_credential(authorization)
        _owned_thread(gateway, project_id, user.id)
        # Flipping the flag dispatches nothing: messages held while paused stay
        # in the transcript as context, and the next contact message wakes the
        # agent with them in view.
        thread = gateway.store.set_paused(project_id, body.paused)
        assert thread is not None
        return ThreadResponse(project_id=project_id, paused=thread.paused)

    @router.get("/me/channels/threads/{project_id}", response_model=ThreadStatusResponse)
    async def get_thread(project_id: str, authorization: str = Header(default="")):
        gateway = _owner_gateway()
        user = await ctx.auth.resolve_user_from_credential(authorization)
        thread = _owned_thread(gateway, project_id, user.id)
        connection = gateway.store.get_connection(thread.connection_id)
        contact = gateway.store.get_contact(thread.contact_id)
        state = gateway.window_state(thread.connection_id, thread.conversation_key)
        closed_at, held = state if state is not None else (None, [])
        return ThreadStatusResponse(
            project_id=project_id, channel=connection.channel if connection else "",
            paused=thread.paused, contact_name=contact.display_name if contact else "",
            window_closed_at=closed_at,
            held=[
                HeldReplyResponse(
                    message_id=row.message_id, part_index=row.part_index, text=row.text,
                    reason=row.reason or "", held_at=held_at,
                )
                for row, held_at in held
            ],
        )

    @router.get("/me/channels/threads/{project_id}/outbox", response_model=list[OutboxItemResponse])
    async def get_outbox(project_id: str, authorization: str = Header(default="")):
        gateway = _owner_gateway()
        user = await ctx.auth.resolve_user_from_credential(authorization)
        # A removed connection's thread still answers: its waiting rows ended
        # ``failed`` / ``connection_removed`` and the owner sees why.
        _owned_history(gateway, project_id, user.id)
        return [
            OutboxItemResponse(
                message_id=r.message_id, part_index=r.part_index,
                state="waiting" if r.state in WAITING_STATES else r.state,
                reason=r.reason, attempts=r.attempts,
                text=r.text if r.state == HELD_WINDOW else None, detail=r.detail,
            )
            for r in gateway.store.outbox_for_project(project_id)
        ]

    return router
