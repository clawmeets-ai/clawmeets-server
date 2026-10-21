# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/notification_assets.py
Gather the assets a notification email should carry: the files an agent
generated *as part of the same response* that triggered the email, plus
a link to the project's interactive report when one exists.

"Same response" is resolved via reply linkage: an agent's ``ActionBlock``
tags its reply MESSAGE and its ``update_file`` FILE_* events with the same
``source_version`` and ``from_participant_id`` (see the Reply Linkage table
in CLAUDE.md and ``ChatFileEvent``'s docstring). So the deliverables tied to
a triggering message are exactly the ChatFileEvents in the room matching
that message's ``(source_version, from_participant_id)`` pair — not a sweep
of every file in the project and not human uploads.

The domain email factories stay pure value-builders; all filesystem reads
(chat log, file bytes, report.json) live here.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from ..models.chat_message import ChatFileEvent
from ..models.chatroom import Chatroom
from ..models.project_report import get_report
from ..utils.email import EmailAttachment, EmailMessage
from .email import ClawMeetsEmailMessage

if TYPE_CHECKING:
    from ..models.context import ModelContext
    from ..models.project import Project


def _room_candidates(
    room: Chatroom,
    source_version: int,
    author_id: str,
) -> list[tuple[str, bytes]]:
    """Collect ``(filename, bytes)`` for files the author produced in the
    turn identified by ``source_version``.

    Dedups to the latest version per filename (a file touched twice in the
    same turn keeps its most recent content). Files whose bytes can't be
    read are skipped rather than raising.
    """
    latest: dict[str, ChatFileEvent] = {}
    for entry in room.get_log_entries():
        if not isinstance(entry, ChatFileEvent):
            continue
        if entry.source_version != source_version:
            continue
        if entry.from_participant_id != author_id:
            continue
        prev = latest.get(entry.filename)
        if prev is None or (entry.version or 0) >= (prev.version or 0):
            latest[entry.filename] = entry

    candidates: list[tuple[str, bytes]] = []
    for filename in latest:
        content = room.get_file(filename)
        if content is None:
            continue
        candidates.append((filename, content))
    return candidates


def gather_response_attachments(
    room: Chatroom,
    *,
    source_version: Optional[int],
    author_id: str,
) -> tuple[list[EmailAttachment], list[str]]:
    """Attachments for a single-room response (assistant_message / dm_response).

    Returns ``(accepted, skipped_filenames)``. An empty result (e.g. a
    server-authored message with ``source_version=None``, or a reply with
    no file outputs) yields ``([], [])``.
    """
    if source_version is None:
        return [], []
    return EmailMessage.select_attachments(
        _room_candidates(room, source_version, author_id)
    )


def gather_project_response_attachments(
    project: "Project",
    model_ctx: "ModelContext",
    *,
    source_version: Optional[int],
    author_id: str,
) -> tuple[list[EmailAttachment], list[str]]:
    """Attachments for a project-completion response.

    Completion carries no body message, but the coordinator's completing
    turn may have produced deliverables (``update_file`` actions sharing the
    completion's ``source_version``). Union those across every chatroom, **plus
    ``PLAN.md`` by name** (:func:`_plan_candidate`, B6), then apply the caps once
    over the combined candidate set.

    A ``source_version`` of ``None`` no longer means "no attachments": the plan
    is attached on its own terms, so a server-authored completion still carries
    the document.
    """
    candidates: list[tuple[str, bytes]] = []
    if source_version is not None:
        for room_name in project.chatrooms:
            room = Chatroom.get(project.id, room_name, model_ctx)
            if room is None:
                continue
            candidates.extend(_room_candidates(room, source_version, author_id))
    plan = _plan_candidate(project, model_ctx)
    if plan is not None and not any(name == plan[0] for name, _ in candidates):
        candidates.append(plan)
    return EmailMessage.select_attachments(candidates)


def _plan_candidate(
    project: "Project", model_ctx: "ModelContext"
) -> Optional[tuple[str, bytes]]:
    """``PLAN.md``, independent of who wrote it or when — **B6**, AC-7.13.

    Reply linkage is the right rule for a *deliverable*: the coordinator shared
    it in the completing turn, so it carries that turn's ``source_version``. It
    is the **wrong** rule for the plan, and silently so. Under the plan system
    the last writer of ``PLAN.md`` is usually the **server** — ``apply_edits``
    appends the ``FILE_UPDATED`` on the coordinator's behalf, and a submit or an
    upload absorption lands at its own version — so the pair the sweep matches
    on stops matching and the plan drops out of the completion email with no
    error anywhere. The failure mode is an email that is quietly missing the one
    document describing what was built.

    So it is named rather than matched. Attached whenever the project has one,
    and skipped silently when it does not (a DM, a pre-feature project whose
    plan was deleted) — deduped against the sweep so a coordinator that *did*
    share it in the completing turn does not attach it twice.
    """
    from ..models.project_plan import PLAN_FILE, PLAN_ROOM

    try:
        room = Chatroom.get(project.id, PLAN_ROOM, model_ctx)
    except ValueError:
        return None
    if room is None:
        return None
    content = room.get_file(PLAN_FILE)
    if content is None:
        return None
    return PLAN_FILE, content


def report_url_if_available(
    project: "Project",
    model_ctx: "ModelContext",
    app_base_url: str,
) -> Optional[str]:
    """Return the project's Report-tab deep link iff a report exists, else None."""
    try:
        report = get_report(model_ctx.llm_log_dir(project.id, project.name))
    except Exception:
        return None
    if report is None:
        return None
    return ClawMeetsEmailMessage.report_url(app_base_url, project.id)
