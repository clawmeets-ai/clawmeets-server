# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/hosts.py

The user's computers — pairing, listing, renaming, disconnecting, and the one
route that can cause code to run on someone's machine.

Every path says ``computers``, never ``hosts`` / ``runners`` / ``daemons``. The
URL is user-visible surface (it turns up in a browser address bar and in
support conversations), and the product's vocabulary rule is that a user reads
about *their computer*, never about our process names.

## The trust boundary, as routes

This is the first place the server can make something happen on a user's own
machine, against a "your data stays on your machine" promise. Four properties
carry that, and each is enforced here rather than left to the caller:

1. **Allowlist.** ``POST /me/computers/{id}/commands`` refuses anything outside
   ``HOST_ACTIONS`` before a frame is built, and the machine refuses again
   before it acts. Two independent fences, on purpose.
2. **Owner scoping.** Every read and write resolves the caller to a user and
   then looks inside THAT user's directory. A host id belonging to someone else
   is a 404, not a 403 — a 403 would confirm the machine exists.
3. **A user-revocable credential.** ``DELETE`` destroys the token hash and
   closes the live socket. It takes a user JWT and nothing else, the same fence
   ``DELETE /agents/{id}`` puts around deleting an agent.
4. **No deletion, ever.** ``delete`` is not on the allowlist and there is no
   route here that could add it.

## Who may call what

- Mint a pairing code — **user JWT only**. Consent to let ClawMeets act on a
  machine is granted once, by the human, at pairing; an agent minting the grant
  would be an agent widening its own reach.
- Pair — **no credential**, because the machine has none yet. The 8-character
  code IS the credential, spent once, valid 15 minutes, with a per-IP throttle
  on wrong guesses.
- Read / rename / run a command — user JWT **or** the owner's assistant token
  (``resolve_user_from_credential``), so the ``control-computer`` skill can
  answer "is my laptop up?" and "start the budget analyst" from a DM.
- Disconnect — **user JWT only**. It is the kill switch.
"""
from __future__ import annotations

import logging
import secrets
import time
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Request

from clawmeets.api.host_protocol import (
    HOST_ACTION_LABELS,
    HOST_ACTIONS,
    HOST_AGENTS_NOTE,
    HOST_NEVER_LABELS,
    TERM_MAX_SESSIONS,
    TERMINAL_OFF_LABEL,
    TERMINAL_ON_LABEL,
    HostCommandRejected,
    command_frame,
    validate_host_action,
    validate_size,
)
from clawmeets.models.host import (
    consume_pairing_code,
    create_pairing_code,
    format_pairing_code,
    get_host,
    list_hosts,
    register_host,
    rename_host,
    revoke_host,
    validate_host_id,
    validate_host_name,
)
from clawmeets.server.auth import JWT_SECRET
from clawmeets.server.socket_events import push_host_sync
from clawmeets.ws_edge.auth import TICKET_TTL_SECONDS, mint_terminal_ticket

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# Wrong-code throttle. A pairing code is 8 characters from a 31-symbol
# alphabet (~8.5e11 combinations) and lives 15 minutes, so the realistic attack
# is volume, not cleverness — and this route is the only one in the app that
# accepts no credential at all. Five misses from one address buys a five-minute
# pause; a CORRECT code clears the counter, so a user fat-fingering their own
# code four times and getting it right is never locked out.
#
# In-memory and per-process, like OAuthStateStore: it dies with the server,
# which is the right trade for a 15-minute secret. It is a speed bump on a
# large keyspace, not an authentication mechanism.
_PAIR_MAX_MISSES = 5
_PAIR_LOCKOUT_SECONDS = 300


class _PairingThrottle:
    """Per-address miss counter for the unauthenticated pairing route."""

    def __init__(self) -> None:
        self._misses: dict[str, tuple[int, float]] = {}

    def locked(self, key: str) -> bool:
        count, until = self._misses.get(key, (0, 0.0))
        if count < _PAIR_MAX_MISSES:
            return False
        if time.monotonic() >= until:
            self._misses.pop(key, None)
            return False
        return True

    def miss(self, key: str) -> None:
        count, _ = self._misses.get(key, (0, 0.0))
        self._misses[key] = (count + 1, time.monotonic() + _PAIR_LOCKOUT_SECONDS)

    def clear(self, key: str) -> None:
        self._misses.pop(key, None)


def create_hosts_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["computers"])
    throttle = _PairingThrottle()

    def _wire(record) -> dict:
        return record.to_wire(connected=ctx.ws_hub.is_host_connected(record.id))

    async def _owner_id(authorization: str) -> str:
        """The caller's user id, accepting their JWT or their assistant's token."""
        user = await ctx.auth.resolve_user_from_credential(authorization)
        return user.id

    def _require_host(owner_id: str, host_id: str):
        """Load one of the caller's OWN computers, or 404.

        Not-found and not-yours are the same answer, on purpose: the read is
        scoped to the caller's own directory, so there is nothing here that can
        tell the two apart and nothing that leaks whether a stranger's machine
        exists.
        """
        try:
            clean = validate_host_id(host_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
        record = get_host(ctx.model_ctx.participants_dir, owner_id, clean)
        if record is None:
            raise HTTPException(404, "No such computer")
        return record

    # ---------------------------------------------------------------- pairing

    # Registered BEFORE /me/computers/{host_id} so the literal path wins the
    # match. `validate_host_id` would reject "consent" anyway, but a 400 on a
    # route that exists is a worse answer than the route.
    @router.get("/me/computers/consent")
    async def computer_consent(authorization: str = Header(default="")):
        """The exact promise shown on the pairing screen and on the machine's page.

        Served rather than duplicated in the frontend so the two surfaces cannot
        drift: the list the user agrees to at pairing has to be the same list the
        page later claims is complete, word for word, or the claim is worthless.
        It is derived from the same ``HOST_ACTIONS`` the command route enforces.
        """
        await ctx.auth.resolve_user_from_credential(authorization)
        return {
            "allowed": [
                {"action": a, "label": HOST_ACTION_LABELS[a]} for a in HOST_ACTIONS
            ],
            "never": list(HOST_NEVER_LABELS),
            # The rest of the truth next to the fixed list: the agents act as
            # the user, and the terminal line the page picks by the machine's
            # own switch.
            "agents_note": HOST_AGENTS_NOTE,
            "terminal_on": TERMINAL_ON_LABEL,
            "terminal_off": TERMINAL_OFF_LABEL,
        }

    @router.post("/me/computers/pairing-code")
    async def create_code(authorization: str = Header(default="")):
        """Mint a 15-minute, single-use code for connecting one computer.

        **User JWT only** — deliberately not ``resolve_user_from_credential``.
        Every other read/write here accepts the owner's assistant, because those
        act within a permission the user already granted. This route MINTS that
        permission, and an agent that could mint it could widen its own reach
        without the human ever seeing the consent text.

        Returns the code in the grouped form the user reads (``7QK2-M4RD``) and
        the whole command to run, so the dialog never has to assemble it and the
        two can never disagree about the verb. The command names the account
        with ``--user``: without it the machine files the credential under
        whoever is signed in locally, so a code minted by one account can pair
        into another account's folder and silently replace its connection.
        """
        user = await ctx.auth.get_current_user(authorization)
        record = await create_pairing_code(ctx.model_ctx.participants_dir, user.id)
        pretty = format_pairing_code(record.code)
        return {
            "code": pretty,
            "expires_at": record.expires_at,
            "command": f"clawmeets computer install --code {pretty} --user {user.username}",
        }

    @router.post("/computers/pair")
    async def pair_computer(
        request: Request,
        code: str = Body("", embed=True),
        hostname: str = Body("", embed=True),
        platform: str = Body("", embed=True),
        os_version: str = Body("", embed=True),
        daemon_version: Optional[str] = Body(None, embed=True),
    ):
        """Spend a pairing code and mint this machine's credential.

        The ONE route in the app that accepts no credential, because the machine
        does not have one yet — the code is the credential. It is spent before
        the host record is created, so two machines racing on one code cannot
        both win.

        The response carries the raw token ONCE. Nothing stores it server-side
        (only its SHA-256), so a lost token is re-paired rather than recovered.

        Unknown, already-spent and expired codes are the same 401 with the same
        message. Telling them apart would turn the throttle into an oracle that
        confirms which codes exist.
        """
        client_key = request.client.host if request.client else "unknown"
        if throttle.locked(client_key):
            raise HTTPException(
                429, "Too many incorrect codes. Wait a few minutes and try again."
            )

        owner_user_id = await consume_pairing_code(
            ctx.model_ctx.participants_dir, code
        )
        if owner_user_id is None:
            throttle.miss(client_key)
            raise HTTPException(401, "That code is not valid. Generate a new one.")
        throttle.clear(client_key)

        record, token = await register_host(
            ctx.model_ctx.participants_dir,
            owner_user_id,
            hostname=hostname,
            platform=platform,
            os_version=os_version,
            daemon_version=daemon_version,
        )
        logger.info(
            f"Computer {record.name!r} ({record.id}) paired to user "
            f"{owner_user_id[:8]}"
        )
        await push_host_sync(owner_user_id, record.id, "paired", ctx)
        return {
            "host_id": record.id,
            "token": token,
            "name": record.name,
        }

    # ------------------------------------------------------------------ reads

    @router.get("/me/computers")
    async def list_my_computers(authorization: str = Header(default="")):
        """Every computer the caller has connected, newest first.

        Disconnected machines are left out. Disconnecting is the user's own,
        deliberate act, so the row has nothing left to explain — and a page for
        a machine nothing here can reach is a dead end. The record stays on
        disk (its token is dead, see ``revoke_host``); only the view drops it.

        ``connected`` and ``status`` are computed per row from the live socket
        table, never read off disk — a machine that is not talking to us right
        now cannot be reported as online, including immediately after a server
        restart.
        """
        owner_id = await _owner_id(authorization)
        return [
            _wire(r)
            for r in list_hosts(ctx.model_ctx.participants_dir, owner_id)
            if not r.is_revoked
        ]

    @router.get("/me/computers/{host_id}")
    async def get_my_computer(host_id: str, authorization: str = Header(default="")):
        """One computer, 404 once disconnected — the same answer as the list."""
        owner_id = await _owner_id(authorization)
        record = _require_host(owner_id, host_id)
        if record.is_revoked:
            raise HTTPException(404, "No such computer")
        return _wire(record)

    # ----------------------------------------------------------------- writes

    @router.patch("/me/computers/{host_id}")
    async def rename_my_computer(
        host_id: str,
        name: str = Body("", embed=True),
        authorization: str = Header(default=""),
    ):
        """Rename a computer. The only mutable field on the record.

        The name is the machine's, not ours: it starts as a humanized hostname
        and the user overrides it, because every line on the page refers to the
        machine by this name and "Chengtaos-MacBook-Pro.local" is not how anyone
        refers to their laptop.
        """
        owner_id = await _owner_id(authorization)
        record = _require_host(owner_id, host_id)
        try:
            validate_host_name(name)
        except ValueError as e:
            raise HTTPException(400, str(e))
        updated = await rename_host(
            ctx.model_ctx.participants_dir, owner_id, record.id, name
        )
        if updated is None:
            raise HTTPException(404, "No such computer")
        await push_host_sync(owner_id, record.id, "renamed", ctx)
        return _wire(updated)

    @router.delete("/me/computers/{host_id}")
    async def disconnect_my_computer(
        host_id: str, authorization: str = Header(default="")
    ):
        """Disconnect a computer — the kill switch.

        **User JWT only.** The same fence as deleting an agent, for the same
        reason: this is the control that backs the claim above every button on
        the machine's page, and a borrowed credential must not be able to lift
        it or drop it.

        Permanent by design. The token hash is replaced with a value no token
        can hash to, so the old key is dead even to someone who edits
        ``revoked_at`` back out; reconnecting needs a fresh pairing code. The
        live socket is then closed with 4004 so the machine lets go immediately
        instead of at its next reconnect.

        Agents already running on the machine are NOT stopped. Revoking removes
        OUR access; it is not a remote shutdown, and the confirm dialog says so.
        """
        user = await ctx.auth.get_current_user(authorization)
        record = _require_host(user.id, host_id)
        updated = await revoke_host(
            ctx.model_ctx.participants_dir, user.id, record.id
        )
        if updated is None:
            raise HTTPException(404, "No such computer")
        await ctx.ws_hub.close_host_connection(record.id)
        logger.info(
            f"Computer {record.name!r} ({record.id}) disconnected by its owner"
        )
        await push_host_sync(user.id, record.id, "revoked", ctx)
        return _wire(updated)

    # --------------------------------------------------------------- commands

    @router.post("/me/computers/{host_id}/commands")
    async def run_command(
        host_id: str,
        action: str = Body("", embed=True),
        agent: Optional[str] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Ask a computer to do ONE allowlisted thing.

        The route that makes the server able to cause code to run on someone's
        machine, so read the order of checks as the design:

        1. Resolve the caller and scope to their own machines (404 otherwise).
        2. Refuse a revoked machine outright — a disconnected computer accepts
           nothing, and answering 409 "not reachable" would imply it might
           later.
        3. Validate the action against the allowlist. ``HostCommandRejected``
           becomes a 400 naming the five permitted actions, which is also the
           answer the ``control-computer`` skill shows a user who asked for
           something else (asking to delete an agent lands here).
        4. Only then build a frame — ``command_frame`` re-validates, so an
           unrepresentable command cannot be constructed.
        5. 409 if the machine holds no live socket. Accepting a command for an
           unreachable machine and silently dropping it is the failure mode the
           whole feature exists to remove, so the button says "not reachable"
           and the page offers the typeable equivalent instead of queueing.

        Fire-and-forget by design: the machine reports the outcome on its own
        ``host_state`` frame, which restamps the agent snapshot and wakes the
        browser. Holding the HTTP request open until a subprocess on someone's
        laptop finished would tie a page to a process we do not control.

        """
        owner_id = await _owner_id(authorization)
        record = _require_host(owner_id, host_id)

        if record.is_revoked:
            raise HTTPException(
                403,
                f"{record.name} is disconnected. Connect it again to control it "
                f"from here.",
            )

        try:
            cleaned, agent_name = validate_host_action(action, agent)
        except HostCommandRejected as e:
            raise HTTPException(400, str(e))

        command_id = secrets.token_hex(8)
        delivered = await ctx.ws_hub.send_to_host(
            record.id,
            command_frame(command_id, cleaned, agent_name),
        )
        if not delivered:
            raise HTTPException(
                409,
                f"{record.name} is not reachable right now, so nothing was sent.",
            )
        logger.info(
            f"Sent {cleaned!r}{f' {agent_name!r}' if agent_name else ''} to "
            f"computer {record.id[:8]} for user {owner_id[:8]}"
        )
        return {
            "command_id": command_id,
            "action": cleaned,
            "agent": agent_name,
            "dispatched": True,
        }

    # --------------------------------------------------------------- terminal

    @router.post("/me/computers/{host_id}/terminal/ticket")
    async def create_terminal_ticket(
        host_id: str,
        cols: int = Body(80, embed=True),
        rows: int = Body(24, embed=True),
        authorization: str = Header(default=""),
    ):
        """A 60-second, single-use ticket for opening ``/ws/terminal/{host_id}``.

        **User JWT only**. A shell is the user's own hands on their machine:
        the assistant can already start and stop agents, but a raw terminal
        stays out of automated hands.

        No re-sign-in. The agents on a connected computer already run commands
        as the user, so a second password prompt here would protect nothing a
        signed-in session cannot already reach.

        Every refusal is a sentence the Terminal card shows as-is: offline,
        switched off on the machine, software too old, too many sessions.
        """
        user = await ctx.auth.get_current_user(authorization)
        record = _require_host(user.id, host_id)
        # In edge mode the sessions live in the edge, so core holds no relay;
        # the edge enforces the session cap itself when the tab opens.
        relay = getattr(ctx, "terminal_relay", None)
        if record.is_revoked:
            raise HTTPException(403, f"{record.name} is disconnected.")
        if not ctx.ws_hub.is_host_connected(record.id):
            raise HTTPException(
                409, f"{record.name} is not reachable right now. Turn it on to "
                f"open a terminal.",
            )
        if record.terminal_enabled is None:
            raise HTTPException(
                409, f"Update {record.name}'s software to use the terminal.",
            )
        if not record.terminal_enabled:
            raise HTTPException(
                409, f"The terminal is turned off on {record.name}. Turn it on "
                f"there with `clawmeets computer terminal enable`.",
            )
        if relay is not None and relay.session_count(record.id) >= TERM_MAX_SESSIONS:
            raise HTTPException(
                409, f"{record.name} already has {TERM_MAX_SESSIONS} terminal "
                f"sessions open. End one first.",
            )
        try:
            clean_cols, clean_rows = validate_size(cols, rows)
        except ValueError as e:
            raise HTTPException(400, str(e))
        ticket = mint_terminal_ticket(JWT_SECRET, user.id, record.id, clean_cols, clean_rows)
        return {"ticket": ticket, "expires_in": TICKET_TTL_SECONDS}

    return router
