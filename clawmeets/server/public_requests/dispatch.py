# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/public_requests/dispatch.py

Asking the hub to rank a public request, sending it to each agent the hub
picked, and reading back where each conversation stands. Nothing new carries
the message: each agent gets the same thread a user would open by hand.

- **A pick on this server:** a fresh Front Desk requester thread
  (``_create_front_desk_requester_thread``), then the request posted as the
  user, exactly as ``POST .../user-message`` posts it.
- **A pick on another server:** a hub thread opened under the ask's slot;
  the hub itself delivers the request. An agent that is away still gets it:
  the request waits for it like any hub message does.

Status is read from the thread itself: an agent has responded once a
non-ack message from the thread's counterpart is in it.

**Ranking is the hub's** (``ask_hub``): one signed ask goes to the hub with
``limit`` (1..3) pre-committed slots; the hub ranks and answers with a plan
before delivering anything. Each hub pick's thread is opened under its slot
(``RequesterMirror.open_dispatched_thread``; the hub delivers the request
itself), each pick on this server goes out as above; a plan with no picks
(``answer_yourself``) posts the request into a new DM thread with the user's
own assistant (``answer_yourself``).

There is no other ranking. When the hub cannot be used the ask fails with
``HTTPException`` and the request is left untouched (the caller stores
nothing): ``hub_required`` [409] when this server is not on the hub (off,
not registered, browse-only), ``hub_unavailable`` [503] when it is but the
hub cannot rank now (unreachable, untrusted, slow, ``ranking_unavailable``,
an older hub that does not know the frame), and ``rate_limited`` [429] with
``retry_after`` when the hub said so.

What the user did with the replies goes back to the hub (``report``), ids and
kinds only, never text.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import TYPE_CHECKING, Any, Iterable, Literal, Optional

from fastapi import HTTPException

from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project, counterpart_of
from clawmeets.models.public_request import PublicRequest, RequestMatch
from clawmeets.models.user import User
from clawmeets.hub_protocol.constants import MAX_DISPATCH_EXCLUDE, MAX_DISPATCH_SLOTS
from clawmeets.hub_protocol.ids import parse_agent_ref
from clawmeets.server.hub.browser import HubError

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger(__name__)

UC = "user-communication"

Status = Literal["not_sent", "working", "responded"]


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


async def send_local(ctx: "ServerContext", user: User, request: PublicRequest, match: RequestMatch) -> None:
    """Send ``request`` to a pick on this server, recording the thread (or why
    it failed) on ``match``. Never raises for one agent's failure: the others
    still go out."""
    if match.project_id is not None:
        return
    try:
        match.project_id = await _send_local(ctx, user, request, match)
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


# ── hub-ranked dispatch ───────────────────────────────────────────────────

#: The hub-state errors that mean this server is not on the hub at all.
_NOT_ON_HUB = frozenset({"hub_off_on_server", "hub_not_registered", "hub_discover_only"})


def _refuse(status: int, code: str, message: str, *, retry_after: Optional[float] = None) -> HTTPException:
    detail: dict[str, Any] = {"code": code, "message": message}
    headers = None
    if retry_after is not None:
        detail["retry_after"] = int(retry_after)
        headers = {"Retry-After": str(int(retry_after))}
    return HTTPException(status, detail=detail, headers=headers)


def hub_required() -> HTTPException:
    return _refuse(409, "hub_required", "public requests need this server to be on the ClawMeets Hub")


def hub_unavailable() -> HTTPException:
    return _refuse(503, "hub_unavailable", "the hub cannot rank this request right now")


#: Outcome reports in flight (fire-and-forget; kept so they are not collected).
pending_reports: set[asyncio.Task] = set()


def _runtime(ctx: "ServerContext"):
    runtime = getattr(ctx, "hub_runtime", None)
    if runtime is None or runtime.client is None or runtime.identity() is None:
        return None
    return runtime


def _address(agent_ref: str) -> Optional[dict[str, str]]:
    try:
        ref = parse_agent_ref(agent_ref)
    except ValueError:
        return None                                 # not a hub address
    return {"deployment_fingerprint": ref.deployment_fingerprint, "agent_name": ref.agent_name}


def _own_published(runtime, user: User) -> list[dict[str, str]]:
    """The user's own agents listed on the hub: never theirs to be asked."""
    from clawmeets.models.agent import Agent

    identity = runtime.identity()
    out = []
    for state in runtime.hub.channel_states():
        if not state.enabled:
            continue
        agent = Agent.get(state.agent_id, runtime._ctx.model_ctx)
        if agent is not None and agent.registered_by == user.id:
            out.append({"deployment_fingerprint": identity.genesis_fp, "agent_name": agent.name})
    return out


def _match_for_pick(runtime, plan, pick) -> RequestMatch:
    ref = f"{pick.agent.deployment_fingerprint}~{pick.agent.agent_name}"
    agent_id, kind, display, owner = None, "hub", pick.agent.agent_name, pick.deployment_name
    if pick.local:
        found = runtime.adapter.channel_for_agent_name(pick.agent.agent_name)
        if found is not None:
            agent = found[1]
            agent_id, kind = agent.id, "local"
            display = agent.public_chat["display_name"] or agent.name
    return RequestMatch(
        agent_ref=ref, kind=kind, agent_id=agent_id, name=pick.agent.agent_name, display_name=display,
        owner=owner, deployment_name=None if kind == "local" else pick.deployment_name,
        fit=int(round(pick.p_fit * 100)), score=pick.score,
        slot=pick.slot, ask_id=plan.ask_id, plan_id=plan.plan_id, p_fit=pick.p_fit,
    )


async def _send_pick(ctx: "ServerContext", runtime, user: User, request: PublicRequest,
                     match: RequestMatch, pick) -> None:
    """One live pick: a local agent gets today's Front Desk thread; a hub
    agent's thread is opened under its slot (the hub delivers the request)."""
    if match.kind == "local":
        await send_local(ctx, user, request, match)
        return
    try:
        thread = await runtime.mirror.open_dispatched_thread(user, pick, ask_id=match.ask_id, text=request.text)
    except HubError as exc:
        match.send_error = exc.code
        return
    except Exception:
        logger.warning("Public request %s: opening the dispatched thread for %s failed",
                       request.id, match.agent_ref, exc_info=True)
        match.send_error = "send_failed"
        return
    match.project_id = thread.project_id
    match.sent_at = time.time()


async def ask_hub(ctx: "ServerContext", user: User, request: PublicRequest, *, limit: int,
                  exclude: Iterable[str] = ()) -> None:
    """Ask the hub to rank and deliver ``request`` to at most ``limit``
    agents (see the module docstring). ``exclude``: agent refs already asked
    ("ask for more"). Raises ``HTTPException`` (``hub_required`` /
    ``hub_unavailable`` / ``rate_limited``) before touching ``request`` when
    there is no plan."""
    from clawmeets.server.hub.client import DispatchUnavailable

    runtime = getattr(ctx, "hub_runtime", None)
    if runtime is None:
        raise hub_required()
    try:
        await runtime.require_live(send=True)
    except HubError as exc:
        raise (hub_required() if exc.code in _NOT_ON_HUB else hub_unavailable()) from None
    if runtime.client is None or runtime.identity() is None:
        raise hub_unavailable()
    limit = max(1, min(limit, MAX_DISPATCH_SLOTS))
    slots = [str(uuid.uuid4()) for _ in range(limit)]
    excluded: list[dict[str, str]] = []
    for address in _own_published(runtime, user) + [a for a in map(_address, exclude) if a is not None]:
        if address not in excluded:
            excluded.append(address)
    ask_id = str(uuid.uuid4())
    try:
        signed = runtime.mirror.sign_ask(user, ask_id=ask_id, text=request.text, slots=slots,
                                         exclude=excluded[:MAX_DISPATCH_EXCLUDE])
        plan = await runtime.client.ask(signed)
    except DispatchUnavailable as exc:
        logger.info("Public request %s: the hub did not rank it (%s)", request.id, exc.code)
        if exc.code == "rate_limited":
            raise _refuse(429, "rate_limited", "too many requests; try again shortly",
                          retry_after=exc.retry_after) from None
        raise hub_unavailable() from None
    except HubError as exc:
        logger.info("Public request %s: hub ask not sent (%s)", request.id, exc.code)
        raise (hub_required() if exc.code in _NOT_ON_HUB else hub_unavailable()) from None
    if request.plan_id is None:
        request.ask_id, request.plan_id = plan.ask_id, plan.plan_id
    if plan.answer_yourself or not plan.picks:
        if not any(m.project_id for m in request.matches):
            request.answer_yourself = True
            request.fallback_project_id = await answer_yourself(ctx, user, request)
        return
    picks = [p for p in plan.picks if p.slot in slots]
    new = [(_match_for_pick(runtime, plan, p), p) for p in sorted(picks, key=lambda p: p.rank)]
    request.matches.extend(m for m, _ in new)
    await asyncio.gather(*(_send_pick(ctx, runtime, user, request, m, p) for m, p in new))


async def answer_yourself(ctx: "ServerContext", user: User, request: PublicRequest) -> Optional[str]:
    """No agent clearly fits: post the request as the user into a new DM
    thread with their own assistant. Returns that project id (None if the
    user has no assistant)."""
    from clawmeets.models.agent import Agent
    from clawmeets.server.routes.messages import send_message_as_user
    from clawmeets.server.routes.projects import _create_own_dm_thread_project

    assistant = Agent.get(user.assistant_id, ctx.model_ctx) if user.assistant_id else None
    if assistant is None:
        logger.info("Public request %s: nobody fits and the user has no assistant", request.id)
        return None
    project = await _create_own_dm_thread_project(ctx, user, assistant.name)
    request.fallback_agent_name = assistant.name
    await send_message_as_user(
        ctx, user.id, user.username, project.id, UC, request.text, owner_post=True,
        client_request_id=f"public-request:{request.id}:assistant",
    )
    return project.id


def outcome_events(request: PublicRequest, match: RequestMatch, kind: str) -> Optional[tuple[str, str, dict]]:
    """``(ask_id, plan_id, event)`` for one match, or None when there is no
    plan to report against (a match the plan never named, an agent with no
    hub address) or the kind was already reported."""
    if kind in match.outcomes_reported:
        return None
    ask_id, plan_id = match.ask_id or request.ask_id, match.plan_id or request.plan_id
    address = _address(match.agent_ref)
    if ask_id is None or plan_id is None or address is None:
        return None
    event: dict[str, Any] = {"agent": address, "kind": kind, "at": int(time.time())}
    if match.slot is not None:
        event["slot"] = match.slot
    return ask_id, plan_id, event


async def report(ctx: "ServerContext", user: User, request: PublicRequest,
                 events: list[tuple[str, str, dict]]) -> None:
    """Sign and send each plan's outcome events; one retry, then given up
    (the hub's record is best effort). Never raises."""
    from clawmeets.server.hub.client import DispatchUnavailable

    runtime = _runtime(ctx)
    if runtime is None or not events:
        return
    by_plan: dict[tuple[str, str], list[dict]] = {}
    for ask_id, plan_id, event in events:
        by_plan.setdefault((ask_id, plan_id), []).append(event)
    for (ask_id, plan_id), plan_events in by_plan.items():
        try:
            signed = runtime.mirror.sign_outcome(ask_id=ask_id, plan_id=plan_id, events=plan_events[:20])
        except Exception:
            logger.warning("Public request %s: outcome not signed", request.id, exc_info=True)
            continue
        for attempt in (1, 2):
            try:
                await runtime.client.report_outcome(signed)
                break
            except DispatchUnavailable as exc:
                logger.info("Public request %s: outcome report attempt %d failed (%s)",
                            request.id, attempt, exc.code)
            except Exception:
                logger.warning("Public request %s: outcome report failed", request.id, exc_info=True)
                break


def report_soon(ctx: "ServerContext", user: User, request: PublicRequest,
                events: list[tuple[str, str, dict]]) -> None:
    """``report`` in the background: the browser never waits on the hub."""
    if not events:
        return
    task = asyncio.ensure_future(report(ctx, user, request, events))
    pending_reports.add(task)
    task.add_done_callback(pending_reports.discard)
