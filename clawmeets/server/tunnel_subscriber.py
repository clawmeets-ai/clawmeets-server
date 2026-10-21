# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/tunnel_subscriber.py

Cross-project message mirror for the LLM-routed tunnel between a requester
agent's project room and the responder's Front Desk project ``user-communication``.

Lives **server-side only** — registered as a ``ChangelogSubscriber`` on every
project's runloop. On each appended MESSAGE entry it consults the binding store
(:mod:`clawmeets.models.tunnel_binding`) and, if the project+room sit on
either end of a binding, appends a mirrored copy to the other end via the
same ``ChangelogRunloopManager`` — along with the side-effects that the
``send_message_as_user`` / ``post_message`` route handlers would have done
for a directly-posted message:

- `PROJECT_REACTIVATED` (when target is `user-communication` of a non-ACTIVE project).
- `CHANGELOG_UPDATE` broadcast via `WSHub` (so the target's participants' runners get a WS push).
- `WorkTracker` bookkeeping: `create_pending_work` on forward direction; `record_response` + `BATCH_COMPLETE` emission on reverse direction.

Loop-guard: every mirrored MESSAGE entry carries `mirrored_from` on the
`ChangelogEntry`; the subscriber returns immediately when that field is set
on an incoming entry. The synthetic ``PROJECT_REACTIVATED`` and
``BATCH_COMPLETE`` entries the mirror itself emits do NOT carry
``mirrored_from`` (they're target-local control entries, not mirrors), and
the entry-type filter on `on_entry` skips them anyway.

Attachments: a mirrored MESSAGE pulls its sibling FILE_CREATED / FILE_UPDATED
entries (those appended in the same atomic batch, carrying
``source_version == message.version``) and mirrors them alongside — appended
files-then-message on the target via ``append_batch`` so the target-side
``source_version`` points at the mirrored message. Incoming FILE_* entries do
NOT drive mirroring themselves (they hit the ``!= MESSAGE`` early return); the
MESSAGE is the sole driver, which keeps ordering deterministic.

Scope (MVP): mirror MESSAGE entries (with their attachments). PROJECT_COMPLETED
through the tunnel is still a TODO.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Mapping

from clawmeets.api.control import (
    ChangelogUpdatePayload,
    ControlEnvelope,
    ControlMessageType,
)

from clawmeets.server.batch_timeout import resolve_batch_timeout
from clawmeets.server.desk_todo_notify import notify_plate_of_project_change
from clawmeets.models.provenance import FOREIGN_KINDS
from clawmeets.server.coordinator_rule import clamp_foreign_expects
from clawmeets.sync.changelog import (
    BatchCompletePayload,
    ChangelogEntry,
    ChangelogEntryType,
    DisplayNameChangedPayload,
    FilePayload,
    MessagePayload,
    MirroredFromRef,
    ProjectReactivatedPayload,
    ProjectStatus,
    RoomDeletedPayload,
    is_contact_id,
)
from clawmeets.sync.runloop import BatchEntrySpec
from clawmeets.sync.subscriber import ChangelogSubscriber

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.models.work_tracker import WorkTracker
    from clawmeets.server.context import ServerContext
    from clawmeets.server.ws_hub import WSHub
    from clawmeets.sync.runloop_manager import ChangelogRunloopManager

logger = logging.getLogger("clawmeets.tunnel")


class TunnelSubscriber(ChangelogSubscriber):
    """Mirrors qualifying entries between bound rooms in two projects.

    Holds back-references to the server's ``runloop_manager``, ``ws_hub`` and
    ``work_tracker``. All three are late-bound after construction (the
    runloop manager and this subscriber have a chicken-and-egg setup; we
    keep the same pattern for the other two — see ``server/app.py``).

    Also lazily creates FD project + tunnel binding when an inbound MESSAGE in
    a regular project mentions a foreign agent (different owner). This is the
    single server-side detection path that replaces the previous runner-side
    router decorator and the eager pre-create calls in route handlers.
    """

    def __init__(self, model_ctx: "ModelContext") -> None:
        self._model_ctx = model_ctx
        self._runloop_manager: "ChangelogRunloopManager | None" = None
        self._ws_hub: "WSHub | None" = None
        self._work_tracker: "WorkTracker | None" = None
        self._server_ctx: "ServerContext | None" = None
        self._batch_timeout: int = 1800
        # Sender-side notes of the inspection hook, posted off the source
        # runloop (its lock is held while this subscriber runs).
        self._note_tasks: set[asyncio.Task] = set()

    def bind_runloop_manager(self, manager: "ChangelogRunloopManager") -> None:
        """Late-bind the runloop manager (constructed after this subscriber)."""
        self._runloop_manager = manager

    def bind_ws_hub(self, ws_hub: "WSHub") -> None:
        """Late-bind the WS hub (used for CHANGELOG_UPDATE broadcasts on mirror)."""
        self._ws_hub = ws_hub

    def bind_work_tracker(
        self, work_tracker: "WorkTracker", batch_timeout: int
    ) -> None:
        """Late-bind the work tracker (used for PendingWork bookkeeping on mirror)."""
        self._work_tracker = work_tracker
        self._batch_timeout = batch_timeout

    def bind_server_context(self, server_ctx: "ServerContext") -> None:
        """Late-bind the server context (needed by `_maybe_detect_and_route`
        when it invokes `ensure_fd_routing_for_foreign_agents`, which itself
        calls into project routes that consume the full ServerContext).
        """
        self._server_ctx = server_ctx

    async def on_entry(
        self,
        entry: ChangelogEntry,
        project_id: str,
        project_name: str,
    ) -> None:
        # Loop-guard.
        if entry.mirrored_from is not None:
            return
        # ROOM_DELETED: prune any binding whose local end references the
        # now-defunct room. Without this, a long-lived FD project accumulates
        # bindings to stale local rooms; the next
        # reverse mirror fan-outs into a deleted chatroom and raises
        # ValueError inside the requester runloop, surfacing as 500 to the
        # responder's ack POST and aborting its LLM invocation.
        if entry.entry_type == ChangelogEntryType.ROOM_DELETED:
            if isinstance(entry.payload, RoomDeletedPayload):
                self._prune_bindings_for_room(project_id, entry.payload.chatroom_name)
            return
        # DD-title: the host FD end is the only side with a running coordinator,
        # so it composes+applies the auto-title (DISPLAY_NAME_CHANGED). Mirror
        # that reverse into the bound requester (local) project so its row
        # re-titles too — the local end has no runloop to title itself. This is
        # the ONE non-MESSAGE entry the tunnel mirrors.
        if entry.entry_type == ChangelogEntryType.DISPLAY_NAME_CHANGED:
            await self._maybe_mirror_title(entry, project_id)
            return
        # Otherwise: only mirror MESSAGE entries.
        if entry.entry_type != ChangelogEntryType.MESSAGE:
            return
        if self._runloop_manager is None:
            logger.warning("TunnelSubscriber.on_entry called before bind_runloop_manager")
            return
        if not isinstance(entry.payload, MessagePayload):
            return
        # An outside contact's words are never carried into another account's
        # project, in either direction. Outbound is already closed by the rule
        # that only a thread's ordinary messages reach an outside person; this
        # closes inbound. A contact thread is never tunnel-bound in normal use,
        # so this only fires on an anomaly — and the safe response is nothing.
        # The message itself is already stored locally and notified there.
        if is_contact_id(entry.payload.from_participant_id):
            logger.debug(
                "tunnel: not mirroring contact message v%d in %s/%s",
                entry.version, project_id, entry.payload.chatroom_name,
            )
            return

        # A hub requester thread is a signed conversation with an agent on
        # another deployment: no local tunnel is ever created from it, and
        # nothing is mirrored into or out of it. Its text is a stranger's
        # agent's, and an @mention in it must not pull a local agent in.
        if self._is_hub_thread(project_id):
            logger.debug("tunnel: not routing hub thread message v%d in %s", entry.version, project_id)
            return

        # Cheap escape: import here so importing this module from tests/early
        # boot doesn't trigger the full model graph load.
        from clawmeets.models.tunnel_binding import find_bindings_for_project

        chatroom_name = entry.payload.chatroom_name

        # Detect foreign @mentions and lazily create FD project + binding.
        # Runs BEFORE the mirror loop so the just-created binding is picked
        # up in the same `on_entry` call and the triggering message itself
        # mirrors through it.
        await self._maybe_detect_and_route(entry, project_id, chatroom_name)

        # Mirroring is NOT load-bearing for the primary message: the source-side
        # append (and `send_message_as_user`'s coordinator wake-broadcast +
        # PendingWork) has already happened by the time `on_entry` runs as a
        # subscriber. A mirror failure must never propagate up through
        # `runloop.append` and abort that downstream broadcast/batch — otherwise
        # the addressed agent is never woken and sits AWAITING forever. Swallow
        # per-binding (mirrors `_maybe_detect_and_route`'s own error handling).
        for binding in find_bindings_for_project(project_id, self._model_ctx):
            try:
                await self._maybe_mirror(entry, project_id, chatroom_name, binding)
            except Exception:
                logger.exception(
                    "tunnel: mirror failed for v%d %s/%s via binding %s",
                    entry.version,
                    project_id,
                    chatroom_name,
                    getattr(binding, "binding_id", "?"),
                )

    def _is_hub_thread(self, project_id: str) -> bool:
        from clawmeets.models.project import Project, is_untrusted_source

        try:
            project = Project.get(project_id, self._model_ctx)
        except ValueError:
            return False
        return project is not None and is_untrusted_source(project)

    def _prune_bindings_for_room(self, project_id: str, chatroom_name: str) -> None:
        """Delete every TunnelBinding whose local end matches (project_id, chatroom_name).

        Idempotent. Binding count is small per CLAUDE.md, so the linear scan
        is fine.
        """
        from clawmeets.models.tunnel_binding import delete_binding, list_bindings

        for binding in list_bindings(self._model_ctx):
            if (
                binding.local_project_id == project_id
                and binding.local_room == chatroom_name
            ):
                delete_binding(binding.binding_id, self._model_ctx)
                logger.info(
                    "tunnel: pruned binding %s for deleted room %s/%s",
                    binding.binding_id,
                    project_id,
                    chatroom_name,
                )

    async def _maybe_detect_and_route(
        self,
        entry: ChangelogEntry,
        project_id: str,
        chatroom_name: str,
    ) -> None:
        """Inspect this MESSAGE for foreign @mentions; ensure FD + binding if any.

        Idempotent: if a matching FD project + binding already exist they are
        reused. Errors are logged + swallowed per-mention so the primary
        message append is never blocked by routing.

        Skipped silently when:
        - the message has no @mentions to resolve
        - the project's surface is not routable (only "regular", "dm",
          "frontdesk" are inspected)
        - the project is the TERMINAL / host end of a cross-account thread
          (its coordinator is owned by its creator) — routing there would
          regress into creating an FD-of-an-FD / self-binding
        - the sender cannot be resolved to a User or Agent
        - no resolved mention is owned by a different user than the sender
        """
        if self._server_ctx is None:
            return
        if not isinstance(entry.payload, MessagePayload):
            return

        from clawmeets.models.agent import Agent
        from clawmeets.models.chatroom import Chatroom
        from clawmeets.models.project import Project
        from clawmeets.models.user import User
        from clawmeets.server.routes._fd_routing import (
            ensure_fd_routing_for_foreign_agents,
        )

        project = Project.get(project_id, self._model_ctx)
        if project is None or project.surface not in ("regular", "dm", "frontdesk"):
            return

        # Terminal / host-end gate (DD1). A dm-shaped project whose coordinator
        # is owned by its creator is the RESPONDER side — someone reached IN to
        # my agent. Only the REQUESTER side routes; routing on the host side
        # would create an FD-of-an-FD (self-binding / infinite regress).
        #
        # This SINGLE positive gate replaces the two old ``is_dm_project``
        # coordinator-drops (the own-DM skip and the shared-FD coordinator drop):
        #   - own DM  (surface "dm", coordinator = my own agent) -> host-side
        #     True -> skip, exactly as the old own-DM guard did (cross-user
        #     delegation must not bleed a tunnel out of a 1:1 with my own agent).
        #   - legacy shared "-fd-" row (surface "dm", coordinator = the foreign
        #     agent, created_by = the host) -> host-side True -> skip, so the
        #     requester's message still reaches the agent via the shared row's
        #     own coordinator-wake and NO second tunnel double-answers.
        #   - new frontdesk host end (surface "frontdesk") -> host-side True ->
        #     terminal, as required.
        #   - new frontdesk requester end (surface "frontdesk", coordinator =
        #     foreign) -> host-side False -> routes.
        #   - regular project (path B local end) -> not dm-shaped -> routes.
        #
        # NOTE (deviation from the plan's literal ``is_frontdesk_project`` scope,
        # reviewer-sanctioned): the gate is scoped to ``is_dm_shaped`` so it ALSO
        # catches legacy ``surface == "dm"`` shared rows. The plan's narrower
        # ``is_frontdesk_project`` scope relied on the DD5 migration flipping
        # those legacy rows to ``frontdesk`` in lockstep with this code land; but
        # DD5 is dry-run-only (no data mutation now), so the flip can't happen
        # yet. Broadening the gate is the alternative the design gate explicitly
        # offered to close the transient double-answer window without a data
        # mutation. Legacy own/shared rows are already terminal by construction,
        # so this is behavior-preserving for them.
        if project.is_dm_shaped and project.frontdesk_is_host_side(self._model_ctx):
            return

        # A regular project's user-communication is strictly the requester's
        # private line to their OWN coordinator (their assistant) — never a
        # foreign delegation channel. The initial project request is posted here
        # verbatim as "@{coordinator} {request}", and that request text often
        # names foreign roster agents (milestone owners); without this gate those
        # names would spuriously spawn a user->foreign tunnel that bypasses the
        # coordinator. Foreign delegation only ever happens in WORK rooms (the
        # coordinator @mentions the foreign agent there), so those still route.
        # Direct foreign DMs use surface="frontdesk" (not "regular"), so their
        # user-communication detection is unaffected.
        if project.surface == "regular" and chatroom_name == "user-communication":
            return

        try:
            room = Chatroom.get(project_id, chatroom_name, self._model_ctx)
        except (ValueError, FileNotFoundError):
            return
        if room is None:
            return

        sender_id = entry.payload.from_participant_id
        local_user = User.get(sender_id, self._model_ctx)
        local_agent = None
        if local_user is None:
            local_agent = Agent.get(sender_id, self._model_ctx)
        if local_user is None and local_agent is None:
            return
        sender_owner_id = (
            local_user.id if local_user is not None
            else (local_agent.registered_by or "")
        )
        if not sender_owner_id:
            return

        # (The own-DM / shared-FD coordinator drops that used to live here are
        # gone — the host-end terminal gate above subsumes both. See DD1.)

        # Candidate foreign agents come from two sources:
        # 1. `@mention`s parsed out of the message content (the explicit case).
        # 2. The server-resolved `expects_response_from` list. For
        #    user-communication rooms without explicit @mentions the server
        #    auto-adds the project coordinator (see send_message_as_user's
        #    user-comm auto-coordinator fallback); if the coordinator is a
        #    foreign agent (FD-shaped project), this second source seeds the
        #    tunnel binding even when the user typed no @mention.
        foreign_agents: list[Agent] = []
        seen: set[str] = set()
        for mention in room.parse_mentions(entry.payload.content):
            agent = room.resolve_mention(mention)
            if agent is None:
                continue
            if not agent.registered_by or agent.registered_by == sender_owner_id:
                continue
            if agent.id in seen:
                continue
            seen.add(agent.id)
            foreign_agents.append(agent)
        for participant_id in entry.payload.expects_response_from:
            if participant_id in seen:
                continue
            agent = Agent.get(participant_id, self._model_ctx)
            if agent is None:
                continue
            if not agent.registered_by or agent.registered_by == sender_owner_id:
                continue
            seen.add(agent.id)
            foreign_agents.append(agent)

        # (No coordinator-drop needed: the requester-side project and the host FD
        # project are always distinct ids by construction — DD1 — so a
        # self-binding cannot occur, and the host end is already excluded by the
        # terminal gate above. The `_maybe_mirror` self-binding guard remains as
        # defense-in-depth but never triggers for the split model.)

        if not foreign_agents:
            return

        try:
            await ensure_fd_routing_for_foreign_agents(
                self._server_ctx,
                local_project=project,
                local_room=chatroom_name,
                foreign_agents=foreign_agents,
                local_user=local_user,
                local_agent=local_agent,
            )
        except Exception:
            logger.exception(
                "tunnel: detect+route failed for v%d %s/%s",
                entry.version,
                project_id,
                chatroom_name,
            )

    async def _maybe_mirror_title(
        self,
        entry: ChangelogEntry,
        host_project_id: str,
    ) -> None:
        """Mirror a host-composed DM-thread title REVERSE into the bound
        requester (local) project so its row re-titles (DD-title).

        Only fires host->local: for a binding whose ``fd_project_id`` is this
        project. The reverse ``DISPLAY_NAME_CHANGED`` carries ``mirrored_from`` so
        ``on_entry`` short-circuits it (no re-mirror loop), and the server's
        ModelContext subscriber applies it to the local project's meta.json. A
        ``CHANGELOG_UPDATE`` broadcast makes the requester's live sidebar refetch.
        """
        if self._runloop_manager is None:
            return
        if not isinstance(entry.payload, DisplayNameChangedPayload):
            return

        from clawmeets.models.project import Project
        from clawmeets.models.tunnel_binding import find_bindings_for_project

        display_name = entry.payload.display_name
        for binding in find_bindings_for_project(host_project_id, self._model_ctx):
            # Reverse only: this project must be the FD (host) end of the binding.
            if binding.fd_project_id != host_project_id:
                continue
            try:
                local_proj = Project.get(binding.local_project_id, self._model_ctx)
            except (ValueError, FileNotFoundError):
                continue
            try:
                runloop = await self._runloop_manager.get_or_create(
                    binding.local_project_id, local_proj.name
                )
                title_entry = await runloop.append(
                    ChangelogEntryType.DISPLAY_NAME_CHANGED,
                    DisplayNameChangedPayload(
                        project_id=binding.local_project_id,
                        display_name=display_name,
                    ),
                    mirrored_from=MirroredFromRef(
                        project_id=host_project_id,
                        version=entry.version,
                    ),
                )
            except Exception:
                logger.exception(
                    "tunnel: title reverse-mirror failed for v%d %s -> %s",
                    entry.version,
                    host_project_id,
                    binding.local_project_id,
                )
                continue
            logger.info(
                "tunnel: mirrored title v%d %s -> %s (%r)",
                entry.version,
                host_project_id,
                binding.local_project_id,
                display_name,
            )
            if self._ws_hub is not None:
                envelope = ControlEnvelope(
                    type=ControlMessageType.CHANGELOG_UPDATE,
                    payload=ChangelogUpdatePayload(
                        project_id=binding.local_project_id,
                        project_name=local_proj.name,
                        new_version=title_entry.version,
                        coordinator_id=local_proj.coordinator_id,
                    ),
                )
                try:
                    await self._ws_hub.broadcast_to_project(envelope, local_proj)
                except Exception:
                    logger.exception(
                        "tunnel: WS broadcast failed for mirrored title v%d",
                        title_entry.version,
                    )

    async def _gather_attachments(
        self,
        src_project_id: str,
        message_version: int,
    ) -> list[tuple[ChangelogEntryType, FilePayload]]:
        """Fetch the FILE_* entries appended in the same atomic batch as a
        message (i.e. ``source_version == message_version``) on the source side.

        Returns (entry_type, FilePayload) pairs in version order — empty when
        the message carried no attachments.
        """
        if self._runloop_manager is None:
            return []
        from clawmeets.models.project import Project

        src_proj = Project.get(src_project_id, self._model_ctx)
        if src_proj is None:
            return []
        runloop = await self._runloop_manager.get_or_create(
            src_project_id, src_proj.name
        )
        out: list[tuple[ChangelogEntryType, FilePayload]] = []
        for e in runloop.get_entries_by_source_version(message_version):
            if e.entry_type in (
                ChangelogEntryType.FILE_CREATED,
                ChangelogEntryType.FILE_UPDATED,
            ) and isinstance(e.payload, FilePayload):
                out.append((e.entry_type, e.payload))
        out.sort(key=lambda pair: pair[1].filename)
        return out

    async def _maybe_mirror(
        self,
        entry: ChangelogEntry,
        project_id: str,
        chatroom_name: str,
        binding,  # TunnelBinding (avoid runtime import in signature)
    ) -> None:
        from clawmeets.models.project import Project

        # Never mirror a message onto itself. A degenerate self-binding
        # (local end == fd end) would otherwise re-append the same message into
        # the room it already lives in. The detection-side filter prevents such
        # bindings from being created; this is the last line of defense.
        if (
            binding.local_project_id == binding.fd_project_id
            and binding.local_room == "user-communication"
        ):
            return

        # Forward: requester local room → responder FD user-communication.
        if (
            project_id == binding.local_project_id
            and chatroom_name == binding.local_room
        ):
            # Partition by sender principal: only mirror when this message's
            # sender is the binding's requester. Without this, a regular
            # project with both `user` and `agent` bindings would mirror
            # every message to every binding, conflating the user and their
            # assistant inside a single foreign-side FD channel.
            if entry.payload.from_participant_id != binding.requester_id:
                return
            # Gather sibling attachments only once we know a mirror will happen.
            attachments = await self._gather_attachments(project_id, entry.version)
            fd_proj = Project.get(binding.fd_project_id, self._model_ctx)
            await self._mirror(
                target_project_id=binding.fd_project_id,
                target_project_name=fd_proj.name,
                target_chatroom="user-communication",
                src_project_id=project_id,
                src_payload=entry.payload,
                src_version=entry.version,
                direction="forward",
                attachments=attachments,
                responder_id=binding.foreign_agent_id,
            )
            return

        # Reverse: responder FD user-communication → requester local room.
        if (
            project_id == binding.fd_project_id
            and chatroom_name == "user-communication"
        ):
            attachments = await self._gather_attachments(project_id, entry.version)
            local_proj = Project.get(binding.local_project_id, self._model_ctx)
            await self._mirror(
                target_project_id=binding.local_project_id,
                target_project_name=local_proj.name,
                target_chatroom=binding.local_room,
                src_project_id=project_id,
                src_payload=entry.payload,
                src_version=entry.version,
                direction="reverse",
                attachments=attachments,
            )

    async def _mirror(
        self,
        target_project_id: str,
        target_project_name: str,
        target_chatroom: str,
        src_project_id: str,
        src_payload: MessagePayload,
        src_version: int,
        direction: str,  # "forward" | "reverse"
        attachments: list[tuple[ChangelogEntryType, FilePayload]] | None = None,
        responder_id: str | None = None,
        *,
        released_ticket: Any = None,
    ) -> None:
        assert self._runloop_manager is not None
        from clawmeets.models.project import Project

        if self._is_hub_thread(target_project_id):
            return                       # never into a hub thread (see on_entry)

        # The inspection hook (server/inspection.py), before anything is
        # written on the target: another account's agent entering a workroom
        # (cross_account_relay) or a same-server requester entering a Front
        # Desk host project (front_desk_requester). A released message comes
        # back here with the ticket of its re-inspection.
        ticket = released_ticket
        if ticket is None:
            admitted, ticket = await self._admit(
                target_project_id, target_project_name, target_chatroom, src_project_id,
                src_payload, src_version, direction, attachments or [], responder_id,
            )
            if not admitted:
                return
        ticket_kw = {"ingress_ticket": ticket} if ticket is not None else {}

        expects: list[str] = []
        if direction == "forward":
            # An outside author may address only the host coordinator, which is
            # the binding's responder by construction (plan-owner-isolation 4):
            # never a list copied verbatim.
            try:
                expects = clamp_foreign_expects(
                    self._model_ctx, Project.get(target_project_id, self._model_ctx),
                    src_payload.from_participant_id, list(src_payload.expects_response_from),
                    reply_to_author=responder_id)
            except ValueError:
                expects = []

        # Build the mirrored payload with the target's chatroom_name. Preserve
        # sender attribution so the chat log on the target side reads as
        # "from the foreign participant"; PARTICIPANTS.ndjson will not list
        # them (ghost participant) — a follow-up will introduce PARTICIPANT_ADDED
        # mirroring so the local prompt rendering sees a clean roster.
        mirrored_payload = MessagePayload(
            chatroom_name=target_chatroom,
            id=src_payload.id,
            ts=src_payload.ts,
            from_participant_id=src_payload.from_participant_id,
            from_participant_name=src_payload.from_participant_name,
            content=src_payload.content,
            # `expects_response_from` on the source side is local to that
            # project's participants. Mirror it through on the forward path
            # (so the responder coordinator wakes up); leave it empty on the
            # reverse path (the local project's worker dispatch is governed
            # by the original @mention, not the mirrored reply).
            expects_response_from=expects,
            is_ack=src_payload.is_ack,
        )

        runloop = await self._runloop_manager.get_or_create(
            target_project_id, target_project_name
        )

        # Auto-reactivate: if the target project is non-ACTIVE and we're
        # delivering into user-communication, reactivate before the MESSAGE
        # so subscribers (and the UI) see status=ACTIVE first. Mirrors
        # `send_message_as_user`'s rule (`messages.py:972`).
        target_proj = Project.get(target_project_id, self._model_ctx)
        if (
            target_proj is not None
            and target_chatroom == "user-communication"
            and target_proj.status != ProjectStatus.ACTIVE
        ):
            await runloop.append(
                ChangelogEntryType.PROJECT_REACTIVATED,
                ProjectReactivatedPayload(),
            )
            # The FOURTH producer of a status flip, and the one the design
            # predicted would be missed: this is not an HTTP route, so the
            # desk-notify line the two `routes/messages.py` doors carry has to
            # be repeated here or the target project's owner sees a to-do stuck
            # at Completed after a tunnelled message revived it. Wired because
            # the hub and the context are already in hand at this call site —
            # `_server_ctx` is bound at app startup and is what the notifier
            # takes. Nothing was plumbed to make this possible.
            await notify_plate_of_project_change(self._server_ctx, target_proj)

        mirrored_from_ref = MirroredFromRef(
            project_id=src_project_id,
            version=src_version,
        )
        if attachments and self._outside_kind(
            target_project_id, src_payload.from_participant_id
        ) in FOREIGN_KINDS:
            attachments = self._confine(attachments, src_payload)
        if attachments:
            # Files-then-message on the target too, so the mirrored message's
            # attachments are present before its notifier fires and each
            # mirrored file's source_version points at the target-side message.
            specs: list[BatchEntrySpec] = []
            for file_entry_type, fp in attachments:
                specs.append(
                    BatchEntrySpec(
                        entry_type=file_entry_type,
                        payload=FilePayload(
                            chatroom_name=target_chatroom,
                            filename=fp.filename,
                            content_b64=fp.content_b64,
                            sha256=fp.sha256,
                            from_participant_id=fp.from_participant_id,
                            from_participant_name=fp.from_participant_name,
                        ),
                        link_to_index=len(attachments),
                        mirrored_from=mirrored_from_ref,
                    )
                )
            specs.append(
                BatchEntrySpec(
                    entry_type=ChangelogEntryType.MESSAGE,
                    payload=mirrored_payload,
                    mirrored_from=mirrored_from_ref,
                )
            )
            entry = (await runloop.append_batch(specs, **ticket_kw))[-1]
        else:
            entry = await runloop.append(
                ChangelogEntryType.MESSAGE,
                mirrored_payload,
                mirrored_from=mirrored_from_ref,
                **ticket_kw,
            )
        logger.info(
            "tunnel: mirrored v%d %s/%s → %s/%s (%s, %d attachment(s))",
            src_version,
            src_project_id,
            src_payload.chatroom_name,
            target_project_id,
            target_chatroom,
            direction,
            len(attachments or []),
        )

        # Broadcast CHANGELOG_UPDATE so target-side runners get a WS push for
        # the mirrored entry (otherwise we rely on whatever polling cadence
        # the runner uses, which can throttle on completed projects).
        if self._ws_hub is not None and target_proj is not None:
            envelope = ControlEnvelope(
                type=ControlMessageType.CHANGELOG_UPDATE,
                payload=ChangelogUpdatePayload(
                    project_id=target_project_id,
                    project_name=target_project_name,
                    new_version=entry.version,
                    coordinator_id=target_proj.coordinator_id,
                ),
            )
            try:
                await self._ws_hub.broadcast_to_project(envelope, target_proj)
            except Exception:
                logger.exception("tunnel: WS broadcast failed for v%d", entry.version)

        # WorkTracker bookkeeping — skip acks (mirrors `messages.py:274` guard).
        if self._work_tracker is None or mirrored_payload.is_ack:
            return

        if direction == "forward":
            # Forward mirror = a delegation message arriving on the FD side.
            # Open a PendingWork batch on the target chatroom so the typing
            # indicator + batch-timeout machinery covers the foreign agent's
            # in-flight work.
            #
            # Only that binding's foreign agent (`responder_id`) can answer on
            # this FD project, so the batch waits for it alone, and only when
            # the message addressed it. A room bound to several foreign agents
            # forwards every message to every FD project; without this, "@A"
            # opened a batch on B's FD waiting for A, who is never there, and it
            # blocked B's own batch (one per room) until it timed out.
            expected = [
                pid
                for pid in mirrored_payload.expects_response_from
                if pid == responder_id
            ]
            if expected:
                try:
                    await self._work_tracker.create_pending_work(
                        message_id=mirrored_payload.id,
                        message_version=entry.version,
                        project_id=target_project_id,
                        project_name=target_project_name,
                        chatroom_name=target_chatroom,
                        coordinator_id=mirrored_payload.from_participant_id,
                        expected_participants=expected,
                        timeout_seconds=resolve_batch_timeout(
                            expected,
                            default=self._batch_timeout,
                            model_ctx=self._model_ctx,
                        ),
                    )
                except ValueError:
                    logger.warning(
                        "tunnel: PendingWork already exists for %s/%s",
                        target_project_id,
                        target_chatroom,
                    )
            return

        # direction == "reverse": foreign agent's reply mirroring back into the
        # requester's local room. Record it against any open PendingWork there;
        # if none is open (e.g. the foreign agent's FIRST reply already closed the
        # batch and this is a later/final message), synthesize a one-participant
        # batch so the local coordinator is re-woken to look at the reply. Guard
        # on replier != local coordinator: in a DM requester thread the foreign
        # agent IS the coordinator, so this is skipped (the reply just surfaces in
        # the user's own DM thread); in a delegation room the local coordinator is
        # a different agent, so it gets re-woken on the final answer.
        # (Since the own-coordinator rule the requester thread's foreign
        # agent is its counterpart and the user coordinates: skipped the same.)
        replier_id = mirrored_payload.from_participant_id
        local_coordinator_id = target_proj.coordinator_id if target_proj else None
        if (
            local_coordinator_id
            and replier_id not in (local_coordinator_id, target_proj.counterpart_id)
            and await self._work_tracker.get_pending_work(
                target_project_id, target_chatroom
            )
            is None
        ):
            work = await self._work_tracker.record_response_opening_if_missing(
                target_project_id,
                target_project_name,
                target_chatroom,
                replier_id,
                coordinator_id=local_coordinator_id,
                message_id=mirrored_payload.id,
                message_version=entry.version,
                timeout_seconds=resolve_batch_timeout(
                    [replier_id],
                    default=self._batch_timeout,
                    model_ctx=self._model_ctx,
                ),
            )
        else:
            work = await self._work_tracker.record_response(
                target_project_id, target_chatroom, replier_id
            )
        if work is None or not work.is_complete:
            return
        await self._work_tracker.clear_pending_work(
            target_project_id, target_chatroom
        )
        batch_entry = await runloop.append(
            ChangelogEntryType.BATCH_COMPLETE,
            BatchCompletePayload(
                chatroom_name=target_chatroom,
                message_id=work.message_id,
                coordinator_id=work.coordinator_id,
                responded_participants=list(work.responded_participants),
            ),
            source_version=work.message_version,
        )
        if self._ws_hub is not None and target_proj is not None:
            envelope = ControlEnvelope(
                type=ControlMessageType.CHANGELOG_UPDATE,
                payload=ChangelogUpdatePayload(
                    project_id=target_project_id,
                    project_name=target_project_name,
                    new_version=batch_entry.version,
                    coordinator_id=target_proj.coordinator_id,
                ),
            )
            try:
                await self._ws_hub.broadcast_to_project(envelope, target_proj)
            except Exception:
                logger.exception(
                    "tunnel: WS broadcast failed for BATCH_COMPLETE v%d",
                    batch_entry.version,
                )

    def _outside_kind(self, target_project_id: str, author_id: str) -> str | None:
        """``outside_author`` of a mirror's author in the target project, or
        None when the target is gone."""
        from clawmeets.models.project import Project
        from clawmeets.models.provenance import outside_author

        try:
            target = Project.get(target_project_id, self._model_ctx)
        except ValueError:
            return None
        return outside_author(target, author_id, self._model_ctx)

    @staticmethod
    def _confine(
        attachments: list[tuple[ChangelogEntryType, FilePayload]], src_payload: MessagePayload,
    ) -> list[tuple[ChangelogEntryType, FilePayload]]:
        """Files from another account (its agent or its person, e.g. the host
        owner of a Front Desk thread), placed like a hub reply's
        (``room_bridge.confine_incoming_path``): under ``hub/<name>/``, loader
        names renamed ``.remote.txt``, so no instruction loader picks them up
        and the file manifest lists them as outside content. A refused name is
        left out. Applied as the mirror is written, so the inspector and a
        held replay keep the sender's own names."""
        from clawmeets.server.hub.room_bridge import confine_incoming_path

        label = src_payload.from_participant_name or src_payload.from_participant_id
        out = []
        for entry_type, fp in attachments:
            path = confine_incoming_path(label, fp.filename)
            if path is None:
                logger.warning("tunnel: file from another account with a refused name: not mirrored")
                continue
            out.append((entry_type, fp.model_copy(update={"filename": path})))
        return out

    # ── the inspection hook ──────────────────────────────────────────────

    async def _admit(
        self, target_project_id: str, target_project_name: str, target_chatroom: str,
        src_project_id: str, src_payload: MessagePayload, src_version: int, direction: str,
        attachments: list[tuple[ChangelogEntryType, FilePayload]], responder_id: str | None,
    ) -> tuple[bool, Any]:
        """``(admitted, ticket)`` for a mirror whose author is outside the
        target project. A held or blocked one is noted on the sender's side
        ("Held for review." / "Not delivered.") and not mirrored."""
        from clawmeets.models.project import Project
        from clawmeets.models.provenance import outside_author
        from clawmeets.server.inspection import InspectionRequest, OutsidePath, Verdict, file_refs

        ingress = getattr(self._server_ctx, "outside_ingress", None)
        if ingress is None:
            return True, None
        try:
            target = Project.get(target_project_id, self._model_ctx)
        except ValueError:
            return True, None
        author = src_payload.from_participant_id
        kind = outside_author(target, author, self._model_ctx)
        if kind is None:
            return True, None
        requester = kind == "requester"
        path = OutsidePath.FRONT_DESK_REQUESTER if requester else OutsidePath.CROSS_ACCOUNT_RELAY
        label = src_payload.from_participant_name or author
        if not requester:
            label = f"{label} (another account)"
        admission = await ingress.admit(InspectionRequest(
            path=path, direction="inbound", owner_user_id=target.created_by or "",
            project_id=target_project_id, chatroom=target_chatroom, author_id=author,
            author_label=label, text=src_payload.content,
            files=file_refs(fp for _t, fp in attachments),
            source_ref=f"{src_project_id}:{src_version}",
        ), replay={
            "target_project_id": target_project_id, "target_project_name": target_project_name,
            "target_chatroom": target_chatroom, "src_project_id": src_project_id,
            "src_payload": src_payload.model_dump(mode="json"), "src_version": src_version,
            "direction": direction, "responder_id": responder_id,
            "attachments": [[t.value, fp.model_dump(mode="json")] for t, fp in attachments],
        })
        if admission.passed:
            return True, admission.ticket
        held = admission.verdict == Verdict.HOLD
        if requester:
            note = "Held for review." if held else "Not delivered."
        else:
            note = "Not delivered yet: held for review." if held else "Not delivered."
        task = asyncio.create_task(ingress.post_note(
            src_project_id, src_payload.chatroom_name, note,
            mirrored_from=MirroredFromRef(project_id=target_project_id, version=src_version),
        ))
        self._note_tasks.add(task)
        task.add_done_callback(self._note_tasks.discard)
        return False, None

    async def close_held(self, replay: Mapping[str, Any]) -> None:
        """A held mirror that expired: the sender's side is told, like the
        hold itself was, and nothing is mirrored."""
        await self._tell_sender(replay, "Not delivered: it was held for review and expired.")

    async def block_held(self, replay: Mapping[str, Any]) -> None:
        """A held mirror blocked on release: the sender's side is told as on
        a live block, and nothing is mirrored."""
        await self._tell_sender(replay, "Not delivered.")

    async def _tell_sender(self, replay: Mapping[str, Any], note: str) -> None:
        ingress = getattr(self._server_ctx, "outside_ingress", None)
        if ingress is None:
            return
        await ingress.post_note(
            replay["src_project_id"], replay["src_payload"]["chatroom_name"], note,
            mirrored_from=MirroredFromRef(project_id=replay["target_project_id"], version=replay["src_version"]),
        )

    async def deliver_held(self, replay: Mapping[str, Any], ticket: Any) -> None:
        """A held mirror released on reopen: mirrored as it would have been."""
        await self._mirror(
            target_project_id=replay["target_project_id"],
            target_project_name=replay["target_project_name"],
            target_chatroom=replay["target_chatroom"],
            src_project_id=replay["src_project_id"],
            src_payload=MessagePayload.model_validate(replay["src_payload"]),
            src_version=replay["src_version"],
            direction=replay["direction"],
            attachments=[
                (ChangelogEntryType(t), FilePayload.model_validate(fp))
                for t, fp in replay.get("attachments") or []
            ],
            responder_id=replay.get("responder_id"),
            released_ticket=ticket,
        )
