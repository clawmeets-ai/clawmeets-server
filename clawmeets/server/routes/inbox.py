# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/inbox.py
Phase-1 Inbox routes backed by an in-memory seed fixture.

The assistant-agent runtime does not yet write proposals into a store; these
routes serve a hardcoded list of 13 example items so the frontend can be built
and demoed end-to-end. State-mutating endpoints (approve/archive/delegate/edit/
skip) echo success without persisting. Phase 2 swaps the fixture for a DB read.
"""
from __future__ import annotations

from typing import Annotated, Literal, TYPE_CHECKING, Union

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext


Source = Literal[
    "email", "sms", "chat",
    "internal-dm", "internal-mention", "internal-notification",
]
Priority = Literal["urgent", "quick", "normal", "low", "later"]
ContextTag = Literal["@home", "@office", "@waiting", "@done", "@someday"]


class Sender(BaseModel):
    name: str
    avatar: str
    color: str
    email: str | None = None
    phone: str | None = None


class Attachment(BaseModel):
    name: str
    size: str


class Due(BaseModel):
    label: str
    minutes: int | None = None


class EmailAction(BaseModel):
    kind: Literal["email"]
    label: str
    to: str
    subject: str
    body: str


class SmsAction(BaseModel):
    kind: Literal["sms"]
    label: str
    to: str
    body: str


class ChatAction(BaseModel):
    kind: Literal["chat", "internal-dm"]
    label: str
    to: str
    body: str


class CalendarAction(BaseModel):
    kind: Literal["calendar"]
    label: str
    title: str
    when: str
    location: str
    attendees: list[str]
    body: str


class NavigateAction(BaseModel):
    kind: Literal["navigate"]
    label: str
    target: str


class DeferAction(BaseModel):
    kind: Literal["defer"]
    label: str
    until: str


class SystemAction(BaseModel):
    kind: Literal["system"]
    label: str
    description: str


Action = Annotated[
    Union[
        EmailAction,
        SmsAction,
        ChatAction,
        CalendarAction,
        NavigateAction,
        DeferAction,
        SystemAction,
    ],
    Field(discriminator="kind"),
]


class ContextBullet(BaseModel):
    label: str
    detail: str


class Proposal(BaseModel):
    whatHappened: str
    actions: list[Action]
    context: list[ContextBullet]
    effort: str


class InboxItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    source: Source
    state: Literal["processed", "unprocessed"]
    priority: Priority
    context: ContextTag
    from_: Sender = Field(..., alias="from")
    time: str
    due: Due
    subject: str | None = None
    body: str | None = None
    excerpt: str | None = None
    eventType: str | None = None
    location: str | None = None
    attachments: list[Attachment] = []
    kv: dict[str, str] | None = None
    dismissRecommended: bool | None = None
    proposal: Proposal | None = None


class ApproveBody(BaseModel):
    skippedIndexes: list[int] = Field(default_factory=list)


class DelegateBody(BaseModel):
    agentId: str
    instruction: str


class SkipBody(BaseModel):
    skipped: bool


SEED_ITEMS: list[InboxItem] = [
    # URGENT
    InboxItem.model_validate({
        "id": "itm-01",
        "source": "email",
        "state": "processed",
        "priority": "urgent",
        "context": "@office",
        "from": {"name": "Priya Narang", "email": "priya@northwind.io", "avatar": "PN", "color": "pink"},
        "subject": "Re: Contract redlines — need your sign-off by 2pm",
        "time": "8m",
        "due": {"label": "2:00pm today", "minutes": 42},
        "body": (
            "Hey — Legal sent over their updated redlines on the MSA. Most are stylistic but two are material:\n\n"
            "1. Indemnity cap raised from $500k → $2M\n"
            "2. Term extended 12→24 months\n\n"
            "I pushed back on (1) but they're firm. Can you give a thumbs-up so I can countersign before our 2pm call? Otherwise we slip to next week.\n\n"
            "— P"
        ),
        "attachments": [{"name": "northwind-msa-v4.pdf", "size": "214 KB"}],
        "proposal": {
            "whatHappened": "Priya needs legal sign-off before 2pm on two material redlines in the Northwind MSA: indemnity cap raised $500k → $2M, and term extended 12 → 24 months.",
            "actions": [
                {
                    "kind": "email",
                    "label": "Send reply approving both redlines",
                    "to": "priya@northwind.io",
                    "subject": "Re: Contract redlines — need your sign-off by 2pm",
                    "body": "Approved on both — indemnity cap to $2M and 24-mo term are fine. Go ahead and countersign. I'll grab the executed copy after the 2pm.\n\n— Taylor",
                },
            ],
            "context": [
                {"label": "Pre-approved range", "detail": "March vendor-review doc authorized indemnity caps up to $2.5M for this tier."},
                {"label": "Peer deals", "detail": "24-mo term matches the other two vendors in this cohort (Lumen, Arbor)."},
                {"label": "Deadline", "detail": "Priya's 2pm call — misses mean a 1-week slip."},
            ],
            "effort": "1 min",
        },
    }),
    InboxItem.model_validate({
        "id": "itm-02",
        "source": "internal-notification",
        "state": "processed",
        "priority": "urgent",
        "context": "@office",
        "from": {"name": "System", "avatar": "SY", "color": "slate"},
        "eventType": "Worker agent errored",
        "time": "22m",
        "due": {"label": "batch paused now", "minutes": 15},
        "kv": {
            "project": "sales-outreach",
            "agent": "chuswine-joyce",
            "error": "RateLimitExceeded (Anthropic, 20 req/min)",
            "last_ok": "10:31 AM",
            "retries": "3 / 3",
        },
        "proposal": {
            "whatHappened": "chuswine-joyce hit Anthropic rate limits during pitch batch #3. Auto-retry exhausted at 3/3; the batch queue is paused.",
            "actions": [
                {"kind": "system", "label": "Upgrade concurrency tier: Standard → Team (+$40/mo)", "description": "Upgrades the sales-outreach project tier and auto-resumes the paused batch."},
            ],
            "context": [
                {"label": "Budget impact", "detail": "+$40/mo; you have $180 unallocated in this project's budget."},
                {"label": "Alternative", "detail": "Wait 4 min and resume manually — costs nothing but delays the batch."},
            ],
            "effort": "30 sec",
        },
    }),
    # < 1 MIN
    InboxItem.model_validate({
        "id": "itm-03",
        "source": "sms",
        "state": "processed",
        "priority": "quick",
        "context": "@home",
        "from": {"name": "Jordan", "phone": "+1 (415) 555-0129", "avatar": "JD", "color": "teal"},
        "time": "14m",
        "due": {"label": "Thu evening", "minutes": 60 * 52},
        "body": "are we still on for dinner thursday? sarah can only do 7 or 8",
        "proposal": {
            "whatHappened": "Jordan is confirming Thursday dinner and asking whether 7pm or 8pm works (Sarah's only windows).",
            "actions": [
                {"kind": "sms", "label": "Reply: 7 works, see you then", "to": "+1 (415) 555-0129", "body": "7 works — see you then. I'll pick the spot and text you the addr."},
            ],
            "context": [
                {"label": "Calendar", "detail": "Thursday evening is open 6pm–10pm."},
                {"label": "Pattern", "detail": "You've picked 7pm the last 4 dinners with this group."},
            ],
            "effort": "10 sec",
        },
    }),
    InboxItem.model_validate({
        "id": "itm-04",
        "source": "email",
        "state": "processed",
        "priority": "quick",
        "context": "@office",
        "from": {"name": "Jane Doe", "email": "jane@acmesupply.co", "avatar": "JD", "color": "amber"},
        "subject": "Quick yes/no on Tuesday?",
        "time": "26m",
        "due": {"label": "Tue 2pm", "minutes": 60 * 28},
        "body": (
            "Hi Taylor — following up on our chat last week. Is Tuesday 2pm still good for the on-site? I can bring the revised estimate and we can walk the shop floor.\n\n"
            "LMK,\nJane"
        ),
        "proposal": {
            "whatHappened": "Jane is asking to confirm a follow-up on-site meeting next Tuesday at 2pm. She'll bring the revised estimate and wants to walk the shop floor.",
            "actions": [
                {
                    "kind": "email",
                    "label": "Send reply confirming Tuesday 2pm",
                    "to": "jane@acmesupply.co",
                    "subject": "Re: Quick yes/no on Tuesday?",
                    "body": "Yes, Tuesday at 2pm works. I'll meet you at the front desk — looking forward to seeing the revised estimate.\n\n— Taylor",
                },
                {
                    "kind": "calendar",
                    "label": "Send calendar invite: On-site w/ Jane Doe",
                    "title": "On-site w/ Jane Doe — Acme Supply",
                    "when": "Tue Apr 28 · 2:00pm – 3:30pm",
                    "location": "Chuswine HQ, shop floor",
                    "attendees": ["jane@acmesupply.co", "taylor@chuswine.co"],
                    "body": "Walkthrough + revised estimate review. Jane to bring updated numbers.",
                },
            ],
            "context": [
                {"label": "Prior thread", "detail": "You tentatively agreed to Tue 2pm last week; this is the confirmation."},
                {"label": "Calendar", "detail": "Tue 2–3:30pm is free. No travel required (on-site at HQ)."},
                {"label": "About Acme", "detail": "Open quote worth $48k, in @waiting since Mar 30."},
            ],
            "effort": "20 sec",
        },
    }),
    InboxItem.model_validate({
        "id": "itm-05",
        "source": "internal-mention",
        "state": "processed",
        "priority": "quick",
        "context": "@office",
        "from": {"name": "chuswine-aubrey", "avatar": "CA", "color": "green"},
        "location": "sales-outreach / milestone-2-pitches-v2",
        "time": "31m",
        "due": {"label": "EOD today", "minutes": 60 * 5},
        "excerpt": "Chunk 3 is done and it looks strong — the K-town cluster framing really landed. @taylor before I ship, can you sanity-check the three borderline pitches in rows 14/17/19? Tier assignment is ambiguous there.",
        "proposal": {
            "whatHappened": "Aubrey is ready to ship milestone-2 chunk 3 but wants you to sanity-check 3 borderline tier assignments (rows 14, 17, 19) before she does.",
            "actions": [
                {"kind": "navigate", "label": "Open the 3 flagged rows in milestone-2-pitches-v2", "target": "sales-outreach / milestone-2-pitches-v2 · rows 14, 17, 19"},
            ],
            "context": [
                {"label": "What's at stake", "detail": "Mis-tiered pitches get the wrong template; 3 rows × ~30 prospects each = ~90 potential misfires."},
                {"label": "Pattern", "detail": "You've overridden Aubrey's tier calls on ~8% of items; she defers to you at the margin."},
            ],
            "effort": "5 min",
        },
    }),
    # NORMAL
    InboxItem.model_validate({
        "id": "itm-06",
        "source": "internal-dm",
        "state": "processed",
        "priority": "normal",
        "context": "@office",
        "from": {"name": "chuswine-assistant", "avatar": "CA", "color": "pink"},
        "time": "48m",
        "due": {"label": "4pm standing", "minutes": 60 * 3},
        "body": "I finished the Q2 outreach recap you asked for last night. Top-line: 142 pitches, 38% response, 11% booked. Full writeup in `shared-context/q2-recap.md`. Three surprises worth flagging — want me to walk through them now or queue for our 4pm?",
        "proposal": {
            "whatHappened": "The assistant has the Q2 recap ready (142 pitches / 38% reply / 11% booked) and is asking whether to walk you through the three 'surprises' now or at your standing 4pm.",
            "actions": [
                {"kind": "internal-dm", "label": "Reply: queue for 4pm", "to": "chuswine-assistant", "body": "Queue for 4pm. Prep the three surprises with data links."},
            ],
            "context": [
                {"label": "Standing slot", "detail": "Your 4pm with chuswine-assistant is the weekly recap block."},
                {"label": "Depth needed", "detail": "'Surprises' tend to need ~20 min of unhurried discussion."},
            ],
            "effort": "15 sec",
        },
    }),
    InboxItem.model_validate({
        "id": "itm-07",
        "source": "chat",
        "state": "processed",
        "priority": "normal",
        "context": "@waiting",
        "from": {"name": "Morgan Reyes", "avatar": "MR", "color": "indigo"},
        "location": "#design-reviews",
        "time": "1h",
        "due": {"label": "next sprint", "minutes": 60 * 72},
        "body": "Posted the v3 onboarding flow in Figma — the one with the welcome sheet before sign-up. Kai and Sam are both +1. **Waiting on you for the green light to hand to eng.** Link inline.",
        "proposal": {
            "whatHappened": "Morgan needs your approval to hand v3 onboarding to eng. Kai and Sam already signed off; you're the last blocker.",
            "actions": [
                {"kind": "navigate", "label": "Open v3 onboarding flow in Figma", "target": "Figma — onboarding-v3"},
                {"kind": "chat", "label": "Reply in #design-reviews: ship it", "to": "#design-reviews", "body": "Reviewed v3 — ship it. Nice work on the welcome sheet."},
            ],
            "context": [
                {"label": "Already approved", "detail": "Kai (design lead) and Sam (PM) both +1."},
                {"label": "Eng capacity", "detail": "Dev Patel's team has a slot open next sprint."},
            ],
            "effort": "3 min",
        },
    }),
    InboxItem.model_validate({
        "id": "itm-08",
        "source": "email",
        "state": "processed",
        "priority": "normal",
        "context": "@office",
        "from": {"name": "Finance Team", "email": "billing@stripe.com", "avatar": "ST", "color": "indigo"},
        "subject": "Invoice #4419 — Northwind (Mar 2026) ready for approval",
        "time": "2h",
        "due": {"label": "Fri (30-day terms)", "minutes": 60 * 96},
        "body": (
            "Invoice #4419 is ready in your finance queue.\n\n"
            "  Client: Northwind Logistics\n"
            "  Amount: $14,200 USD\n"
            "  Period: March 1–31, 2026\n\n"
            "Usual 30-day terms. One click approves & sends."
        ),
        "proposal": {
            "whatHappened": "March invoice for Northwind ($14,200) is queued and matches the contracted monthly rate exactly — no anomalies.",
            "actions": [
                {"kind": "system", "label": "Approve & send invoice #4419", "description": "Sends invoice #4419 to accounts@northwind.io with 30-day terms."},
            ],
            "context": [
                {"label": "Matches contract", "detail": "Contracted rate is $14.2k/mo; this is identical to Feb and Jan."},
                {"label": "Payment history", "detail": "Northwind has paid on-time 11 of last 12 invoices (1 day late once)."},
            ],
            "effort": "20 sec",
        },
    }),
    InboxItem.model_validate({
        "id": "itm-09",
        "source": "chat",
        "state": "unprocessed",
        "priority": "normal",
        "context": "@office",
        "from": {"name": "Dev Patel", "avatar": "DP", "color": "teal"},
        "location": "#eng-platform",
        "time": "2h",
        "due": {"label": "no firm deadline", "minutes": None},
        "body": "The staging DB migration ran clean but we're seeing a 12% latency regression on `GET /projects`. I think it's the new index on `updated_at` — want me to roll it back or dig further?",
    }),
    InboxItem.model_validate({
        "id": "itm-10",
        "source": "email",
        "state": "processed",
        "priority": "normal",
        "context": "@waiting",
        "from": {"name": "Kai Yamamoto", "email": "kai@ymmt.studio", "avatar": "KY", "color": "amber"},
        "subject": "Brand audit findings (you asked Mar 28)",
        "time": "3h",
        "due": {"label": "end of month", "minutes": 60 * 24 * 8},
        "body": (
            "Here's the first pass of the audit. Top three:\n\n"
            "1. Logo lockup inconsistency across 3 subproducts\n"
            "2. Type ramp too wide (13 sizes in use)\n"
            "3. Color tokens referenced but not always honored in marketing site\n\n"
            "Full deck attached (18 slides). No rush on response."
        ),
        "attachments": [
            {"name": "brand-audit-v1.pdf", "size": "2.4 MB"},
            {"name": "findings-summary.md", "size": "4 KB"},
        ],
        "proposal": {
            "whatHappened": "Kai delivered the brand-audit first pass you commissioned on Mar 28. Top three findings: logo inconsistency, overly-wide type ramp, color tokens not honored on marketing site. Full 18-slide deck attached.",
            "actions": [
                {"kind": "navigate", "label": "Open the 18-slide audit deck", "target": "brand-audit-v1.pdf"},
                {"kind": "email", "label": "Queue a thank-you + next steps reply", "to": "kai@ymmt.studio", "subject": "Re: Brand audit findings", "body": "Thanks Kai — skimmed it, the type-ramp finding is the one I'd like to act on first. Can we get on a call this week?\n\n— Taylor"},
            ],
            "context": [
                {"label": "Your ask", "detail": "On Mar 28 you asked for a v1 by end of April. Kai delivered early."},
                {"label": "No rush", "detail": "Kai explicitly said no deadline on reply."},
            ],
            "effort": "12 min",
        },
    }),
    # LOW PRIORITY
    InboxItem.model_validate({
        "id": "itm-11",
        "source": "email",
        "state": "processed",
        "priority": "low",
        "context": "@someday",
        "from": {"name": "Longform Weekly", "email": "hello@longform.weekly", "avatar": "LW", "color": "slate"},
        "subject": "This week: 8 essays on attention, craft, and slow media",
        "time": "5h",
        "due": {"label": "—", "minutes": None},
        "body": (
            "Issue #184.\n\n"
            "• 'The attention economy is eating itself' — Kyle Chayka\n"
            "• 'What editors actually do' — Maria Popova\n"
            "• 'Slow media in a fast year' — Ezra Klein\n"
            "• + 5 more\n\n"
            "Unsubscribe in one click if this isn't for you."
        ),
        "dismissRecommended": True,
        "proposal": {
            "whatHappened": "Weekly newsletter — not a recurring read for you. You've opened 2 of the last 12 issues.",
            "actions": [
                {"kind": "system", "label": "Dismiss and unsubscribe", "description": "Archives this item and sends an unsubscribe request to hello@longform.weekly."},
            ],
            "context": [
                {"label": "Open rate", "detail": "2 of last 12 issues opened."},
                {"label": "Time saved", "detail": "~4 min/week reclaimed if unsubscribed."},
            ],
            "effort": "3 sec",
        },
    }),
    InboxItem.model_validate({
        "id": "itm-12",
        "source": "internal-notification",
        "state": "processed",
        "priority": "low",
        "context": "@done",
        "from": {"name": "System", "avatar": "SY", "color": "slate"},
        "eventType": "Weekly digest ready",
        "time": "6h",
        "due": {"label": "weekly", "minutes": 60 * 24 * 3},
        "kv": {
            "window": "Apr 13 – Apr 20",
            "items_handled": "92",
            "auto_approved": "61",
            "dismissed": "24",
            "flagged_to_you": "7",
        },
        "proposal": {
            "whatHappened": "Weekly assistant digest is ready. 92 items handled, 61 auto-approved, 24 dismissed, 7 flagged to you.",
            "actions": [
                {"kind": "navigate", "label": "Open the full weekly digest", "target": "Inbox / Digest · Apr 13 – Apr 20"},
            ],
            "context": [
                {"label": "Trend", "detail": "Auto-approval rate up 12% vs last week — assistant is getting more confident on routine items."},
            ],
            "effort": "1 min",
        },
    }),
    # LATER
    InboxItem.model_validate({
        "id": "itm-13",
        "source": "email",
        "state": "processed",
        "priority": "later",
        "context": "@someday",
        "from": {"name": "Sam Okoye", "email": "sam@loudroom.co", "avatar": "SO", "color": "pink"},
        "subject": "Podcast invite — Ops in the age of agents",
        "time": "1d",
        "due": {"label": "Jun–Jul (flex)", "minutes": 60 * 24 * 45},
        "body": (
            "Big fan of your work. Would love to have you on the show to talk agent-first operations. 45 min record, remote, no prep needed. Happy to work around your calendar — June or July both open.\n\n"
            "No rush at all on a reply."
        ),
        "proposal": {
            "whatHappened": "Sam is inviting you onto the Loudroom podcast to talk agent-first operations. 45 min remote record, flexible on Jun/Jul.",
            "actions": [
                {"kind": "defer", "label": "Snooze until May 15 (post-v4 launch)", "until": "May 15"},
            ],
            "context": [
                {"label": "Conflict", "detail": "v4 launch is your top priority through mid-May; press before ship is distracting."},
                {"label": "No deadline", "detail": "Sam explicitly said 'no rush' on reply."},
            ],
            "effort": "—",
        },
    }),
]


def _find_item(item_id: str) -> InboxItem:
    for item in SEED_ITEMS:
        if item.id == item_id:
            return item
    raise HTTPException(status_code=404, detail=f"Inbox item {item_id} not found")


def create_inbox_router(ctx: "ServerContext") -> APIRouter:
    """Phase-1 inbox router. State mutations are no-op stubs."""
    router = APIRouter(prefix="/inbox", tags=["inbox"])

    @router.get("/items")
    async def list_items() -> dict:
        return {"items": [item.model_dump(by_alias=True) for item in SEED_ITEMS]}

    @router.post("/items/{item_id}/approve")
    async def approve(item_id: str, body: ApproveBody = Body(default_factory=ApproveBody)) -> dict:
        _find_item(item_id)
        return {"id": item_id, "state": "approved", "skippedIndexes": body.skippedIndexes}

    @router.post("/items/{item_id}/archive")
    async def archive(item_id: str) -> dict:
        _find_item(item_id)
        return {"id": item_id, "state": "archived"}

    @router.post("/items/{item_id}/delegate")
    async def delegate(item_id: str, body: DelegateBody) -> dict:
        _find_item(item_id)
        return {"id": item_id, "state": "delegated", "agentId": body.agentId}

    @router.patch("/items/{item_id}/actions/{action_idx}")
    async def edit_action(
        item_id: str,
        action_idx: int,
        patch: dict = Body(...),
    ) -> dict:
        item = _find_item(item_id)
        if item.proposal is None or action_idx < 0 or action_idx >= len(item.proposal.actions):
            raise HTTPException(status_code=404, detail=f"Action {action_idx} not found on item {item_id}")
        existing = item.proposal.actions[action_idx].model_dump()
        existing.update(patch)
        return existing

    @router.post("/items/{item_id}/actions/{action_idx}/skip")
    async def toggle_skip(
        item_id: str,
        action_idx: int,
        body: SkipBody,
    ) -> dict:
        item = _find_item(item_id)
        if item.proposal is None or action_idx < 0 or action_idx >= len(item.proposal.actions):
            raise HTTPException(status_code=404, detail=f"Action {action_idx} not found on item {item_id}")
        return {"id": item_id, "actionIdx": action_idx, "skipped": body.skipped}

    return router
