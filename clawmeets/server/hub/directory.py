# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/directory.py
The hub's directory as this server's users see it: search, one agent's
detail, and reporting an agent. Every answer comes from the hub over the
outbound socket (``search``, ``agent_get``, ``report``); search and detail
answers are cached for 24 h (``hub_directory_cache``) and served from the
cache, marked ``served_from="cache"``, while the hub cannot be reached.
A live search also drops every cached agent item older than the listing
refresh it reports, so a changed listing (and its avatar) shows at once.

**Hub-state errors** come from ``HubRuntime.require`` in its fixed order; a
``hub_unreachable`` is answered from the cache when there is one.

**Marking.** Every item gets ``hub_agent_id = {genesis fp}~{agent_name}``
(opaque to the browser), ``is_local`` (its deployment is this one: the local
entry wins and keeps the in-process path), ``first_contact`` (no key of that
deployment is pinned here yet) and ``current_fingerprint`` (only when the
deployment rotated since its genesis, as pinned here). A deployment URL is
shown only when the hub verified it. ``retained`` is true when the asking
user retained the agent and its row is still ``active`` (``hub_retained``).
The raw hub answer is what is cached; the marking is redone on every read,
so a pin or retain made since is reflected. A search answer never changes a
retained row's state (only a signed statement or a new retain does).

**Agent detail** (and the avatar, which reads the same answer) is checked
by ``HubDirectory.item_verifies``: the item must be the agent asked about,
its certificate for this hub, unexpired and, once the deployment is pinned,
signed by a live pinned key of it; then the listing's signature with the
certificate's agent key. An item that fails is treated as not found and
nothing is cached.

**Rate limit.** Each user may make ``USER_REQUESTS_PER_MINUTE`` directory
calls a minute (search, detail, report together): ``rate_limited`` [429]
with ``retry_after`` past that, before the hub is asked. The detail lookups
that start a conversation and check a target before a send are not charged
(``agent(..., charge=False)``): a send is never refused by this budget.

**Hub lookups.** The hub allows this deployment a fixed number of
``agent_get`` a minute, shared by every user. So an agent item fetched in the
last ``LOOKUP_FRESH_S`` is answered from the cache without asking again (one
user repeating start costs the hub one lookup per agent in that time; send's
target check, which reads presence, always asks), and each
user may send at most ``HUB_LOOKUPS_PER_USER_MINUTE`` lookups to the hub a
minute, charged or not; past that a cached answer is served if there is one,
else ``rate_limited``. One user can no longer use the deployment's hub budget
up for everyone else.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping, Optional

from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import Purpose, b64url_decode, verify_object
from clawmeets.hub_protocol.codes import ErrorCode
from clawmeets.hub_protocol.frames import AgentItem, AgentSummary, SearchResult, verify_listing
from clawmeets.hub_protocol.ids import AgentRef, agent_ref, parse_agent_ref, reporter_id

from .browser import HubAgent, HubAgentDetail, HubAgentPage, HubAgentSearch, HubError, ReportRequest
from .views import current_fingerprint

if TYPE_CHECKING:
    from clawmeets.server.channels.hub_store import CachedAnswer

    from .runtime import HubRuntime

logger = logging.getLogger(__name__)

USER_REQUESTS_PER_MINUTE = 60
#: Below the hub's per-deployment lookup limit (120 a minute).
HUB_LOOKUPS_PER_USER_MINUTE = 20
#: An agent item this young is reused without asking the hub.
LOOKUP_FRESH_S = 30.0
AVATAR_PATH = "/api/hub/agents/{hub_agent_id}/avatar"
#: Hub error codes passed to the browser as they are.
_PASSED = {
    ErrorCode.QUERY_TOO_BROAD.value: "query_too_broad",
    ErrorCode.AGENT_NOT_FOUND.value: "agent_not_found",
    ErrorCode.AGENT_UNLISTED.value: "agent_unlisted",
    ErrorCode.RATE_LIMITED.value: "rate_limited",
}


@dataclass(frozen=True)
class AgentLookup:
    """One agent's detail plus what a conversation needs (its deployment)."""

    detail: HubAgentDetail
    deployment_id: Optional[str]


class _UserLimiter:
    #: Past this many users tracked, users with no request in the last minute are dropped.
    SWEEP_AT = 1024

    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self._hits: dict[str, deque[float]] = {}

    def check(self, user_id: str, *, what: str = "too many directory requests") -> None:
        now = time.monotonic()
        if len(self._hits) >= self.SWEEP_AT:
            self._hits = {u: h for u, h in self._hits.items() if h and h[-1] > now - 60.0}
        hits = self._hits.setdefault(user_id, deque())
        while hits and hits[0] <= now - 60.0:
            hits.popleft()
        if len(hits) >= self.per_minute:
            raise HubError("rate_limited", what,
                           retry_after=max(1, int(60.0 - (now - hits[0])) + 1))
        hits.append(now)


class HubDirectory:
    def __init__(self, runtime: "HubRuntime") -> None:
        self.runtime = runtime
        self.limiter = _UserLimiter(USER_REQUESTS_PER_MINUTE)
        self.hub_lookups = _UserLimiter(HUB_LOOKUPS_PER_USER_MINUTE)

    @property
    def hub(self):
        return self.runtime.hub

    def _now(self) -> float:
        return self.runtime._now()

    # ── the hub, with the cache behind it ────────────────────────────────

    async def _ask(self, frame_type: str, body: Mapping[str, Any], expect: str) -> dict:
        """One hub request; its answer's data, or a HubError for a hub error
        (``hub_unreachable`` when the socket is down or the hub does not answer)."""
        client = self.runtime.client
        if client is None:
            raise HubError("hub_unreachable", "the hub cannot be reached")
        try:
            reply = await client.request(frame_type, body)
        except (ConnectionError, asyncio.TimeoutError):
            raise HubError("hub_unreachable", "the hub cannot be reached") from None
        if reply.frame.type == expect:
            return dict(reply.data)
        code = str(reply.data.get("code") or "") if reply.frame.type == "error" else ""
        mapped = _PASSED.get(code)
        if mapped == "rate_limited":
            raise HubError(mapped, "the hub is rate limiting this server",
                           retry_after=_retry_after(reply.data.get("retry_after")))
        if mapped is not None:
            raise HubError(mapped, str(reply.data.get("message") or code))
        logger.warning("Hub %s answered %s %s", frame_type, reply.frame.type, code or "")
        raise HubError("hub_unreachable", "the hub could not answer")

    async def _require_or_cache(self, cached) -> bool:
        """The hub-state checks (connecting first in mode auto); True when the
        hub is unreachable and a cached answer may be served instead."""
        try:
            await self.runtime.require_live(send=False)
        except HubError as exc:
            if exc.code == "hub_unreachable" and cached is not None:
                return True
            raise
        return False

    # ── marking ──────────────────────────────────────────────────────────

    def _own_genesis(self) -> Optional[str]:
        reg = self.runtime.registration()
        return reg.genesis_fp if reg is not None else None

    def agent_out(self, summary: AgentSummary, *, now: float) -> HubAgent:
        genesis = self.hub.genesis_of(summary.deployment_fingerprint) or summary.deployment_fingerprint
        hub_agent_id = agent_ref(genesis, summary.agent_name)
        return HubAgent(
            hub_agent_id=hub_agent_id, name=summary.agent_name, deployment_name=summary.deployment_name,
            deployment_label=summary.deployment_label, deployment_fingerprint=genesis,
            current_fingerprint=current_fingerprint(self.hub, genesis),
            deployment_url=summary.public_url if summary.public_url_verified else None,
            deployment_url_verified=summary.public_url_verified,
            first_contact=self.hub.first_seen(genesis) is None,
            description=summary.description, capabilities=list(summary.capabilities),
            avatar_url=AVATAR_PATH.format(hub_agent_id=hub_agent_id) if summary.has_avatar else None,
            agent_online=summary.agent_online, deployment_connected=summary.deployment_connected,
            accepting_messages=summary.accepting_messages, needs_approval=summary.needs_approval,
            last_seen_at=summary.last_seen_at, listed_at=summary.listed_at,
            listing_refreshed_at=summary.refreshed_at, listing_age_s=max(0.0, now - summary.refreshed_at),
            is_local=genesis == self._own_genesis(),
        )

    # ── search ───────────────────────────────────────────────────────────

    @staticmethod
    def _query_key(params: HubAgentSearch) -> str:
        return json.dumps({
            "q": params.q, "capabilities": sorted(params.capabilities), "online_only": params.online_only,
            "cursor": params.cursor, "limit": params.limit,
        }, sort_keys=True, separators=(",", ":"))

    def _page(self, raw: Mapping[str, Any], *, cached_at: Optional[float]) -> HubAgentPage:
        now = self._now()
        result = SearchResult.model_validate(raw)
        return HubAgentPage(
            agents=[self.agent_out(a, now=now) for a in result.agents], next_cursor=result.next_cursor,
            served_from="cache" if cached_at is not None else "live",
            cache_age_s=max(0.0, now - cached_at) if cached_at is not None else None,
            cached_at=cached_at,
        )

    async def search(self, user_id: str, params: HubAgentSearch) -> HubAgentPage:
        page = await self._search(user_id, params)
        retained = self.runtime.retained.retained_hub_ids(user_id, [a.hub_agent_id for a in page.agents])
        page.agents = [a.model_copy(update={"retained": a.hub_agent_id in retained}) for a in page.agents]
        return page

    async def _search(self, user_id: str, params: HubAgentSearch) -> HubAgentPage:
        key = self._query_key(params)
        cached = self.hub.cached_search(key, now=self._now())
        if await self._require_or_cache(cached):
            return self._page(cached.body, cached_at=cached.cached_at)
        self.limiter.check(user_id)
        body = {"q": params.q, "capabilities": params.capabilities, "online_only": params.online_only,
                "cursor": params.cursor, "limit": params.limit}
        try:
            raw = await self._ask("search", body, "search_result")
        except HubError as exc:
            if exc.code == "hub_unreachable" and cached is not None:
                return self._page(cached.body, cached_at=cached.cached_at)
            raise
        self.hub.cache_search(key, raw, now=self._now())
        page = self._page(raw, cached_at=None)
        # A live answer is the freshest word on each listing: a cached agent
        # item (and so its avatar) older than it is dropped, so the next
        # detail or avatar request asks the hub again.
        self.hub.drop_cached_agents_refreshed_before(
            {a.hub_agent_id: int(a.listing_refreshed_at) for a in page.agents})
        return page

    # ── one agent ────────────────────────────────────────────────────────

    def _detail(self, raw: Mapping[str, Any], *, cached_at: Optional[float]) -> AgentLookup:
        item = AgentItem.model_validate(raw)
        agent = self.agent_out(item.item, now=self._now())
        detail = HubAgentDetail(**agent.model_dump(), listed=True,
                                served_from="cache" if cached_at is not None else "live")
        return AgentLookup(detail=detail, deployment_id=raw.get("deployment_id"))

    def item_verifies(self, raw: Mapping[str, Any], ref: AgentRef) -> bool:
        """An ``agent_item`` answer is for the agent asked about, and its
        listing is signed by that agent's certified key. Checked, in order:
        it fits; its name, its certificate's name and its deployment (as
        pinned here, else as the hub names it) are ``ref``'s; the certificate is for this hub and not
        expired; when the issuer key is pinned, it is a live key of that
        deployment and signed the certificate; when the deployment is pinned
        but the issuer is not, refused; then ``listing_sig`` with the
        certificate's agent key. Only on first contact (nothing of that
        deployment pinned here) does the certificate rest on trust in the
        hub, which ``first_contact`` already tells the browser."""
        try:
            item = AgentItem.model_validate(raw)
        except ValidationError:
            return False
        summary, cert = item.item, item.cert
        if summary.agent_name != ref.agent_name or cert.agent_name != ref.agent_name:
            return False
        genesis = self.hub.genesis_of(summary.deployment_fingerprint) or summary.deployment_fingerprint
        if genesis != ref.deployment_fingerprint:
            return False
        if cert.hub_url != self.runtime.config.hub_url or cert.not_after <= self._now():
            return False
        issuer = self.hub.pin_for(cert.issuer_fp)
        if issuer is not None:
            if (issuer.genesis_fp != genesis or issuer.revoked_at is not None
                    or issuer.identity_changed_at is not None
                    or not verify_object(raw["cert"], issuer.pubkey, purpose=Purpose.AGENT_CERT)):
                return False
        elif self.hub.first_seen(genesis) is not None:
            return False
        try:
            pub = b64url_decode(cert.agent_pubkey, length=32)
        except ValueError:
            return False
        return verify_listing(raw, pub, aud=self.runtime.config.hub_url)

    def cached_item(self, hub_agent_id: str) -> Optional["CachedAnswer"]:
        """The cached ``agent_item`` for an agent, checked again as it is read
        (a certificate expires, a deployment gets pinned after first contact);
        one that no longer verifies is dropped from the cache."""
        cached = self.hub.cached_agent(hub_agent_id, now=self._now())
        if cached is None:
            return None
        try:
            ref = parse_agent_ref(hub_agent_id)
        except ValueError:
            ref = None
        if ref is None or not self.item_verifies(cached.body, ref):
            logger.info("Cached hub agent item for %s no longer verifies: dropped", hub_agent_id)
            self.hub.drop_cached_agent(hub_agent_id)
            return None
        return cached

    async def agent(self, user_id: str, hub_agent_id: str, *, charge: bool = True,
                    live: bool = False) -> AgentLookup:
        """One agent's detail. ``charge=False`` (start and send) skips the
        per-user budget; the hub's own limits still apply. ``live`` (send's
        target check, which reads presence) never reuses a fresh cached item."""
        lookup = await self._agent(user_id, hub_agent_id, charge=charge, live=live)
        retained = bool(self.runtime.retained.retained_hub_ids(user_id, [lookup.detail.hub_agent_id]))
        return AgentLookup(detail=lookup.detail.model_copy(update={"retained": retained}),
                           deployment_id=lookup.deployment_id)

    async def _agent(self, user_id: str, hub_agent_id: str, *, charge: bool, live: bool) -> AgentLookup:
        try:
            ref = parse_agent_ref(hub_agent_id)
        except ValueError:
            raise HubError("invalid_agent_id", "not a hub agent id") from None
        cached = self.cached_item(hub_agent_id)
        if await self._require_or_cache(cached):
            return self._detail(cached.body, cached_at=cached.cached_at)
        if not live and cached is not None and self._now() - cached.cached_at < LOOKUP_FRESH_S:
            return self._detail(cached.body, cached_at=None)          # just fetched: as good as live
        if charge:
            self.limiter.check(user_id)
        try:
            self.hub_lookups.check(user_id, what="too many hub lookups")
        except HubError:
            if cached is not None:
                return self._detail(cached.body, cached_at=cached.cached_at)
            raise
        try:
            raw = await self._ask("agent_get", {"deployment_fingerprint": ref.deployment_fingerprint,
                                                "agent_name": ref.agent_name}, "agent_item")
        except HubError as exc:
            if exc.code == "hub_unreachable" and cached is not None:
                return self._detail(cached.body, cached_at=cached.cached_at)
            if exc.code == "agent_unlisted":
                exc.status = 404                    # 404 on detail, 410 on start and send
            raise
        if not self.item_verifies(raw, ref):
            logger.warning("Hub agent item for %s does not verify: not shown", hub_agent_id)
            raise HubError("agent_not_found", "no such agent")
        self.hub.cache_agent(hub_agent_id, raw, now=self._now())
        return self._detail(raw, cached_at=None)

    def cached(self, hub_agent_id: str) -> Optional[HubAgent]:
        """The last answer for an agent (any age within the cache), marked now."""
        cached = self.cached_item(hub_agent_id)
        if cached is None:
            return None
        try:
            return self._detail(cached.body, cached_at=cached.cached_at).detail
        except ValidationError:
            return None

    # ── report ───────────────────────────────────────────────────────────

    async def report(self, user_id: str, hub_agent_id: str, req: ReportRequest) -> None:
        try:
            ref = parse_agent_ref(hub_agent_id)
        except ValueError:
            raise HubError("invalid_agent_id", "not a hub agent id") from None
        await self.runtime.require_live(send=False)
        self.limiter.check(user_id)
        config = self.runtime.config
        try:
            secret = self.hub.reporter_secret(config.hub_url, config.fernet)
        except Exception:  # noqa: BLE001 — no readable reporter secret: not registered
            raise HubError("hub_not_registered", "this server is not registered with the hub") from None
        body = {"deployment_fingerprint": ref.deployment_fingerprint, "agent_name": ref.agent_name,
                "reason": req.reason, "reporter": reporter_id(secret, user_id)}
        if req.note:
            body["note"] = req.note
        await self._ask("report", body, "report_ack")


def _retry_after(raw: Any) -> int:
    """The hub's retry_after as whole seconds in [1, 3600]; 60 when it is
    missing or not a number."""
    try:
        seconds = int(raw)
    except (TypeError, ValueError, OverflowError):
        return 60
    return min(max(seconds, 1), 3600)
