# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/install.py

The one-command install: the script itself, the token that authorizes it, and
the progress the machine reports while it runs.

## The trust boundary, as routes

``POST /install/claim`` hands a real user session to whoever presents a valid
token. That is the most powerful unauthenticated exchange in the app, and it is
deliberate — it is what removes the password from the terminal. Four properties
carry it, each enforced here rather than left to a caller:

1. **The token is the credential, and it is short-lived.** One hour
   (``INSTALL_TOKEN_TTL_SECONDS``), minted by a user JWT, single-use for the
   session exchange. Holding it is equivalent to holding a magic link.
2. **Minting needs the human.** ``POST /me/install-token`` takes a **user JWT
   only** — not ``resolve_user_from_credential``. An agent that could mint one
   could mint itself a session for its own owner.
3. **A per-address throttle on wrong tokens**, the same speed bump
   ``/computers/pair`` puts on pairing codes, because this is the other route
   that accepts no credential.
4. **Unknown, expired, wrong-secret and already-spent are not all one answer**,
   and that is a considered exception to the usual rule. The first three collapse
   to one 401 (telling them apart would confirm which tokens exist), but
   *already-spent* gets its own message, because the user who hits it is the
   legitimate holder re-running a command and the remedy differs: "you already
   ran this" rather than "get a fresh one". A token id is not a secret — the
   secret is the half after the dot — so this leaks nothing a guesser could use.

## Why the script is served rather than shipped

``GET /install`` returns a shell script with this server's URL already
substituted. A script that guessed its own server would send a self-hosted
user's token to clawmeets.ai; a script the user had to parameterize would not be
one line. The bytes come from ``install.sh`` next to this module, so the thing
under review and the thing piped into ``sh`` are the same file.

``GET /install.ps1`` is the Windows twin: ``install.ps1``, same substitution,
same step keys, run as a PowerShell scriptblock so the token can be passed.

## Progress is narrative, never proof

``POST /install/progress`` records what the machine SAYS it is doing, so the web
app can show movement instead of a dead page. It decides nothing. The zero-state
checklist rows are driven by what the server itself observes — a live host
socket, a live agent socket, the machine's model-CLI report — and a script that
lied about its progress could not turn a single row green.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import APIRouter, Body, Header, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse

from clawmeets.models.user import User
from clawmeets.server.config import public_app_url
from clawmeets.server.socket_events import push_install_sync
from clawmeets.models.install_token import (
    INSTALL_STEP_LABELS,
    INSTALL_STEPS,
    claim_install_token,
    create_install_token,
    latest_for_owner,
    record_step,
    verify_install_token,
)

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

# The scripts, read from disk next to this module. One per shell; both report the
# same step keys, so the web app cannot tell which one is running.
INSTALL_SCRIPT_PATH = Path(__file__).parent / "install.sh"
WINDOWS_INSTALL_SCRIPT_PATH = Path(__file__).parent / "install.ps1"

# Replaced with this deployment's public URL when the script is served. A
# placeholder rather than a default so a misconfigured server produces an obvious
# broken command instead of quietly pointing someone's machine at clawmeets.ai.
SERVER_PLACEHOLDER = "@@CLAWMEETS_SERVER@@"

# Wrong-token throttle, mirroring `/computers/pair`. In-memory and per-process,
# which is the right trade for a one-hour secret: it dies with the server, and it
# is a speed bump on a large keyspace rather than an authentication mechanism.
_CLAIM_MAX_MISSES = 5
_CLAIM_LOCKOUT_SECONDS = 300


class _ClaimThrottle:
    """Per-address miss counter for the unauthenticated install routes."""

    def __init__(self) -> None:
        self._misses: dict[str, tuple[int, float]] = {}

    def locked(self, key: str) -> bool:
        count, until = self._misses.get(key, (0, 0.0))
        if count < _CLAIM_MAX_MISSES:
            return False
        if time.monotonic() >= until:
            self._misses.pop(key, None)
            return False
        return True

    def miss(self, key: str) -> None:
        count, _ = self._misses.get(key, (0, 0.0))
        self._misses[key] = (count + 1, time.monotonic() + _CLAIM_LOCKOUT_SECONDS)

    def clear(self, key: str) -> None:
        self._misses.pop(key, None)


def create_install_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["install"])
    throttle = _ClaimThrottle()

    def _public_url() -> str:
        """The base URL a user's machine should talk to.

        Read from the environment via ``server/config.public_app_url`` rather
        than from the inbound request: the request may have arrived through a
        proxy that rewrote Host, and this URL gets baked into a script that a
        laptop will keep using for weeks.
        """
        return public_app_url()

    # ------------------------------------------------------------- the script

    def _serve_script(path: Path) -> PlainTextResponse:
        """An install script, with this server's URL substituted in.

        ``text/plain`` deliberately: this is piped into a shell, and a
        content-type that invited a browser to render or download it would be
        the wrong hint for every real consumer.

        No caching. The script is small, it is fetched once per machine, and a
        stale cached copy pointing at an old URL is a support ticket nobody can
        diagnose from the outside.
        """
        try:
            body = path.read_text()
        except OSError:
            logger.error(f"Install script missing at {path}")
            raise HTTPException(500, "Install script is unavailable")
        return PlainTextResponse(
            body.replace(SERVER_PLACEHOLDER, _public_url()),
            media_type="text/plain; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/install", include_in_schema=False)
    async def serve_install_script():
        """The macOS / Linux script, piped into ``sh``."""
        return _serve_script(INSTALL_SCRIPT_PATH)

    @router.get("/install.ps1", include_in_schema=False)
    async def serve_windows_install_script():
        """The Windows script, run as a PowerShell scriptblock."""
        return _serve_script(WINDOWS_INSTALL_SCRIPT_PATH)

    # -------------------------------------------------------------- the token

    @router.post("/me/install-token")
    async def mint_install_token(response: Response, authorization: str = Header(default="")):
        """Mint the one-time token for this account's install command.

        **User JWT only** — deliberately not ``resolve_user_from_credential``.
        This route mints a credential that can be exchanged for a session as this
        user; an agent able to call it could escalate to its own owner.

        Returns the whole command — one per shell, both carrying the same token —
        assembled here, so the welcome page never builds it and the two cannot
        disagree about the verb. Also returns the
        declared step list, so the page can render the checklist greyed out
        before the machine has said anything.

        ``no-store`` also keeps the token out of the idempotency record: the
        browser sends an Idempotency-Key on every write, and that record is a
        file on disk for a day.
        """
        user = await ctx.auth.get_current_user(authorization)
        record, raw = await create_install_token(
            ctx.model_ctx.participants_dir, user.id, user.username
        )
        base = _public_url()
        response.headers["Cache-Control"] = "no-store"
        return {
            "token_id": record.id,
            "expires_at": record.expires_at,
            "command": f"curl -fsSL {base}/install | sh -s {raw}",
            # A scriptblock rather than `irm | iex`, which cannot take an
            # argument; see install.ps1's header.
            "windows_command": (
                f"& ([scriptblock]::Create((irm {base}/install.ps1))) {raw}"
            ),
            "steps": [{"key": k, "label": label} for k, label in INSTALL_STEPS],
        }

    @router.get("/me/install-progress")
    async def my_install_progress(authorization: str = Header(default="")):
        """How this account's most recent install run is getting on.

        Accepts the owner's assistant as well as their JWT
        (``resolve_user_from_credential``): "did my install work?" is a
        reasonable thing to ask in a DM, and this is a read of the user's own
        state with no power attached.

        ``null`` for ``run`` when the user has never started one — an empty
        object would make the page render an install that is not happening.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        record = latest_for_owner(ctx.model_ctx.participants_dir, user.id)
        return {
            "run": record.to_wire() if record else None,
            "steps": [{"key": k, "label": label} for k, label in INSTALL_STEPS],
        }

    # --------------------------------------------------------- the machine's half

    @router.post("/install/claim")
    async def claim(request: Request, token: str = Body("", embed=True)):
        """Exchange the one-time token for a session on this machine.

        Unauthenticated, because the machine has nothing yet — the token IS the
        credential, exactly as the 8-character code is for ``/computers/pair``.
        Spent under a lock before the session is minted, so two machines racing
        on one token cannot both get one.

        Returns the same ``access_token`` / ``refresh_token`` pair as
        ``/auth/login``, so the CLI persists an ordinary session and nothing
        downstream has to know it arrived by a different door.
        """
        client_key = request.client.host if request.client else "unknown"
        if throttle.locked(client_key):
            raise HTTPException(
                429, "Too many invalid install tokens. Wait a few minutes and try again."
            )

        # Distinguish "already used" from "unknown/expired" — see the module
        # docstring on why this one case is worth its own message.
        existing = verify_install_token(ctx.model_ctx.participants_dir, token)
        if existing is not None and existing.is_claimed:
            throttle.clear(client_key)
            raise HTTPException(
                409,
                "This install command has already been used. Open ClawMeets in "
                "your browser to get a fresh one.",
            )

        record = await claim_install_token(ctx.model_ctx.participants_dir, token)
        if record is None:
            throttle.miss(client_key)
            raise HTTPException(
                401,
                "That install command is not valid any more. Open ClawMeets in "
                "your browser to get a fresh one.",
            )
        throttle.clear(client_key)

        user = User.get(record.owner_user_id, ctx.model_ctx)
        if user is None:
            # The account went away between minting and claiming. Nothing to sign
            # in as, and nothing the caller can fix by retrying.
            raise HTTPException(401, "That account no longer exists.")

        logger.info(
            f"Install token {record.id} claimed for user {record.owner_user_id[:8]}"
        )
        return {
            "username": user.username,
            "server_url": _public_url(),
            "access_token": ctx.auth.create_access_token(user),
            "refresh_token": ctx.auth.create_refresh_token(user),
        }

    @router.post("/install/progress")
    async def report_progress(
        request: Request,
        token: str = Body("", embed=True),
        step: str = Body("", embed=True),
        state: str = Body("started", embed=True),
        detail: str = Body("", embed=True),
    ):
        """Record one step the install script says it reached.

        Still accepted AFTER the token is claimed — the session exchange is
        single-use but the narrative runs to the end of the install, and a page
        that went blind after the first step would be the silence this work
        exists to remove.

        Unknown steps and invalid states are refused rather than stored: the web
        app renders the declared list, so a row it has no label for could only
        render as a blank.
        """
        client_key = request.client.host if request.client else "unknown"
        if throttle.locked(client_key):
            raise HTTPException(429, "Too many invalid install tokens.")

        if step not in INSTALL_STEP_LABELS:
            raise HTTPException(400, f"Unknown install step {step!r}")
        if state not in ("started", "ok", "failed", "skipped"):
            raise HTTPException(400, f"Unknown state {state!r}")

        record = await record_step(
            ctx.model_ctx.participants_dir, token, step, state, detail  # type: ignore[arg-type]
        )
        if record is None:
            throttle.miss(client_key)
            raise HTTPException(401, "That install command is not valid any more.")
        throttle.clear(client_key)

        # Push so the welcome page moves as the install moves, rather than on a
        # poll interval that is either wasteful or laggy.
        await push_install_sync(record.owner_user_id, step, state, ctx)
        return {"ok": True}

    return router

