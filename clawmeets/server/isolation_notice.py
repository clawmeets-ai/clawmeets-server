# SPDX-License-Identifier: BUSL-1.1
"""Telling people when an agent holds work because it cannot isolate.

The isolation gate (``server/isolation_gate.py``) holds a stranger's
conversation for an agent whose runners cannot run it sandboxed: its start-up
isolation check failed, or a settings change withdrew it. Holding is right;
holding silently was not. The requester was told nothing for up to 72 hours
(hub) or 7 days (Front Desk, channels), and the owner never learned that
their listed agent had stopped serving.

A runner cannot isolate in two states that look the same from here: its
check is still running (every start-up and every provider change, for
minutes) and its check failed. Only a failure is announced. The runner says
which one per socket: it advertises ``isolation_check_failed.v1`` once its
latest current check failed (``failing``), so a restart or a settings change
announces nothing unless the check really fails, and a failure that lands
while work is already held announces itself then (``on_check_failed``, from
the reconnect the failure triggers).

This module is the one home for that "your hand is needed" signal:

* **The owner** gets ONE email at their registered, verified address the
  first time work is held for the agent, then at most once a day while it
  keeps failing. It names the agent, how many conversations wait, why the
  last check failed and the command that re-runs it. No web notification.
  The owner's address is never shown to anyone else.
* **The requester** of a same-server Front Desk conversation gets one
  waiting note in the conversation, the first time it is held while a
  message of theirs is unanswered (the gate records a hold on any read of
  the project, not only when work is waiting). A hub
  requester is told in-protocol instead (``HubAdapter``'s held ack with
  ``detail="isolation_unavailable"``). A channel contact (email, chat app)
  gets nothing new: the outbox sends a contact only the agent's replies.
* **The re-check** an owner asks for (``routes/isolation_check.py``): what is
  running and the last result each runner reported, in memory.
* **The sweep**: held work past its ceiling is closed even while the agent
  stays incapable (``IsolationGate.expire_while_incapable``), and the daily
  owner reminder goes out from the same pass.

When the agent can serve again (``SocketEvents.agent_connected``) the notice
window and the per-conversation notes are cleared, so a later failure is
announced afresh.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Optional

from clawmeets.api.turn_protocol import ISOLATION_CHECK_FAILED_CAPABILITY
from clawmeets.models.agent import Agent
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.project import Project, scope_key
from clawmeets.models.user import User
from clawmeets.utils.email import EmailMessage, get_mailer

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server.isolation_notice")

#: Owner reminders: at most one per agent in this window.
OWNER_NOTICE_EVERY_S = 24 * 3600
SWEEP_INTERVAL_S = 3600.0
#: The detail a hub held ack carries for this reason (an open WireCode).
HUB_DETAIL = "isolation_unavailable"
#: The note a Front Desk / channel requester gets once per conversation.
SENDER_NOTE = (
    "Waiting: the agent's computer can't take this conversation safely yet, "
    "so it is held. Its owner has been notified; it will be answered once "
    "the agent can take it."
)
#: Requester keys whose conversation gets the waiting note: a same-server
#: Front Desk thread, whose room the tunnel mirrors to the requester. A hub
#: thread is told by its ack; a channel contact never sees a system message
#: (the outbox sends only replies); a project a scoped turn created has no
#: requester in it.
_NOTED_KEY_PREFIXES = ("account:",)


def unsupported_provider(agent: Agent) -> bool:
    """A provider whose check fails every time (the in-process ``-api``
    providers and smart routing have no scoped CLI wiring yet)."""
    card = agent._load_card() or {}
    provider = str((card.get("local_settings") or {}).get("llm_provider") or "claude")
    return provider.endswith("-api") or provider == "smart"


@dataclass
class CheckState:
    """One agent's isolation check as the server knows it."""

    state: str = "unknown"                 # running | passed | failed | unknown
    recheck_id: Optional[str] = None
    started_at: Optional[float] = None
    provider: Optional[str] = None
    kind: Optional[str] = None             # turn_protocol.CHECK_KINDS
    failures: list[str] = field(default_factory=list)
    checked_at: Optional[float] = None


class IsolationNotice:
    """Owner email, requester notes, re-check bookkeeping and the sweep."""

    def __init__(self, ctx: "ServerContext") -> None:
        self._ctx = ctx
        self._checks: dict[str, CheckState] = {}
        self._tasks: set[asyncio.Task] = set()
        #: Replaced in tests to capture what would be mailed.
        self.send_email = self._send_email

    @property
    def _gate(self):
        return self._ctx.isolation_gate

    # ── held work ────────────────────────────────────────────────────────

    def failing(self, agent_id: str) -> bool:
        """The agent's live runners say their latest check failed. False
        while a check is still running, for an offline agent (told its own
        way: the hub's held_agent_offline, the batch's offline note) and for
        a runner too old to say."""
        gate = self._gate
        return gate is not None and gate.capabilities.has(agent_id, ISOLATION_CHECK_FAILED_CAPABILITY)

    def on_held(self, agent_id: str, project: Optional[Project] = None) -> None:
        """Work for ``agent_id`` is held because it cannot isolate. Announced
        only when its check failed (``failing``). Sync (the gate's read paths
        are sync): the email and the note are scheduled. ``project`` is the
        held conversation, when there is one."""
        gate = self._gate
        if gate is None or not self.failing(agent_id):
            return
        if (project is not None and (scope_key(project) or "").startswith(_NOTED_KEY_PREFIXES)
                and _awaits_answer(project, agent_id, self._ctx.model_ctx)
                and gate.held.claim_sender_note(agent_id, project.id)):
            self._spawn(self._post_sender_note(project))
        if gate.held.claim_owner_notice(agent_id, time.time(), OWNER_NOTICE_EVERY_S):
            self._spawn(self._notify_owner(agent_id))

    def on_check_failed(self, agent_id: str) -> None:
        """A runner connected saying its check failed (``SocketEvents``):
        work held while it was still checking is announced now."""
        gate = self._gate
        if gate is None or not self.failing(agent_id):
            return
        held = gate.held.held_for(agent_id)
        for project_id, _held_at in held:
            try:
                project = Project.get(project_id, self._ctx.model_ctx)
            except ValueError:
                continue
            self.on_held(agent_id, project)
        if held:
            self.on_held(agent_id)       # the owner, even if no project could be read

    def on_capable(self, agent_id: str) -> None:
        """The agent can serve again: forget the window and the notes."""
        gate = self._gate
        if gate is not None:
            gate.held.clear_notices(agent_id)

    def held_count(self, agent_id: str) -> int:
        gate = self._gate
        return len(gate.held.held_for(agent_id)) if gate is not None else 0

    async def _post_sender_note(self, project: Project) -> None:
        from clawmeets.sync.changelog import ChangelogEntryType, MessagePayload

        try:
            runloop = await self._ctx.runloop_manager.get_or_create(project.id, project.name)
            await runloop.append(ChangelogEntryType.MESSAGE, MessagePayload(
                chatroom_name="user-communication", id=str(uuid.uuid4()), ts=datetime.now(UTC),
                from_participant_id="system", from_participant_name="ClawMeets",
                content=SENDER_NOTE, expects_response_from=[], is_ack=False,
            ))
        except Exception:  # noqa: BLE001 — a note never undoes the hold
            logger.warning("isolation waiting note for %s not posted", project.id[:8], exc_info=True)

    async def _notify_owner(self, agent_id: str) -> None:
        agent = Agent.get(agent_id, self._ctx.model_ctx)
        owner = User.get(agent.registered_by, self._ctx.model_ctx) if agent and agent.registered_by else None
        if agent is None or owner is None or not owner.email or not owner.email_verified:
            logger.info("isolation: no verified owner address for %s; nobody emailed", agent_id[:8])
            return
        message = owner_email(
            to_email=owner.email, username=owner.username,
            agent_short=agent.short_name_for(owner.username), held=self.held_count(agent_id),
            check=self._checks.get(agent_id), unsupported=unsupported_provider(agent),
        )
        await self.send_email(message)

    async def _send_email(self, message: EmailMessage) -> None:
        try:
            await get_mailer().send(message)
        except Exception:  # noqa: BLE001 — logged, never surfaced
            logger.exception("isolation notice to %s not sent", message.to_email)

    def _spawn(self, coro) -> None:
        try:
            task = asyncio.get_running_loop().create_task(coro)
        except RuntimeError:
            coro.close()
            return
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        """Wait for scheduled emails and notes (tests, shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # ── the sweep ────────────────────────────────────────────────────────

    async def sweep(self, *, now: Optional[float] = None) -> None:
        """Close held work past its ceiling for agents that still cannot
        isolate, and remind each one's owner (at most daily)."""
        gate = self._gate
        if gate is None:
            return
        for agent_id in gate.held.agents():
            if gate.can_serve(agent_id):
                continue
            try:
                await gate.expire_while_incapable(agent_id, now=now)
            except Exception:  # noqa: BLE001 — one agent never stops the rest
                logger.warning("isolation expiry for %s failed", agent_id[:8], exc_info=True)
            if gate.held.held_for(agent_id):
                self.on_held(agent_id)

    async def run_sweep(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL_S)
            try:
                await self.sweep()
            except Exception:  # noqa: BLE001
                logger.exception("isolation notice sweep failed")

    # ── re-checks ────────────────────────────────────────────────────────

    def check(self, agent_id: str) -> CheckState:
        return self._checks.setdefault(agent_id, CheckState())

    def start_check(self, agent_id: str, recheck_id: str, now: float) -> None:
        state = self.check(agent_id)
        state.state, state.recheck_id, state.started_at = "running", recheck_id, now

    def report_check(self, agent_id: str, *, recheck_id: Optional[str], provider: str, passed: bool,
                     kind: Optional[str], failures: list[str], now: float) -> None:
        """A runner reported a check (any check: start-up, settings change or
        requested). It ends a running request whatever its id: the runner
        answers a request that arrived mid-check with that check's result."""
        state = self.check(agent_id)
        state.state = "passed" if passed else "failed"
        state.recheck_id = recheck_id or state.recheck_id
        state.provider, state.kind, state.checked_at = provider, kind, now
        state.failures = list(failures)[:20]


def _awaits_answer(project: Project, agent_id: str, model_ctx) -> bool:
    """Whether the conversation's latest message (system notes aside) is the
    requester's, not the agent's: a read of a conversation the agent already
    answered holds nothing anyone is waiting for."""
    try:
        messages = Chatroom.get(project.id, "user-communication", model_ctx).get_messages()
    except Exception:  # noqa: BLE001 — no room, no one waiting
        return False
    for message in reversed(messages):
        if message.from_participant_id == "system" or message.is_ack:
            continue
        return message.from_participant_id != agent_id
    return False


def owner_email(*, to_email: str, username: str, agent_short: str, held: int,
                check: Optional[CheckState], unsupported: bool) -> EmailMessage:
    """The owner's notice: which agent, how many conversations wait, why, and
    what to do. Plain text: the action is a command, not a link. The reason
    is the first line the runner reported."""
    waiting = f"{held} conversation{'s' if held != 1 else ''}" if held else "Conversations"
    command = f"clawmeets agent isolation-check {agent_short}"
    reason = ""
    if check is not None and check.failures:
        reason = check.failures[0].splitlines()[0][:200]
    if unsupported or (check is not None and check.kind == "unsupported"):
        what = (f"{agent_short}'s model provider can't serve conversations from other people "
                "yet, so they are held. Switch the agent to a model CLI (claude, codex, gemini, "
                "opencode, antigravity) or turn its Hub listing off.")
    elif check is not None and check.kind == "temporary":
        what = (f"The last check hit a temporary problem. Re-run it: `{command}`, or "
                "\"Re-run check\" on the agent's Hub card.")
    else:
        what = (f"Fix what the check reports (for a login error, sign the model CLI in again "
                f"on that computer), then re-run it: `{command}`, or \"Re-run check\" on the "
                "agent's Hub card.")
    subject = f"{agent_short} can't take conversations from other people right now"
    intro = (f"{waiting} for {agent_short} {'are' if held != 1 else 'is'} waiting. Its computer "
             "failed the safety check that lets it run a stranger's conversation in a sandbox, "
             "so ClawMeets is holding them instead of running them unprotected.")
    body = (f"Hi {username},\n\n{intro}\n\n"
            + (f"Last check: {reason}\n\n" if reason else "")
            + f"{what}\n\nWhen the check passes, the waiting conversations are delivered and each "
            "sender is told. Held conversations are closed after 72 hours (hub) or 7 days.\n\n"
            "— ClawMeets\n")
    return EmailMessage(to_email=to_email, subject=subject, body=body,
                        log_label="Isolation notice")
