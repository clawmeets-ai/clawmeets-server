# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/auth.py
Authentication routes for users.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Body, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from clawmeets.api.responses import UserResponse
from clawmeets.models.agent import Agent
from clawmeets.models.participant import Participant
from clawmeets.models.user import EMAIL_PROOF_TRUSTED_DOMAIN, User
from clawmeets.server.email import ClawMeetsEmailMessage
from clawmeets.server.errors import AuthError, auth_error_response
from clawmeets.server.signup_policy import SIGNUP_CLOSED, SignupRefused
from clawmeets.utils.email import get_mailer

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


# Hand-written because /auth/login declares NO FastAPI-validated parameter (see
# _read_login_body); without this the request body vanishes from the generated
# OpenAPI schema. Keep in sync with _read_login_body by hand — the deprecated
# `username` alias is deliberately absent, as it is not part of the public API.
_LOGIN_OPENAPI_BODY = {
    "required": True,
    "content": {
        "application/json": {
            "schema": {
                "type": "object",
                "required": ["identifier", "password"],
                "properties": {
                    "identifier": {
                        "type": "string",
                        "description": "A username OR an email address.",
                    },
                    "password": {"type": "string", "format": "password"},
                },
            }
        }
    },
}


async def _read_login_body(request: Request) -> tuple[str, str]:
    """Pull ``(identifier, password)`` out of the raw request, or raise.

    422 SUPPRESSION LIVES HERE (AUTH_CONTRACT §5). The route declares no
    ``Body(...)`` and no Pydantic model, so ``RequestValidationError`` can never
    fire on it and 422 is unreachable BY CONSTRUCTION rather than by being
    caught after the fact. The rejected alternative — an app-level
    ``RequestValidationError`` handler — would rewrite the error shape of every
    endpoint in the server to satisfy one route.

    Returns the identifier STRIPPED and the password EXACTLY as sent: leading
    and trailing whitespace in a password is significant (§2.2).

    Deliberately performs NO format validation on the identifier. ``"!!!"`` and
    ``"a@b"`` are valid input here; they reach the lookup, find nothing, and are
    answered 401 like any other failure. A 400 would tell an attacker which
    branch they are on. Same for password policy: a 3-character password is a
    401, never a 400.

    Raises:
        AuthError: ``invalid_request``, with ``field`` naming the offender.
    """
    # application/json is required (§2.1); form-encoded bodies are not accepted.
    # Starlette's request.json() ignores the content type, so an unmarked body
    # would otherwise sneak through.
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise AuthError("invalid_request", "Invalid request body.", field=None)

    try:
        body = await request.json()
    except Exception:
        raise AuthError("invalid_request", "Invalid request body.", field=None)
    if not isinstance(body, dict):
        raise AuthError("invalid_request", "Invalid request body.", field=None)

    identifier = body.get("identifier")
    if not isinstance(identifier, str) or not identifier.strip():
        # DEPRECATED alias (§2.2): released runner wheels still POST `username`,
        # and they only ever sent usernames, so treating it as the identifier is
        # strictly backward compatible. Never offered to the frontend; must not
        # appear in new code. Removed once the wheel floor moves past this
        # release. A non-empty `identifier` always wins over it.
        identifier = body.get("username")

    if not isinstance(identifier, str) or not identifier.strip():
        # Reported before password when both are bad (§5, table row 3).
        raise AuthError("invalid_request", field="identifier")

    password = body.get("password")
    if not isinstance(password, str) or not password:
        raise AuthError("invalid_request", field="password")

    return identifier.strip(), password


def create_auth_router(ctx: "ServerContext") -> APIRouter:
    """Create the authentication router.

    Args:
        ctx: Server context with shared dependencies

    Returns:
        Configured APIRouter
    """
    router = APIRouter(tags=["auth"])

    @router.post("/auth/login", openapi_extra={"requestBody": _LOGIN_OPENAPI_BODY})
    async def user_login(request: Request) -> JSONResponse:
        """Authenticate with a username OR an email address, and return an
        access + refresh token pair.

        The client never says which kind of identifier it sent; the server
        decides by shape (AUTH_CONTRACT §6.1). The 200 body is byte-identical
        whether the user signed in by username or by email — and identical to
        what ``/auth/oauth/exchange`` returns — so nothing in it reveals which
        path was taken. The short-lived ``access_token`` is the Bearer used on
        every request; the long-lived ``refresh_token`` is exchanged at
        ``POST /auth/refresh`` for a fresh pair.

        THE ORDER OF OPERATIONS IS LOAD-BEARING (§4.2):

            1. parse + validate   -> 400 invalid_request
            2. verify_credentials -> 401 invalid_credentials  (constant work)
            3. email_verified?    -> 403 email_not_verified
            4. issue tokens       -> 200

        Step 3 must come after step 2 and never before. The 403 is reachable
        only once the password has ALREADY verified, so a caller who sees it
        already knows the account's password and learns nothing new — that
        ordering is the entire reason the 403 is not an email-enumeration
        oracle. Swapping steps 2 and 3 turns this endpoint into one without
        changing a single status code.

        Every failure exits through ``auth_error_response``; this handler raises
        no HTTPException, so ``{"detail": ...}`` can never appear on this route.
        """
        try:
            identifier, password = await _read_login_body(request)
            user = await User.verify_credentials(identifier, password, ctx.model_ctx)
            if not user:
                raise AuthError("invalid_credentials")
            if not user.email_verified:
                raise AuthError("email_not_verified")
        except AuthError as err:
            return auth_error_response(err)

        access_token = ctx.auth.create_access_token(user)
        refresh_token = ctx.auth.create_refresh_token(user)
        assistant_name = ""
        if user.assistant_id:
            assistant = Agent.get(user.assistant_id, ctx.model_ctx)
            if assistant is not None:
                assistant_name = assistant.name
        return JSONResponse({
            "access_token": access_token,
            "refresh_token": refresh_token,
            "user": {
                "id": user.id,
                "username": user.username,
            },
            # Always present, null when the user has no assistant — never
            # omitted. /auth/oauth/exchange emits the same keys; §3 requires the
            # two to stay byte-identical.
            "assistant_agent_id": user.assistant_id,
            "assistant_agent_name": assistant_name,
        })

    @router.post("/auth/refresh")
    async def refresh_token(
        refresh_token: str = Body(..., embed=True),
    ):
        """Exchange a valid refresh token for a fresh access + refresh pair.

        Stateless: the refresh token is a signed JWT, validated by signature
        + expiry + ``type`` claim — no server-side store. The refresh token is
        also rotated (rolling window), so a continuously-active client never
        hits the refresh-token expiry; an idle client past the refresh TTL
        falls back to re-login. A missing/expired/wrong-type token yields 401.
        """
        user = await ctx.auth.verify_refresh_token(refresh_token)
        return {
            "access_token": ctx.auth.create_access_token(user),
            "refresh_token": ctx.auth.create_refresh_token(user),
        }

    @router.post("/auth/register", response_model=UserResponse)
    async def user_register(
        username: str = Body(..., embed=True),
        password: str = Body(..., embed=True),
        email: str = Body(..., embed=True),
        invitation_code: str = Body("", embed=True),
    ):
        """Self-register a new user account (public; the server's sign-up policy
        decides whether an invitation code is required — server/signup_policy.py).

        Creates the user record only. The assistant agent is created later via
        `clawmeets assistant register` on the user's machine — that materializes
        the local agent dir, credentials, and (optionally) the reflection
        schedule + interview DM.

        A verification email is sent — login is blocked until verified — unless
        the email's domain is one the operator trusts, which starts verified.
        """
        # Enforce minimum username length for public registration
        if len(username.strip()) < User.MIN_PUBLIC_USERNAME_LENGTH:
            raise HTTPException(
                400,
                f"Username must be at least {User.MIN_PUBLIC_USERNAME_LENGTH} characters for public registration",
            )

        # Usernames must be lowercase. The rule is enforced for every caller by
        # User._validate_username (which is also what /auth/username-available
        # reports through, so the sign-up form surfaces it live before submit);
        # this checks it early, before the invitation code is consumed, so a bad
        # username never costs a code. Unlike sign-in, there is nothing to hide
        # at registration, so the message names the fix.
        if username.strip() != username.strip().lower():
            return auth_error_response(AuthError(
                "invalid_request",
                f"Username must be lowercase. Use '{username.strip().lower()}' "
                f"instead of '{username.strip()}'.",
                field="username",
            ))

        # Validate email format
        try:
            email = User.validate_email(email)
        except ValueError as e:
            raise HTTPException(400, str(e))

        # Check email uniqueness
        existing = User.get_by_email(email, ctx.model_ctx)
        if existing is not None:
            raise HTTPException(400, "Email already registered")

        # The sign-up gate (after other validations, so a bad request never
        # costs an invitation code). In invite mode the refusal text is the same
        # one this route always returned.
        policy = ctx.signup_policy
        try:
            await policy.admit(
                invitation_code,
                username=username.strip().lower(),
                data_dir=ctx.model_ctx.participants_dir,
            )
        except SignupRefused as refused:
            if refused.code == SIGNUP_CLOSED:
                return auth_error_response(AuthError(SIGNUP_CLOSED))
            raise HTTPException(400, "Invalid or missing invitation code")
        pre_verified = policy.pre_verified(email)

        try:
            user = await User.register(
                username,
                password,
                ctx.model_ctx,
                email=email,
                email_verified=pre_verified,
                # Lets them sign in, but proves nothing about who holds the
                # mailbox: an OAuth sign-in for this email will not link to it.
                email_proven_by=EMAIL_PROOF_TRUSTED_DOMAIN if pre_verified else None,
            )

            if not pre_verified:
                msg = ClawMeetsEmailMessage.verification(
                    to_email=email,
                    username=user.username,
                    verification_token=user.verification_token,
                )
                await get_mailer().send(msg)

            return UserResponse(
                user_id=user.id,
                username=user.username,
                user_created_at=user.created_at,
                email_verified=pre_verified,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))

    @router.get("/auth/signup-config")
    async def signup_config():
        """Public: whether this server takes sign-ups and needs an invitation
        code for them, so the sign-up page can show or hide the code field.
        Never lists the trusted email domains."""
        return ctx.signup_policy.public_config()

    @router.get("/auth/username-available")
    async def username_available(username: str = Query(...)):
        """Advisory, non-consuming check for public username slug availability.

        Feeds the sign-up flow's live username step. Applies the same rules the
        register endpoint enforces — minimum length + ``_validate_username``
        (lowercase, filesystem-safe, no hyphens) — then checks uniqueness across
        ALL participant types (users, agents, assistants) via
        ``Participant.get_by_name``, mirroring ``User.register``. No mutation.

        Returns ``{available: bool, reason: str | None}``; ``reason`` carries a
        human message when unavailable (validation failure or taken).
        """
        raw = (username or "").strip()
        if len(raw) < User.MIN_PUBLIC_USERNAME_LENGTH:
            return {
                "available": False,
                "reason": f"At least {User.MIN_PUBLIC_USERNAME_LENGTH} characters.",
            }
        try:
            normalized = User._validate_username(raw)
        except ValueError as e:
            return {"available": False, "reason": str(e)}
        if Participant.get_by_name(normalized, ctx.model_ctx) is not None:
            return {"available": False, "reason": f"@{normalized} is taken."}
        return {"available": True, "reason": None}

    @router.get("/auth/verify-email")
    async def verify_email(token: str = Query(...)):
        """Verify user email address via token link."""
        user = await User.verify_email(token, ctx.model_ctx)
        if user is None:
            raise HTTPException(400, "Invalid or expired verification token")
        return {
            "message": "Email verified successfully. You can now log in.",
            "username": user.username,
        }

    @router.get("/auth/user/me")
    async def get_current_user_info(authorization: str = Header(default="")):
        """Get current authenticated user info.

        Accepts a user JWT or the user's assistant-agent bearer token, so
        commands shelled from inside the assistant's runner can
        resolve "who am I acting for" without a browser session.
        """
        user = await ctx.auth.resolve_user_from_credential(authorization)
        return user.to_dict()

    @router.post("/auth/change-password")
    async def change_password(
        current_password: str = Body(..., embed=True),
        new_password: str = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Change the current user's password."""
        user = await ctx.auth.get_current_user(authorization)

        if len(new_password) < 6:
            raise HTTPException(400, "New password must be at least 6 characters")

        # Verify current password
        verified = await User.verify_password(user.username, current_password, ctx.model_ctx)
        if not verified:
            raise HTTPException(403, "Current password is incorrect")

        await user.change_password(new_password)
        return {"message": "Password changed successfully"}

    @router.post("/auth/waitlist")
    async def join_waitlist(
        email: str = Body(..., embed=True),
    ):
        """Join the waitlist (public, no auth required).

        Sends a confirmation email to the user and BCC to chengtao@clawmeets.ai.
        """
        try:
            email = User.validate_email(email)
        except ValueError as e:
            raise HTTPException(400, str(e))

        msg = ClawMeetsEmailMessage.waitlist(to_email=email)
        await get_mailer().send(msg)
        return {"message": "You're on the waitlist! Check your email for confirmation."}

    return router
