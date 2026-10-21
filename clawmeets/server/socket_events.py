# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/socket_events.py

The CORE half of every socket: what the server does when a runner, browser or
computer connects, reports in, or goes away — status changes and their
broadcast, the owner's runner-version snapshot, in-flight turn restore, host
records, home-folder replies.

The other half — accepting the socket, the auth handshake, the send and receive
loops, close codes — is transport, and lives in ``routes/websocket.py``. The
split is the seam for running the sockets in a separate process: there, the
same calls arrive over a link instead of from the endpoint, and nothing in here
changes. So nothing in here may touch a ``WebSocket``; a socket is only ever a
``ConnId`` handed back to the hub.

Every method assumes the hub's registry is already up to date: ``*_connected``
runs after the socket is registered, ``*_disconnected`` after it is removed.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, Optional

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    HostSyncPayload,
    InstallSyncPayload,
    RunnerVersion,
    RunnerVersionsPayload,
)
from clawmeets.api.host_protocol import (
    CLOSE_BAD_TOKEN,
    CLOSE_NO_HOST,
    HOST_HELLO,
    HOST_HEARTBEAT,
    HOST_STATE,
    HostHelloFrame,
    HostStateFrame,
)
from clawmeets.api.responses import AgentStatus
from clawmeets.models.agent import Agent
from clawmeets.models.host import (
    HostAgent,
    HostCommandResult,
    HostModelCLI,
    find_host,
    record_agent_snapshot,
    record_model_clis,
    record_terminal_enabled,
    touch_host,
    verify_host_token,
)
from clawmeets.models.project import Project
from clawmeets.server.in_flight_restore import (
    parse_in_flight_turns,
    restore_in_flight_turns,
)
from clawmeets.server.ws_hub import ConnId

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.context import ServerContext
    from clawmeets.server.in_flight_restore import ReportedTurn

logger = logging.getLogger("clawmeets.server")

# How long an agent whose last socket closed still counts as online. A runner
# that reconnects inside this window — a network blip, a proxy reload — never
# flips to offline and back, so nobody gets the pair of status broadcasts (each
# a scan of every project) and no coordinator sees its worker blink.
OFFLINE_GRACE_S = 20.0


@dataclass(frozen=True)
class ConnInfo:
    """What core knows about one live socket, beyond its ``ConnId``.

    ``owner_id`` / ``agent_name`` are set for runner sockets only — the same
    rule ``WSHub.connect`` relies on to keep browsers out of
    ``runners_for_owner``.
    """

    kind: Literal["agent", "user"]
    pid: str
    ip: Optional[str] = None
    clawmeets_version: Optional[str] = None
    owner_id: Optional[str] = None
    agent_name: Optional[str] = None
    capabilities: frozenset[str] = frozenset()


#: Close code: an owner's non-isolated agent on a host exposed by its
#: owner-isolated agent (plan-owner-isolation 5e). The runner backs off.
HOST_EXPOSED = 4403


@dataclass(frozen=True)
class SocketAuth:
    """The verdict on a runner's or computer's first frame.

    Refused: ``code`` / ``reason`` are what the socket is closed with. The two
    socket transports (``routes/websocket.py`` in-process, the edge over the
    link) both close with exactly these, which is what keeps the close codes
    of the two modes identical.
    """

    ok: bool
    code: int = 0
    reason: str = ""
    info: Optional[ConnInfo] = None          # runner sockets
    in_flight_turns: tuple = ()              # runner sockets
    owner_id: Optional[str] = None           # computer sockets
    hello: Optional[HostHelloFrame] = None   # computer sockets
    host_name: Optional[str] = None          # computer sockets, for logs


def check_agent_socket(
    agent_id: str, auth_msg: object, ip: Optional[str], model_ctx: "ModelContext",
    owner_isolation: object = None,
) -> SocketAuth:
    """Check a runner socket's auth frame and describe the socket.

    4004 when the agent is gone (the runner self-destructs on it rather than
    reconnect-looping on what looks like a bad token), 4001 for a bad token.
    """
    try:
        if not isinstance(auth_msg, dict):
            raise ValueError("auth frame is not an object")
        token = auth_msg.get("token", "")

        # Optional sibling of `token`. Three inputs, one read:
        #   {"token": …, "clawmeets_version": "1.2.10"} -> "1.2.10"
        #   {"token": …, "clawmeets_version": null}     -> None  (undeterminable)
        #   {"token": …}                                -> None  (older runner)
        # A non-string value is normalized to None — "undeterminable" is the
        # honest reading of a version we cannot interpret.
        reported_version = auth_msg.get("clawmeets_version")
        if not isinstance(reported_version, str):
            reported_version = None
        # Optional too: the optional frames this runner answers
        # (api/fs_protocol.FS_CAPABILITY, api/control.RESYNC_CAPABILITY).
        # Absent / not a list -> none, which is how an older runner is told
        # apart from a current one.
        reported_caps = auth_msg.get("capabilities")
        capabilities = frozenset(
            c for c in (reported_caps if isinstance(reported_caps, list) else ())
            if isinstance(c, str) and len(c) <= 64
        )
        # Optional: LLM turns still running on this runner. Lenient —
        # a malformed report drops entries, never the connection.
        in_flight_turns = parse_in_flight_turns(auth_msg.get("in_flight_turns"))

        participant = Agent.get(agent_id, model_ctx)
        if participant is None:
            return SocketAuth(False, 4004, "Participant not found")
        if not Agent.verify_token(agent_id, token, model_ctx):
            return SocketAuth(False, 4001, "Invalid token")
    except Exception as e:
        logger.warning(f"WebSocket auth failed for {agent_id}: {e}")
        return SocketAuth(False, 4001, "Auth failed")

    # Optional: what an unsandboxed turn on this runner's host could read
    # (plan-owner-isolation 5a). Absent or malformed -> unreported.
    if owner_isolation is not None:
        from clawmeets.server.owner_isolation import parse_host_report

        report = parse_host_report(auth_msg.get("host"))
        owner_isolation.observe(agent_id, report, live=True)  # type: ignore[attr-defined]
        # The owner's agent without the setting, on a host that ran an
        # owner-isolated agent's unsandboxed turns (section 5e).
        exposed = owner_isolation.refuse_on_exposed_host(participant, report)  # type: ignore[attr-defined]
        if exposed:
            return SocketAuth(False, HOST_EXPOSED, exposed)

    # Only runner sockets carry owner_id / agent_name — that is what keeps
    # browser sockets structurally out of every runners_for_owner result.
    return SocketAuth(
        True,
        info=ConnInfo(
            kind="agent",
            pid=agent_id,
            ip=ip,
            clawmeets_version=reported_version,
            owner_id=participant.registered_by,
            agent_name=participant.name,
            capabilities=capabilities,
        ),
        in_flight_turns=tuple(in_flight_turns),
    )


def check_host_socket(
    host_id: str, hello_raw: object, model_ctx: "ModelContext",
) -> SocketAuth:
    """Check a computer's ``host_hello``.

    The record is resolved FIRST, so "this computer was disconnected"
    (``CLOSE_NO_HOST`` — stop for good) is a different answer from "this
    token is wrong" (``CLOSE_BAD_TOKEN`` — may retry). The revoked case is
    ``CLOSE_NO_HOST`` because the credential was destroyed on purpose.
    """
    try:
        if not isinstance(hello_raw, dict) or hello_raw.get("type") != HOST_HELLO:
            return SocketAuth(False, CLOSE_BAD_TOKEN, "Expected host_hello")
        hello = HostHelloFrame.model_validate(hello_raw)
        participants_dir = model_ctx.participants_dir
        record = find_host(participants_dir, host_id)
        if record is None or record.is_revoked:
            return SocketAuth(False, CLOSE_NO_HOST, "Computer not connected")
        if not verify_host_token(participants_dir, host_id, hello.token):
            return SocketAuth(False, CLOSE_BAD_TOKEN, "Invalid token")
    except Exception as e:
        logger.warning(f"Host socket auth failed for {host_id}: {e}")
        return SocketAuth(False, CLOSE_BAD_TOKEN, "Auth failed")
    return SocketAuth(
        True, owner_id=record.owner_user_id, hello=hello, host_name=record.name,
    )


def get_status_broadcast_recipients(
    participant_id: str,
    ctx: "ServerContext",
) -> list[str]:
    """Find all participants in the same projects as this agent/assistant.

    Works for both worker agents and assistants:
    - Workers are in project.participating_agents
    - Assistants are project.coordinator_id

    Args:
        participant_id: The ID of the agent/assistant whose status changed
        ctx: Server context with model_ctx for filesystem access

    Returns:
        List of participant IDs (agents, assistants, or users)
    """
    recipients: set[str] = set()

    for project in Project.list_all(ctx.model_ctx):
        # Check if participant is involved in this project
        is_worker = participant_id in project.participating_agents
        is_coordinator = participant_id == project.coordinator_id

        if not is_worker and not is_coordinator:
            continue

        # Add all participating agents (workers)
        for agent_id in project.participating_agents:
            recipients.add(agent_id)

        # Add coordinator (assistant)
        recipients.add(project.coordinator_id)

        # Add project creator (user)
        recipients.add(project.created_by)

    # Always notify the agent's registrant even if the agent is not yet in
    # any project. The My Agents sidebar lists workers by registered_by, so
    # the owner needs status updates on agents they registered before those
    # agents have been added to a project.
    agent = Agent.get(participant_id, ctx.model_ctx)
    if agent and agent.registered_by:
        recipients.add(agent.registered_by)

    recipients.discard(participant_id)  # Don't include self
    return list(recipients)


async def push_runner_versions(
    user_id: str,
    ctx: "ServerContext",
    *,
    send_empty_on_error: bool,
) -> None:
    """Push one user's live-runner snapshot to every session they hold.

    Recipient is the ONE user, via ``WSHub.send_to`` — never
    ``get_status_broadcast_recipients``. The full argument lives on the
    ``RUNNER_VERSIONS`` enum member in ``api/control.py``; the short version is
    that the broadcast list spans every shared project and is consumed by other
    people's runners, so using it here would leak this user's agent names and
    version numbers across tenants. ``send_to`` fans out across the user's own
    tabs, so every one of them sees the identical snapshot.

    **This function never re-raises.** It is called from inside the socket
    lifecycle of BOTH the runner and the browser endpoints, so an escaping
    exception would take down a live socket. Hence the two nested guards: the
    inner one covers building the snapshot, the outer one covers ``send_to``
    itself. A failure here must not break the status broadcast — note the
    ordering at the runner sites, where ``broadcast_status_change`` runs FIRST
    and is never made conditional on this.

    ``send_empty_on_error`` splits the two kinds of call site:

    - ``True`` (initial push, browser connect) — on failure send
      ``{"runners": []}``. The client holds no prior state, so the key must be
      present and there is exactly one empty state to render.
    - ``False`` (update push, runner connect/disconnect) — on failure send
      **nothing at all**: no envelope, no empty ``runners`` key. The client
      already holds a correct list and its rule is *no envelope, or no
      ``runners`` key, means keep what you have*. That rule only works if we
      stay silent — replacing a correct list with ``[]`` over a transient
      error would silently erase banners that are still true.
    """
    try:
        try:
            payload = RunnerVersionsPayload(
                runners=[
                    RunnerVersion(id=r["id"], name=r["name"] or "", version=r["version"])
                    for r in ctx.ws_hub.runners_for_owner(user_id)
                ]
            )
        except Exception as e:
            logger.error(
                f"Runner-version snapshot failed for user {user_id}: {e}", exc_info=True
            )
            if not send_empty_on_error:
                return
            payload = RunnerVersionsPayload(runners=[])

        await ctx.ws_hub.send_to(
            user_id,
            ControlEnvelope(type=ControlMessageType.RUNNER_VERSIONS, payload=payload),
        )
        logger.debug(
            f"runner_versions -> user {user_id}: "
            f"{[(r.id, r.version) for r in payload.runners]}"
        )
    except Exception as e:
        logger.error(
            f"push_runner_versions failed for user {user_id}: {e}", exc_info=True
        )


async def push_install_sync(
    owner_user_id: str,
    step: str,
    state: str,
    ctx: "ServerContext",
) -> None:
    """Tell ONE user that their one-command install reported a step.

    Owner-scoped via ``WSHub.send_to``, the same rule as ``push_host_sync``: what
    is happening on someone's laptop mid-install is that user's business alone.

    **Never re-raises.** A missed push costs a welcome page that lags by one step
    until the next report arrives, because the payload is a cursor and the
    browser refetches. Failing the install script's progress POST over it would
    be strictly worse — the script treats a failed report as fatal to nothing,
    but a 500 is still a lie about what happened.
    """
    if not owner_user_id:
        return
    try:
        await ctx.ws_hub.send_to(
            owner_user_id,
            ControlEnvelope(
                type=ControlMessageType.INSTALL_SYNC,
                payload=InstallSyncPayload(step=step, state=state),
            ),
        )
    except Exception as e:
        logger.error(
            f"push_install_sync({step}/{state}) failed: {e}",
            exc_info=True,
        )


async def push_host_sync(
    owner_user_id: str,
    host_id: str,
    action: str,
    ctx: "ServerContext",
) -> None:
    """Tell ONE user that one of their computers moved.

    Recipient is ``host.owner_user_id`` via ``WSHub.send_to`` — the same rule,
    for the same reason, as ``push_runner_versions``: a machine's name, its
    software version and the roster of agents on it are that user's business
    alone, and ``get_status_broadcast_recipients`` spans other people's
    projects and other people's runners.

    **Never re-raises.** It is called from inside the host socket's lifecycle
    and from REST handlers; an escaping exception there would either kill a live
    socket or turn a successful rename into a 500. A missed push costs a stale
    page until the next one, because the payload is a cursor and the browser
    refetches.
    """
    if not owner_user_id:
        return
    try:
        await ctx.ws_hub.send_to(
            owner_user_id,
            ControlEnvelope(
                type=ControlMessageType.HOST_SYNC,
                payload=HostSyncPayload(host_id=host_id, action=action),
            ),
        )
    except Exception as e:
        logger.error(
            f"push_host_sync({action}) failed for host {host_id[:8]}: {e}",
            exc_info=True,
        )


def _to_host_model_cli(reported) -> HostModelCLI:
    """One reported model CLI, carried through as the machine described it.

    No narrowing to do — unlike an agent's ``state`` there is no enum here, only
    two booleans and some labels. It exists as a function anyway so the wire
    model and the stored model stay two types: the machine is untrusted, and
    handing its parsed frame straight to a persisted model is how that stops
    being true.
    """
    return HostModelCLI(
        id=reported.id,
        label=reported.label or reported.id,
        binary=reported.binary,
        present=reported.present,
        logged_in=reported.logged_in,
        version=reported.version,
    )


def _to_host_agent(reported) -> HostAgent:
    """One reported agent, narrowed to the three states the product knows.

    An unrecognized ``state`` becomes ``stopped`` rather than raising: a newer
    daemon inventing a fourth word must not take down the check-in that carries
    the other nine agents. "Stopped" is the safe reading — it never claims an
    agent is running when we cannot tell.
    """
    state = reported.state if reported.state in ("running", "crashed", "stopped") else "stopped"
    return HostAgent(
        short_name=reported.short_name,
        name=reported.name or reported.short_name,
        state=state,
        pid=reported.pid,
    )


class SocketEvents:
    """Core's reactions to socket lifecycle events. One per server process."""

    def __init__(
        self, ctx: "ServerContext", *, offline_grace_s: float = OFFLINE_GRACE_S,
    ) -> None:
        self._ctx = ctx
        self._offline_grace_s = offline_grace_s
        # agent_id -> the timer that will mark it offline unless it reconnects
        self._offline_timers: dict[str, asyncio.Task] = {}

    @classmethod
    def of(cls, ctx: "ServerContext") -> "SocketEvents":
        """``ctx.socket_events``, created on first use for contexts built by
        hand (tests) rather than by ``create_app``."""
        events = getattr(ctx, "socket_events", None)
        if events is None:
            events = cls(ctx)
            ctx.socket_events = events
        return events

    async def close(self) -> None:
        """Drop pending offline timers (server shutdown). The cards keep
        whatever they say; status shown to users is read from the live socket
        table, which is empty after a restart anyway."""
        timers = list(self._offline_timers.values())
        self._offline_timers.clear()
        for task in timers:
            task.cancel()
        await asyncio.gather(*timers, return_exceptions=True)

    # ---------------------------------------------------------------- agents

    async def agent_connected(
        self,
        conn: ConnId,
        info: ConnInfo,
        *,
        in_flight_turns: "list[ReportedTurn] | tuple" = (),
    ) -> None:
        """A runner socket passed auth and is registered with the hub.

        Restores the turns it reports as still running, marks it ONLINE and
        tells everyone who shares a project with it, then refreshes its owner's
        runner-version snapshot. A reconnect inside the offline grace skips the
        status change entirely: the offline broadcast never went out, so there
        is nothing to undo.
        """
        agent_id = info.pid
        participant = Agent.get(agent_id, self._ctx.model_ctx)
        if participant is None:
            return

        # A server that restarted mid-turn has forgotten this runner's open
        # batches; rebuild them so the desk keeps showing Working.
        if in_flight_turns:
            restored = await restore_in_flight_turns(agent_id, list(in_flight_turns), self._ctx)
            logger.info(
                f"Restored {restored}/{len(in_flight_turns)} in-flight turn(s) "
                f"for {participant.name}"
            )

        pending = self._offline_timers.pop(agent_id, None)
        if pending is not None:
            pending.cancel()
            logger.info(f"{participant.name} reconnected within the offline grace")
        else:
            await self._go_online(agent_id, participant.name)

        # A newly connected runner changes its owner's snapshot. Deliberately
        # OUTSIDE the `if recipients:` guard above and never conditional on it:
        # the status broadcast has already gone out by this point, and the
        # recompute is the owner's business whether or not the agent is in any
        # project yet.
        if participant.registered_by:
            await push_runner_versions(
                participant.registered_by, self._ctx, send_empty_on_error=False,
            )

        # Isolated work held while no capable runner was connected: replay it
        # (oldest first, a few per pass) or close what sat past its ceiling.
        gate = getattr(self._ctx, "isolation_gate", None)
        if gate is not None:
            gate.capabilities.observe_card(agent_id, participant._load_card())
            gate.schedule_replay(agent_id)
            # Able again: a later failure announces itself afresh. Reconnected
            # because its check failed: what it held meanwhile is announced.
            if gate.notice is not None and gate.can_serve(agent_id):
                gate.notice.on_capable(agent_id)
            elif gate.notice is not None:
                gate.notice.on_check_failed(agent_id)

        # Hub messages held while this runner was away are with it now.
        hub_runtime = getattr(self._ctx, "hub_runtime", None)
        if hub_runtime is not None:
            try:
                await hub_runtime.agent_connected(agent_id)
            except Exception as exc:  # noqa: BLE001 — never fails the socket
                logger.warning(f"Hub picked_up on connect failed: {type(exc).__name__}")

    async def _go_online(self, agent_id: str, agent_name: str) -> None:
        """Mark the agent ONLINE and tell everyone who shares a project."""
        p = Agent.get(agent_id, self._ctx.model_ctx)
        if p is None:
            return
        p.update_status(AgentStatus.ONLINE)
        # **Off the loop.** This scans every project directory and parses every
        # `meta.json` (~90 ms warm here, 1303 projects). It fires on connect AND
        # disconnect, so under a reconnect storm — 228 runners retrying on a 60 s
        # backoff — it alone burned ~40 s of event-loop time per minute, starving
        # the very handshakes that were retrying.
        recipients = await asyncio.to_thread(
            get_status_broadcast_recipients, agent_id, self._ctx
        )
        if recipients:
            await self._ctx.ws_hub.broadcast_status_change(
                agent_id=agent_id,
                agent_name=agent_name,
                new_status="online",
                recipient_ids=recipients,
            )

    async def agent_disconnected(self, conn: ConnId, info: ConnInfo) -> None:
        """A runner socket closed and the hub has forgotten it.

        Every home-folder request waiting on it fails at once. The owner's
        runner-version snapshot is refreshed now — the version died with the
        socket. If the agent holds no other socket, it goes offline once the
        grace runs out without a reconnect.
        """
        # Synchronous and first: every home-folder request waiting on THIS
        # socket fails as offline now, even if the awaits below are
        # interrupted by teardown.
        fs_relay = getattr(self._ctx, "home_fs_relay", None)
        if fs_relay is not None:
            fs_relay.socket_gone(conn)

        agent_id = info.pid
        if not self._ctx.ws_hub.is_connected(agent_id):
            if self._offline_grace_s > 0:
                self._start_offline_timer(agent_id)
            else:
                await self._go_offline(agent_id, off_loop=False)

        # The hub has already dropped this socket, so the snapshot excludes
        # the departed runner. Offline runners do not count.
        if info.owner_id:
            await push_runner_versions(
                info.owner_id, self._ctx, send_empty_on_error=False,
            )

    def agent_heartbeat(self, agent_id: str) -> None:
        """A runner's keep-alive: stamp ``last_heartbeat`` on its card."""
        p = Agent.get(agent_id, self._ctx.model_ctx)
        if p is not None:
            p.heartbeat()

    async def agent_fs_frame(self, conn: ConnId, raw: str | bytes) -> None:
        """An ``fs_reply`` / ``fs_chunk`` frame from runner socket ``conn``."""
        fs_relay = getattr(self._ctx, "home_fs_relay", None)
        if fs_relay is not None:
            await fs_relay.from_runner(conn, raw)

    def _start_offline_timer(self, agent_id: str) -> None:
        previous = self._offline_timers.pop(agent_id, None)
        if previous is not None:
            previous.cancel()
        self._offline_timers[agent_id] = asyncio.create_task(
            self._offline_after_grace(agent_id),
            name=f"offline-grace-{agent_id[:8]}",
        )

    async def _offline_after_grace(self, agent_id: str) -> None:
        await asyncio.sleep(self._offline_grace_s)
        # Leave the table before the first await below: from here on a
        # reconnect must take the full ONLINE path, not cancel this task.
        if self._offline_timers.get(agent_id) is asyncio.current_task():
            del self._offline_timers[agent_id]
        try:
            await self._go_offline(agent_id, off_loop=True)
        except Exception as e:
            logger.error(f"Offline transition failed for {agent_id}: {e}", exc_info=True)

    async def _go_offline(self, agent_id: str, *, off_loop: bool) -> None:
        """Mark the agent OFFLINE and tell everyone who shares a project.

        ``off_loop=False`` is the no-grace path, which runs inside a socket
        endpoint's ``finally:`` during teardown: there the handler task can
        already be cancelled, and an ``await`` on a worker thread would raise
        CancelledError and drop the broadcast. So the ~90 ms scan stays on the
        loop there. The grace timer is its own task and has no such problem.
        """
        p = Agent.get(agent_id, self._ctx.model_ctx)
        if p is None:
            return
        if off_loop:
            recipients = await asyncio.to_thread(
                get_status_broadcast_recipients, agent_id, self._ctx
            )
        else:
            recipients = get_status_broadcast_recipients(agent_id, self._ctx)
        # Re-checked after the scan: a runner that reconnected meanwhile has
        # already been marked ONLINE, and must not be overwritten.
        if self._ctx.ws_hub.is_connected(agent_id):
            return
        p.update_status(AgentStatus.OFFLINE)
        if recipients:
            await self._ctx.ws_hub.broadcast_status_change(
                agent_id=agent_id,
                agent_name=p.name,
                new_status="offline",
                recipient_ids=recipients,
            )

    # ----------------------------------------------------------------- users

    async def user_connected(self, conn: ConnId, info: ConnInfo) -> None:
        """A browser (or CLI listener) socket passed auth and is registered.

        INITIAL STATE — the first frame this browser sees, and the only push
        with send_empty_on_error=True. Nothing else is sent to a user socket
        on connect, and RUNNER_VERSIONS otherwise only fires when a runner
        connects or disconnects — so without this, a user opening the app
        while all their runners are already connected would see nothing until
        some runner happened to restart, possibly never. Re-arms on every
        socket reconnect.
        """
        await push_runner_versions(info.pid, self._ctx, send_empty_on_error=True)

    # ----------------------------------------------------------------- hosts

    async def host_connected(
        self, host_id: str, owner_id: str, hello: HostHelloFrame,
    ) -> None:
        """A computer passed auth and is registered with the hub.

        The machine re-describes itself on every connect (it may have been
        renamed by its OS, upgraded, or moved to a new OS version) and reports
        what is running. `None` fields mean "unchanged", so a daemon that
        reports less than it used to cannot blank the page.
        """
        participants_dir = self._ctx.model_ctx.participants_dir
        await touch_host(
            participants_dir, owner_id, host_id,
            daemon_version=hello.daemon_version,
            runner_version=hello.runner_version,
            hostname=hello.hostname,
            platform=hello.platform,
            os_version=hello.os_version,
        )
        if hello.agents:
            await record_agent_snapshot(
                participants_dir, owner_id, host_id,
                [_to_host_agent(a) for a in hello.agents],
            )
        # `is not None`, not truthiness: an EMPTY list is the machine saying it
        # looked and found no model CLI, which is a real finding the zero-state
        # checklist must show. Only a missing field means "did not tell us".
        if hello.model_clis is not None:
            await record_model_clis(
                participants_dir, owner_id, host_id,
                [_to_host_model_cli(c) for c in hello.model_clis],
                checked_at=hello.model_clis_checked_at,
            )
        await record_terminal_enabled(
            participants_dir, owner_id, host_id, hello.terminal_enabled
        )
        await push_host_sync(owner_id, host_id, "connected", self._ctx)

    async def host_frame(self, host_id: str, owner_id: str, data: dict) -> None:
        """One ``host_heartbeat`` or ``host_state`` frame from a computer.
        Other frame types are ignored here (terminal frames are transport)."""
        participants_dir = self._ctx.model_ctx.participants_dir
        kind = data.get("type")
        if kind == HOST_HEARTBEAT:
            await touch_host(participants_dir, owner_id, host_id)
        elif kind == HOST_STATE:
            try:
                frame = HostStateFrame.model_validate(data)
            except Exception as e:
                logger.warning(f"Bad host_state from {host_id}: {e}")
                return
            result = None
            if frame.result is not None:
                result = HostCommandResult(
                    command_id=frame.result.command_id,
                    action=frame.result.action,
                    agent=frame.result.agent,
                    ok=frame.result.ok,
                    detail=frame.result.detail,
                    finished_at=datetime.now(UTC).isoformat(),
                )
            await record_agent_snapshot(
                participants_dir, owner_id, host_id,
                [_to_host_agent(a) for a in frame.agents],
                command_result=result,
            )
            if frame.model_clis is not None:
                await record_model_clis(
                    participants_dir, owner_id, host_id,
                    [_to_host_model_cli(c) for c in frame.model_clis],
                    checked_at=frame.model_clis_checked_at,
                )
            if frame.daemon_version is not None or frame.runner_version is not None:
                await touch_host(
                    participants_dir, owner_id, host_id,
                    daemon_version=frame.daemon_version,
                    runner_version=frame.runner_version,
                )
            if frame.terminal_enabled is not None:
                await record_terminal_enabled(
                    participants_dir, owner_id, host_id, frame.terminal_enabled,
                )
            await push_host_sync(owner_id, host_id, "state", self._ctx)

    async def host_disconnected(self, host_id: str, owner_id: str) -> None:
        """A computer socket closed and the hub has forgotten it.

        Runs AFTER the disconnect, so the snapshot the browser refetches
        already reads this machine as offline — the same ordering the agent
        side uses for runner versions, and for the same reason.
        """
        await push_host_sync(owner_id, host_id, "disconnected", self._ctx)

    # ------------------------------------------------------------- relink

    async def reconcile(
        self,
        *,
        live: "list[tuple[ConnId, ConnInfo]]",
        arrived: "list[tuple[ConnId, ConnInfo]]",
        departed: "list[tuple[ConnId, ConnInfo]]",
        hosts: dict[str, dict],
        hosts_arrived: set[str],
        hosts_departed: dict[str, str],
        heartbeats: dict[str, str],
    ) -> None:
        """Square core's records with the sockets the edge really holds.

        Run once per link to the websocket edge, after the hub's mirror has
        been replaced by the edge's snapshot. ``arrived`` / ``departed`` are
        sockets the snapshot has and the previous mirror did not, and the other
        way round (on the first link of a process, everything has arrived).

        Nothing is re-announced that did not change: an agent that is live and
        already recorded ONLINE gets no broadcast, so a core restart makes no
        agent blink. An agent recorded ONLINE with no live socket — it left
        while core was down, or the last process died before recording it —
        takes the ordinary disconnect path, grace included. A live agent
        recorded OFFLINE takes the connect path. Computers get the state they
        reported while core was not listening.
        """
        fs_relay = getattr(self._ctx, "home_fs_relay", None)
        for conn, _ in departed:
            if fs_relay is not None:
                fs_relay.socket_gone(conn)

        live_agents = {info.pid for _, info in live if info.kind == "agent"}
        cards = await asyncio.to_thread(Agent.list_all_cards, self._ctx.model_ctx)
        recorded_online = {
            c["id"] for c in cards if c.get("status") == AgentStatus.ONLINE.value
        }
        names = {c["id"]: c.get("name") or "" for c in cards}

        # Read the recorded statuses BEFORE applying heartbeats: a heartbeat
        # also stamps ONLINE, and would hide an agent that needs the broadcast.
        for agent_id in heartbeats:
            if agent_id in live_agents:
                self.agent_heartbeat(agent_id)

        for agent_id in sorted(live_agents):
            pending = self._offline_timers.pop(agent_id, None)
            if pending is not None:
                pending.cancel()
            elif agent_id not in recorded_online and agent_id in names:
                try:
                    await self._go_online(agent_id, names[agent_id])
                except Exception as e:
                    logger.error(f"Reconcile: online transition failed for {agent_id}: {e}", exc_info=True)

        for agent_id in sorted(recorded_online - live_agents):
            if agent_id in self._offline_timers:
                continue
            if self._offline_grace_s > 0:
                self._start_offline_timer(agent_id)
            else:
                await self._go_offline(agent_id, off_loop=True)

        owners = {
            info.owner_id for _, info in (*arrived, *departed)
            if info.kind == "agent" and info.owner_id
        }
        for owner_id in sorted(owners):
            await push_runner_versions(owner_id, self._ctx, send_empty_on_error=False)

        for host_id, owner_id in hosts_departed.items():
            try:
                await self.host_disconnected(host_id, owner_id)
            except Exception as e:
                logger.error(f"Reconcile: host {host_id[:8]} disconnect failed: {e}", exc_info=True)
        for host_id, meta in hosts.items():
            owner_id = meta.get("owner_id")
            if not owner_id:
                continue
            try:
                if host_id in hosts_arrived and isinstance(meta.get("hello"), dict):
                    hello = HostHelloFrame.model_validate({**meta["hello"], "token": ""})
                    await self.host_connected(host_id, owner_id, hello)
                if isinstance(meta.get("last_state"), dict):
                    await self.host_frame(host_id, owner_id, meta["last_state"])
            except Exception as e:
                logger.error(f"Reconcile: host {host_id[:8]} replay failed: {e}", exc_info=True)
