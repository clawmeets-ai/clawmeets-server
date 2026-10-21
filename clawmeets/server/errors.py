# SPDX-License-Identifier: BUSL-1.1
"""The one JSON error envelope for password sign-in and sign-up.

Shape::

    {"error": {"code": str, "message": str, "field": str | null}}

This is the same shape ``server/oauth_login/errors.py`` emits. That module's
13-code ``ERROR_SPEC`` is a frozen FE<->BE contract surface (its codes are
SCREAMING_CASE; ours are lowercase), so the password-auth codes get their own
table here rather than polluting it — but the SHAPE is defined exactly once, in
:func:`error_envelope`, and ``AppError.envelope()`` delegates to it. One shape,
one definition, two registries.

AUTH_CONTRACT.md §4 / §5 pin every literal below.
"""
from __future__ import annotations

from fastapi.responses import JSONResponse

# code -> (http_status, default message, default offending field)
#
# Every value is lifted verbatim from AUTH_CONTRACT.md: "Invalid credentials"
# (capital I, no trailing period), the 403 verification sentence, and the 400
# message that both missing-field rows share.
AUTH_ERROR_SPEC: dict[str, tuple[int, str, str | None]] = {
    "invalid_request":     (400, "Identifier and password are required.", "identifier"),
    "invalid_credentials": (401, "Invalid credentials", None),
    "email_not_verified":  (403, "Email not verified. Check your email for the verification link.", None),
    # CLAWMEETS_SIGNUP_MODE=closed (server/signup_policy.py).
    "signup_closed":       (403, "Sign-up is closed on this server. Ask its operator for an account.", None),
    # RESERVED, never raised. Rate limiting is out of scope (AUTH_CONTRACT §7);
    # registering the code now means shipping it later needs no contract change.
    "rate_limited":        (429, "Too many attempts. Try again later.", None),
}


def error_envelope(code: str, message: str, field: str | None) -> dict:
    """Build the envelope dict — the single definition of the shape.

    ``message`` is ALWAYS a ``str`` and ``field`` is ALWAYS present (``None``
    when the failure is not field-specific). Never a list: FastAPI's 422 body
    puts a list under the same ``detail`` key a string lives under on 401/403,
    and that polymorphism is the defect this envelope exists to prevent.
    """
    return {"error": {"code": code, "message": message, "field": field}}


class AuthError(Exception):
    """A typed password-auth failure, carrying its own HTTP status.

    ``code`` must be in :data:`AUTH_ERROR_SPEC` — a typo raises ``KeyError`` at
    raise time rather than silently shipping an unknown code on the wire.
    ``message`` and ``field`` default to the spec's; pass them explicitly to
    override, as the "Invalid request body." case does.
    """

    def __init__(
        self,
        code: str,
        message: str | None = None,
        field: str | None = "__default__",
    ) -> None:
        if code not in AUTH_ERROR_SPEC:
            raise KeyError(f"unknown error code {code!r}")
        status, default_msg, default_field = AUTH_ERROR_SPEC[code]
        self.code = code
        self.status = status
        self.message = message or default_msg
        self.field = default_field if field == "__default__" else field
        super().__init__(f"{code}: {self.message}")

    def envelope(self) -> dict:
        return error_envelope(self.code, self.message, self.field)


def auth_error_response(err: AuthError) -> JSONResponse:
    """Render an :class:`AuthError` as the response the route returns.

    No headers beyond FastAPI's defaults — AUTH_CONTRACT §4.1 requires the four
    indistinguishable 401 cases to agree on headers as well as on body.
    """
    return JSONResponse(status_code=err.status, content=err.envelope())
