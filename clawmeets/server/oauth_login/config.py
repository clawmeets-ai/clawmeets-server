# SPDX-License-Identifier: BUSL-1.1
"""Configuration for OAuth invite-login — client creds come ONLY from the four
namespaced vars.

There is deliberately NO field for GOOGLE_APPLICATION_CREDENTIALS, any
client_secret*.json path, or CLAWMEETS_GOOGLE_OAUTH_CREDENTIALS (those belong to
the Google skills/MCP relay and must stay untouched). ``from_env`` fails fast
(RuntimeError) if any required OAuth field is empty, listing every missing var.

Implemented as a plain frozen dataclass (no pydantic-settings dependency) so the
fail-fast rule is explicit and the same object can be constructed directly in
tests. app.py mounts the router only when ``from_env`` succeeds — mirroring the
existing optional-router pattern (``if skill_registry:`` / ``if mcp_registry:``).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

# The provider client credentials — the ONLY accepted source. CLAWMEETS_APP_URL
# is the SPA origin the callback 302-redirects to.
_REQUIRED = (
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GITHUB_OAUTH_CLIENT_ID",
    "GITHUB_OAUTH_CLIENT_SECRET",
    "CLAWMEETS_APP_URL",
)

# The SPA's BrowserRouter basename + Vite base. A code constant, NOT env-derived:
# CLAWMEETS_APP_URL carries the ORIGIN only; success/error redirects are built as
# f"{frontend_base_url}{SPA_BASE_PATH}{route}".
SPA_BASE_PATH = "/app"


@dataclass(frozen=True)
class OAuthLoginSettings:
    google_oauth_client_id: str
    google_oauth_client_secret: str
    github_oauth_client_id: str
    github_oauth_client_secret: str
    oauth_redirect_base_url: str        # API origin — builds the registered callback URLs
    frontend_base_url: str              # SPA origin — where the callback 302-redirects the browser
    state_secret: str                   # HMAC key for the short-lived oauth_login_state cookie
    spa_base_path: str = SPA_BASE_PATH
    # cookies emitted with Secure by default; overridable for local http testing.
    cookie_secure: bool = True

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "OAuthLoginSettings":
        # Read from os.environ (or an injected mapping). Raise RuntimeError listing
        # every missing required var. The state-cookie secret reuses
        # CLAWMEETS_JWT_SECRET (plan §6 Q2); the redirect base defaults to
        # CLAWMEETS_APP_URL when CLAWMEETS_OAUTH_REDIRECT_BASE_URL is unset.
        env = os.environ if env is None else env
        missing = [k for k in _REQUIRED if not (env.get(k) or "").strip()]
        if missing:
            raise RuntimeError(
                "Missing required environment variable(s): "
                + ", ".join(missing)
                + ". OAuth client credentials are accepted ONLY from the namespaced "
                "GOOGLE_OAUTH_* / GITHUB_OAUTH_* vars (never a client_secret*.json "
                "file, GOOGLE_APPLICATION_CREDENTIALS, or "
                "CLAWMEETS_GOOGLE_OAUTH_CREDENTIALS)."
            )
        app_url = env["CLAWMEETS_APP_URL"].strip().rstrip("/")
        redirect_base = (env.get("CLAWMEETS_OAUTH_REDIRECT_BASE_URL") or app_url).strip().rstrip("/")
        # CLAWMEETS_JWT_SECRET always resolves (auth.py assigns a random default
        # when unset), so the state cookie is always signable.
        import secrets as _secrets
        state_secret = (env.get("CLAWMEETS_JWT_SECRET") or "").strip() or _secrets.token_hex(32)
        secure = (env.get("COOKIE_SECURE", "true").strip().lower() != "false")
        return cls(
            google_oauth_client_id=env["GOOGLE_OAUTH_CLIENT_ID"].strip(),
            google_oauth_client_secret=env["GOOGLE_OAUTH_CLIENT_SECRET"].strip(),
            github_oauth_client_id=env["GITHUB_OAUTH_CLIENT_ID"].strip(),
            github_oauth_client_secret=env["GITHUB_OAUTH_CLIENT_SECRET"].strip(),
            oauth_redirect_base_url=redirect_base,
            frontend_base_url=app_url,
            state_secret=state_secret,
            cookie_secure=secure,
        )

    def redirect_uri(self, provider: str) -> str:
        # The provider redirect target the API registers with Google/GitHub.
        return f"{self.oauth_redirect_base_url}/auth/oauth/{provider}/callback"

    def spa_url(self, route: str) -> str:
        # Browser-facing SPA URL: origin + "/app" basename + route.
        return f"{self.frontend_base_url}{self.spa_base_path}{route}"
