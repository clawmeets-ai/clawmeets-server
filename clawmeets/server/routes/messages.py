# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/messages.py
Message handling routes.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import secrets
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.responses import JSONResponse
from pydantic import BaseModel, TypeAdapter

from clawmeets.api.retry_transport import IDEMPOTENCY_HEADER
from clawmeets.api.control import CancelLLMPayload, ChangelogUpdatePayload, ControlEnvelope, ControlMessageType
from clawmeets.models.chat_message import ChatFileEvent, ChatLogEntry, ChatMessage
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.agent import Agent
from clawmeets.models.project import Project, is_untrusted_source
from clawmeets.models.provenance import owner_isolated_outside
from clawmeets.server.coordinator_rule import is_own_coordinator
from clawmeets.server.hub.browser import HubError
from clawmeets.server.isolation_gate import check_project_read
from clawmeets.models.share_token import is_viewer
from clawmeets.models.user import User
from clawmeets.utils.file_io import FileUtil
from clawmeets.utils.email import queue_notification
from clawmeets.server.batch_timeout import resolve_batch_timeout
from clawmeets.server.desk_todo_notify import notify_plate_of_project_change
from clawmeets.server.participant_liveness import split_by_liveness
from clawmeets.server.email import APP_BASE_URL, ClawMeetsEmailMessage
from clawmeets.server.message_forward import (
    attached_filenames,
    compose_forward,
    find_messages,
)
from clawmeets.server.notification_assets import (
    gather_response_attachments,
    report_url_if_available,
)
from clawmeets.server.routes._mentions import resolve_room_mentions
from clawmeets.server.routes.files import _check_upload_size, _validate_filename
from clawmeets.server.turn_tokens import GRANT_HEADER
from clawmeets.sync.changelog import (
    BatchCompletePayload,
    ChangelogEntryType,
    ChatroomClearedPayload,
    FilePayload,
    MessagePayload,
    AgentOfflinePayload,
    ProjectReactivatedPayload,
    ProjectStatus,
)
from clawmeets.sync.runloop import BatchEntrySpec
from clawmeets.server.channels.gateway import channel_thread_for

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# Cap the TOTAL bytes of files attached to a single user message. Attachments
# ride the atomic message request as base64 and are replayed by every
# participant runner, so keep the per-message payload bounded. Default 20 MB;
# override via CLAWMEETS_MAX_MESSAGE_ATTACHMENTS_BYTES. Each file is ALSO
# checked against the per-file _check_upload_size limit.
_DEFAULT_MAX_MESSAGE_ATTACHMENTS_BYTES = 20 * 1024 * 1024


def _max_message_attachments_bytes() -> int:
    raw = os.environ.get("CLAWMEETS_MAX_MESSAGE_ATTACHMENTS_BYTES", "")
    try:
        val = int(raw)
        if val > 0:
            return val
    except (TypeError, ValueError):
        pass
    return _DEFAULT_MAX_MESSAGE_ATTACHMENTS_BYTES


_LOG_ENTRIES_ADAPTER = TypeAdapter(list[ChatLogEntry])


def _refuse_hub_thread(project: Project) -> None:
    """A hub requester thread (its coordinator is a remote agent's stand-in)
    is written only through ``POST /api/hub/conversations/{id}/messages``,
    which signs and relays: ``use_hub_send`` [409] here."""
    if is_untrusted_source(project):
        raise HubError("use_hub_send", "send through the hub conversation route")


def _project_or_404(project_id: str, model_ctx) -> Project:
    """The project, or 404: ``Project.get`` raises ``ValueError`` for an
    unknown or malformed id, which a route would otherwise answer 500."""
    try:
        return Project.get(project_id, model_ctx)
    except ValueError:
        raise HTTPException(404, f"Project {project_id!r} not found")


def _is_fd_requester(project: Project, room: Chatroom, user: User) -> bool:
    """True when ``user`` is the requester of this Front Desk DM channel and the
    room is ``user-communication``.

    Cross-user DM channels (``{requester}-fd-{agent_short}``) are owned
    (``created_by``) by the host — the foreign agent's owner — so the requester
    reads/writes their own thread directly without owning the project. Scoped to
    ``user-communication`` (the only room the requester touches); other rooms
    stay owner/participant-only.
    """
    return room.is_user_communication_room and project.fd_requester_name == user.username


class MessageBody(BaseModel):
    """Request body for posting a message."""
    model_config = {"protected_namespaces": ()}  # allow model_config_name field

    content: str
    type: Optional[str] = None
    filename: Optional[str] = None
    note: Optional[str] = None
    is_ack: bool = False  # Acknowledgment marker (system use only)
    source_version: Optional[int] = None  # Version of the changelog entry this reply reacts to
    # Per-request model override (spec #3): names a config on the responding
    # agent. null/absent ⇒ the agent's default config; overrides that turn only.
    model_config_name: Optional[str] = None


class AttachedFile(BaseModel):
    """One file attached to a user message (base64-encoded raw bytes)."""
    filename: str
    content_b64: str


class ForwardOf(BaseModel):
    """The source of a forwarded message (the web UI's Forward button).

    Names messages; never carries their text. The server loads the originals
    and writes the quote itself — see ``server/message_forward.py``.
    """
    project_id: str
    chatroom_name: str
    #: One message, or every message of a coalesced group, in any order.
    message_ids: list[str]
    #: Which of the originals' attachments to carry. ``None`` ⇒ all of them;
    #: a name that did not ride with the originals is rejected.
    include_files: Optional[list[str]] = None


class UserMessageBody(BaseModel):
    """Request body for POST .../user-message.

    Backward-compatible: legacy callers post ``{"content": "..."}`` and get
    ``files=[]`` (the plain single-message path). The web composer posts
    ``{"content": ..., "files": [...]}`` so the message and its attachments are
    delivered atomically (files land before the coordinator is woken).
    """
    model_config = {"protected_namespaces": ()}  # allow model_config_name field

    content: str
    files: list[AttachedFile] = []
    # Per-request model override (spec #3): names a config on the responding
    # agent (the coordinator/worker woken by this message). null/absent ⇒ the
    # agent's default config; overrides that one turn only.
    model_config_name: Optional[str] = None
    # Optional: attribute this message to one of the caller's OWN agents (e.g.
    # a user's assistant delegating to a foreign front-desk agent on the user's
    # behalf). The agent must be registered_by the resolved user. When set, the
    # message's from_participant_id is that agent (so the tunnel classifies the
    # requester as an agent and the host thread is keyed by the agent), while
    # authorization + addressing still resolve from the user.
    as_agent_id: Optional[str] = None
    # Optional: forward existing messages. ``content`` becomes the user's note
    # above the quote; the quote and its attachments are copied server-side
    # from the source room, which the caller must be able to read.
    forward_of: Optional[ForwardOf] = None


class SaySpeakResponse(BaseModel):
    """Response from POST /me/agents/{agent_name}/say (and the legacy
    /me/assistant/say alias).

    `speak` is a friendly confirmation string designed for an iOS Shortcut
    (or any voice client) to read back aloud — the agent's actual reply
    arrives later, asynchronously, and is read in the app.
    """
    speak: str
    message: ChatMessage


def create_messages_router(ctx: "ServerContext") -> APIRouter:
    """Create the messages router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["messages"])

    async def _execute_user_communication_hook(
        project_id: str,
        chatroom_name: str,
        message: ChatMessage,
        background: BackgroundTasks,
    ) -> None:
        """Execute hook when message posted to user-communication chatroom.

        When the assistant (coordinator) sends a message, notify the user via email.
        """
        # A channel thread's messages are an outside contact's conversation
        # (and the answers quote it): never in the log.
        content = (
            "<channel thread>" if channel_thread_for(ctx, project_id) is not None
            else (message.content or "")[:100]
        )
        logger.info(
            f"[USER_COMM_HOOK] project={project_id[:8]} room={chatroom_name} "
            f"from={message.from_participant_name or message.from_participant_id} "
            f"content={content}"
        )

        # Only notify when the coordinator (assistant) sends a message
        project = Project.get(project_id, ctx.model_ctx)
        if not project or message.from_participant_id != project.coordinator_id:
            return

        # DM-shaped projects (owned DM + Front Desk host end) do NOT get the
        # regular assistant_message email here — an owned DM gets the dm_response
        # email from the BATCH_COMPLETE block in post_message; a Front Desk host
        # end notifies the requester via the reverse tunnel mirror + live
        # CHANGELOG_UPDATE (a matching email is a follow-up, SF1). Skipping here
        # avoids emailing the host owner about their own agent's reply.
        if project.is_dm_shaped:
            return

        # Skip acknowledgment messages
        if message.is_ack:
            return

        try:
            if not project.created_by:
                return
            user = User.get(project.created_by, ctx.model_ctx)
            if not user:
                return

            assistant_name = message.from_participant_name or "your assistant"

            # Send email notification
            if user.email:
                # Gather the deliverables this response produced (files the
                # assistant generated in the same turn) + a report link if one
                # exists. A gather failure must never block the email.
                attachments: list = []
                skipped: list[str] = []
                report_link = None
                try:
                    room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
                    if room is not None:
                        attachments, skipped = gather_response_attachments(
                            room,
                            source_version=message.source_version,
                            author_id=message.from_participant_id,
                        )
                    report_link = report_url_if_available(
                        project, ctx.model_ctx, APP_BASE_URL
                    )
                except Exception:
                    logger.exception("Failed to gather notification assets")
                msg = ClawMeetsEmailMessage.assistant_message(
                    to_email=user.email,
                    username=user.username,
                    assistant_name=assistant_name,
                    project=project,
                    chatroom_name=chatroom_name,
                    content=message.content or "",
                    app_base_url=APP_BASE_URL,
                    attachments=attachments,
                    attachments_skipped=skipped,
                    report_url=report_link,
                )
                queue_notification(background, msg)
        except Exception:
            logger.exception("Failed to send user-communication notification")

    def _agent_thread(project: Project, agent_id: str):
        """The hub DM thread ``project`` when ``agent_id`` started it, else None."""
        runtime = ctx.hub_runtime
        thread = runtime.hub.thread_for_project(project.id) if runtime is not None else None
        if thread is None or thread.started_by_agent_id != agent_id:
            return None
        return thread

    async def _relay_thread_reply(project: Project, thread, agent_id: str, body: "MessageBody"):
        from clawmeets.server.hub.agent_send_guard import AgentSendGuard, via_agent_name

        runtime = ctx.hub_runtime
        owner = User.get(thread.user_id, ctx.model_ctx)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if owner is None or agent is None:
            raise HTTPException(404, f"Project {project.id!r} not found")
        key = hashlib.sha256(f"{body.source_version}:{body.content}".encode()).hexdigest()[:32]
        client_message_id = f"turn-{agent_id}-{key}"
        runloop = await ctx.runloop_manager.get_or_create(project.id, project.name)

        def _stored(message_id: str):
            for e in reversed(runloop.get_entries_since(0)):
                if e.entry_type == ChangelogEntryType.MESSAGE and getattr(e.payload, "id", None) == message_id:
                    return ChatMessage.from_message_payload(e.payload, version=e.version,
                                                            source_version=e.source_version)
            return None

        # A retry of a reply already sent replays it, as the hub send route
        # does: before the flow check and the charge, so it is neither
        # charged twice nor refused by a stop that came after it.
        # A replay needs the queued request too: a first attempt that stored
        # the message but failed to queue it is finished by mirror.send below
        # (idempotent on the claim), still uncharged and past the flow check.
        claimed = runtime.hub.claimed_send(owner.id, project.id, client_message_id)
        if claimed is not None and runtime.hub.request_row(project.id, claimed) is not None:
            replay = _stored(claimed)
            if replay is not None:
                return replay
        short = via_agent_name(agent, ctx.model_ctx)
        if claimed is None:
            # A stopped thread refuses its starting agent like the hub send
            # route refuses the user: before anything is charged or queued.
            flow = getattr(ctx, "room_flow", None)
            if flow is not None and not flow.is_open(project.id, "user-communication"):
                raise HubError("room_flow_stopped", "this conversation's inbound flow is stopped; reopen it first")
            guard = getattr(ctx, "hub_send_guard", None)
            if guard is None:
                guard = ctx.hub_send_guard = AgentSendGuard(ctx.channel_store)
            guard.charge(user_id=owner.id, agent_id=agent_id, target=thread.stand_in_id)
        sent = await runtime.mirror.send(owner, project.id, text=body.content,
                                         client_message_id=client_message_id,
                                         via_agent=short, author=agent)
        stored = _stored(sent.message_id)
        if stored is None:
            raise HTTPException(500, "relayed message not found")
        return stored

    @router.post("/projects/{project_id}/chatrooms/{chatroom_name}/messages", response_model=ChatMessage)
    async def post_message(
        project_id: str,
        chatroom_name: str,
        request: Request,
        background: BackgroundTasks,
        authorization: str = Header(default=""),
        body: MessageBody = Body(...),
    ):
        """Post a message to a chatroom.

        Addressing is done via @mentions in the message content:
        - "@agent-name" in content -> agent is addressed and should respond
        - "agent-name" (no @) -> reference only, not addressed
        """
        project = _project_or_404(project_id, ctx.model_ctx)
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

        agent_id = request.headers.get("X-Agent-ID")
        if not agent_id:
            raise HTTPException(400, "Missing X-Agent-ID header")
        if agent_id not in room.participants:
            raise HTTPException(403, f"Agent {agent_id} is not a participant in chatroom {chatroom_name}")

        await ctx.auth.check_agent_token(agent_id, authorization)
        thread = None
        if is_untrusted_source(project):       # after auth: never tells a stranger what a project is
            thread = _agent_thread(project, agent_id)
            if thread is None:
                _refuse_hub_thread(project)
        if getattr(ctx, "isolation_gate", None) is not None:     # replies and acks alike need a live grant
            getattr(ctx, "isolation_gate", None).check_write(
                project, agent_id=agent_id, grant_id=request.headers.get(GRANT_HEADER),
            )
        if is_untrusted_source(project) and not body.is_ack:
            # The starting agent answering the remote agent from its turn in
            # the thread: relayed through the hub, signed as the user "sent by
            # their agent", and charged like any agent send.
            return await _relay_thread_reply(project, thread, agent_id, body)

        # Get agent/assistant name - fail fast if authenticated participant not found
        participant = Agent.get(agent_id, ctx.model_ctx)
        if participant is None:
            raise HTTPException(500, f"Authenticated participant {agent_id} not found in registry")
        agent_name = participant.name

        # Parse @mentions from content and resolve to IDs
        # Only coordinators (and users) can @mention to delegate work.
        # Workers' @mentions are ignored to prevent uncoordinated fan-out.
        # An own coordinator only (plan-owner-isolation 4): a foreign one, which
        # the append guard keeps from existing, never addresses anyone.
        # An owner-isolated agent outside its own conversations (an owner
        # workroom, even one it coordinates) never addresses anyone: a visitor
        # who steered it must not wake the owner's agents into full turns
        # (plan-owner-isolation 5d). Its row is stamped outside content.
        isolated_outside = owner_isolated_outside(project, agent_id, ctx.model_ctx)
        is_coordinator = agent_id == project.coordinator_id and not isolated_outside and is_own_coordinator(
            ctx.model_ctx, project_owner_id=project.created_by, coordinator_id=agent_id)
        is_user = User.get(agent_id, ctx.model_ctx) is not None

        resolved_expects: list[str] = []
        if is_coordinator or is_user:
            # Address only the @mentions that resolve to a real agent in this
            # room; a batch opens for those. Every other @token — unknown name,
            # typo, out-of-room agent, or a bare code/prose token like
            # @property — is left as plain text and ignored. The message always
            # posts (no valid-agent-name validation, no rejection).
            resolved_expects = resolve_room_mentions(
                room, body.content, ctx.model_ctx
            )
        elif room.parse_mentions(body.content):
            logger.info(f"Worker {agent_name} ({agent_id[:8]}) used @mentions -- ignored (workers cannot delegate)")

        # Drop self-mentions: an agent that @mentions itself in a status
        # update ("asked @gamemaster to start game") must not be expected to
        # reply to its own message — that would create a PendingWork batch
        # waiting on the sender forever, leaving the typing chip stuck on
        # until batch timeout.
        resolved_expects = [pid for pid in resolved_expects if pid != agent_id]

        # The agent's own reply in a channel thread's user-communication room is
        # one of the two ordinary messages the channel outbox sends. Marked here,
        # at the write, because the outbox cannot tell it from the plan/review
        # and init messages that are also written as the coordinator.
        channel_outbound = (
            room.is_user_communication_room
            and agent_id == project.coordinator_id
            and not body.is_ack
            and channel_thread_for(ctx, project_id) is not None
        )

        # Get runloop for this project (reuse for message + potential batch complete)
        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)

        # A retry of a post that already landed — core died before the
        # idempotency middleware could record the response — gets the
        # message it wrote, not a second copy.
        request_key = request.headers.get(IDEMPOTENCY_HEADER)
        if request_key:
            prior = runloop.find_recent_by_request_id(agent_id, request_key)
            if prior is not None:
                return ChatMessage.from_message_payload(
                    prior.payload, version=prior.version, source_version=prior.source_version
                )

        # Create message
        msg_id = str(uuid.uuid4())
        now = datetime.now(UTC)

        # Append to changelog and process through subscribers
        # MessagePayload is now flat - all fields directly on the payload
        entry = await runloop.append(
            ChangelogEntryType.MESSAGE,
            MessagePayload(
                chatroom_name=chatroom_name,
                id=msg_id,
                ts=now,
                from_participant_id=agent_id,
                from_participant_name=agent_name,
                content=body.content,
                expects_response_from=resolved_expects,
                is_ack=body.is_ack,
                model_config_name=body.model_config_name,
                channel_outbound=channel_outbound,
                client_request_id=request_key,
                outside_isolated=isolated_outside,
            ),
            source_version=body.source_version,
        )

        # Create ChatMessage for return value and hook
        msg = ChatMessage(
            id=msg_id,
            ts=now,
            from_participant_id=agent_id,
            from_participant_name=agent_name,
            content=body.content,
            expects_response_from=resolved_expects,
            is_ack=body.is_ack,
            version=entry.version,
            source_version=body.source_version,
            model_config_name=body.model_config_name,
            outside_isolated=isolated_outside,
        )

        # Record the sender's response against any existing batch FIRST (skip
        # acknowledgments). Must happen before create_pending_work below so a
        # reply that both closes an old batch and starts a new batch in the
        # same chatroom doesn't hit ValueError on the stale entry.
        if not msg.is_ack:
            # A reply the room's open batch is not waiting for would otherwise
            # be invisible to the batch machinery and never re-wake the
            # coordinator. Two shapes, one cause:
            #   * no batch open at all — e.g. a worker posting a follow-up
            #     after its earlier batch completed;
            #   * a batch open that does not expect THIS replier — a batch
            #     narrowed to its live members at dispatch, answered by an
            #     agent that was offline then and has since reconnected (the
            #     reconnect backoff floor is 2.0s, `cli_runner.py:2659`).
            # Testing `get_pending_work(...) is None` only caught the first,
            # because it asks whether a batch exists in the ROOM rather than
            # whether this replier is in it — and `record_response` returns
            # None for an id outside `expected_participants`, so the second
            # shape silently dropped the reply.
            # Guard on sender != coordinator: synthesizing a batch whose
            # coordinator is the replier would wake it on its own message
            # (loop) — and it correctly leaves DM-shaped threads, where the
            # partner agent IS the coordinator, untouched.
            open_work = await ctx.work_tracker.get_pending_work(
                project_id, chatroom_name
            )
            if (
                project.coordinator_id
                and agent_id != project.coordinator_id
                and (
                    open_work is None
                    or agent_id not in open_work.expected_participants
                )
            ):
                work = await ctx.work_tracker.record_response_opening_if_missing(
                    project_id,
                    project.name,
                    chatroom_name,
                    agent_id,
                    coordinator_id=project.coordinator_id,
                    message_id=msg_id,
                    message_version=entry.version,
                    timeout_seconds=resolve_batch_timeout(
                        [agent_id], default=ctx.batch_timeout,
                        model_ctx=ctx.model_ctx,
                    ),
                )
            else:
                work = await ctx.work_tracker.record_response(project_id, chatroom_name, agent_id)
            if work and work.is_complete:
                # Clear pending work
                await ctx.work_tracker.clear_pending_work(project_id, chatroom_name)

                # Append BATCH_COMPLETE to changelog. source_version points at
                # the @mention MESSAGE that opened the batch (same chain as the
                # workers that just answered).
                batch_entry = await runloop.append(
                    ChangelogEntryType.BATCH_COMPLETE,
                    BatchCompletePayload(
                        chatroom_name=chatroom_name,
                        message_id=work.message_id,
                        coordinator_id=work.coordinator_id,
                        responded_participants=work.responded_participants,
                    ),
                    source_version=work.message_version,
                )

                # When a coordinator-led batch completes, the coordinator is
                # about to run its batch-complete flow (on_batch_complete →
                # _invoke_claude). Track it as a self-batch so the typing chip
                # and cancel button show for the coordinator. coordinator_id is
                # set to the project owner (not the actual coordinator) so the
                # eventual BATCH_COMPLETE from this self-batch does not route
                # back to the coordinator — preventing an infinite loop.
                # message_version is the BATCH_COMPLETE we just appended — the
                # coordinator's upcoming reply reacts to that BATCH_COMPLETE.
                # A user coordinator (a requester end, plan-owner-isolation)
                # never gets one: no agent runs a batch-complete flow for it.
                if (
                    project.coordinator_id
                    and project.created_by
                    and project.coordinator_id != project.created_by
                    and work.coordinator_id == project.coordinator_id
                ):
                    try:
                        await ctx.work_tracker.create_pending_work(
                            message_id=work.message_id,
                            message_version=batch_entry.version,
                            project_id=project_id,
                            project_name=project.name,
                            chatroom_name=chatroom_name,
                            coordinator_id=project.created_by,
                            expected_participants=[work.coordinator_id],
                            timeout_seconds=resolve_batch_timeout(
                                [work.coordinator_id], default=ctx.batch_timeout,
                                model_ctx=ctx.model_ctx,
                            ),
                        )
                    except ValueError:
                        logger.warning(
                            f"Self-batch already exists for chatroom {chatroom_name}"
                        )

                # Broadcast batch completion to all project participants
                batch_envelope = ControlEnvelope(
                    type=ControlMessageType.CHANGELOG_UPDATE,
                    payload=ChangelogUpdatePayload(
                        project_id=project_id,
                        project_name=project.name,
                        new_version=batch_entry.version,
                        coordinator_id=project.coordinator_id,
                    ),
                )
                await ctx.ws_hub.broadcast_to_project(batch_envelope, project)

                # Send email notification for DM batch completion. DM threads
                # live on `user-communication` in a DM-shaped project; the
                # coordinator IS the partner agent.
                if project.is_dm_project and chatroom_name == "user-communication":
                    try:
                        # Notify the human waiting on this DM: the FD requester
                        # on a cross-user `-fd-` channel, else the project owner
                        # (solo `-dm-`). On a cross-user channel `created_by` is
                        # the host (agent owner), not the requester.
                        notify_user = None
                        if project.fd_requester_name:
                            notify_user = User.get_by_username(
                                project.fd_requester_name, ctx.model_ctx
                            )
                        if notify_user is None and project.created_by:
                            notify_user = User.get(project.created_by, ctx.model_ctx)
                        if notify_user and notify_user.email:
                            # Attach files the agent produced in this DM turn +
                            # a report link if one exists; never block on gather.
                            dm_attachments: list = []
                            dm_skipped: list[str] = []
                            dm_report = None
                            try:
                                dm_attachments, dm_skipped = gather_response_attachments(
                                    room,
                                    source_version=msg.source_version,
                                    author_id=msg.from_participant_id,
                                )
                                dm_report = report_url_if_available(
                                    project, ctx.model_ctx, APP_BASE_URL
                                )
                            except Exception:
                                logger.exception("Failed to gather DM notification assets")
                            email_msg = ClawMeetsEmailMessage.dm_response(
                                to_email=notify_user.email,
                                username=notify_user.username,
                                agent_name=project.coordinator_name,
                                project=project,
                                chatroom_name=chatroom_name,
                                content=msg.content or "",
                                app_base_url=APP_BASE_URL,
                                attachments=dm_attachments,
                                attachments_skipped=dm_skipped,
                                report_url=dm_report,
                            )
                            queue_notification(background, email_msg)
                    except Exception:
                        logger.exception("Failed to send DM notification")

        # Create a new batch for this message's @mentions (after any
        # self-response clearing above, so same-chatroom transitions work).
        if resolved_expects:
            try:
                await ctx.work_tracker.create_pending_work(
                    message_id=msg_id,
                    message_version=entry.version,
                    project_id=project_id,
                    project_name=project.name,
                    chatroom_name=chatroom_name,
                    coordinator_id=agent_id,
                    expected_participants=resolved_expects,
                    timeout_seconds=resolve_batch_timeout(
                        resolved_expects, default=ctx.batch_timeout,
                        model_ctx=ctx.model_ctx,
                    ),
                )
            except ValueError:
                logger.warning(f"Pending work already exists for chatroom {chatroom_name}")

        # Broadcast message to all project participants
        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        # Check if this is user-communication room
        if room.is_user_communication_room:
            await _execute_user_communication_hook(
                project_id, chatroom_name, msg, background
            )

        return msg

    async def _authorize_room_read(
        project: Project,
        room: Chatroom,
        authorization: str,
        x_agent_id: Optional[str],
    ) -> None:
        """Authorize a chatroom read, cheapest credential first.

        1. User JWT → project owner or share-token viewer.
        2. Agent bearer + ``X-Agent-ID`` (runners send it on every request)
           → must be a room participant.
        3. Assistant-agent bearer → resolves to the owner (covers
           assistant-shelled ``clawmeets dm history`` / ``dm list``).

        The ordering keeps the per-assistant ``Agent.list_all`` scan in
        ``resolve_user_from_credential`` off the high-frequency JWT and
        runner paths. An isolated project passes the isolation gate first.
        """
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        await check_project_read(ctx, project, authorization=authorization, x_agent_id=x_agent_id)
        try:
            user: Optional[User] = await ctx.auth.get_current_user(authorization)
        except HTTPException:
            user = None
        if user is not None:
            if (
                project.created_by == user.id
                or is_viewer(project.id, user.id, ctx.model_ctx.participants_dir)
                or _is_fd_requester(project, room, user)
            ):
                return
            raise HTTPException(403, "Not authorized to read this chatroom")
        token = authorization[7:]
        if x_agent_id and Agent.verify_token(x_agent_id, token, ctx.model_ctx):
            if x_agent_id in room.participants:
                return
            raise HTTPException(
                403, f"Agent {x_agent_id} is not a participant in chatroom {room.name}"
            )
        user = await ctx.auth.resolve_user_from_credential(authorization)
        if project.created_by == user.id or _is_fd_requester(project, room, user):
            return
        raise HTTPException(403, "Not authorized to read this chatroom")

    @router.get(
        "/projects/{project_id}/chatrooms/{chatroom_name}/messages",
        response_model=list[ChatLogEntry],
    )
    async def get_messages(
        project_id: str,
        chatroom_name: str,
        since: Optional[str] = Query(None),
        authorization: str = Header(default=""),
        x_agent_id: Optional[str] = Header(default=None),
    ):
        """Get CHATS.ndjson entries (messages + file events) from a chatroom.

        Returns a discriminated union keyed by `entry_type`:
        - "message" -> ChatMessage
        - "file_created" / "file_updated" -> ChatFileEvent

        When `since` is provided, only rows strictly after the message with
        that ID are returned (file events keep their file-order position
        relative to surrounding messages).

        Authorization: user JWT (owner / share-token viewer),
        agent bearer + ``X-Agent-ID`` (room participant), or the user's
        assistant-agent bearer (owner).
        """
        project = _project_or_404(project_id, ctx.model_ctx)
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")
        await _authorize_room_read(project, room, authorization, x_agent_id)

        # Reading + serializing a long log is blocking work; run it in a
        # worker thread so one big room can't stall every other request on
        # the (single-process) server's event loop.
        def _read_and_serialize() -> bytes:
            entries = room.get_log_entries()
            if since:
                # Find the target message ID and slice after its file position.
                for idx, entry in enumerate(entries):
                    if isinstance(entry, ChatMessage) and entry.id == since:
                        entries = entries[idx + 1:]
                        break
                else:
                    raise ValueError(f"Message {since!r} not found")
            return _LOG_ENTRIES_ADAPTER.dump_json(entries, by_alias=True)

        body = await asyncio.to_thread(_read_and_serialize)
        return Response(content=body, media_type="application/json")

    @router.delete(
        "/projects/{project_id}/chatrooms/{chatroom_name}/messages",
        status_code=204,
    )
    async def clear_chatroom_history(
        project_id: str,
        chatroom_name: str,
        authorization: str = Header(default=""),
    ) -> Response:
        """Wipe the message history of a chatroom.

        Allowed for the project owner (anywhere in the project) and, for Front
        Desk projects, the external requester limited to ``user-communication``
        (mirrors the post_user_message authz rules). Clears in three observable
        effects: a CHATROOM_CLEARED changelog entry is appended (the subscriber
        rewrites CHATS.ndjson to empty and moves prior contents to a .bak
        sibling), in-memory PendingWork for the room is cleared (typing chip
        drops), and a CHANGELOG_UPDATE is broadcast over WebSocket so every
        connected client refetches the (now empty) message list.

        Returns 204 with empty body. The .bak archive name is recorded in the
        changelog payload — runners reuse it so the same backup filename
        appears on every node (server + runners), which helps support diffs.

        Accepts a user JWT or the user's assistant-agent bearer token.
        """
        current_user = await ctx.auth.resolve_user_from_credential(authorization)

        project = _project_or_404(project_id, ctx.model_ctx)
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

        # The project owner can clear history anywhere in the project. The
        # requester of a cross-user Front Desk DM channel can also clear, but
        # only their user-communication thread (``created_by`` stays the host).
        if project.created_by != current_user.id and not _is_fd_requester(project, room, current_user):
            raise HTTPException(403, "Not authorized to clear history in this chatroom")

        # Decide archive name BEFORE appending — runners will reuse this
        # exact filename via the payload, so all sides produce identical
        # .bak siblings.
        now = datetime.now(UTC)
        chats_path = room.chats_path
        has_history = chats_path.exists() and chats_path.stat().st_size > 0
        archive_filename = (
            f"CHATS.ndjson.cleared-{now.strftime('%Y%m%dT%H%M%SZ')}.bak"
            if has_history
            else None
        )

        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)
        cleared_through_version = runloop.get_current_version()
        entry = await runloop.append(
            ChangelogEntryType.CHATROOM_CLEARED,
            ChatroomClearedPayload(
                chatroom_name=chatroom_name,
                cleared_by_participant_id=current_user.id,
                cleared_at=now,
                cleared_through_version=cleared_through_version,
                archive_filename=archive_filename,
            ),
        )

        # Drop any in-flight batch for the chatroom — typing indicator clears
        # for the user and the chatroom is ready to accept a fresh batch.
        await ctx.work_tracker.clear_pending_work(project_id, chatroom_name)

        envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(envelope, project)

        return Response(status_code=204)

    @router.get("/me/active-work")
    async def get_active_work(authorization: str = Header(default="")):
        """Snapshot of all in-flight PendingWork batches visible to the caller.

        Used by the frontend on mount/reconnect to hydrate its activeWorkStore;
        steady-state updates flow through the ACTIVE_WORK_CHANGE WebSocket
        envelope instead. Filters by the user's accessible projects (owned +
        viewer) to mirror the visibility of project routes.
        """
        current_user = await ctx.auth.get_current_user(authorization)
        all_projects = Project.list_all(ctx.model_ctx)
        accessible = {
            p.id: p for p in all_projects
            if p.created_by == current_user.id
            or is_viewer(p.id, current_user.id, ctx.model_ctx.participants_dir)
            or p.fd_requester_name == current_user.username
        }

        entries = []
        for work in await ctx.work_tracker.get_all_pending_work():
            project = accessible.get(work.project_id)
            if project is None:
                continue
            outstanding = work.timed_out_participants
            if not outstanding:
                continue
            entries.append({
                "project_id": work.project_id,
                "project_name": project.name,
                "chatroom_name": work.chatroom_name,
                "active_participants": outstanding,
            })
        return {"active": entries}

    async def _resolve_voice_caller(authorization: str) -> User:
        """Resolve the bearer token to a User. Accepts either a user JWT
        or a user's assistant_token (the latter is the credential shown
        in Account Settings → Assistant Token, copy-pasteable into voice
        shortcuts). Raises 401 on any failure."""
        return await ctx.auth.resolve_user_from_credential(authorization)

    async def _say_to_agent_dm(user: User, agent_name: str, text: str) -> SaySpeakResponse:
        """Resolve the target agent within the caller's namespace, then
        post `text` into the per-agent DM project's `user-communication`.

        Resolution: try a direct lookup; if missing, prefix with the
        caller's username (e.g. `amy` → `{username}-amy`) and try again.
        Mirrors the @mention resolver used elsewhere. The per-agent DM
        project is lazy-ensured via _ensure_own_dm_project.

        Authorization: only the caller's own agents (registered_by ==
        user.id) are addressable. Cross-owner DMs via voice are out of
        scope for v1; the web UI remains the path for those.
        """
        from clawmeets.server.routes.projects import _ensure_own_dm_project

        target = Agent.get_by_name(agent_name, ctx.model_ctx)
        if target is None:
            target = Agent.get_by_name(f"{user.username}-{agent_name}", ctx.model_ctx)
        if target is None:
            raise HTTPException(404, f"Agent {agent_name!r} not found")
        if target.registered_by != user.id:
            raise HTTPException(403, "Voice DMs are only allowed to your own agents")

        dm_project = await _ensure_own_dm_project(ctx, user, target.name)
        msg = await send_message_as_user(
            ctx, user.id, user.username, dm_project.id, "user-communication", text,
        )
        return SaySpeakResponse(
            speak="Got it — working on it. I'll have a reply waiting in ClawMeets.",
            message=msg,
        )

    @router.post("/me/agents/{agent_name}/say", response_model=SaySpeakResponse)
    async def say_to_agent(
        agent_name: str,
        text: str = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Forward a text utterance to one of the caller's agents via DM.

        Designed for iOS Shortcuts triggered via Siri. `agent_name` is
        either the agent's full registry name (e.g. `chengtao-amy`) or
        the namespace-aware short name within the caller's own scope
        (e.g. `amy`, `assistant`, `outreach_writer`). The server
        resolves it, lazy-ensures the per-agent DM project
        (`{username}-dm-{agent_short}`), and posts the text into its
        `user-communication` room as a user message — same path as a
        typed DM in the web app.

        Returns a SaySpeakResponse with a `speak` field for the voice
        client to read back immediately ("Got it — working on it...");
        the assistant agent's actual reply arrives asynchronously and
        is read in the app.

        Auth: user JWT or assistant_token (Account Settings).
        """
        try:
            FileUtil.validate_fs_name(agent_name)
        except ValueError as e:
            raise HTTPException(400, f"Invalid agent name: {e}")
        user = await _resolve_voice_caller(authorization)
        return await _say_to_agent_dm(user, agent_name, text)

    @router.post("/me/assistant/say", response_model=SaySpeakResponse)
    async def say_to_assistant_legacy(
        text: str = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Legacy alias of POST /me/agents/assistant/say.

        Kept so the original assistant-only Shortcut keeps working. New
        documentation directs users to /me/agents/{agent_name}/say.
        """
        user = await _resolve_voice_caller(authorization)
        return await _say_to_agent_dm(user, "assistant", text)

    @router.post("/projects/{project_id}/chatrooms/{chatroom_name}/cancel")
    async def cancel_chatroom_invocation(
        project_id: str,
        chatroom_name: str,
        agent_id: str = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Cancel an agent's in-flight LLM invocation in a chatroom.

        Sends CANCEL_LLM over WebSocket to the agent's runner (which kills
        the subprocess), posts an ack message saying "Message canceled.",
        and clears the agent from any pending batch tracker so the typing
        indicator clears.

        Auth: only the project owner can cancel.
        """
        current_user = await ctx.auth.get_current_user(authorization)

        project = _project_or_404(project_id, ctx.model_ctx)
        if project.created_by != current_user.id:
            raise HTTPException(403, "Not authorized to cancel work in this project")

        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        cancel_envelope = ControlEnvelope(
            type=ControlMessageType.CANCEL_LLM,
            payload=CancelLLMPayload(
                agent_id=agent_id,
                project_id=project_id,
                chatroom_name=chatroom_name,
            ),
        )
        delivered = await ctx.ws_hub.send_to(agent_id, cancel_envelope)

        # Post the ack message as the agent. is_ack=True keeps it out of
        # batch-completion accounting (we clear the agent below explicitly).
        msg_id = str(uuid.uuid4())
        now = datetime.now(UTC)
        runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)
        entry = await runloop.append(
            ChangelogEntryType.MESSAGE,
            MessagePayload(
                chatroom_name=chatroom_name,
                id=msg_id,
                ts=now,
                from_participant_id=agent_id,
                from_participant_name=agent.name,
                content="Message canceled.",
                expects_response_from=[],
                is_ack=True,
            ),
        )

        # Clear the agent from any in-flight batch so the typing indicator
        # stops showing them as "thinking" and frees the chatroom for the
        # next user message. We deliberately do NOT trigger batch completion
        # here — a cancel is not a completed delivery. If this cancel empties
        # the batch (always true for DMs, sometimes true elsewhere), drop the
        # entry so the next user message can open a fresh PendingWork instead
        # of silently hitting ValueError in create_pending_work.
        # A managed job attached to this request is cancelled with it; its
        # supervisor sees the refusal on its next event and stops the work.
        open_work = await ctx.work_tracker.get_pending_work(project_id, chatroom_name)
        if open_work and open_work.managed_job_id and open_work.managed_job_owner_id == agent_id:
            await ctx.managed_job_store.cancel_by_server(
                open_work.managed_job_id, "request cancelled by the user"
            )
        work = await ctx.work_tracker.record_response(
            project_id, chatroom_name, agent_id, from_managed_job=True,
        )
        if work and work.is_complete:
            await ctx.work_tracker.clear_pending_work(project_id, chatroom_name)

        update_envelope = ControlEnvelope(
            type=ControlMessageType.CHANGELOG_UPDATE,
            payload=ChangelogUpdatePayload(
                project_id=project_id,
                project_name=project.name,
                new_version=entry.version,
                coordinator_id=project.coordinator_id,
            ),
        )
        await ctx.ws_hub.broadcast_to_project(update_envelope, project)

        return {"delivered": delivered, "message_id": msg_id}

    async def _load_forward(
        fwd: ForwardOf, note: str, authorization: str, username: str
    ) -> tuple[str, list[tuple[str, bytes]]]:
        """The forwarded body and its attachments, read from the source room.

        The caller must be able to READ the source room (same rule as
        ``GET .../messages``) — forwarding is never a way to see more.
        """
        src_project = _project_or_404(fwd.project_id, ctx.model_ctx)
        src_room = Chatroom.get(fwd.project_id, fwd.chatroom_name, ctx.model_ctx)
        if src_room is None:
            raise HTTPException(404, f"Chatroom {fwd.chatroom_name!r} not found")
        await _authorize_room_read(src_project, src_room, authorization, None)

        if not fwd.message_ids:
            raise HTTPException(400, "forward_of.message_ids is empty")
        entries = await asyncio.to_thread(src_room.get_log_entries)
        try:
            originals = find_messages(entries, fwd.message_ids)
        except KeyError as e:
            raise HTTPException(404, f"Message {e.args[0]!r} not found in {fwd.chatroom_name!r}")

        sender = Agent.get(originals[0].from_participant_id, ctx.model_ctx)
        sender_label = (
            sender.short_name_for(username)
            if sender is not None
            else originals[0].from_participant_name
        )
        content = compose_forward(note, sender_label, originals)

        available = attached_filenames(entries, originals)
        if fwd.include_files is None:
            chosen = available
        else:
            unknown = [f for f in fwd.include_files if f not in available]
            if unknown:
                raise HTTPException(400, f"files {unknown} did not ride with the forwarded message")
            chosen = [f for f in available if f in fwd.include_files]
        files: list[tuple[str, bytes]] = []
        for filename in chosen:
            raw = src_room.get_file(filename)
            # A file deleted since it was posted is skipped, not fatal: the
            # quote still carries the message, and the chip would be dead.
            if raw is not None:
                files.append((filename, raw))
        return content, files

    @router.post("/projects/{project_id}/chatrooms/{chatroom_name}/user-message", response_model=ChatMessage)
    async def post_user_message(
        project_id: str,
        chatroom_name: str,
        request: Request,
        body: UserMessageBody = Body(...),
        authorization: str = Header(default=""),
    ):
        """Post a message as a user (not an agent), optionally with attachments.

        Addressing is done via @mentions in the message content:
        - "@agent-name" in content -> agent is addressed and should respond
        - "agent-name" (no @) -> reference only, not addressed

        When ``files`` is non-empty, the attachments and the message are appended
        atomically so the files are present before the coordinator/agent is woken
        (see ``send_message_as_user``).

        Accepts a user JWT or the user's assistant-agent bearer token (the
        assistant posting on the user's behalf, e.g. ``clawmeets dm send``).
        """
        current_user, acting_agent = await ctx.auth.resolve_credential(authorization)

        project = _project_or_404(project_id, ctx.model_ctx)
        room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

        # The project owner can post directly. The requester of a cross-user
        # Front Desk DM channel can also post — but only to user-communication
        # (the channel they reach the host's agent through); ``created_by`` stays
        # the host. (In tunneled @mention FD projects the external requester
        # instead writes to their own local project and the server mirrors.)
        if project.created_by != current_user.id and not _is_fd_requester(project, room, current_user):
            raise HTTPException(403, "Not authorized to post to this project")
        _refuse_hub_thread(project)            # after the ownership check: only its owner learns it

        # Optional agent attribution: the caller may author this message as one
        # of their OWN agents (the assistant delegating to a foreign agent). The
        # agent must be owned by the resolved user; addressing/auth stay the
        # user's. from_participant_id becomes the agent so TunnelSubscriber keys
        # the front-desk thread by the requesting agent (see `_fd_routing`).
        author_id: Optional[str] = None
        author_name: Optional[str] = None
        if body.as_agent_id:
            as_agent = Agent.get(body.as_agent_id, ctx.model_ctx)
            if as_agent is None or as_agent.registered_by != current_user.id:
                raise HTTPException(
                    403, "as_agent_id must be an agent you own"
                )
            author_id = as_agent.id
            author_name = as_agent.name

        content = body.content
        decoded: list[tuple[str, bytes]] = []
        if body.forward_of:
            # A forward is the USER handing on another agent's words, so it is
            # never re-attributed to an agent.
            if body.as_agent_id:
                raise HTTPException(400, "forward_of cannot be combined with as_agent_id")
            content, decoded = await _load_forward(
                body.forward_of, body.content, authorization, current_user.username
            )

        # Decode + validate attachments (path traversal, per-file + total size).
        attached_files: list[tuple[str, bytes]] | None = None
        if body.files or decoded:
            total = sum(len(raw) for _, raw in decoded)
            for f in body.files:
                try:
                    raw = base64.b64decode(f.content_b64, validate=True)
                except (ValueError, TypeError):
                    raise HTTPException(400, f"file {f.filename!r} is not valid base64")
                try:
                    _validate_filename(f.filename, room.files_dir)
                except ValueError as e:
                    raise HTTPException(400, str(e))
                _check_upload_size(raw, f.filename)
                total += len(raw)
                decoded.append((f.filename, raw))
            limit = _max_message_attachments_bytes()
            if total > limit:
                raise HTTPException(
                    413,
                    f"attachments total {total} bytes, exceeds the {limit}-byte "
                    "per-message limit (raise CLAWMEETS_MAX_MESSAGE_ATTACHMENTS_BYTES)",
                )
            attached_files = decoded

        # The requester of a cross-user Front Desk DM channel is outside the
        # host's project: the inspection hook admits the message first.
        ticket = None
        if project.created_by != current_user.id:
            try:
                ticket = await _admit_fd_requester_post(
                    ctx, project, chatroom_name, current_user,
                    author_id or current_user.id, author_name or current_user.username,
                    content, attached_files or [], body.model_config_name,
                )
            except _HeldForReview as held:
                return held.response()

        return await send_message_as_user(
            ctx, current_user.id, current_user.username, project_id, chatroom_name,
            content, attached_files=attached_files,
            author_id=author_id, author_name=author_name,
            model_config_name=body.model_config_name,
            owner_post=True,
            client_request_id=request.headers.get(IDEMPOTENCY_HEADER),
            ingress_ticket=ticket,
            # Posted with the assistant's bearer: that agent is the one sending.
            via_agent_id=acting_agent.id if acting_agent is not None and author_id is None else None,
        )

    return router


FD_REQUESTER_POST = "fd_requester_post"


class _HeldForReview(Exception):
    """A requester post that was HELD, not refused: answered 202."""

    #: What the sender is told per hold reason. An inspector's own reason
    #: code is shown to the owner only, so the sender sees plain ``held``.
    _MESSAGES = {
        "flow_stopped": "Held for review: this conversation's inbound flow is stopped. "
                        "It is delivered when the owner reopens it; do not resend.",
        "inspector_error": "Held for review: the message check is unavailable. "
                           "It is delivered when the owner releases it; do not resend.",
        "requester_key_pending": "Held: this conversation is still being set up. "
                                 "It is delivered once that finishes; do not resend.",
        "held": "Held for review. It is delivered when the owner releases it; do not resend.",
    }

    def __init__(self, reason_code: Optional[str]) -> None:
        super().__init__(reason_code)
        self.reason = reason_code if reason_code in self._MESSAGES else "held"

    def response(self) -> JSONResponse:
        from clawmeets.server.hub.browser import HeldForReview

        return JSONResponse(status_code=202, content=HeldForReview(
            held=True, reason=self.reason, message=self._MESSAGES[self.reason],
        ).model_dump(mode="json"))


async def _admit_fd_requester_post(
    ctx: "ServerContext", project: Project, chatroom_name: str, user: User,
    author_id: str, author_name: str, content: str,
    attached_files: list[tuple[str, bytes]], model_config_name: Optional[str],
) -> object | None:
    """The inspection hook (path ``front_desk_requester``) for a requester
    posting straight into a cross-user Front Desk DM channel. Returns the
    ticket, or None when the author is not outside. Any HOLD (a stopped room,
    an inspector hold or timeout, a project still waiting for its
    requester key) raises ``_HeldForReview``: the route answers 202
    ``HeldForReview`` because the message is delivered on release, so the
    client must not resend. Only a BLOCK is a 403."""
    from clawmeets.models.provenance import outside_author
    from clawmeets.server.inspection import (
        FileRef, InspectionRequest, OutsidePath, Verdict,
    )

    ingress = getattr(ctx, "outside_ingress", None)
    if ingress is None or outside_author(project, author_id, ctx.model_ctx) is None:
        return None
    admission = await ingress.admit(InspectionRequest(
        path=OutsidePath.FRONT_DESK_REQUESTER, direction="inbound",
        owner_user_id=project.created_by or "", project_id=project.id, chatroom=chatroom_name,
        author_id=author_id, author_label=author_name, text=content,
        files=tuple(FileRef(name=n, sha256=FileUtil.sha256(raw), size=len(raw)) for n, raw in attached_files),
        source_ref=None,
    ), replay={
        "via": FD_REQUESTER_POST, "project_id": project.id, "chatroom": chatroom_name,
        "user_id": user.id, "username": user.username, "author_id": author_id,
        "author_name": author_name, "content": content, "model_config_name": model_config_name,
        "files": [[n, FileUtil.to_base64(raw)] for n, raw in attached_files],
    })
    if admission.passed:
        return admission.ticket
    if admission.verdict == Verdict.HOLD:
        raise _HeldForReview(admission.reason_code)
    raise HTTPException(403, "Not delivered.")


async def deliver_held_fd_requester_post(ctx: "ServerContext", replay, ticket) -> None:
    """A held direct Front Desk requester post, released on reopen."""
    await send_message_as_user(
        ctx, replay["user_id"], replay["username"], replay["project_id"], replay["chatroom"],
        replay["content"],
        attached_files=[(n, FileUtil.from_base64(b64)) for n, b64 in replay.get("files") or []] or None,
        author_id=replay["author_id"], author_name=replay["author_name"],
        model_config_name=replay.get("model_config_name"), owner_post=True, ingress_ticket=ticket,
    )


async def _dispatch_targets(
    ctx: "ServerContext",
    runloop,
    chatroom_name: str,
    *,
    message_id: str,
    message_version: int,
    coordinator_id: str,
    expects: list[str],
) -> list[str]:
    """Decide who a user message actually dispatches to, and record who it did not.

    Returns the subset of ``expects`` that has a live runner attached — the
    only ids a ``PendingWork`` should ever wait for — and appends one
    ``AGENT_OFFLINE`` row naming the rest.

    **Why this is at the door and not inside** :func:`_open_pending_batch`.
    The blast radius is identical either way (both scheduler paths arrive
    *through* :func:`send_message_as_user`), so this is a placement argument,
    not a coverage one: ``_open_pending_batch``'s job is mechanical — a typing
    indicator and something for ``BatchTimeoutChecker`` to expire — whereas
    deciding whether to dispatch at all is policy, and the doors are where
    ``message_id``, ``message_version``, ``coordinator_id`` and the resolved
    expects list already are.

    **Why the row and not a return value.** Three of the five callers of
    :func:`send_message_as_user` are background tasks with no HTTP response at
    all (``message_scheduler.py:140``, ``reflection_scheduler.py:215``,
    ``projects.py:926``), and the web UI rebuilds per-recipient state from the
    log stream rather than from the POST — so a response-only field renders
    once and vanishes on reload, which is the same silent stall this exists to
    forbid. ``ChatBatchTimeoutEvent`` is the precedent, mirrored line for line.

    **One row per message, never per outage.** The row is appended here, ahead
    of and outside :func:`_open_pending_batch`, so it cannot inherit that
    helper's ``PendingWork``-collision swallow. ``PendingWork`` is keyed
    ``(project_id, chatroom_name)``, so a second send into a room that already
    has an open batch is swallowed with a warning; an offline row swallowed the
    same way would paint the newer message PROCESSING and silently drop the
    older one to AWAITING, because the client's ``latestAddressingMessageId``
    has already advanced.

    **Narrowing is load-bearing, not cosmetic.** ``PendingWork.is_complete`` is
    ``set(expected) == set(responded)``, so an offline id left in the expected
    set means the mixed batch waits the whole window and dies in
    ``BATCH_TIMEOUT`` — the exact stall being fixed — while
    ``get_processing_agents`` renders the dead runner as an animated in-flight
    row for the duration. Returning early on an empty result is what removes
    the wait entirely in the all-offline case: no batch, no window, nothing for
    the timeout checker to expire, no ``CANCEL_LLM`` to an agent that is not
    there, and no coordinator wake for a batch that never started.

    **Not a retraction of delivery.** ``expects_response_from`` is already
    durable in the changelog before this runs and nothing here removes it, so
    when the runner comes back, catch-up replays the message and the agent
    answers — ``reactive_loop.py:1304-1310`` -> ``:1229-1246`` ->
    ``runloop.py:175-186`` -> ``participant_notifier.py:183-194`` ->
    ``agent.py:1089-1134``, with no age or freshness guard on any link. That
    late reply is picked up by ``record_response_opening_if_missing`` at the
    ``post_message`` guard above, so ``BATCH_COMPLETE`` still fires and the
    coordinator is still woken. The UI copy must therefore say the message is
    still queued, never "send it again".
    """
    if not expects:
        return []

    dispatched, offline = split_by_liveness(
        expects, ws_hub=ctx.ws_hub, model_ctx=ctx.model_ctx
    )
    if offline:
        # Ids, never names: the client indexes recipient status by id, so a
        # name would silently miss every lookup and leave the chip processing.
        # source_version points at the MESSAGE — the same key BATCH_TIMEOUT
        # already uses, and what makes the state attachable to a mention.
        await runloop.append(
            ChangelogEntryType.AGENT_OFFLINE,
            AgentOfflinePayload(
                chatroom_name=chatroom_name,
                message_id=message_id,
                coordinator_id=coordinator_id,
                offline_participants=list(offline),
                dispatched_participants=list(dispatched),
            ),
            source_version=message_version,
        )
    return dispatched


async def _open_pending_batch(
    ctx: "ServerContext",
    project: Project,
    chatroom_name: str,
    *,
    message_id: str,
    message_version: int,
    coordinator_id: str,
    expects: list[str],
) -> None:
    """Open the ``PendingWork`` batch a user-initiated message owes.

    Two effects, and both are why a message that skips this goes silently
    nowhere:
      1. ``WorkTracker.get_processing_agents`` lights up the typing indicator
         and exposes the cancel button while the responders are busy.
      2. ``BatchTimeoutChecker`` has something to expire, so an unanswered
         batch surfaces as ``BATCH_TIMEOUT`` instead of a recipient chip that
         reads "awaiting" forever.

    When responders reply (cleared via ``record_response`` in ``post_message``),
    BATCH_COMPLETE is routed to ``coordinator_id=user_id``. The user's reactive
    loop receives it and ``on_batch_complete`` is a no-op today — the
    assistant's filter at ``participant_notifier._notify_batch_complete``
    naturally skips the assistant since ``coordinator_id != assistant.id``, so
    this does NOT trigger the assistant's batch-review prompt.

    Shared by both user-message doors so the two cannot drift: a door that
    forgets this block is exactly the bug this helper was extracted to prevent.

    KNOWN LIMIT: ``PendingWork`` is keyed ``(project_id, chatroom_name)``
    (``work_tracker.py:61-62``), so a caller posting two addressed messages into
    ONE room opens a batch on the first and collides on the second — swallowed
    with a warning below. Only the first message gets a timeout backstop. The
    honest fix is a per-message batch key; until then this is the same
    behaviour two consecutive user messages to two agents already have.

    **The surface of that limit widened when ``plan-review`` merged into
    ``shared-context``.** The spec consultation used to have a room to itself,
    so its batch could not collide with anything; it now sits on
    ``(pid, "shared-context")``, and a user @-mentioning a specialist there
    while a consultation is open takes this branch. Accepted rather than fixed —
    re-keying ``PendingWork`` is a different change — but the warning is what
    keeps it from being silent, so it is asserted by test rather than assumed.

    ``expects`` is the set this batch will actually WAIT for, and the caller
    has already narrowed it — see :func:`_dispatch_targets`. This helper is
    mechanical on purpose: it opens the batch it is told to open. Deciding
    *whether* to dispatch, and to whom, is policy and lives one level up in
    the two user-message doors, where ``message_id``, ``message_version``,
    ``coordinator_id`` and the resolved expects list already are.
    """
    if not expects:
        return
    # The default window is raised by any responder whose card asks for a
    # longer one (`invoke_timeout_seconds`). ``expects`` is already the live subset, so an offline agent with a raised
    # `invoke_timeout_seconds` card can no longer inflate the live agents'
    # window. That is why the narrowing has to happen BEFORE this call.
    effective_timeout = resolve_batch_timeout(
        expects, default=ctx.batch_timeout, model_ctx=ctx.model_ctx,
    )
    try:
        await ctx.work_tracker.create_pending_work(
            message_id=message_id,
            message_version=message_version,
            project_id=project.id,
            project_name=project.name,
            chatroom_name=chatroom_name,
            coordinator_id=coordinator_id,
            expected_participants=expects,
            timeout_seconds=effective_timeout,
        )
    except ValueError:
        logger.warning(f"Pending work already exists for chatroom {chatroom_name}")


async def _broadcast_changelog(
    ctx: "ServerContext", project: Project, new_version: int
) -> None:
    """Push the changelog cursor to every participant's runner.

    The runner dispatches on CHANGELOG_UPDATE and nothing else
    (``reactive_loop.py:263-268``); a write that lands without this sits
    unfetched until some unrelated event pushes. Shared for the same reason as
    :func:`_open_pending_batch`.
    """
    envelope = ControlEnvelope(
        type=ControlMessageType.CHANGELOG_UPDATE,
        payload=ChangelogUpdatePayload(
            project_id=project.id,
            project_name=project.name,
            new_version=new_version,
            coordinator_id=project.coordinator_id,
        ),
    )
    await ctx.ws_hub.broadcast_to_project(envelope, project)


@dataclass
class AddressedMessage:
    """One message of a batch, with its addressees supplied by the caller."""

    chatroom_name: str
    content: str
    #: Explicit addressee participant ids. VALIDATED against the room's
    #: participants in :func:`send_addressed_messages_as_user` — this door can
    #: address nobody ``resolve_room_mentions`` could not.
    expects: list[str] = field(default_factory=list)
    #: Caller-chosen message id. The channel gateway derives it from the
    #: provider's event id so a retried flush can recognise its own message.
    message_id: Optional[str] = None
    #: Attribution override, as on :func:`send_message_as_user`: an outside
    #: contact (``contact:<id>`` + cleaned display name) writing over a channel.
    #: Authorization and the batch's coordinator stay the user's.
    author_id: Optional[str] = None
    author_name: Optional[str] = None


async def send_addressed_messages_as_user(
    ctx: "ServerContext",
    user_id: str,
    username: str,
    project_id: str,
    messages: Sequence[AddressedMessage],
    *,
    prelude_specs: Sequence[BatchEntrySpec] = (),
    ingress_tickets: Sequence[object] = (),
) -> list[ChatMessage]:
    """Post several user messages, to a caller-supplied addressee list, as ONE act.

    **Distinct from** :func:`send_message_as_user` **on purpose, and deliberately
    not a parameter on it.** That door reads addressees out of the message text,
    and outside ``user-communication`` deliberately reads none — because an
    ``@name`` in typed prose is a guess, and a stray one must not silently open a
    batch. This door is for a caller holding an explicit list the user built in a
    UI, which is not a guess. Folding the two into one function with an
    ``expects_override`` flag would let every future caller of the widely-used
    door address agents in any room; keeping them separate is what stops that.

    It is **not** a wider permission either way: every id is checked against the
    target room's participants below, so the reachable set is identical to what
    mention resolution would allow. Authorization is the route's, as it already
    is for every caller of :func:`send_message_as_user` — that function has never
    carried any, and its callers differ (``post_user_message`` checks
    ``project.created_by == current_user.id``, ``_wake_coordinator`` relies on
    the plan routes' ``_identity``, the scheduler on the schedule's owner).

    ``prelude_specs`` are appended ahead of every message, in order: the caller's
    own entries that must be on disk before any agent is woken. Same ordering
    rule ``attached_files`` already relies on — entries that wake nobody take the
    lower versions. Everything, prelude included, lands in ONE ``append_batch``,
    so a caller whose write and sends are one act stays one act.

    ``ingress_tickets``: the inspection hook's admissions of the outside
    messages in this batch (a channel contact's), handed to the append guard
    (server/inspection.py).

    An addressee that is not a participant of its room **raises**. The caller has
    already resolved the list against room membership; a leftover means two
    server-side filters disagree, which is drift worth failing loudly on rather
    than user input worth tolerating.
    """
    project = _project_or_404(project_id, ctx.model_ctx)

    rooms: dict[str, Chatroom] = {}
    for item in messages:
        if item.chatroom_name in rooms:
            continue
        room = Chatroom.get(project_id, item.chatroom_name, ctx.model_ctx)
        if room is None:
            raise HTTPException(404, f"Chatroom {item.chatroom_name!r} not found")
        rooms[item.chatroom_name] = room

    for item in messages:
        members = set(rooms[item.chatroom_name].participants)
        unknown = [pid for pid in item.expects if pid not in members]
        if unknown:
            raise ValueError(
                f"addressees {unknown} are not participants of "
                f"{item.chatroom_name!r} in project {project_id[:8]} — the "
                f"caller's addressee filter and the room's membership disagree"
            )

    # A paused channel thread (the owner has taken over): nothing written into
    # its user-communication room addresses anyone — same rule as
    # send_message_as_user, applied here for the plan-review owner poster and
    # the channel gateway's contact messages.
    channel_thread = channel_thread_for(ctx, project_id)
    paused = channel_thread is not None and channel_thread.paused

    def _expects(item: AddressedMessage) -> list[str]:
        if paused and rooms[item.chatroom_name].is_user_communication_room:
            return []
        return list(item.expects)

    specs: list[BatchEntrySpec] = list(prelude_specs)

    # Auto-reactivate, same rule and same ordering as send_message_as_user:
    # typing into a completed/failed task's user-communication resumes it, and
    # the flip must take a lower version than the MESSAGE so subscribers see
    # status=ACTIVE first. Riding this batch rather than a separate append also
    # means a reactivation cannot land without the message that caused it.
    reactivated = project.status != ProjectStatus.ACTIVE and any(
        rooms[item.chatroom_name].is_user_communication_room for item in messages
    )
    if reactivated:
        specs.append(
            BatchEntrySpec(
                entry_type=ChangelogEntryType.PROJECT_REACTIVATED,
                payload=ProjectReactivatedPayload(),
            )
        )

    drafted: list[tuple[str, datetime, AddressedMessage]] = []
    for item in messages:
        msg_id = item.message_id or str(uuid.uuid4())
        now = datetime.now(UTC)
        drafted.append((msg_id, now, item))
        specs.append(
            BatchEntrySpec(
                entry_type=ChangelogEntryType.MESSAGE,
                payload=MessagePayload(
                    chatroom_name=item.chatroom_name,
                    id=msg_id,
                    ts=now,
                    from_participant_id=item.author_id or user_id,
                    from_participant_name=item.author_name or username,
                    content=item.content,
                    expects_response_from=_expects(item),
                ),
            )
        )

    if not drafted:
        return []

    runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)
    ticket_kw = {"ingress_ticket": list(ingress_tickets)} if ingress_tickets else {}
    entries = await runloop.append_batch(specs, **ticket_kw)
    message_entries = entries[len(entries) - len(drafted):]

    sent: list[ChatMessage] = []
    for (msg_id, now, item), entry in zip(drafted, message_entries):
        sent.append(
            ChatMessage(
                id=msg_id,
                ts=now,
                from_participant_id=item.author_id or user_id,
                from_participant_name=item.author_name or username,
                content=item.content,
                expects_response_from=_expects(item),
                version=entry.version,
            )
        )
        dispatched = await _dispatch_targets(
            ctx,
            runloop,
            item.chatroom_name,
            message_id=msg_id,
            message_version=entry.version,
            coordinator_id=user_id,
            expects=_expects(item),
        )
        if dispatched:
            await _open_pending_batch(
                ctx,
                project,
                item.chatroom_name,
                message_id=msg_id,
                message_version=entry.version,
                coordinator_id=user_id,
                expects=dispatched,
            )

    # One push for the whole act — the runner syncs a cursor, not a message.
    # Read the cursor back rather than using `entries[-1].version`:
    # `_dispatch_targets` may have appended AGENT_OFFLINE rows above,
    # which would make that stale and under-push the newest entry.
    await _broadcast_changelog(ctx, project, runloop.get_current_version())

    # A reactivation moves a linked to-do from Completed back to Working, so the
    # owner's desk needs telling. THE TRIGGER IS THE ROUTE: the status flip is
    # applied by the changelog subscriber, which has no socket hub, so every
    # route that causes one carries this line. See `server/desk_todo_notify.py`.
    if reactivated:
        await notify_plate_of_project_change(ctx, project)

    return sent


async def send_message_as_user(
    ctx: "ServerContext",
    user_id: str,
    username: str,
    project_id: str,
    chatroom_name: str,
    content: str,
    attached_files: list[tuple[str, bytes]] | None = None,
    author_id: str | None = None,
    author_name: str | None = None,
    model_config_name: str | None = None,
    owner_post: bool = False,
    client_request_id: str | None = None,
    ingress_ticket: object | None = None,
    via_agent_id: str | None = None,
) -> ChatMessage:
    """Send a message as a user. Used by both the HTTP endpoint and the scheduler.

    Args:
        ctx: Server context with shared dependencies
        user_id: ID of the user sending the message (authorization + addressing)
        username: Username for from_participant_name
        project_id: Target project ID
        chatroom_name: Target chatroom name
        content: Message content (may contain @mentions)
        attached_files: Optional (filename, raw_bytes) pairs to attach. When
            present, the FILE_* entries and the MESSAGE entry are appended
            atomically (files first, message last) so the attachments are on
            disk before the coordinator/agent is woken, and each file's
            source_version points at the message.
        author_id / author_name: Optional attribution override. Defaults to the
            user. Set to one of the user's OWN agents (validated by the caller)
            so the message reads as "from the assistant" — used when the
            assistant delegates to a foreign front-desk agent, so the tunnel
            classifies the requester as an agent. Or an outside contact
            (``contact:<id>`` + their display name) writing in over a channel;
            ``user_id`` is then the thread's owner. Addressing
            (expects_response), the batch's coordinator and the
            auto-coordinator fallback still resolve from the room and
            ``user_id``, never the author.
        owner_post: True only from the owner's own HTTP post. In a channel
            thread's user-communication room that makes the message one the
            channel outbox sends to the contact (``channel_outbound``); no
            other caller — scheduler, plan routes — can send to an outside
            person through this function.
        ingress_ticket: The inspection hook's admission when the author is
            outside the project (a Front Desk requester posting directly),
            handed to the append guard (server/inspection.py).
        client_request_id: The caller's Idempotency-Key. Stamped on the
            MESSAGE entry; a retry whose first attempt already landed (core
            died before the idempotency middleware recorded the response) gets
            that message back instead of posting a second copy.

    Returns:
        The created ChatMessage

    Raises:
        HTTPException: If project or chatroom not found, or room type invalid
    """
    author_id = author_id or user_id
    author_name = author_name or username
    project = _project_or_404(project_id, ctx.model_ctx)
    room = Chatroom.get(project_id, chatroom_name, ctx.model_ctx)
    if room is None:
        raise HTTPException(404, f"Chatroom {chatroom_name!r} not found")

    resolved_expects: list[str] = []

    # user-communication, DM and shared-context rooms let the user address
    # agents. In a milestone workroom the user message is posted as context only
    # — @mentions are intentionally not resolved so no agent is addressed and no
    # batch is opened. Users who want to direct a worker's own work go through
    # user-communication so the coordinator can coordinate.
    #
    # `shared-context` is here because the spec consultation moved into it: the
    # coordinator relays the user's questions to the specialists in the room the
    # plan itself lives in, and the user is watching that happen with a live
    # composer (`ChatroomView.tsx` classifies it as not-a-workroom). Before this,
    # an @mention typed there posted as plain text and addressed nobody, with no
    # error — a quiet edge case that would now sit directly under a running
    # consultation. Widening the resolver rather than disabling the composer is
    # the deliberate choice: a user watching a spec review and wanting to ask the
    # specialist directly is the natural thing to want.
    #
    # No ACL widening comes with it. `resolve_room_mentions` only resolves agents
    # ALREADY in the room, so an out-of-room name is still ignored, and the Front
    # Desk requester ACL keys off `is_user_communication_name`, untouched.
    if room.is_user_communication_room or room.is_shared_context_room:
        # Address only the @mentions that resolve to a real agent in this room
        # (same rule as the agent post path). Unknown names / typos / out-of-
        # room agents are ignored (left as plain text) — the message still
        # posts. Uses the namespace-aware resolver (plain name AND ``{owner}-``
        # prefix).
        resolved_expects = resolve_room_mentions(
            room, content, ctx.model_ctx
        )

        # Note: foreign-@mention detection (FD + tunnel-binding creation) is
        # handled uniformly by TunnelSubscriber on the resulting MESSAGE entry —
        # no per-route eager pass needed.

        # For user-communication without an explicit @mention, the project's
        # coordinator is the implicit responder. In DM-shaped projects the
        # coordinator IS the partner agent, so this also covers the DM
        # auto-addressing case.
        #
        # **Deliberately user-communication ONLY.** A bare user message in
        # `shared-context` stays what it has always been — context — because
        # that room is also the team's file-drop stream, and waking the
        # coordinator on every line typed into it would turn a shared notepad
        # into a second inbox. In `shared-context` the user addresses somebody
        # or addresses nobody.
        # On a requester end the implicit responder is the counterpart (the
        # foreign agent the tunnel carries the message to), not the coordinating user.
        if not resolved_expects and room.is_user_communication_room and project.coordinator_id:
            resolved_expects = [project.counterpart_id or project.coordinator_id]

    # A channel thread (an outside contact's conversation with the agent).
    # Paused means the owner has taken over: NOTHING written into its
    # user-communication room addresses anyone, so no message — the owner's
    # included — wakes the agent. Applied here, at addressing time, so there is
    # no batch to filter out later and no dispatch to replay after a restart.
    channel_outbound = False
    if room.is_user_communication_room:
        channel_thread = channel_thread_for(ctx, project_id)
        if channel_thread is not None:
            if channel_thread.paused:
                resolved_expects = []
            channel_outbound = (
                owner_post and author_id == user_id and user_id == project.created_by
            )

    # Create message
    msg_id = str(uuid.uuid4())
    now = datetime.now(UTC)

    # Append to changelog and process through subscribers
    runloop = await ctx.runloop_manager.get_or_create(project_id, project.name)

    if client_request_id:
        prior = runloop.find_recent_by_request_id(author_id, client_request_id)
        if prior is not None:
            return ChatMessage.from_message_payload(
                prior.payload, version=prior.version, source_version=prior.source_version
            )

    # Auto-reactivate: typing into a completed/failed task's user-communication
    # resumes it. Mirrors PROJECT_COMPLETED's changelog-first flow so runners
    # pick the status flip up via normal sync — no separate broadcast needed.
    # Lands at a lower version than the subsequent MESSAGE so subscribers see
    # status=ACTIVE before the message is processed.
    if room.is_user_communication_room and project.status != ProjectStatus.ACTIVE:
        await runloop.append(
            ChangelogEntryType.PROJECT_REACTIVATED,
            ProjectReactivatedPayload(),
        )
        # Same reason as the batch door above: the status flip happens in a
        # hub-less changelog context, so the desk notification is the route's.
        await notify_plate_of_project_change(ctx, project)

    ticket_kw = {"ingress_ticket": ingress_ticket} if ingress_ticket is not None else {}
    message_payload = MessagePayload(
        chatroom_name=chatroom_name,
        id=msg_id,
        ts=now,
        from_participant_id=author_id,
        from_participant_name=author_name,
        content=content,
        expects_response_from=resolved_expects,
        model_config_name=model_config_name,
        channel_outbound=channel_outbound,
        client_request_id=client_request_id,
        via_agent_id=via_agent_id,
    )

    if attached_files:
        # Atomic: FILE_* entries first (they wake no agent), MESSAGE last so it
        # fires the notifier with attachments already on disk. Each file links
        # to the message's assigned version (resolved under the lock).
        message_index = len(attached_files)
        specs: list[BatchEntrySpec] = []
        for filename, raw in attached_files:
            entry_type = (
                ChangelogEntryType.FILE_UPDATED
                if room.file_exists(filename)
                else ChangelogEntryType.FILE_CREATED
            )
            specs.append(
                BatchEntrySpec(
                    entry_type=entry_type,
                    payload=FilePayload(
                        chatroom_name=chatroom_name,
                        filename=filename,
                        content_b64=FileUtil.to_base64(raw),
                        sha256=FileUtil.sha256(raw),
                        from_participant_id=author_id,
                        from_participant_name=author_name,
                    ),
                    link_to_index=message_index,
                )
            )
        specs.append(
            BatchEntrySpec(
                entry_type=ChangelogEntryType.MESSAGE,
                payload=message_payload,
            )
        )
        entries = await runloop.append_batch(specs, **ticket_kw)
        entry = entries[-1]
    else:
        entry = await runloop.append(
            ChangelogEntryType.MESSAGE,
            message_payload,
            **ticket_kw,
        )

    # Create ChatMessage for return value
    msg = ChatMessage(
        id=msg_id,
        ts=now,
        from_participant_id=author_id,
        from_participant_name=author_name,
        content=content,
        expects_response_from=resolved_expects,
        version=entry.version,
        model_config_name=model_config_name,
    )

    dispatched = await _dispatch_targets(
        ctx,
        runloop,
        chatroom_name,
        message_id=msg_id,
        message_version=entry.version,
        coordinator_id=user_id,
        expects=resolved_expects,
    )
    if dispatched:
        await _open_pending_batch(
            ctx,
            project,
            chatroom_name,
            message_id=msg_id,
            message_version=entry.version,
            coordinator_id=user_id,
            expects=dispatched,
        )
    # Cursor read back, not `entry.version`: `_dispatch_targets` may have
    # appended an AGENT_OFFLINE row above it.
    await _broadcast_changelog(ctx, project, runloop.get_current_version())

    return msg
