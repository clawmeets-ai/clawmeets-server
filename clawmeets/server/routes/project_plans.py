# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/project_plans.py

The plan system's HTTP surface (§6, D6) — **transport, and nothing else.**

Every decision lives in :mod:`clawmeets.models.project_plan`; every byte that
reaches ``PLAN.md`` goes through :func:`~clawmeets.models.project_plan.apply_edits`
or :func:`~clawmeets.models.project_plan.submit_review`. This module constructs
no ``FilePayload``, parses no Markdown and re-derives no rule. Its three real
jobs are:

1. **Resolve an identity** to the one token the model layer speaks — the literal
   ``"user"`` for the owner, an agent's name for an agent — and let the model
   decide what that identity may do.
2. **Map the model's five errors onto the five statuses §6 owes** (404 / 403 /
   400 / 413 / 409), so the routes are a mapping table rather than a pile of
   re-derived conditions.
3. **Derive the seven per-note fields §3.3 does not store** — ``has_proposal``,
   ``sent``, ``replies``, ``section_missing``, ``section_new``,
   ``section_changed``, ``display_diff`` — per request, never persisted.

**Exactly one ``PROJECT_PLAN_SYNC`` per mutation** (AC-3.1). There is one
broadcast helper and every mutating route calls it once, so *"exactly one"* is a
property of the code rather than a discipline.

Registered beside ``create_project_reports_router`` in ``server/app.py``, whose
report lane is the precedent this one follows throughout: a project-scoped
artifact, a sync envelope carrying the cursor and not the body, and a
denormalized timestamp on ``meta.json`` so a list can badge without a fetch.

``server/`` is not shipped in the runner wheel and is not an ``MIT_PREFIXES``
entry, so this file is **BUSL-1.1**.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Request
from pydantic import BaseModel, Field

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    ProjectPlanSyncPayload,
)
from clawmeets.api.responses import Deviation, PlanSummary
from clawmeets.models.agent import Agent
from clawmeets.models.chatroom import Chatroom
from clawmeets.models.plan_markdown import (
    SPEC,
    PlanCriterion,
    PlanLimitError,
    PlanSection,
    body_sha,
    parse_criteria,
    parse_sections,
    render_clean,
    render_diff,
    section_extent,
    spec_digest,
)
from clawmeets.models.project import Project
from clawmeets.models.provenance import outside_author
from clawmeets.server.isolation_gate import check_project_read
from clawmeets.models.project_plan import (
    OWNER,
    PLAN_ROOM,
    USER_ROOM,
    DraftEntry,
    PlanConflictError,
    PlanCorruptError,
    PlanForbiddenError,
    PlanHistoryEntry,
    PlanInputError,
    PlanNote,
    PlanNotFoundError,
    PlanNudge,
    PlanRevision,
    PlanReviewDraft,
    PlanReviewRound,
    PlanSpecLockedError,
    ProjectPlan,
    PlanTick,
    SectionEdit,
    add_note,
    apply_edits,
    changed_since_acceptance,
    close_round,
    create_plan,
    discard_draft,
    ensure_consultation_roster,
    get_plan,
    get_plan_sidecar,
    keeper,
    may_decide,
    may_write,
    note_is_deviation,
    note_kind,
    open_notes_for_you,
    owns_thought_partner,
    plan_revisions,
    publish_plan_state,
    record_nudge_event,
    resolve_note,
    section_changed,
    section_changed_since_answer,
    section_missing,
    section_new,
    set_decision,
    stage_draft,
    submit_review,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


# ---------------------------------------------------------------------------
# The read response (§3.3, §6.B) — response-only, computed per request, never
# persisted, so there is no stored copy to drift and no migration.
# ---------------------------------------------------------------------------


class PlanNoteView(PlanNote):
    """A stored note plus the seven fields §3.3 derives on every read.

    ``section_changed`` is a **string comparison, not a merge trial** — the
    actionable answer to *"does this proposal still make sense"*.
    ``display_diff`` is generated per request and is **never an input**: no
    surface anywhere accepts a diff (AC-4.4).
    """

    #: **THE ONLY PRODUCER OF THE WORD.** ``kind`` is not stored on a note and
    #: has not been since it became a function of the note's own fields — see
    #: :func:`note_kind`. It ships on every read so a client prints a word
    #: rather than re-deriving one, which is how the old chip came to say
    #: ``question`` where the button said *Reply*.
    kind: str = "note"
    has_proposal: bool = False
    sent: bool = False
    replies: list[str] = Field(default_factory=list)
    section_missing: bool = False
    #: The note PROPOSES the section it names, so the slug not resolving is the
    #: point rather than a problem — the third reader of the create-vs-vanished
    #: rule ``resolve_note`` and ``_row_creates`` already share.
    #:
    #: **Mutually exclusive with ``section_missing`` by construction**, not by a
    #: client's arithmetic: :func:`section_missing` returns ``False`` wherever
    #: this is ``True``, so a surface renders whichever fired and never has to
    #: decide which of two banners wins.
    section_new: bool = False
    section_changed: bool = False
    display_diff: str = ""
    #: Server-internal, and redeclared here for one reason: this class
    #: subclasses ``PlanNote`` and has **no allow-list**, so the inherited field
    #: would ship to every reader of ``GET …/plan`` the day it was added — and
    #: that read is open to anyone holding the project id. The browser needs
    #: ``display_diff``, not the raw text; shipping both invites a second source
    #: of truth for one fact.
    applied_text: str = Field(default="", exclude=True)


class DraftEntryView(DraftEntry):
    """A tray row plus its derived ``stale``.

    ``kind`` is still the **five** stored values. ``superseded`` is a client-side
    display state and never a wire kind (§6.B.5) — a row whose text was overtaken
    is staged, sent and stored as ``accept``, and the outcome the label predicts
    is produced server-side at submit.
    """

    stale: bool = False
    #: The row's section is no longer in the document. It is a **separate member
    #: from ``stale``** for the reason :func:`section_changed` and
    #: :func:`section_missing` are separate predicates: *"the text moved, re-read
    #: it"* and *"there is no longer anything to write to"* are different answers
    #: with different remedies, and ``section_changed`` deliberately reports
    #: ``False`` here rather than shadowing this one. Without it a row whose
    #: section vanished while it sat in the tray renders no reason at all.
    #:
    #: **It no longer predicts the outcome, and it used to.** This said the
    #: submit was a ``409``; it now depends on the note the row accepts —
    #: ``_row_creates`` re-creates the section when the proposal was written
    #: against one that was already absent, and refuses when it was deleted
    #: underneath. That distinction needs the note's ``base_section``, which this
    #: row does not carry, so the flag reports the FACT and lets the submit
    #: decide. Predicting it here would be a second copy of the server's rule in
    #: the browser, which is what this view exists not to be.
    missing: bool = False


class PlanReviewDraftView(PlanReviewDraft):
    entries: list[DraftEntryView] = Field(default_factory=list)


class PlanIndex(BaseModel):
    """``GET /projects/{pid}/plan`` — the body plus the derived, read-only index.

    ``accepted_revision`` is ``None`` before acceptance (ruling 6.2): ``0`` is a
    sentinel the sidecar keeps internally and putting a sentinel on the wire asks
    every client to know it.

    ``history`` is a **plain passthrough** of the sidecar's activity log — the
    route already holds it, so there is no join and no second read. Three things
    a client must hold about it: it is capped at 200 and trimmed from the front,
    so render it as *"recent activity"* and never derive a count or a first-event
    date from it; ``seq`` is a display counter and **never** a precondition; and
    it is **not** ``/plan/versions`` — this is everything that happened, including
    refusals and notes that moved no bytes, while that is writes that landed.
    """

    body: str
    sections: list[PlanSection] = Field(default_factory=list)
    #: Every ``AC-<m>.<n>`` occurrence, in source order — the second address a
    #: note can carry. Ships on **every** read, symmetric with ``sections``,
    #: rather than only under ``?sections=true``: that mode blanks ``body``, and
    #: ``plan note --ac --edit-file`` needs the body and the criteria from one
    #: read. A fifty-criterion plan adds roughly 10 KB beside a response that
    #: already carries every note and its rendered diff.
    criteria: list[PlanCriterion] = Field(default_factory=list)
    notes: list[PlanNoteView] = Field(default_factory=list)
    draft: Optional[PlanReviewDraftView] = None
    sha: str = ""
    revision: int = 1
    keeper: str = ""
    open_notes_for_you: int = 0
    spec_digest: str = ""
    accepted: bool = False
    #: The revision the OWNER last had this plan put in front of them. Read by
    #: `plan review --dry-run`, which renders the review message with the same
    #: function the server does and would otherwise preview a message missing
    #: the owner's changelog block. Zero means "never presented".
    owner_last_seen_revision: int = 0
    accepted_revision: Optional[int] = None
    #: The digest of the body **as the acceptance left it** — empty until the
    #: go-note is applied. It moved here when ``POST /plan/approve`` was
    #: deleted: that route's response was the only place acceptance facts
    #: reached a client, and acceptance is now a note resolution whose response
    #: is a generic ``WriteResult``. A caller comparing it against
    #: ``spec_digest`` above learns what ``changed_since_acceptance`` says, and
    #: also *what* the approved text was, which the boolean cannot carry.
    accepted_spec_digest: str = ""
    changed_since_acceptance: bool = False
    history: list[PlanHistoryEntry] = Field(default_factory=list)
    #: May **this viewer** accept or reject a proposal? Resolved from
    #: :func:`~clawmeets.models.project_plan.may_decide`, the same predicate
    #: ``submit_review``'s guard enforces, so the affordance and the capability
    #: cannot drift — a client that renders Accept from this flag renders it
    #: exactly when pressing it would succeed.
    #:
    #: Default ``False`` is load-bearing in **both** directions: an older client
    #: that does not read it sees no change at all, and a newer client against
    #: an older server renders no decision buttons rather than rendering them
    #: and collecting a 403. ``_viewer`` cannot raise, so a broken credential
    #: degrades to *"no buttons"* and never to a 500 — matching ``draft``.
    can_decide: bool = False
    #: Does **this server** honour ``DraftEntry.folded`` — the tray row that says
    #: *"keep this text alongside the winner's"*? A statement about the
    #: deployment, not about the viewer, which is the one way it differs from
    #: ``can_decide`` above; the reasoning is otherwise word for word the same,
    #: and a client that stages a fold from this flag stages it exactly when the
    #: server will record one.
    #:
    #: **Default ``False``, and an absent field reads as ``False``.** This is
    #: load-bearing rather than ceremony, because the failure it prevents is
    #: silent in both directions. ``DraftEntry`` declares no ``model_config``, so
    #: pydantic's default ``extra='ignore'`` means an older server receiving
    #: ``"folded": true`` answers **200 and drops it** — no 422, no validation
    #: error, no log line, nothing to alert on. The note then closes ``rejected``
    #: on a document whose text landed, while the UI tells the user both
    #: proposals were kept. That is strictly worse than the client taking its own
    #: fallback path, which at least never says the false word.
    #:
    #: And the skew is not hypothetical: the public bundle is built on the box
    #: ahead of the restart, and the SPA routes read it off disk per request, so
    #: the old server serves the new bundle for about a minute on every deploy —
    #: the dangerous direction, every time.
    #:
    #: A build fact, never configuration: this code honours the field, so this
    #: code returns ``True``, and it ships in the same commit as the field. A
    #: flag landing later than the capability it advertises is worse than no
    #: flag — the client would take its fallback against a server that already
    #: folds correctly.
    records_folds: bool = False
    #: **Is this project's request a decision?** The coordinator's flag from the
    #: plan sidecar; ``None`` = never set, which reads as no. Only ``True`` lets
    #: the Plan tab show the thought_partner nudge (section 5.4).
    decision: Optional[bool] = None
    #: The nudge's first-occurrence stamps; ``""`` = never. A non-empty
    #: ``dismissed_at`` keeps the line hidden for this project.
    nudge: PlanNudge = Field(default_factory=PlanNudge)
    #: Does **this viewer** own an agent named exactly ``thought_partner``?
    #: The server's answer to the same rule the start view applies; ``False``
    #: for anyone but the owner. Additive to section 5.4 — the UI resolves the
    #: agent itself and may ignore this.
    has_thought_partner: bool = False


#: **THERE IS NO ACCEPTANCE MARKER ANY MORE, AND NOTHING REPLACED IT.**
#: Kept as a paragraph rather than deleted, because a wake-up that quietly
#: stopped existing is exactly the kind of thing someone re-adds.
#:
#: ``POST /plan/approve`` used to post ``<!-- clawmeets:plan-accepted ... -->``
#: into ``user-communication`` as the user, to start the coordinator's turn.
#: Acceptance is now the user applying the go-note, and both doors that can do
#: that already wake the coordinator, better:
#:
#: * the tray's Accept goes through ``submit_review``, which posts a real
#:   message to the note's author — the coordinator — in the SAME
#:   ``append_batch`` as the ``PROJECT_PLAN_STATE`` projection that clears the
#:   gate, with the projection in the prelude so the woken turn reads the
#:   post-acceptance state;
#: * ``plan resolve --apply`` posts no message, and the runner's
#:   ``Agent.on_plan_state_change`` resumes the coordinator on the gate's
#:   transition to clear.
#:
#: So the release is a state transition rather than a user message the
#: coordinator can answer conversationally with *"shall I begin?"* — which is
#: what the double-confirmation was.


# ---------------------------------------------------------------------------
# Identity (§4's table) — resolved here, enforced in the model.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PlanIdentity:
    """Who is calling, as the model layer names them.

    ``name`` is the literal ``"user"`` for the owner and the agent's display name
    for an agent, because that is the vocabulary ``PlanNote.to``, ``keeper()``
    and ``may_write()`` all speak. Resolving it here and passing one string down
    is what keeps ``models/`` free of any notion of a bearer token.
    """

    name: str
    agent_id: str = ""
    user_id: str = ""
    #: The owner's username. ``name`` is the literal ``"user"`` the model layer
    #: speaks; this is who a message posted **as** them is from (§7.2).
    user_name: str = ""
    #: **WHICH HAND, when ``name`` is the owner's.** The agent whose bearer the
    #: credential resolved through — the owner's ``{username}-assistant`` — or
    #: ``""`` for a real user JWT (a browser session, or ``--token``).
    #:
    #: ``name`` STAYS ``"user"`` when this is set, and that is the whole design.
    #: ``may_decide`` and every other ownership rule are untouched, so the
    #: assistant keeps relaying its owner's applies, rejects and replies exactly
    #: as it does today. What this buys is two things ``name`` alone cannot say:
    #: the acceptance record can name the real actor (``accepted_via``), and the
    #: ONE act that must not be borrowed — the keeper approving its own draft
    #: before anyone was shown it — can be refused by the model
    #: (``_refuse_presigned_go_note``) instead of being invisible to it.
    acting_agent: str = ""

    @property
    def is_owner(self) -> bool:
        return self.name == OWNER


def _open_deviation(project: Project, plan: ProjectPlan) -> Optional[Deviation]:
    """The open deviation note, if there is one (§6.2).

    Presence **is** the predicate, which is why :class:`Deviation` carries no
    ``status``. Newest first, so a fresh deviation is what the card shows.

    ``open`` is filtered HERE and deliberately not inside
    :func:`note_is_deviation`. A note is a deviation forever; this card is about
    the unresolved ones, and that is a property of the alarm rather than of the
    note.

    ``layer == SPEC`` is filtered here for exactly that reason, and it is the
    same test :func:`~clawmeets.models.project_plan.open_notes_for_you` applies:
    this card is the alarm's other surface, and an alarm that fires where the
    gate does not is a red pill over a project that is not stopped. A departure
    from a section the keeper was free to rewrite is still a deviation, still
    carries the word, and still shows in the plan tab's history — it just does
    not shout on the desk.
    """
    for note in reversed(plan.notes):
        if (
            note_is_deviation(project, plan, note)
            and note.status == "open"
            and note.layer == SPEC
        ):
            return Deviation(
                id=note.id,
                by=note.by,
                comment=note.comment,
                section=note.section,
                # UNGUARDED, and AC-1.9 considered guarding it on the proposal
                # and was wrong to. This function selects deviations and nothing
                # else, and a deviation is precisely the note that
                # carries a base WITHOUT a proposal: §5.4 makes `section` +
                # `base_section` the locator of the contract clause it departed
                # from, and two tests pin it. Blanking it here would delete that
                # locator to solve a problem this card does not have.
                base_section=note.base_section,
            )
    return None


async def plan_summary_for(
    project: Project, ctx: "ServerContext"
) -> Optional[PlanSummary]:
    """D23 — the single seam between this server and the My Desk card (§6.2).

    ``None`` when the project has no plan at all: a DM (no ``shared-context``
    room to hang one on) or a pre-feature project with no ``PLAN.md``, which is
    the same case ``GET …/plan`` answers ``404``. **Absence is the signal**, so
    nobody has to define a sentinel.

    ``open_notes_for_you`` comes from
    :func:`~clawmeets.models.project_plan.open_notes_for_you` and is **not**
    recounted here. That integer is read server-side by the execution gate and a
    number that stops work has a higher cost of being wrong than a number that
    decorates a header — a second implementation in a route is not a shortcut,
    it is the drift §3.3 spends a paragraph refusing.

    **Cost.** One *sidecar* read per project on the list path, taken
    deliberately over denormalizing the count into ``meta.json``: a
    denormalized copy is a second place the number lives, and one small JSON
    read per project is a cost ``meta.json`` already pays. The document is not
    read — :func:`get_plan_sidecar` asks whether ``PLAN.md`` exists instead of
    fetching and decoding up to 512 KB of it for every project in the list, and
    nothing below this line looks at a body.

    **Blast radius.** A corrupt sidecar is caught here and answered ``None``
    rather than allowed out as a ``500``. This function decorates a project
    row, and it is called once per project on the list path
    (``routes/projects.py``) — letting :class:`PlanCorruptError` escape would
    take the *whole* project list down over one project's should-never-happen
    file, which is a strictly worse failure than one row that reads as having
    no plan. Nothing is given up by doing so: the loudness that
    :class:`PlanCorruptError` exists for is the refusal to **overwrite**, and
    every write path in ``models/project_plan.py`` reads the sidecar before it
    writes one, so all of them still raise. ``GET …/plan`` still raises too, so
    the surface a user reaches when a row says *"no plan"* is the one that
    tells them why. ``_load`` logs at ``error`` on every read, so a swallow
    here is never a silence.
    """
    try:
        plan = await get_plan_sidecar(project, ctx.model_ctx)
    except PlanNotFoundError:
        return None
    except PlanCorruptError:
        # Already logged with the project id and a stack by ``_load``.
        return None
    frontdesk = project.surface == "frontdesk"
    accepted = bool(plan.accepted_at)
    return PlanSummary(
        surface=project.surface,
        # **One derivation, nulled — not recomputed.** ``Project.phase`` (D13) is
        # the lifecycle answer; the wire nulls it on a front-desk row (ruling
        # 6.1) so a client can tell *"no acceptance model"* from *"not yet
        # accepted"*. The phase-3 stand-in that derived this from the sidecar's
        # first history row is deleted: ``plan_seeded_at`` is stored now, so the
        # >200-act degradation `F-6` documented is over.
        phase=None if frontdesk else project.phase,
        revision=None if frontdesk else plan.revision,
        accepted=None if frontdesk else accepted,
        accepted_revision=(
            None if frontdesk or not accepted else plan.accepted_revision
        ),
        open_notes_for_you=open_notes_for_you(plan),
        deviation=_open_deviation(project, plan),
    )


# ---------------------------------------------------------------------------
# The router
# ---------------------------------------------------------------------------


def create_project_plans_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["project-plans"])

    # -- plumbing ----------------------------------------------------------

    def _project(project_id: str) -> Project:
        try:
            project = Project.get(project_id, ctx.model_ctx)
        except ValueError:
            raise HTTPException(404, f"Project {project_id!r} not found")
        if project is None:
            raise HTTPException(404, f"Project {project_id!r} not found")
        return project

    async def _readable(project_id: str, request: Request) -> Project:
        """The project, past the isolation gate (``check_project_read``)."""
        project = _project(project_id)
        await check_project_read(
            ctx, project, authorization=request.headers.get("Authorization", ""),
            x_agent_id=(request.headers.get("X-Agent-ID") or "").strip() or None,
        )
        return project

    async def _identity(
        project: Project, request: Request, authorization: str
    ) -> PlanIdentity:
        """Resolve the caller to the one token the model layer speaks.

        Two modes, the same two ``files.py`` already has: an agent bearer plus
        ``X-Agent-ID`` (the header every runner sends), or the owner's JWT. An
        agent must be a participant of the room the plan lives in; a user must
        own the project. **A valid bearer that is neither is
        ``403``, never ``401``** — the credential was fine, the identity is not
        entitled (AC-3.1).

        **The credential branch resolves through ``resolve_credential``** (M1
        AC-1.2) — the sibling of the ``resolve_user_from_credential``
        ``agents.py``, ``mcps.py`` and ``skills.py`` use, with the same two
        accepted credentials and the same owner returned for both: a user JWT
        **or** the owner's ``{username}-assistant`` bearer. That is what gives
        ``clawmeets plan resolve --apply --as-user`` a door after AC-1.1 closed
        the coordinator's — and with no approve route left, that flag is the
        whole of the CLI-only owner's route to approving their own project.

        **What the sibling adds is the second half of the answer**, which this
        route is the one place that needs it. The owner is unchanged and every
        ownership rule still sees ``OWNER``; ``acting_agent`` carries WHICH
        credential arrived, so the acceptance record can name the real actor and
        the model can refuse the one act a borrowed hand must not make — see
        :class:`PlanIdentity`.

        **The two branches share nothing but the ``agent_id`` read.** The agent
        branch returns or raises; it never falls through. So widening the
        credential branch widens the credential branch alone — and it does not
        widen it to a specialist: ``resolve_user_from_credential`` matches only
        agents whose name ends ``-assistant`` and which have a ``registered_by``,
        so a specialist bearer with the header suppressed is ``401``, not the
        owner. The ``created_by`` check below is unchanged and is
        what keeps one user's assistant off another user's project.
        """
        agent_id = (request.headers.get("X-Agent-ID") or "").strip()
        if agent_id:
            await ctx.auth.check_agent_token(agent_id, authorization)
            room = Chatroom.get(project.id, PLAN_ROOM, ctx.model_ctx)
            if room is None or agent_id not in room.participants:
                raise HTTPException(403, "Not a participant in this project")
            if outside_author(project, agent_id, ctx.model_ctx) is not None:
                # Another account's agent seated in shared-context (an
                # ``external`` member): the plan is between the keeper and
                # the user, and its notes skip every inspection.
                raise HTTPException(403, "Another account's agent cannot act on this project's plan")
            agent = Agent.get(agent_id, ctx.model_ctx)
            return PlanIdentity(
                name=agent.name if agent is not None else agent_id, agent_id=agent_id
            )
        # **``resolve_credential`` AND NOT ``resolve_user_from_credential``, and
        # the only difference is that this one does not throw away the answer.**
        # Both accept the same two credentials and both return the same owner;
        # the sibling additionally says which of the two arrived. Discarding
        # that is what let `ct-assistant` stamp an acceptance reading
        # `accepted_by: user, accepted_via: owner` on a plan the user had never
        # been shown — and disarmed the two refusals that would have caught it,
        # because both are keyed on the caller's name.
        user, agent = await ctx.auth.resolve_credential(authorization)
        if project.created_by != user.id:
            raise HTTPException(403, "Not authorized to act on this project's plan")
        return PlanIdentity(
            name=OWNER,
            user_id=user.id,
            user_name=user.username,
            acting_agent=agent.name if agent is not None else "",
        )

    async def _viewer(
        project: Project, request: Request, authorization: str
    ) -> Optional[PlanIdentity]:
        """A read's identity, or ``None``.

        ``GET`` matches the report route's access rule — anyone with the id may
        read — so a non-participant bearer gets ``200`` (AC-3.1) and no
        credential at all is not an error. The identity is resolved anyway
        because **the tray is the owner's**: it rides this response only for the
        owner, and for anyone else there is nothing to show rather than an error
        to raise.

        **A REJECTED CREDENTIAL IS NOT THE SAME AS NO CREDENTIAL, AND SWALLOWING
        BOTH COST THE OWNER THEIR BUTTONS.** The rule above is about
        *authorization* — who may see what — and it is kept whole: an anonymous
        read and a valid-but-not-the-owner read both still get ``200`` with
        ``can_decide`` false. What must not be folded in with them is
        *authentication* failing. This route is the only one a browser calls that
        never emits ``401``, so ``api/client.ts``'s refresh-and-replay ladder
        never fires for it — and an ordinary access-token expiry, invisible
        everywhere else because the ladder handles it, arrived here as
        ``identity=None``. That renders as no ``Accept``/``Reject`` on the
        owner's own proposal, under ``PlanNoteRow``'s sentence telling them only
        the plan's owner may decide. No error, no retry, no logout, and the one
        line on screen was false.

        So a ``401`` raised against a credential the caller actually offered is
        re-raised, and the client replays the request with a fresh token. The
        ``authorization`` guard is what keeps the anonymous read a read: with no
        header there is nothing to refresh and nothing to say, which is the case
        the paragraph above is about. ``403`` stays swallowed in both its forms —
        the non-participant agent (:func:`_identity`'s room check) and the user
        who does not own this project — because those are answers, not failures.
        """
        try:
            return await _identity(project, request, authorization)
        except HTTPException as exc:
            if exc.status_code == 401 and authorization:
                raise
            return None

    async def _runloop(project: Project):
        return await ctx.runloop_manager.get_or_create(project.id, project.name)

    def _conflict_detail(exc: PlanConflictError) -> dict[str, Any]:
        """§6's ``409`` body.

        ``note_ids`` is a **list**: the refusal files one conflict note per stale
        section, and a singular ``note_id`` cannot represent what happens the
        moment two sections are stale. ``current`` rides along so a client shows
        your text beside what it says now with **no second request** — the server
        never needs a version it is not already holding (AC-2.5).
        """
        return {
            "error": str(exc),
            "revision": getattr(exc, "revision", 0),
            "note_ids": list(getattr(exc, "note_ids", [])),
            "stale": [
                {"section": s.section, "base": s.base, "current": s.current}
                for s in getattr(exc, "stale", [])
            ],
        }

    def _http(exc: Exception) -> HTTPException:
        """The model's five errors onto the five statuses §6 owes.

        One table, so no route re-derives a condition the model already decided.
        """
        if isinstance(exc, PlanConflictError):
            return HTTPException(409, _conflict_detail(exc))
        if isinstance(exc, PlanNotFoundError):
            return HTTPException(404, str(exc))
        if isinstance(exc, PlanForbiddenError):
            return HTTPException(403, str(exc))
        if isinstance(exc, PlanLimitError):
            return HTTPException(413, str(exc))
        if isinstance(exc, PlanInputError):
            return HTTPException(400, str(exc))
        raise exc

    async def _sync(
        project: Project,
        *,
        action: str,
        by: str,
        sections: list[str] | None = None,
        sha: str = "",
        revision: int = 0,
        stamp: bool = True,
    ) -> None:
        """**Two envelopes, two audiences**, from one place so a mutating route
        cannot serve one reader and forget the other.

        ``PROJECT_PLAN_SYNC`` goes out unconditionally and is the BROWSER's
        signal — AC-3.1's *"exactly one per mutation"* is still a property of
        this function and not a discipline.

        ``CHANGELOG_UPDATE`` goes out **iff the changelog actually moved**, and
        it is the RUNNER's. The runner dispatches on that envelope and nothing
        else, so a lifecycle fact published without it sits unfetched until some
        unrelated event pushes — which is not a theoretical window. Accepting a
        plan through ``POST /notes/{id}/resolve`` posts no message, so the
        acceptance reached the sidecar and the coordinator never learned of it:
        its local ``meta.json`` still read ``plan_accepted_at: null`` with an
        open note, the gate stayed closed, and the project stopped for hours on a
        release that had already happened. ``publish_plan_state`` already
        returned the bool that says whether there is anything to tell; this
        stopped discarding it.

        Conditional, because ``_sync`` also fires on the tray's autosave (``PUT``
        and ``DELETE …/draft``) and on every note post, most of which move no
        lifecycle fact at all. An unconditional push would wake every
        participating runner on each keystroke-sized save.

        It is NOT a second push on the ``/review`` paths: ``submit_review``
        publishes the projection inside its own batch, so by the time ``_sync``
        runs ``publish_plan_state`` re-reads a fresh project, finds nothing
        moved, and answers ``False``. Those routes keep their own explicit
        broadcast, which is then the only one.

        Stamps ``plan_updated_at`` on ``meta.json`` first — outside the changelog,
        the ``report_published_at`` safety argument — so the list a client
        refetches after this envelope already reads the new value.
        """
        updated_at = datetime.now(UTC).isoformat()
        # ``stamp=False`` is the nudge's events: UI bookkeeping, not a change to
        # the plan, so they must not read as "the plan moved" in the project
        # list, and they move no lifecycle fact for a runner to learn.
        moved = False
        if stamp:
            project.state().set_plan_updated_at(updated_at)
            # …and fan the lifecycle projection onto the changelog, which is the
            # one channel that reaches a RUNNER. `plan_updated_at` above is a
            # server-side list field; `phase` and the gate's note count are read
            # in the agent process, which never sees the sidecar. Idempotent — a
            # write that moves no lifecycle fact costs no changelog version.
            # §7.2, D13.
            moved = await publish_plan_state(
                project,
                ctx.model_ctx,
                await ctx.runloop_manager.get_or_create(project.id, project.name),
            )
        envelope = ControlEnvelope(
            type=ControlMessageType.PROJECT_PLAN_SYNC,
            payload=ProjectPlanSyncPayload(
                project_id=project.id,
                action=action,
                sections=list(sections or []),
                sha=sha,
                revision=revision,
                by_agent_name=by,
                updated_at=updated_at,
            ),
        )
        count = await ctx.ws_hub.broadcast_to_project(envelope, project)
        logger.info(
            f"Sent PROJECT_PLAN_SYNC({action}) for project {project.id[:8]} "
            f"to {count} recipients"
        )
        if moved:
            # AFTER the browser's envelope, not before: the human is the one
            # waiting on a screen. Lazy import for the reason the two explicit
            # callers below have one — `messages` cannot be imported at module
            # scope here.
            from clawmeets.server.routes.messages import _broadcast_changelog

            await _broadcast_changelog(
                ctx, project, (await _runloop(project)).get_current_version()
            )

    # -- the read ----------------------------------------------------------

    def _note_view(
        project: Project, plan: ProjectPlan, body: str, note: PlanNote
    ) -> PlanNoteView:
        sent = any(note.id in round_.sends for round_ in plan.rounds)
        # AC-1.9 gave every note that names a section a stored `base_section`.
        # Nothing in the browser reads that field, and shipping it for notes
        # that have nothing to diff would grow `GET …/plan` by a section of
        # prose per comment for no reader — so the sidecar grows and the wire
        # does not.
        #
        # CRITICAL: `section_changed` below is asked of the STORED note, not of
        # this dump. The flag stays true off the captured base while the wire
        # field reads `""`, which is the whole point of the capture and is
        # pinned by a test.
        #
        # `proposes_delete` is the exception, and it is the whole reason that
        # note has a base at all: the diff it renders is the section against
        # NOTHING, so blanking the base here would blank the diff and put the
        # note straight back in the state this flag exists to leave.
        dump = note.model_dump()
        if not note.proposal and not note.proposes_delete:
            dump["base_section"] = ""
        return PlanNoteView(
            **dump,
            # Computed here and nowhere else. `dump` cannot carry it — there is
            # no stored `kind` to dump — so this is the one line that puts the
            # word on the wire.
            kind=note_kind(project, plan, note),
            # A refused DELETE is a proposal whose replacement text is empty, so
            # the action set follows the FLAG and not the string. Everything
            # downstream keys off this one boolean — `PlanNoteRow` gates both
            # `Accept` and `Reject` on it — so the desk needs no notion of a
            # delete of its own.
            # THE STATUS CLAUSE IS ON THE DELETE ARM ALONE, and it is not
            # symmetry that is missing from the other one. A text proposal
            # self-clears: applying it moves the string to `applied_text` and
            # blanks `proposal`, so `has_proposal` goes false and the diff still
            # renders from the record. A FLAG cannot blank itself without
            # destroying the only record that an applied delete has — its base,
            # rendered against nothing — so the fact stays stored and the
            # ACTION is what closes. Without this an applied delete would
            # re-offer `Accept` on a section that is already gone.
            has_proposal=bool(note.proposal)
            or (note.proposes_delete and note.status == "open"),
            sent=sent,
            replies=[n.id for n in plan.notes if n.reply_to == note.id],
            section_missing=section_missing(body, note),
            section_new=section_new(body, note),
            # Measured from the addressee's newest reply when there is one, so
            # an edit that ANSWERED the note does not flag the note it
            # answered. Proposals keep the raw predicate — see the function.
            section_changed=section_changed_since_answer(plan, body, note),
            # KEYED OFF `proposal or applied_text`, NOT off `base_section`.
            # Keying off the base is the natural reading of "render the diff
            # whenever we have one to render against" and it is a BUG: since
            # AC-1.9 every note that names a section has a base, so every plain
            # comment would render as a full-section DELETION diff and the
            # browser's gate would render it faithfully. Pinned by a test.
            #
            # `has_proposal` above is a DIFFERENT question, and that split is
            # the point of the item: the diff and the action set stopped being
            # one signal, so an applied note shows what was applied and does NOT
            # re-offer Accept. (It used to read `bool(note.proposal)` here;
            # `proposes_delete` widened the action set without widening this,
            # which is the split doing its job rather than drifting from it.)
            # A delete renders `base -> nothing`, which is what
            # `render_diff(base, "")` already produces; the arm above it stays
            # keyed on `proposal or applied_text` so a plain comment — which has
            # a base and no flag — still renders nothing. That distinction is
            # the bug the comment above warns about, and the flag is what keeps
            # the two apart.
            display_diff=(
                render_diff(
                    note.base_section,
                    note.proposal or note.applied_text,
                    label=note.section,
                )
                if (note.proposal or note.applied_text or note.proposes_delete)
                else ""
            ),
        )

    def _draft_view(body: str, draft: PlanReviewDraft | None) -> PlanReviewDraftView | None:
        """The tray with per-row ``stale``.

        Staleness is asked of the model's **one** implementation rather than
        recomputed here: a row is stale on exactly the predicate a note's
        proposal is, so the row is handed to :func:`section_changed` wearing a
        note's shape. The alternative — a second string comparison in a route —
        is how the tray and the review surface come to disagree about the same
        section.
        """
        if draft is None:
            return None
        rows = []
        for entry in draft.entries:
            probe = PlanNote(id=entry.id, section=entry.section, base_section=entry.base)
            rows.append(
                DraftEntryView(
                    **entry.model_dump(),
                    stale=bool(entry.section) and section_changed(body, probe),
                    # Only rows that carry text can be missing: a reject / ask /
                    # dismiss writes no bytes, so a vanished section costs it
                    # nothing and flagging one would be noise on a row the
                    # submit will happily send.
                    missing=(
                        entry.kind in ("edit", "accept")
                        and bool(entry.section)
                        and section_missing(body, probe)
                    ),
                )
            )
        data = draft.model_dump()
        data.pop("entries", None)
        return PlanReviewDraftView(**data, entries=rows)

    @router.get("/projects/{project_id}/plan")
    async def get_project_plan(
        project_id: str,
        request: Request,
        section: str = "",
        note: str = "",
        clean: bool = False,
        sections: bool = False,
        authorization: str = Header(default=""),
    ):
        """The body, the derived index, and — for the owner — your tray.

        ``404`` when there is no ``PLAN.md``: a DM, or a project whose plan was
        deleted. That is the same case ``PlanSummary`` renders as *no plan*.

        **There is no ``?scope=``** (§2.1). The four query params narrow what is
        returned; none of them classifies a section, because there is no
        classification to make.
        """
        project = await _readable(project_id, request)
        identity = await _viewer(project, request, authorization)
        try:
            body, plan = await get_plan(project, ctx.model_ctx)
        except PlanNotFoundError as exc:
            raise _http(exc)

        parsed = parse_sections(body)
        notes = plan.notes
        if note:
            notes = [n for n in plan.notes if n.id == note]
            if not notes:
                raise HTTPException(404, f"Note {note!r} not found")

        shown = body
        if section:
            extent = section_extent(body, section)
            if extent is None:
                raise HTTPException(404, f"Section {section!r} not found")
            shown = body[extent[0]:extent[1]]
        if clean:
            shown = render_clean(shown)
        if sections:
            # The `--sections` diagnostic: structure without prose. A duplicate
            # heading is visible as two rows with equal `heading` and slugs
            # `x`/`x-2`, so the warning is derived by the client and is not a
            # wire member §6.B does not have.
            shown = ""

        accepted = bool(plan.accepted_at)
        return PlanIndex(
            body=shown,
            sections=parsed,
            criteria=parse_criteria(body),
            notes=[_note_view(project, plan, body, n) for n in notes],
            draft=_draft_view(body, plan.draft) if identity and identity.is_owner else None,
            # Computed from the MODEL's predicate, not from this file's
            # ``identity.is_owner``. Same value today; only this form makes
            # "the same predicate the guard enforces" literally true.
            # ``is_owner`` keeps its other callers and keeps meaning *"who is
            # this"*; this line asks *"what may they do"*, which is the question
            # a client should branch on.
            can_decide=bool(identity and may_decide(identity.name)),
            # A constant, not a setting. See the field for why making it
            # configurable would create a deployment that lies in one direction
            # or the other.
            records_folds=True,
            sha=body_sha(body),
            revision=plan.revision,
            owner_last_seen_revision=plan.owner_last_seen_revision,
            keeper=keeper(project),
            open_notes_for_you=open_notes_for_you(plan),
            spec_digest=spec_digest(body),
            accepted=accepted,
            accepted_revision=plan.accepted_revision if accepted else None,
            accepted_spec_digest=plan.accepted_spec_digest if accepted else "",
            changed_since_acceptance=changed_since_acceptance(body, plan),
            history=plan.history,
            decision=plan.decision,
            nudge=plan.nudge,
            has_thought_partner=bool(
                identity
                and identity.is_owner
                and owns_thought_partner(identity.user_id, ctx.model_ctx)
            ),
        )

    @router.get("/projects/{project_id}/plan/versions")
    async def get_plan_versions(project_id: str, request: Request) -> list[PlanRevision]:
        """Newest first, one row per recorded write, contiguous revisions
        (AC-3.4).

        **The name mapping is inverted against the obvious reading and getting it
        wrong credits the applier**: ``by`` is who wrote the bytes — a changelog
        read's author — while ``proposed_by`` is whose proposals they were. Since
        the only writers are ever the owner and the keeper, a straight
        ``by``-means-proposer port would read *"@coordinator's proposal, applied
        by @coordinator"* on every revision a specialist originated, and look
        plausible.

        ``note`` is the batch comment the round was sent with, ``""`` on every
        row no round produced. There is **no ``changes[]``** and this response
        does not grow one (§6.C.5).
        """
        project = await _readable(project_id, request)
        try:
            # The existence check is `get_plan`'s, not this function's:
            # `plan_revisions` is a changelog read and would happily answer `[]`
            # for a project that has no plan at all. That makes "no plan" and "a
            # plan nobody has written to" the same response, and a client would
            # need two conditions to tell them apart. One 404, same as
            # `GET /plan`, same as `PlanSummary`'s absence.
            await get_plan(project, ctx.model_ctx)
            return await plan_revisions(
                project, ctx.model_ctx, await _runloop(project)
            )
        except PlanNotFoundError as exc:
            raise _http(exc)

    @router.get("/projects/{project_id}/plan/rounds")
    async def get_plan_rounds(project_id: str, request: Request) -> list[PlanReviewRound]:
        """Backs ``plan review-status``."""
        project = await _readable(project_id, request)
        try:
            _body, plan = await get_plan(project, ctx.model_ctx)
        except PlanNotFoundError as exc:
            raise _http(exc)
        return plan.rounds

    # -- the writes --------------------------------------------------------

    @router.post("/projects/{project_id}/plan")
    async def create_project_plan(
        project_id: str,
        request: Request,
        body: str | None = Body(None, embed=True),
        title: str = Body("", embed=True),
        authorization: str = Header(default=""),
    ):
        """Create from the coordinator's v1 or from the §5.1 seed template.
        ``409`` if ``PLAN.md`` already exists."""
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            result = await create_plan(
                project,
                ctx.model_ctx,
                await _runloop(project),
                body=body,
                by=identity.name,
                title=title,
            )
        except Exception as exc:
            raise _http(exc)
        await _sync(
            project,
            action="create",
            by=identity.name,
            sha=result.sha,
            revision=result.revision,
        )
        return result

    @router.put("/projects/{project_id}/plan")
    async def put_project_plan(
        project_id: str,
        request: Request,
        edits: list[SectionEdit] = Body(..., embed=True),
        #: *"Tick the box labelled M2."* — a write that names a box instead of
        #: supplying a section, materialized against the document under the plan
        #: lock. It rides THIS route rather than getting one of its own because
        #: `apply_edits` is the one funnel and a tick is an ordinary edit by the
        #: time it reaches it; what it is not is an ordinary REQUEST, because the
        #: caller cannot be trusted to know what the section says — that
        #: assumption is what turned a coordinator's end-of-project ticks into
        #: four deviation notes on `ig-incumbent-teardown`.
        #:
        #: Defaulted, so every existing caller of this route is untouched.
        ticks: list[PlanTick] = Body([], embed=True),
        #: The keeper's one-line changelog for a spec move on a plan the user
        #: has NOT accepted yet. Such a write LANDS — the spec lock starts at
        #: acceptance — and files a comment-only receipt carrying this line, so
        #: the user reads a named changelog instead of adjudicating diffs
        #: against a draft nobody has ratified. `400` when it is missing on a
        #: write that moves `spec_digest`; ignored on every other write, so a
        #: checkbox tick and a `## Milestones` re-cut still need nothing.
        #:
        #: Defaulted rather than required, and the default is what keeps every
        #: other caller of this route working untouched: the owner's own writes,
        #: the tray's accepts and a front-desk coordinator never reach the arm
        #: that reads it.
        why: str = Body("", embed=True),
        authorization: str = Header(default=""),
    ):
        """``{edits: [SectionEdit], ticks?: [PlanTick], why?: str}``.
        **All-or-nothing.**

        ``200`` when every ``base`` matches, ``200`` no-op when the spliced result
        is byte-identical, ``409`` otherwise — carrying every stale section's
        ``base`` and ``current``, and the ids of the conflict notes the refusal
        filed, so **a refused write is never a dead end** (§4.3).

        **No whole-body write, no ``base`` sha, no patch input.** A non-keeper
        agent is ``403`` and the message names ``plan note``: a ``403`` that does
        not say what to do instead is how an agent retries forever.
        """
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            result = await apply_edits(
                project,
                edits,
                by=identity.name,
                ctx=ctx.model_ctx,
                runloop=await _runloop(project),
                file_conflict=True,
                why=why,
                ticks=ticks,
            )
        except PlanConflictError as exc:
            await _sync(
                project,
                action="refused",
                by=identity.name,
                sections=[s.section for s in exc.stale],
                revision=exc.revision,
            )
            raise _http(exc)
        except PlanSpecLockedError as exc:
            # **The spec lock files notes too, so it syncs too** — the sibling
            # branch above is the whole argument. M3's refusal is not a dead
            # end precisely because it lands the coordinator's text on the
            # user's plan as a one-click proposal; a refusal that filed that
            # note and told nobody is a dead end wearing the note's clothes.
            # `_sync` is what reaches both readers: `PROJECT_PLAN_SYNC` to the
            # browser pane, and — through `publish_plan_state` — the
            # `PROJECT_PLAN_STATE` projection §7.4's execution gate reads in
            # the AGENT process, which is the gate this very note should
            # engage.
            await _sync(
                project, action="refused", by=identity.name, revision=exc.revision
            )
            raise _http(exc)
        except Exception as exc:
            raise _http(exc)
        await _sync(
            project,
            action="write",
            by=identity.name,
            sections=result.sections,
            sha=result.sha,
            revision=result.revision,
        )
        return result

    @router.post("/projects/{project_id}/plan/notes")
    async def post_plan_note(
        project_id: str,
        request: Request,
        section: str = Body("", embed=True),
        to: list[str] = Body(default_factory=list, embed=True),
        comment: str = Body("", embed=True),
        proposal: str = Body("", embed=True),
        base_section: str = Body("", embed=True),
        quote: str = Body("", embed=True),
        reply_to: str = Body("", embed=True),
        keep_open: bool = Body(False, embed=True),
        #: **BOTH ACCEPTED AND IGNORED, AND FOR THE SAME REASON.** Each named a
        #: stored `kind` that no longer exists: `kind` is derived on read from
        #: the note's own fields (`note_kind`), so neither flag has anywhere to
        #: go. `question` went first, at AC-1.6. `deviation` followed it when
        #: the word became `note.at > plan.first_accepted_at` — a coordinator
        #: note to the user after acceptance IS the deviation record, and a
        #: coordinator note BEFORE acceptance cannot be one, so there is nothing
        #: for a caller to assert.
        #:
        #: They stay on the wire so a `clawmeets` CLI or a browser build from
        #: before this change gets a 200 rather than a 422 on a field that now
        #: does nothing. Delete both together, one release after the last such
        #: client is gone.
        question: bool = Body(False, embed=True),
        deviation: bool = Body(False, embed=True),
        authorization: str = Header(default=""),
    ):
        """One id per addressee — ``N`` **sibling** notes with independent ids and
        statuses, because one note with one status cannot represent *"two agreed,
        one objected"*.

        ``400`` if comment and proposal are both absent, or a proposal arrives
        with no section. **Never refused for staleness, even several revisions
        behind** (AC-3.6): a stale view is still a real objection, and a note
        cannot clobber anything.
        """
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            ids = await add_note(
                project,
                ctx.model_ctx,
                by=identity.name,
                section=section,
                to=to,
                comment=comment,
                proposal=proposal,
                base_section=base_section,
                quote=quote,
                reply_to=reply_to,
                keep_open=keep_open,
            )
        except Exception as exc:
            raise _http(exc)
        await _sync(
            project, action="note", by=identity.name, sections=[section] if section else []
        )
        return {"note_ids": ids}

    @router.post("/projects/{project_id}/plan/notes/{note_id}/resolve")
    async def resolve_plan_note(
        project_id: str,
        note_id: str,
        request: Request,
        action: str = Body(..., embed=True),
        reason: str = Body("", embed=True),
        force: bool = Body(False, embed=True),
        authorization: str = Header(default=""),
    ):
        """The status ladder. ``409`` on ``apply`` when the section changed and
        ``force`` is unset — printing both texts is the client's job, and both
        ride the refusal."""
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            result = await resolve_note(
                project,
                ctx.model_ctx,
                await _runloop(project),
                nid=note_id,
                action=action,
                by=identity.name,
                reason=reason,
                force=force,
                acting_agent=identity.acting_agent,
            )
        except Exception as exc:
            raise _http(exc)
        await _sync(
            project,
            action="apply" if action == "apply" else "resolve",
            by=identity.name,
            sections=result.sections,
            sha=result.sha,
            revision=result.revision,
        )
        return result

    # -- the tray (owner only) --------------------------------------------

    @router.put("/projects/{project_id}/plan/decision")
    async def put_plan_decision(
        project_id: str,
        request: Request,
        decision: bool = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Record whether the project request is a decision. The coordinator
        (who drafts) or the owner; last write wins. Sidecar only — no PLAN.md
        write, no revision, no history row."""
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            saved = await set_decision(
                project, ctx.model_ctx, by=identity.name, decision=decision
            )
        except Exception as exc:
            raise _http(exc)
        await _sync(project, action="decision", by=identity.name)
        return {"decision": saved}

    @router.post("/projects/{project_id}/plan/nudge")
    async def post_plan_nudge(
        project_id: str,
        request: Request,
        event: Literal["shown", "accepted", "dismissed", "held_back"] = Body(..., embed=True),
        authorization: str = Header(default=""),
    ) -> PlanNudge:
        """Record one decision-nudge event (section 5.4). Owner only; ``422`` on
        an unknown event. Idempotent: the stamp lands once, a repeat returns
        ``200`` and the unchanged stamps. Never touches the plan itself."""
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            nudge, stamped = await record_nudge_event(
                project, ctx.model_ctx, by=identity.name, event=event
            )
        except Exception as exc:
            raise _http(exc)
        if stamped:
            await _sync(project, action="nudge", by=identity.name, stamp=False)
        return nudge

    @router.get("/projects/{project_id}/plan/draft")
    async def get_plan_draft(
        project_id: str, request: Request, authorization: str = Header(default="")
    ):
        """**Owner only** — agents do not stage."""
        project = await _readable(project_id, request)
        identity = await _identity(project, request, authorization)
        if not identity.is_owner:
            raise HTTPException(403, "Agents do not stage; the tray is the owner's")
        try:
            body, plan = await get_plan(project, ctx.model_ctx)
        except PlanNotFoundError as exc:
            raise _http(exc)
        return _draft_view(body, plan.draft)

    @router.put("/projects/{project_id}/plan/draft")
    async def put_plan_draft(
        project_id: str,
        request: Request,
        draft: PlanReviewDraft = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Replace the whole tray. **Never validated against the document** —
        staleness is computed on read and a row records ``base`` and nothing
        more, so staging is never refused for anything but the 100-row cap."""
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            saved = await stage_draft(
                project, ctx.model_ctx, by=identity.name, draft=draft
            )
        except Exception as exc:
            raise _http(exc)
        await _sync(project, action="draft", by=identity.name)
        try:
            body, _plan = await get_plan(project, ctx.model_ctx)
        except PlanNotFoundError:
            body = ""
        return _draft_view(body, saved)

    @router.delete("/projects/{project_id}/plan/draft")
    async def delete_plan_draft(
        project_id: str, request: Request, authorization: str = Header(default="")
    ):
        """Discard your own tray. Not a decision about the document, so it writes
        no history and touches no byte of ``PLAN.md``."""
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            await discard_draft(project, ctx.model_ctx, by=identity.name)
        except Exception as exc:
            raise _http(exc)
        await _sync(project, action="draft", by=identity.name)
        return {"status": "discarded"}

    # -- the batch ---------------------------------------------------------

    @router.post("/projects/{project_id}/plan/review")
    async def post_plan_review(
        project_id: str,
        request: Request,
        entries: list[DraftEntry] | None = Body(None, embed=True),
        note_ids: list[str] = Body(default_factory=list, embed=True),
        room: str = Body("", embed=True),
        resend: bool = Body(False, embed=True),
        batch_comment: str = Body("", embed=True),
        #: The same field ``PUT …/plan`` takes, for the same write, because it
        #: is the same funnel: a batch carrying an ``edit`` row from the keeper
        #: on a plan the user has reviewed but not accepted moves the spec, so
        #: it owes them the changelog line. NOT ``batch_comment`` — that is the
        #: sentence above the notes in the message, and this is the line filed
        #: as a receipt on the document. Ignored on every batch that does not
        #: reach the receipt arm, which is every batch the tray and the CLI
        #: send today.
        why: str = Body("", embed=True),
        authorization: str = Header(default=""),
    ):
        """Submit. **One transaction** (§4.2).

        ``409`` if any edit is stale — nothing applied, nothing sent, **tray
        untouched**. The write and every message share one atomic append, so
        *"send review to #room"* does one thing that either happens or does not.

        **An owner's messages go out as the owner's**, through
        ``send_addressed_messages_as_user`` — the same door ``_wake_coordinator``
        uses for the acceptance marker below. That is what makes the submit wake
        its addressee: the door attributes the message to the user (a message the
        coordinator appears to have sent itself is dropped by the runner's
        self-message guard), opens the ``PendingWork`` batch that gives it a
        timeout, and pushes the ``CHANGELOG_UPDATE`` a runner needs to fetch it at
        all. The PLAN.md write rides in as ``prelude_specs`` so §4.2 still holds.
        """
        # Lazy, mirroring `_wake_coordinator`'s import of the same module.
        from clawmeets.server.routes.messages import (
            AddressedMessage,
            _broadcast_changelog,
            send_addressed_messages_as_user,
        )

        project = _project(project_id)
        identity = await _identity(project, request, authorization)

        async def _post(prelude, items) -> list[str]:
            # Guarded on `is_owner`, not merely on the model layer's `by ==
            # "user"`: posting "as the user" with an empty user_id would be this
            # route's own version of the attribution bug this door exists to fix.
            assert identity.is_owner and identity.user_id, (
                "the owner poster requires an owner identity"
            )
            sent = await send_addressed_messages_as_user(
                ctx,
                identity.user_id,
                identity.user_name,
                project.id,
                [
                    AddressedMessage(room_name, content, list(expects))
                    for room_name, content, expects in items
                ],
                prelude_specs=prelude,
            )
            return [m.id for m in sent]

        try:
            round_ = await submit_review(
                project,
                ctx.model_ctx,
                await _runloop(project),
                by=identity.name,
                entries=entries,
                note_ids=note_ids,
                room=room,
                resend=resend,
                batch_comment=batch_comment,
                why=why,
                post=_post if identity.is_owner else None,
                acting_agent=identity.acting_agent,
            )
        except PlanSpecLockedError as exc:
            # Same as `put_project_plan`'s arm, for the same reason: a submit
            # refused by the spec lock has already filed and saved its
            # deviation notes (`submit_review` step 1), so the one broadcast
            # this route owes is owed on the way out too.
            await _sync(
                project, action="refused", by=identity.name, revision=exc.revision
            )
            raise _http(exc)
        except Exception as exc:
            raise _http(exc)

        if not identity.is_owner:
            # An agent's round is still appended directly by `submit_review`, so
            # nothing has pushed the changelog cursor — and the runner dispatches
            # on CHANGELOG_UPDATE alone (`reactive_loop.py:263-268`); the
            # PROJECT_PLAN_SYNC that `_sync` sends below is a browser signal the
            # runner has no case for. Without this the addressed agent's message
            # sits unfetched until some unrelated event pushes.
            #
            # DEFERRED, not overlooked: this path still opens no PendingWork, so
            # an unanswered keeper→worker round has no timeout backstop.
            # `messages._open_pending_batch` is most of what that needs; it also
            # wants per-message ids and versions threaded out of `submit_review`,
            # and PendingWork's (project, room) key means a multi-addressee round
            # can open only one batch. Its own change.
            await _broadcast_changelog(
                ctx, project, (await _runloop(project)).get_current_version()
            )
        try:
            _body, plan = await get_plan(project, ctx.model_ctx)
            revision = plan.revision
        except PlanNotFoundError:
            revision = round_.revision
        await _sync(
            project,
            action="review",
            by=identity.name,
            sha=round_.sha,
            revision=revision,
        )
        return round_

    @router.post("/projects/{project_id}/plan/review-room")
    async def post_plan_review_room(
        project_id: str,
        request: Request,
        authorization: str = Header(default=""),
    ):
        """Seat the specialist roster in ``shared-context``, and report who is
        in it.

        The coordinator's door to the consultation room, for the case a review
        round has not happened yet: a coordinator that wants to consult a
        specialist *unprompted* during ``spec-ing`` cannot invite anyone — the
        pre-approval gate refuses every ``create_room`` action, and the auto-add
        that populates ``shared-context`` lives inside that same refused handler
        — so until this route it had a room with nobody in it.

        **It seats and reports; it posts nothing.** The consultation itself
        stays the coordinator's own ``reply`` action into the room, which is
        what opens the ``PendingWork`` batch that wakes it again when the
        specialists answer. A second message-writing path here would be a second
        way to do the one thing that already works.

        Idempotent, because :func:`ensure_consultation_roster` is — **per
        participant**, not per room. A second call with an unchanged roster
        appends nothing and returns ``created=False``; one made after a new
        agent was registered admits exactly that agent. The round-tripped
        participant list is the answer either way.

        **The path and the response keys are deliberately unchanged**, including
        ``created``, whose meaning widened from *"the room was created"* to
        *"the changelog moved"*. A shipped runner wheel older than this server
        still calls ``POST /plan/review-room`` and still prints something true
        off ``created``; the only cost is that the first call now prints
        ``shared-context`` where it used to print ``plan-review``.
        """
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        if not may_write(project, identity.name):
            raise HTTPException(
                403,
                f"@{identity.name} may not open this project's review room; "
                f"@{keeper(project)} and the owner may",
            )
        runloop = await _runloop(project)
        created = await ensure_consultation_roster(
            project, ctx.model_ctx, runloop, PLAN_ROOM
        )
        if created:
            # The runner dispatches on CHANGELOG_UPDATE and nothing else, so a
            # membership appended without this one is invisible to the
            # coordinator that just asked for it. Same reason
            # `post_plan_review`'s agent path pushes the cursor by hand.
            from clawmeets.server.routes.messages import _broadcast_changelog

            await _broadcast_changelog(
                ctx, Project.get(project.id, ctx.model_ctx), runloop.get_current_version()
            )
        room = Chatroom.get(project.id, PLAN_ROOM, ctx.model_ctx)
        members = [p.name for p in room.list_participants() if p is not None] if room else []
        return {"room": PLAN_ROOM, "created": created, "participants": members}

    @router.post("/projects/{project_id}/plan/rounds/{round_id}/close")
    async def close_plan_round(
        project_id: str,
        round_id: str,
        request: Request,
        authorization: str = Header(default=""),
    ):
        project = _project(project_id)
        identity = await _identity(project, request, authorization)
        try:
            round_ = await close_round(
                project, ctx.model_ctx, round_id=round_id, by=identity.name
            )
        except Exception as exc:
            raise _http(exc)
        await _sync(project, action="round-close", by=identity.name)
        return round_

    return router
