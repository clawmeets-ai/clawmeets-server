# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/public_requests/dispatch.py

Sending a public request to one matched agent, and reading back where that
conversation stands. Nothing new carries the message: each agent gets the
same thread a user would open by hand.

- **This server:** a fresh Front Desk requester thread
  (``_create_front_desk_requester_thread``), then the request posted as the
  user, exactly as ``POST .../user-message`` posts it.
- **Other servers:** a hub thread (``HubMirror.start_conversation``), then
  ``HubMirror.send``, charged against the same send windows as the hub route.
  An agent that is away still gets it: the request waits for it like any
  hub message does.

Status is read from the thread itself: an agent has responded once a
non-ack message from the thread's counterpart is in it.
"""
from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Literal, Optional

from fastapi import HTTPException

from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project, counterpart_of
from clawmeets.models.public_request import PublicRequest, RequestMatch
from clawmeets.models.user import User
from clawmeets.server.hub.browser import HubError

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

UC = "user-communication"

Status = Literal["not_sent", "working", "responded"]


def _send_guard(ctx: "ServerContext"):
    from clawmeets.server.hub.agent_send_guard import AgentSendGuard

    guard = getattr(ctx, "hub_send_guard", None)
    if guard is None:
        guard = AgentSendGuard(ctx.channel_store)
        ctx.hub_send_guard = guard
    return guard


async def _send_local(ctx: "ServerContext", user: User, request: PublicRequest, match: RequestMatch) -> str:
    from clawmeets.models.agent import Agent
    from clawmeets.server.routes.messages import send_message_as_user
    from clawmeets.server.routes.projects import _create_front_desk_requester_thread

    agent = Agent.get(match.agent_id or "", ctx.model_ctx)
    if agent is None:
        raise HubError("agent_not_found", "no such agent on this server")
    project = await _create_front_desk_requester_thread(ctx, user, agent.name)
    await send_message_as_user(
        ctx, user.id, user.username, project.id, UC, request.text, owner_post=True,
        client_request_id=f"public-request:{request.id}:{match.agent_ref}",
    )
    return project.id


async def _send_hub(ctx: "ServerContext", user: User, request: PublicRequest, match: RequestMatch) -> str:
    runtime = getattr(ctx, "hub_runtime", None)
    if runtime is None:
        raise HubError("hub_off_on_server", "the hub is off on this server")
    key = f"public-request:{request.id}:{match.agent_ref}"
    thread = await runtime.mirror.start_conversation(user, match.agent_ref, key,
                                                     deployment_name=match.deployment_name)
    _send_guard(ctx).charge(user_id=user.id, agent_id=None, target=thread.stand_in_id)
    await runtime.mirror.send(user, thread.project_id, text=request.text, client_message_id=key)
    return thread.project_id


async def send(ctx: "ServerContext", user: User, request: PublicRequest, match: RequestMatch) -> None:
    """Send ``request`` to ``match``'s agent, recording the thread (or why it
    failed) on ``match``. Never raises for one agent's failure: the others
    still go out."""
    if match.project_id is not None:
        return
    try:
        if match.kind == "local":
            match.project_id = await _send_local(ctx, user, request, match)
        else:
            match.project_id = await _send_hub(ctx, user, request, match)
    except HubError as exc:
        match.send_error = exc.code
        return
    except HTTPException as exc:
        match.send_error = "agent_not_found" if exc.status_code == 404 else "send_failed"
        return
    except Exception:
        logger.warning("Public request %s: sending to %s failed", request.id, match.agent_ref, exc_info=True)
        match.send_error = "send_failed"
        return
    match.sent_at = time.time()
    match.send_error = None


def thread_state(ctx: "ServerContext", match: RequestMatch) -> tuple[Status, Optional[float]]:
    """The match's status and when its agent first answered (epoch seconds)."""
    if match.project_id is None:
        return "not_sent", None
    try:
        counterpart = counterpart_of(Project.get(match.project_id, ctx.model_ctx))
    except ValueError:
        return "working", None
    room = Chatroom.get(match.project_id, UC, ctx.model_ctx)
    if room is None or counterpart is None:
        return "working", None
    for message in room.get_messages():
        if message.from_participant_id == counterpart and not message.is_ack:
            return "responded", message.ts.timestamp()
    return "working", None
