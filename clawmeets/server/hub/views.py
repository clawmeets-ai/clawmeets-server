# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/views.py
What the browser is shown, built from stored state: the pure mapping from
outbox rows, threads, pins and the registration to the models of the
browser contract (``browser.py``). No I/O beyond the reads the caller hands
in, and no hub call: the read-only routes (config, deliveries) are answered
from here whatever the hub mode or registration.

**A request row as a Delivery.** Waiting rows read ``sent_to_hub`` until the
target is known to be away: parked ``deployment_offline`` or
``hub_unreachable`` read ``waiting_for_target`` with that reason, and so does
a row parked ``browse_only`` (a server switched to discover_only with requests
queued), shown as ``hub_unreachable`` (a display mapping: the frozen contract
has no browse-only wait). A row held ``held_agent_offline`` waits for the
agent; one held ``held_for_approval`` is delivered, with the flag. Ended rows
map their stored reason onto the contract's vocabulary. ``expires_at`` is the
sweep's own limit: 72 h from the send, or for a held row 7 days from when it
left (``forwarded_at``), so the limit shown is the real one.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional, get_args

from clawmeets.hub_protocol.canonical import b64url_decode, fingerprint

from clawmeets.hub_protocol.constants import (
    MAX_ENVELOPE_BYTES,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_TEXT_BYTES,
    PROTOCOL_VERSION,
)
from clawmeets.server.channels import hub_delivery
from clawmeets.server.channels.store import (
    AWAITING_RECEIPT,
    EXPIRED,
    PARKED,
    PENDING,
    SENDING,
    SENT,
    WAIT_BROWSE_ONLY,
    WAIT_DEPLOYMENT_OFFLINE,
    WAIT_HUB_UNREACHABLE,
    OutboxRow,
)

from .browser import (
    DAILY_RUN_CAP,
    BlockedDeployment,
    Delivery,
    FailedReason,
    HubAgent,
    HubChannel,
    HubChannelStatus,
    HubConfigOut,
    HubContactFields,
    HubTarget,
    RejectReason,
)

if TYPE_CHECKING:
    from clawmeets.models.agent import Agent
    from clawmeets.server.channels.config import HubConfig
    from clawmeets.server.channels.hub_store import HubChannelState, HubRegistration, HubStore, HubThread

HELD_FOR_APPROVAL = "held_for_approval"
HELD_AGENT_OFFLINE = "held_agent_offline"
_FAILED_REASONS = frozenset(get_args(FailedReason))
#: Stored reasons whose contract name differs.
_REASON_NAMES = {"blocked": "blocked_by_target", "stale": "expired_72h"}
#: A parked row's wait, as the browser names it.
_WAITS = {
    WAIT_DEPLOYMENT_OFFLINE: "deployment_offline",
    WAIT_HUB_UNREACHABLE: "hub_unreachable",
    WAIT_BROWSE_ONLY: "hub_unreachable",
}
_REGISTRATION = {"pending_email": "pending_email", "active": "active", "suspended": "suspended"}
_CHANNEL_STATUSES = frozenset(get_args(HubChannelStatus))
_REJECT_REASONS = frozenset(get_args(RejectReason))


def failed_reason(reason: Optional[str]) -> str:
    """A stored failure reason as the contract names it; anything this build
    does not name (a hub refusal code) reads ``rejected_by_hub``."""
    name = _REASON_NAMES.get(reason or "", reason or "")
    return name if name in _FAILED_REASONS else "rejected_by_hub"


def reject_reason(reason: Optional[str]) -> Optional[str]:
    """A stored hub rejection reason as the contract names it; one this build
    does not name (a newer hub's) reads None, never a 500."""
    return reason if reason in _REJECT_REASONS else None


def delivery_out(row: OutboxRow) -> Delivery:
    """One requester message's delivery (see the module docstring)."""
    held_for_approval = row.last_receipt == HELD_FOR_APPROVAL
    was_held = row.last_receipt in hub_delivery.HELD_RECEIPTS
    if was_held:
        since = row.forwarded_at if row.forwarded_at is not None else row.created_at
        expires_at = since + hub_delivery.HELD_CEILING_SECONDS
    else:
        expires_at = row.created_at + hub_delivery.max_age(row)
    state, waiting, failed, detail = "sent_to_hub", None, None, None
    if row.state in (PENDING, SENDING, AWAITING_RECEIPT):
        pass
    elif row.state == PARKED:
        waiting = _WAITS.get(row.reason or "")
        if waiting is not None:
            state = "waiting_for_target"
    elif row.state == SENT:
        if row.last_receipt == HELD_AGENT_OFFLINE:
            # Connected but unable to run it isolated reads apart from offline:
            # the owner has been told, and it is theirs to fix.
            state = "waiting_for_target"
            waiting = ("isolation_unavailable" if row.delivery_detail == "isolation_unavailable"
                       else "agent_offline")
        else:
            state = "delivered"
    else:                                               # failed or expired
        state = "failed"
        failed = failed_reason(row.reason or ("expired_72h" if row.state == EXPIRED else None))
        if failed == "not_accepting":
            detail = row.delivery_detail
    return Delivery(
        message_id=row.message_id, state=state, waiting_reason=waiting, failed_reason=failed,
        detail=detail, retry_at=row.retry_at if state == "failed" else None,
        held_for_approval=held_for_approval, delivered_late=row.delivered_late,
        attempts=row.attempts, state_at=row.updated_at or row.created_at, expires_at=expires_at,
    )


def registration_state(reg: Optional["HubRegistration"]) -> str:
    """``held_for_reclaim`` and anything unknown read ``none``."""
    return _REGISTRATION.get(reg.status, "none") if reg is not None else "none"


def sender_label(username: str, reg: Optional["HubRegistration"]) -> str:
    """What a host deployment shows for this user: ``{username} @ {deployment_name}``."""
    if reg is not None and reg.name and registration_state(reg) != "none":
        return f"{username} @ {reg.name}"
    return username


def config_out(
    config: "HubConfig", reg: Optional["HubRegistration"], *, link: str, username: str,
    channels_enabled: bool,
) -> HubConfigOut:
    registered = registration_state(reg) != "none" and reg is not None and reg.deployment_id is not None
    return HubConfigOut(
        mode=config.mode, hub_url=config.hub_url, hub_url_is_default=config.is_default,
        deployment_id=reg.deployment_id if registered else None,
        deployment_connected=link == "connected",
        last_connected_at=reg.last_connected_at if reg is not None else None,
        protocol_version=PROTOCOL_VERSION,
        deployment_fingerprint=reg.genesis_fp if registered else None,
        deployment_name=reg.name if registered else None,
        registration=registration_state(reg), hub_link=link, channels_enabled=channels_enabled,
        sender_label=sender_label(username, reg), max_file_bytes=MAX_FILE_BYTES, max_files=MAX_FILES,
        max_envelope_bytes=MAX_ENVELOPE_BYTES, max_text_bytes=MAX_TEXT_BYTES,
    )


def current_fingerprint(hub: "HubStore", genesis_fp: str) -> Optional[str]:
    """The deployment's current key when it rotated since its genesis; None otherwise."""
    chain = hub.chain(genesis_fp)
    head = chain[-1].fingerprint if chain else None
    return head if head is not None and head != genesis_fp else None


def hub_target_out(
    hub: "HubStore", thread: "HubThread", *, deployment_label: str = "",
    deployment_url: Optional[str] = None, deployment_url_verified: bool = False,
) -> Optional[HubTarget]:
    """``hub_target`` for a requester thread's project."""
    stand_in = hub.remote_agent(thread.stand_in_id)
    if stand_in is None:
        return None
    return HubTarget(
        hub_agent_id=stand_in.id, display=stand_in.display, name=stand_in.agent_name,
        deployment_name=stand_in.deployment_name, deployment_label=deployment_label,
        deployment_fingerprint=stand_in.genesis_fp,
        current_fingerprint=current_fingerprint(hub, stand_in.genesis_fp),
        deployment_url=deployment_url if deployment_url_verified else None,
        deployment_url_verified=deployment_url_verified,
        listed=thread.closed_reason not in ("agent_unlisted", "deployment_suspended"),
        closed_reason=thread.closed_reason, closed_at=thread.closed_at,
    )


def project_hub_target(
    hub: "HubStore", project_id: str, *, agent: Optional[HubAgent] = None,
) -> Optional[dict]:
    """``hub_target`` as a project response carries it: None for a project
    that is not a hub thread. ``agent`` (the last directory answer, if any)
    supplies the deployment's label and verified address."""
    thread = hub.thread_for_project(project_id)
    if thread is None:
        return None
    target = hub_target_out(
        hub, thread, deployment_label=agent.deployment_label if agent is not None else "",
        deployment_url=agent.deployment_url if agent is not None else None,
        deployment_url_verified=agent.deployment_url_verified if agent is not None else False,
    )
    return target.model_dump(mode="json") if target is not None else None


def key_last4(cert: Optional[dict]) -> Optional[str]:
    """The tail of the agent key's fingerprint (never of the key itself)."""
    try:
        return fingerprint(b64url_decode(cert["agent_pubkey"], length=32))[-4:] if cert else None
    except (KeyError, TypeError, ValueError):
        return None


def listed_as(agent_name: str, reg: Optional["HubRegistration"]) -> Optional[str]:
    if reg is None or not reg.name or registration_state(reg) != "active":
        return None
    return f"{agent_name}@{reg.name}"


def channel_status(
    config: "HubConfig", reg: Optional["HubRegistration"], *, link: str, agent: "Agent",
    state: Optional["HubChannelState"],
) -> str:
    """The card's status: the server's own state first (hub off, not
    registered, untrusted), then the agent's eligibility, then the channel's."""
    if not config.enabled:
        return "hub_off_on_server"
    if registration_state(reg) != "active":
        return "hub_not_registered"
    if link == "untrusted":
        return "hub_untrusted"
    if state is None or not state.enabled:
        return "off"                          # turning it on makes the agent public
    if not agent.is_discoverable:
        return "agent_not_public"             # made private since: disable_private turns it off
    if state.status == "connected" and link != "connected":
        return "hub_unreachable"
    return state.status if state.status in _CHANNEL_STATUSES else "hub_unreachable"


def channel_out(
    config: "HubConfig", reg: Optional["HubRegistration"], *, link: str, agent: "Agent",
    state: Optional["HubChannelState"], open_conversations: int, in_flight_messages: int,
    next_midnight: float, now: float, isolation: str = "unavailable", held_conversations: int = 0,
    local_conversations: int = 0,
) -> HubChannel:
    """An agent's Hub channel, as its owner's card shows it (masked: the
    only key material is ``key_last4``)."""
    fresh_day = state is None or state.runs_reset_at is None or now >= state.runs_reset_at
    return HubChannel(
        enabled=bool(state is not None and state.enabled),
        status=channel_status(config, reg, link=link, agent=agent, state=state),
        status_detail=state.status_detail if state is not None else None,
        reject_reason=reject_reason(state.reject_reason) if state is not None and state.status == "rejected" else None,
        # The switch makes the agent public, so every agent can be listed;
        # only an enabled channel of an agent made private since is not.
        eligible=agent.is_discoverable or not (state is not None and state.enabled),
        ineligible_reason=(None if agent.is_discoverable or not (state is not None and state.enabled)
                           else "agent_not_public"),
        public=agent.is_discoverable,
        listed_as=listed_as(agent.name, reg),
        key_last4=key_last4(state.cert if state is not None else None),
        rotate_by=state.rotate_by if state is not None else None,
        last_success_at=state.last_success_at if state is not None else None,
        next_retry_at=state.next_retry_at if state is not None else None,
        hub_url=config.hub_url, hub_url_is_default=config.is_default,
        open_conversations=open_conversations, in_flight_messages=in_flight_messages,
        daily_run_cap=DAILY_RUN_CAP,
        runs_today=0 if fresh_day else state.runs_today,
        runs_reset_at=next_midnight if fresh_day else state.runs_reset_at,
        isolation=isolation, held_conversations=held_conversations,
        local_conversations=local_conversations, owner_isolated=agent.owner_isolated,
    )


def blocked_out(hub: "HubStore", scope: Optional[str]) -> list[BlockedDeployment]:
    if scope is None:
        return []
    return [
        BlockedDeployment(
            deployment_fingerprint=b.genesis_fp, current_fingerprint=current_fingerprint(hub, b.genesis_fp),
            deployment_name=b.deployment_name, created_at=b.created_at,
        )
        for b in hub.blocked_deployments(scope)
    ]


def contact_fields(hub: "HubStore", user_key: Optional[str], name: Optional[str],
                   connection_id: Optional[str] = None) -> HubContactFields:
    """A hub sender's separate fields on request and thread rows: the
    username (the contact's stored name), its deployment's name and genesis
    fingerprint, and which of their agents sent their newest message, so the
    browser never parses a display string."""
    genesis = (user_key or "").split("~", 1)[0] or None
    pin = hub.pin_for(genesis) if genesis else None
    return HubContactFields(
        remote_username=name or None, deployment_name=pin.deployment_name if pin is not None else None,
        deployment_fingerprint=genesis, via_agent=hub.via_agent_for(connection_id, user_key),
    )


def bridge_project_ids(ctx) -> set[str]:
    """Every room-bridge thread's project id (plumbing: project lists filter
    them out server-side). Empty when no channel store exists."""
    runtime = getattr(ctx, "hub_runtime", None)
    if runtime is not None:
        return runtime.hub.bridge_project_ids()
    store = getattr(ctx, "channel_store", None)
    if store is None:
        return set()
    from clawmeets.server.channels.hub_store import HubStore

    return HubStore(store).bridge_project_ids()
