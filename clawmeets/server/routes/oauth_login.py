# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/oauth_login.py
User-facing Google + GitHub OAuth invite-login routes (additive).

All routes live under the distinct ``/auth/oauth/*`` prefix — deliberately NOT
in ``routes/oauth.py`` (the MCP/skill OAuth relay), which owns ``/oauth/*``.
This router adds "Continue with Google/GitHub" alongside the existing
username/password auth; the existing endpoints are untouched.

Handoff contract (Option A — must match the SPA byte-for-byte):
  - The provider callback provisions/links/authenticates the account, mints a
    single-use ~120s server-side handoff code, then 302s the browser to
    ``{APP_URL}/app/auth/callback?code=&status=``.
  - The SPA does one ``POST /auth/oauth/exchange {code}`` and receives the
    byte-identical ``POST /auth/login`` payload (same token pair + user shape),
    so it hydrates through the exact same store path as password login. Tokens
    never touch the URL, history, or JS-readable cookies.

JSON endpoints return the ported ``{"error":{code,message,field}}`` envelope
(the SPA maps on ``error.code``); the callback ONLY ever 302s (?error=CODE on
failure). Both surfaces wire the same 13 stable error codes.
"""
from __future__ import annotations

import logging
from html import escape
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

from clawmeets.models.agent import Agent
from clawmeets.models.invitation_code import classify
from clawmeets.models.user import OAuthProvisionError, User
from clawmeets.server.signup_policy import SIGNUP_CLOSED, SignupRefused
from ..oauth_login.cli_state import OOB_REDIRECT, validate_cli_redirect
from ..oauth_login.config import OAuthLoginSettings
from ..oauth_login.errors import AppError, InviteError, OAuthError
from ..oauth_login.flow import STATE_COOKIE, OAuthFlow, verify_pkce
from ..oauth_login.providers import get_provider

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


class InviteIn(BaseModel):
    code: Optional[str] = None
    # The slug picked in the sign-up flow before choosing a provider. Passed
    # through to a newly provisioned account so it gets clawmeets.ai/<username>
    # instead of an email-derived name; ignored on login/link and omitted on
    # pure sign-in. Advisory only — a taken/invalid value falls back server-side.
    username: Optional[str] = None


class CliStartIn(BaseModel):
    # `redirect` is a loopback URL (http://127.0.0.1:PORT/…) for the browser
    # flow, or the literal "oob" for the --no-browser paste fallback.
    # `code_challenge` is the S256 PKCE challenge (base64url, no pad).
    redirect: str
    code_challenge: str
    invite_code: Optional[str] = None
    username: Optional[str] = None


class ExchangeIn(BaseModel):
    code: str
    # Present for CLI (PKCE) exchanges; absent for the web flow.
    code_verifier: Optional[str] = None


def create_oauth_login_router(
    ctx: "ServerContext",
    settings: OAuthLoginSettings | None = None,
    flow: OAuthFlow | None = None,
) -> APIRouter:
    """Create the OAuth invite-login router.

    ``settings`` / ``flow`` are injectable for tests; in production the caller
    (``app.py``) builds ``OAuthLoginSettings.from_env()`` (fail-fast on missing
    creds) and mounts this router only when that succeeds — mirroring the
    existing ``if skill_registry:`` / ``if mcp_registry:`` optional-router pattern.
    """
    router = APIRouter(tags=["oauth-login"])
    if settings is None:
        settings = OAuthLoginSettings.from_env()
    if flow is None:
        flow = OAuthFlow(settings)

    def _err(exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=exc.envelope())

    def _set_state_cookie(resp: JSONResponse, value: str) -> None:
        resp.set_cookie(
            key=STATE_COOKIE, value=value, max_age=600, httponly=True,
            secure=settings.cookie_secure, samesite="lax", path="/",
        )

    def _redirect_error(code: str) -> RedirectResponse:
        # The callback NEVER returns JSON — failures 302 to the SPA login page.
        return RedirectResponse(settings.spa_url(f"/login?error={code}"), status_code=302)

    def _bad_request(code: str, message: str) -> JSONResponse:
        # CLI-only 400 for cli/start validation failures that don't map to a
        # web-surface (SPA) error code — keeps the 13-code SPA contract stable.
        return JSONResponse(status_code=400, content={"error": {"code": code, "message": message, "field": None}})

    def _oob_page(handoff: str, outcome: str) -> str:
        # Shown by the browser on a --no-browser (oob) flow: the user copies the
        # handoff code back into the waiting terminal. Code is HTML-escaped.
        safe = escape(handoff)
        return (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<title>clawmeets CLI login</title></head>"
            "<body style='font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem'>"
            "<h2>clawmeets CLI login</h2>"
            "<p>Copy this code back into your terminal:</p>"
            f"<pre style='font-size:1.1rem;padding:1rem;background:#f6f8fa;border-radius:6px;"
            f"user-select:all;word-break:break-all'>{safe}</pre>"
            "<p>You can close this tab afterwards.</p></body></html>"
        )

    def _oob_error_page(code: str) -> str:
        safe = escape(code)
        return (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<title>clawmeets CLI login — error</title></head>"
            "<body style='font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem'>"
            "<h2>Login failed</h2>"
            f"<p>The server reported: <code>{safe}</code></p>"
            "<p>Return to your terminal and try again.</p></body></html>"
        )

    def _cli_error(redirect: str, code: str):
        # Surface a CLI-flow failure back to the client: 302 ?error= to the
        # loopback listener, or an error page for oob / a bad redirect.
        if redirect and redirect != OOB_REDIRECT and validate_cli_redirect(redirect):
            sep = "&" if "?" in redirect else "?"
            return RedirectResponse(f"{redirect}{sep}error={code}", status_code=302)
        return HTMLResponse(_oob_error_page(code), status_code=400)

    async def _admit(invite_code: Optional[str], username: str) -> None:
        # The server's sign-up policy, in the model's error vocabulary: the
        # model never imports server code (Layer 1 -> Layer 2).
        try:
            await ctx.signup_policy.admit(
                invite_code, username=username, data_dir=ctx.model_ctx.participants_dir,
            )
        except SignupRefused as refused:
            raise OAuthProvisionError(
                "SIGNUP_CLOSED" if refused.code == SIGNUP_CLOSED else refused.code
            ) from None

    async def _finish_cli_callback(provider: str, code: str | None, pending: dict):
        # CLI analogue of the web callback tail: verify the provider identity,
        # authenticate/provision the user, mint a single-use handoff, bind the
        # PKCE challenge to it, then hand the code back over loopback (or oob).
        redirect = pending.get("redirect") or ""
        # Defense in depth — cli/start already gated this; re-assert before any 302.
        if not validate_cli_redirect(redirect):
            return _cli_error("", "OAUTH_STATE_INVALID")
        try:
            identity = await flow.fetch_identity_for_cli(provider=provider, code=code)
            user, outcome = await User.oauth_authenticate_or_provision(
                provider=identity.provider,
                provider_subject=identity.provider_subject,
                verified_email=identity.verified_email,
                display_name=identity.display_name,
                avatar_url=identity.avatar_url,
                invite_code=pending.get("invite_code"),
                desired_username=pending.get("username"),
                ctx=ctx.model_ctx,
                admit=_admit,
            )
        except OAuthProvisionError as exc:
            return _cli_error(redirect, exc.code)
        except AppError as exc:
            return _cli_error(redirect, exc.code)

        handoff = await ctx.login_handoff_store.add(user.id)
        cli_store = getattr(ctx, "cli_oauth_state_store", None)
        challenge = pending.get("code_challenge")
        if challenge and cli_store is not None:
            # TTL matches the handoff's own short life — /exchange pops both.
            await cli_store.put({"code_challenge": challenge}, key=handoff, ttl=120)
        if redirect == OOB_REDIRECT:
            return HTMLResponse(_oob_page(handoff, outcome))
        sep = "&" if "?" in redirect else "?"
        return RedirectResponse(f"{redirect}{sep}code={handoff}&status={outcome}", status_code=302)

    @router.post("/auth/oauth/invite/validate")
    async def validate_invite(body: InviteIn):
        """Advisory pre-check so the SPA can reveal provider buttons for a good
        code. Non-consuming: delegates to invitation_code.classify()."""
        code_err = await classify(body.code, ctx.model_ctx.participants_dir)
        if code_err is not None:
            return _err(InviteError(code_err))
        return JSONResponse({"valid": True})

    @router.post("/auth/oauth/{provider}/start")
    async def oauth_start(provider: str, body: InviteIn):
        """Begin OAuth. Reject unknown provider (PROVIDER_UNSUPPORTED). If a code
        is supplied, classify() it first (advisory; pure sign-in may omit it).
        Returns {authorization_url} + Set-Cookie oauth_login_state."""
        if get_provider(provider) is None:
            return _err(OAuthError("PROVIDER_UNSUPPORTED", field="provider"))
        if (ctx.signup_policy.invitation_code_required
                and body.code is not None and str(body.code).strip()):
            code_err = await classify(body.code, ctx.model_ctx.participants_dir)
            if code_err is not None:
                return _err(InviteError(code_err))
        authorization_url, state_cookie = flow.start(
            provider=provider, invite_code=body.code, username=body.username,
        )
        resp = JSONResponse({"authorization_url": authorization_url})
        _set_state_cookie(resp, state_cookie)
        return resp

    @router.post("/auth/oauth/{provider}/cli/start")
    async def oauth_cli_start(provider: str, body: CliStartIn):
        """Begin a CLI OAuth flow (browser-loopback or --no-browser paste).

        Unlike the web /start there is no cookie: the pending flow params live in
        the server-side CliOAuthStateStore keyed by an opaque ``state`` echoed
        back through the provider redirect. Validates the loopback redirect
        (open-redirect/SSRF guard) and PKCE challenge up front, advisory-checks
        any invite, then returns {authorize_url, state}."""
        if get_provider(provider) is None:
            return _err(OAuthError("PROVIDER_UNSUPPORTED", field="provider"))
        cli_store = getattr(ctx, "cli_oauth_state_store", None)
        if cli_store is None:
            return _bad_request("CLI_LOGIN_UNAVAILABLE", "CLI OAuth login is not enabled on this server.")
        if not validate_cli_redirect(body.redirect):
            return _bad_request("CLI_REDIRECT_INVALID",
                                "redirect must be a loopback http URL (127.0.0.1/localhost) or 'oob'.")
        if not (body.code_challenge or "").strip():
            return _bad_request("CLI_CHALLENGE_MISSING", "code_challenge is required.")
        if (ctx.signup_policy.invitation_code_required
                and body.invite_code is not None and str(body.invite_code).strip()):
            code_err = await classify(body.invite_code, ctx.model_ctx.participants_dir)
            if code_err is not None:
                return _err(InviteError(code_err))
        state = await cli_store.put({
            "provider": provider,
            "invite_code": body.invite_code,
            "redirect": body.redirect,
            "code_challenge": body.code_challenge,
            "username": body.username,
        })
        authorize_url = flow.start_cli(provider=provider, state=state)
        return JSONResponse({"authorize_url": authorize_url, "state": state})

    @router.get("/auth/oauth/{provider}/callback")
    async def oauth_callback(
        provider: str,
        request: Request,
        code: str | None = None,
        state: str | None = None,
        error: str | None = None,
    ):
        """Provider redirect target. NEVER returns JSON — always a 302 to the SPA.

        On success: verify state + exchange code -> verified identity + invite;
        resolve the account (login/linked/created); mint a one-time handoff code;
        302 to {APP_URL}/app/auth/callback?code=&status=, clearing the state
        cookie. On any AppError -> 302 {APP_URL}/app/login?error=CODE.
        """
        if get_provider(provider) is None:
            return _redirect_error("PROVIDER_UNSUPPORTED")
        if error:  # provider returned e.g. access_denied
            return _redirect_error("OAUTH_ACCESS_DENIED")

        # CLI flow? The pending state lives server-side (cookieless). Pop it
        # single-use; when present this is a CLI login and the handoff goes back
        # over loopback/oob instead of to the SPA. Absent -> the web flow below.
        cli_store = getattr(ctx, "cli_oauth_state_store", None)
        pending = await cli_store.take(state) if (cli_store and state) else None
        if pending is not None:
            return await _finish_cli_callback(provider, code, pending)

        state_cookie = request.cookies.get(STATE_COOKIE)
        try:
            identity, invite_code, desired_username = await flow.complete(
                provider=provider, code=code, state_cookie=state_cookie, query_state=state,
            )
            user, outcome = await User.oauth_authenticate_or_provision(
                provider=identity.provider,
                provider_subject=identity.provider_subject,
                verified_email=identity.verified_email,
                display_name=identity.display_name,
                avatar_url=identity.avatar_url,
                invite_code=invite_code,
                desired_username=desired_username,
                ctx=ctx.model_ctx,
                admit=_admit,
            )
        except OAuthProvisionError as exc:
            return _redirect_error(exc.code)
        except AppError as exc:
            return _redirect_error(exc.code)

        handoff = await ctx.login_handoff_store.add(user.id)
        resp = RedirectResponse(
            settings.spa_url(f"/auth/callback?code={handoff}&status={outcome}"),
            status_code=302,
        )
        resp.delete_cookie(STATE_COOKIE, path="/")
        return resp

    @router.post("/auth/oauth/exchange")
    async def exchange(body: ExchangeIn):
        """Single-use exchange. Pop the handoff code -> user_id (miss/expiry ->
        401 NO_SESSION); mint the JWT pair via AuthService and return the EXACT
        ``POST /auth/login`` body so the SPA hydrates through the same store path.
        """
        user_id = await ctx.login_handoff_store.take(body.code)
        if not user_id:
            return _err(AppError("NO_SESSION"))
        # PKCE (CLI): a handoff minted for a CLI flow carries a bound challenge;
        # require a verifier that satisfies it. Web handoffs have no binding and
        # skip the check. A failure burns the (already-popped) handoff — no leak.
        cli_store = getattr(ctx, "cli_oauth_state_store", None)
        binding = await cli_store.take(body.code) if cli_store else None
        if binding is not None and not verify_pkce(body.code_verifier, binding.get("code_challenge")):
            return _err(AppError("NO_SESSION"))
        user = User.get(user_id, ctx.model_ctx)
        if user is None:
            return _err(AppError("NO_SESSION"))

        access_token = ctx.auth.create_access_token(user)
        refresh_token = ctx.auth.create_refresh_token(user)
        assistant_name = ""
        if user.assistant_id:
            assistant = Agent.get(user.assistant_id, ctx.model_ctx)
            if assistant is not None:
                assistant_name = assistant.name
        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "user": {
                "id": user.id,
                "username": user.username,
            },
            "assistant_agent_id": user.assistant_id,
            "assistant_agent_name": assistant_name,
        }

    return router
