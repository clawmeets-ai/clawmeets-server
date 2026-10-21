# SPDX-License-Identifier: BUSL-1.1
"""The single error envelope and the 13 stable error codes for OAuth invite-login.

Every JSON error response from the ``/auth/oauth/*`` router uses ONE shape:
    {"error": {"code": <CODE>, "message": <str>, "field": <str|null>}}
On the OAuth callback the same code strings are conveyed as ``?error=<CODE>`` on
the 302 back to the SPA login page.

Ported verbatim from the standalone ``oauth_invite_login`` module. The 13-code
set is the FE<->BE contract surface and must stay byte-stable. NO_SESSION is
reused for a missing/expired/used one-time exchange handoff (plan §6 Q1).
"""
from __future__ import annotations

from clawmeets.server.errors import error_envelope

# code -> (http_status, default message, default offending field)
ERROR_SPEC: dict[str, tuple[int, str, str | None]] = {
    "INVITE_MALFORMED":        (422, "The invite code is empty or malformed.", "code"),
    "INVITE_REQUIRED":         (403, "An invite code is required to create a new account.", "code"),
    "INVITE_NOT_FOUND":        (404, "No such invite code.", "code"),
    "INVITE_ALREADY_REDEEMED": (409, "This invite code has already been used.", "code"),
    "INVITE_EXPIRED":          (410, "This invite code has expired.", "code"),
    "INVITE_REVOKED":          (403, "This invite code has been revoked.", "code"),
    "PROVIDER_UNSUPPORTED":    (400, "Unsupported OAuth provider.", "provider"),
    "OAUTH_ACCESS_DENIED":     (302, "OAuth consent was denied.", None),
    "OAUTH_STATE_INVALID":     (302, "OAuth state is missing, expired, or invalid.", None),
    "OAUTH_EXCHANGE_FAILED":   (302, "Failed to exchange the OAuth authorization code.", None),
    "OAUTH_EMAIL_UNVERIFIED":  (302, "The provider email is not verified.", None),
    "OAUTH_EMAIL_MISSING":     (302, "The provider returned no usable email.", None),
    "NO_SESSION":              (401, "No active session.", None),
    # Added after the original 13: CLAWMEETS_SIGNUP_MODE=closed (server/signup_policy.py).
    "SIGNUP_CLOSED":           (403, "Sign-up is closed on this server.", None),
    # The provider email matches an account whose own address was never proven
    # (unverified, or only trusted-domain pre-verified): no link, no new account.
    "EMAIL_UNPROVEN":          (409, (
        "An account already uses this email address but the address was never "
        "confirmed. Sign in with that account's password instead, or ask this "
        "server's operator."
    ), None),
}

# Codes that only ever surface on the callback (as a 302 ?error=CODE redirect).
REDIRECT_ONLY = {
    "OAUTH_ACCESS_DENIED", "OAUTH_STATE_INVALID", "OAUTH_EXCHANGE_FAILED",
    "OAUTH_EMAIL_UNVERIFIED", "OAUTH_EMAIL_MISSING", "INVITE_REQUIRED",
    "SIGNUP_CLOSED", "EMAIL_UNPROVEN",
}


class AppError(Exception):
    """Base for every typed, contract-mapped error."""

    def __init__(self, code: str, message: str | None = None, field: str | None = "__default__"):
        if code not in ERROR_SPEC:
            raise KeyError(f"unknown error code {code!r}")
        status, default_msg, default_field = ERROR_SPEC[code]
        self.code = code
        self.status = status
        self.message = message or default_msg
        self.field = default_field if field == "__default__" else field
        super().__init__(f"{code}: {self.message}")

    def envelope(self) -> dict:
        # The one JSON error shape the frontend maps on error.code. Delegated to
        # clawmeets.server.errors so the shape has exactly ONE definition shared
        # with password sign-in; the 13-code ERROR_SPEC above stays this module's.
        # Output is byte-identical to the dict literal this replaced —
        # tests/test_error_envelope_shared.py pins that for all 13 codes.
        return error_envelope(self.code, self.message, self.field)


class InviteError(AppError):
    """INVITE_* — invite validation / redemption failures."""


class OAuthError(AppError):
    """OAUTH_* / PROVIDER_UNSUPPORTED — provider round-trip failures."""
