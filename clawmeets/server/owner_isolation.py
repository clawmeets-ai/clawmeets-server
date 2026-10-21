# SPDX-License-Identifier: BUSL-1.1
"""Owner isolation (plan-owner-isolation sections 2 and 5).

An owner may say a public agent "runs in its own isolated environment that I
set up" (``owner_isolated``, a top-level card field only the owner's user JWT
sets). This module keeps what the server knows about that agent's host (the
runner's self-reported ``HostReport``), computes the refusals of section 5a
and serves the frozen status and copy of section 8.

The co-host check catches the owner's mistakes, not an attacker: once a
hijacked turn has run unsandboxed on a host, that host's reports can lie.

Host reports are kept in memory per agent (the latest from a socket or a
mint) and persisted, last one per agent, in ``owner_isolation_hosts`` so the
status page works while the agent is offline. A persisted report alone never
makes the setting effective (section 2).
"""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from clawmeets.api.turn_protocol import HostReport

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext
    from clawmeets.server.ws_hub import Hub

logger = logging.getLogger("clawmeets.server.owner_isolation")


def parse_host_report(raw: object) -> Optional[HostReport]:
    """A report from an auth frame or a mint body; None when absent or
    malformed (which every check treats as "unreported")."""
    if raw is None:
        return None
    try:
        return HostReport.model_validate(raw)
    except Exception:  # noqa: BLE001 — a bad report is no report
        logger.info("ignoring a malformed host report")
        return None


class OwnerIsolationStore:
    """The last host report per agent (sqlite, next to the gate's files)."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS owner_isolation_hosts ("
            " agent_id TEXT PRIMARY KEY, host_key TEXT NOT NULL, readable_agent_ids TEXT NOT NULL,"
            " user_session_present INTEGER NOT NULL, model_key_digest TEXT, model_login TEXT,"
            " reported_at REAL NOT NULL)"
        )
        self._exposed_schema()

    def save(self, agent_id: str, report: HostReport, now: float) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO owner_isolation_hosts VALUES (?,?,?,?,?,?,?)",
                (agent_id, report.host_key, json.dumps(report.readable_agent_ids),
                 int(report.user_session_present), report.model_key_digest, report.model_login, now),
            )

    def load(self, agent_id: str) -> Optional[HostReport]:
        with self._lock:
            row = self._db.execute(
                "SELECT host_key, readable_agent_ids, user_session_present, model_key_digest, model_login"
                " FROM owner_isolation_hosts WHERE agent_id = ?", (agent_id,),
            ).fetchone()
        if row is None:
            return None
        return HostReport(host_key=row[0], readable_agent_ids=json.loads(row[1]),
                          user_session_present=bool(row[2]), model_key_digest=row[3],
                          model_login=row[4] or "none")

    # -- exposed hosts (section 5e) ---------------------------------------

    def _exposed_schema(self) -> None:
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS owner_isolation_exposed_hosts ("
            " host_key TEXT NOT NULL, owner_id TEXT NOT NULL, agent_id TEXT NOT NULL,"
            " first_turn_at REAL NOT NULL, last_turn_at REAL NOT NULL, cleared_at REAL,"
            " PRIMARY KEY (host_key, agent_id))"
        )
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS owner_isolation_host_refusals ("
            " host_key TEXT NOT NULL, agent_id TEXT NOT NULL, owner_id TEXT NOT NULL,"
            " refused_by TEXT NOT NULL, refused_at REAL NOT NULL, PRIMARY KEY (host_key, agent_id))"
        )

    def record_exposed(self, host_key: str, owner_id: str, agent_id: str, now: float) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO owner_isolation_exposed_hosts VALUES (?,?,?,?,?,NULL)"
                " ON CONFLICT (host_key, agent_id) DO UPDATE SET last_turn_at = excluded.last_turn_at,"
                " cleared_at = NULL",
                (host_key, owner_id, agent_id, now, now),
            )

    def exposing_agents(self, host_key: str, owner_id: str) -> list[str]:
        """This owner's agents whose uncleared row marks ``host_key``."""
        with self._lock:
            rows = self._db.execute(
                "SELECT agent_id FROM owner_isolation_exposed_hosts WHERE host_key = ? AND owner_id = ?"
                " AND cleared_at IS NULL ORDER BY first_turn_at", (host_key, owner_id),
            ).fetchall()
        return [r[0] for r in rows]

    def exposed_hosts_of(self, agent_id: str) -> list[str]:
        with self._lock:
            rows = self._db.execute(
                "SELECT host_key FROM owner_isolation_exposed_hosts WHERE agent_id = ? AND cleared_at IS NULL",
                (agent_id,),
            ).fetchall()
        return [r[0] for r in rows]

    def clear_exposed(self, agent_id: str, now: float) -> None:
        with self._lock:
            hosts = [r[0] for r in self._db.execute(
                "SELECT host_key FROM owner_isolation_exposed_hosts WHERE agent_id = ? AND cleared_at IS NULL",
                (agent_id,))]
            self._db.execute("UPDATE owner_isolation_exposed_hosts SET cleared_at = ? WHERE agent_id = ?"
                             " AND cleared_at IS NULL", (now, agent_id))
            for host in hosts:
                self._db.execute("DELETE FROM owner_isolation_host_refusals WHERE host_key = ?"
                                 " AND refused_by = ?", (host, agent_id))

    def record_refusal(self, host_key: str, agent_id: str, owner_id: str, refused_by: str, now: float) -> None:
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO owner_isolation_host_refusals VALUES (?,?,?,?,?)",
                             (host_key, agent_id, owner_id, refused_by, now))

    def refused_agents(self, refused_by: str) -> list[str]:
        with self._lock:
            rows = self._db.execute("SELECT agent_id FROM owner_isolation_host_refusals WHERE refused_by = ?"
                                    " ORDER BY refused_at", (refused_by,)).fetchall()
        return [r[0] for r in rows]

    def all_reports(self) -> dict[str, HostReport]:
        with self._lock:
            ids = [r[0] for r in self._db.execute("SELECT agent_id FROM owner_isolation_hosts")]
        return {i: r for i in ids if (r := self.load(i)) is not None}

    def close(self) -> None:
        self._db.close()


# ── the setting (sections 2, 5a and 8) ─────────────────────────────────────

OWNER_ISOLATED_TURNS = "owner_isolated_turns.v1"   # literal: no runner import for a wire string


def confirm_copy(agent: str) -> dict:
    """The switch's confirm copy (section 8, revision 3)."""
    return {
        "title": f"Run {agent} without the ClawMeets sandbox?",
        "body": [
            f"Only do this if {agent} runs alone in an isolated environment you set up (its own VM, "
            "container or OS user) with nothing else of yours on it.",
            "Conversations with people outside your account (Front Desk visitors, Telegram, webchat and "
            "Hub channels, and Hub conversations others start) will run with full access to that environment.",
            f"Anyone talking to {agent} could steer a turn into reading everything {agent} can reach: its "
            "other visitors' conversations, its memory and knowledge, and its ClawMeets credential. A copied "
            "credential keeps working after the conversation ends, until you re-issue it.",
            f"While this is on, {agent} can work in its own visitor conversations, its direct messages with "
            "you, and the rooms of your projects you add it to. Its posts there are marked as outside "
            "content. It can't start projects, create rooms, invite agents or coordinate.",
            f"Those turns can read {agent}'s model API key. Give it its own key with a spending cap, not one "
            "you use anywhere else. We can only spot a key shared with your other ClawMeets agents.",
            f"Once {agent} has run here without the sandbox, treat this environment as exposed: never add "
            "other agents or a ClawMeets login to it without wiping it first. We refuse your other agents "
            "there until you confirm it was wiped, but that only catches mistakes, not someone who has "
            "already got in.",
        ],
        "acknowledge": f"{agent} runs alone in an environment I set up and has its own spend-capped model key.",
        "action": "Turn off the sandbox",
    }


def clear_host_copy(agent: str) -> dict:
    return {
        "title": f"Has {agent}'s environment been wiped?",
        "body": [
            f"{agent} ran without the sandbox on this computer, so anything it ran there may still be running.",
            "Only confirm if you rebuilt or wiped that environment. After this, your other agents can "
            "connect from it again.",
        ],
        "acknowledge": f"I wiped or rebuilt {agent}'s environment.",
        "action": "Allow my agents there again",
    }


def _short(agent) -> str:
    """The agent's name without its owner's ``{username}-`` prefix."""
    name = agent.name
    return name.split("-", 1)[1] if "-" in name else name


def _refusal(code: str, message: str, agents: Optional[list[str]] = None) -> dict:
    return {"code": code, "message": message, "agents": agents or []}


class OwnerIsolationRefused(Exception):
    def __init__(self, refusals: list[dict]) -> None:
        super().__init__("owner isolation refused")
        self.refusals = refusals


class OwnerIsolationService:
    """The owner-isolation setting's server half."""

    def __init__(self, model_ctx: "ModelContext", hub: "Hub", store: OwnerIsolationStore) -> None:
        self._model_ctx = model_ctx
        self._hub = hub
        self.store = store
        # agent_id -> the latest report a live socket or a mint sent
        self._latest: dict[str, HostReport] = {}
        # agent_id -> host_key its live socket reported at auth
        self._socket_host: dict[str, str] = {}
        #: The live-socket capability registry (set by create_app).
        self.capabilities = None
        #: Agents whose setting was on at start or turned on since: the only
        #: tokens the serving-only middleware looks up (a superset; each
        #: lookup re-reads the card, so an unpublish takes effect at once).
        self.enabled_ids: set[str] = set()

    def load_enabled(self) -> None:
        from clawmeets.models.agent import Agent

        self.enabled_ids = {a.id for a in Agent.list_all(self._model_ctx, discoverable_only=False,
                                                         include_private=True) if a.owner_isolated}

    def isolated_agent_for_token(self, token: str):
        """The agent whose setting is stored on and whose own token this is."""
        from clawmeets.models.agent import Agent

        for agent_id in list(self.enabled_ids):
            agent = Agent.get(agent_id, self._model_ctx)
            if agent is None or not agent.owner_isolated:
                continue
            if Agent.verify_token(agent_id, token, self._model_ctx):
                return agent
        return None

    def observe(self, agent_id: str, report: Optional[HostReport], *, live: bool) -> None:
        """Record a report from a socket connect (``live``) or a mint body. A
        socket that connects without one forgets the in-memory report, so
        ``live_report`` never answers from an earlier connection."""
        if report is None:
            if live:
                self._latest.pop(agent_id, None)
                self._socket_host.pop(agent_id, None)
            return
        self._latest[agent_id] = report
        if live:
            self._socket_host[agent_id] = report.host_key
        try:
            self.store.save(agent_id, report, time.time())
        except sqlite3.Error:
            logger.warning("could not persist host report of %s", agent_id[:8], exc_info=True)

    def latest(self, agent_id: str) -> Optional[HostReport]:
        """The newest report: in memory, else the persisted one."""
        return self._latest.get(agent_id) or self.store.load(agent_id)

    def live_report(self, agent_id: str) -> Optional[HostReport]:
        """The newest report this process received (socket auth or mint)
        while the agent has a live socket, else None: never the stored one."""
        if not self._hub.is_connected(agent_id):
            return None
        return self._latest.get(agent_id)

    def live_socket_host(self, agent_id: str) -> Optional[str]:
        """The host key a live socket of this agent reported, or None."""
        if not self._hub.is_connected(agent_id):
            return None
        return self._socket_host.get(agent_id)

    def refusals(self, agent, report: Optional[HostReport] = None, *,
                          at_mint: bool = False) -> list[dict]:
        """Why ``agent`` cannot run owner-isolated against ``report`` (section 5a).

        ``at_mint``: only the report in the mint body counts; None is
        ``runner_unreported`` (never the stored report). Otherwise the latest
        known report is used. An empty list means "would be effective"."""
        from clawmeets.models.agent import Agent

        name = _short(agent)
        out: list[dict] = []
        if not agent.is_discoverable:
            out.append(_refusal("not_public", f"{name} is not public. Only public agents can run "
                                              "without the ClawMeets sandbox."))
        if report is None and not at_mint:
            report = self.latest(agent.id)
        live = self._hub.is_connected(agent.id)
        capable = report is not None and (not live or self._has_cap(agent.id))
        if not capable:
            out.append(_refusal("runner_unreported", f"{name} hasn't reported its computer yet. Start it "
                                                     "with a current ClawMeets version, then try again."))
            return out
        assert report is not None
        owner = agent.registered_by
        named: list[str] = []
        foreign = False
        for other_id in report.readable_agent_ids:
            if other_id == agent.id:
                continue
            other = Agent.get(other_id, self._model_ctx)
            if other is None:
                continue                          # deleted / unknown: its token is dead
            if other.registered_by != owner:
                foreign = True                    # someone else's token is exposed, whatever its setting
            elif not other.owner_isolated:
                named.append(_short(other))
        # Backstop for a home the disk scan missed: a live socket of THIS owner's
        # agent on the same host key. Scoped to the owner: the key is self-reported.
        for other in Agent.list_all(self._model_ctx, discoverable_only=False, include_private=True):
            if other.id == agent.id or other.registered_by != owner or other.owner_isolated:
                continue
            if self.live_socket_host(other.id) == report.host_key and _short(other) not in named:
                named.append(_short(other))
        if named or foreign:
            who = ", ".join(named) if named else "an agent of another account"
            out.append(_refusal(
                "cohosted_with_non_isolated",
                f"{name}'s computer can read the ClawMeets credentials of agents that still use the sandbox "
                f"({who}). Give {name} an environment of its own.",
                sorted(named),
            ))
        if report.user_session_present:
            out.append(_refusal("owner_login_on_host",
                                f"A ClawMeets login is saved on {name}'s computer. Run clawmeets user logout "
                                "there after starting the agent."))
        return out


    def _has_cap(self, agent_id: str) -> bool:
        return self.capabilities is None or self.capabilities.has(agent_id, OWNER_ISOLATED_TURNS)


    def effective(self, agent, report: Optional[HostReport] = None, *,
                           at_mint: bool = False) -> bool:
        return agent.owner_isolated and not self.refusals(agent, report, at_mint=at_mint)


    def status(self, agent) -> dict:
        refusals = self.refusals(agent)
        enabled = agent.owner_isolated
        name = _short(agent)
        return {
            "agent_id": agent.id,
            "enabled": enabled,
            "effective": enabled and not refusals,
            "eligible": not enabled and not refusals,
            "refusals": refusals,
            "model_key_shared": self.model_key_shared(agent),
            "host_exposed": self.host_exposed(agent),
            "blocked_agents": self.blocked_agents(agent),
            "confirm": confirm_copy(name),
            "clear_host_confirm": clear_host_copy(name),
        }


    async def set(self, agent, *, enabled: bool) -> dict:
        """Store the owner's choice. Turning it off always works; turning it on
        needs no refusals (the caller checked the user and the acknowledgement)."""
        if enabled:
            refusals = self.refusals(agent)
            if refusals:
                raise OwnerIsolationRefused(refusals)
        agent.update_card(owner_isolated=bool(enabled))
        if enabled:
            self.enabled_ids.add(agent.id)
        logger.info("owner isolation %s for agent %s", "on" if enabled else "off", agent.id[:8])
        return self.status(agent)


    def model_key_shared(self, agent) -> Optional[bool]:
        """Warning only (section 5c): True when the agent's model login is
        the OS user's CLI login (the owner's whole subscription), or its key
        digest matches another of the owner's agents; None when nothing has
        been reported. A key used outside ClawMeets cannot be detected."""
        from clawmeets.models.agent import Agent

        report = self.latest(agent.id)
        if report is None:
            return None
        if report.model_login == "cli_login":
            return True
        if not report.model_key_digest:
            return False
        for other_id, other in self.store.all_reports().items():
            if other_id == agent.id or other.model_key_digest != report.model_key_digest:
                continue
            peer = Agent.get(other_id, self._model_ctx)
            if peer is not None and peer.registered_by == agent.registered_by:
                return True
        return False

    # -- the exposed-host record (section 5e) ----------------------------
    # Best effort: it relies on reports from a host that may already be
    # tampered with. It catches the honest mistake (installing another agent
    # on the concierge's VM), the only case any check here can catch.

    def record_exposed(self, agent, report: HostReport) -> None:
        """A mint answered owner_isolated: ``report.host_key`` is exposed."""
        self.store.record_exposed(report.host_key, agent.registered_by or "", agent.id, time.time())

    def exposed_by(self, agent, report: Optional[HostReport]):
        """For an agent WITHOUT the setting: the owner-isolated agent of the
        same owner whose uncleared row marks this host, else None. Other
        accounts' rows are never consulted (the key is self-reported)."""
        from clawmeets.models.agent import Agent

        if report is None or agent.owner_isolated:
            return None
        for other_id in self.store.exposing_agents(report.host_key, agent.registered_by or ""):
            if other_id != agent.id:
                return Agent.get(other_id, self._model_ctx)
        return None

    def refuse_on_exposed_host(self, agent, report: Optional[HostReport]) -> Optional[str]:
        """``host_exposed:<short name>`` when ``agent`` must be refused here
        (and the refusal is recorded for the owner's status page)."""
        exposing = self.exposed_by(agent, report)
        if exposing is None:
            return None
        assert report is not None
        self.store.record_refusal(report.host_key, agent.id, agent.registered_by or "", exposing.id, time.time())
        # Mirrored on the refused agent's card: AgentResponse.blocked_by_exposed_host.
        agent.update_card(blocked_by_exposed_host=_short(exposing))
        logger.warning("refused agent %s on a host exposed by %s", agent.id[:8], exposing.id[:8])
        return f"host_exposed:{_short(exposing)}"

    def host_exposed(self, agent) -> bool:
        return bool(self.store.exposed_hosts_of(agent.id))

    def blocked_agents(self, agent) -> list[str]:
        from clawmeets.models.agent import Agent

        names = []
        for agent_id in self.store.refused_agents(agent.id):
            other = Agent.get(agent_id, self._model_ctx)
            if other is not None:
                names.append(_short(other))
        return names

    async def clear_host(self, agent) -> dict:
        """The owner confirmed the environment was wiped."""
        from clawmeets.models.agent import Agent

        for refused_id in self.store.refused_agents(agent.id):
            refused = Agent.get(refused_id, self._model_ctx)
            if refused is not None:
                refused.update_card(blocked_by_exposed_host=None)
        self.store.clear_exposed(agent.id, time.time())
        logger.info("exposed-host record cleared for agent %s", agent.id[:8])
        return self.status(agent)
