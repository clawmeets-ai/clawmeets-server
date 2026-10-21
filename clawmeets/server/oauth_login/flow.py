# SPDX-License-Identifier: BUSL-1.1
"""OAuth authorization-code flow for Google + GitHub (invite-login).

The invite code travels through the provider redirect inside a short-lived,
HMAC-signed, CSRF-bound ``oauth_login_state`` cookie (never a client-editable
field). Only VERIFIED provider emails are accepted.

Ported from the standalone ``oauth_invite_login`` module; the only changes are
the cookie name (``oauth_state`` -> ``oauth_login_state`` to avoid any confusion
with the MCP/skill relay) and the settings type (``OAuthLoginSettings``).
"""
from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from .config import OAuthLoginSettings
from .errors import OAuthError
from .providers import get_provider

STATE_COOKIE = "oauth_login_state"
_STATE_SALT = "clawmeets.oauth-login.state.v1"
_STATE_MAX_AGE = 600  # 10 minutes


@dataclass(frozen=True)
class ProviderIdentity:
    provider: str
    provider_subject: str
    verified_email: str
    display_name: str | None
    avatar_url: str | None


def verify_pkce(code_verifier: str | None, code_challenge: str | None) -> bool:
    """True iff ``code_verifier`` proves possession of ``code_challenge`` (S256).

    RFC-7636: challenge == base64url-no-pad(sha256(verifier)). A missing verifier
    or challenge fails closed. Compared with ``secrets.compare_digest`` so the
    check is timing-safe.
    """
    if not code_verifier or not code_challenge:
        return False
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return secrets.compare_digest(expected, code_challenge)


class OAuthFlow:
    def __init__(self, settings: OAuthLoginSettings, client: httpx.AsyncClient | None = None):
        self.s = settings
        self._state = URLSafeTimedSerializer(settings.state_secret, salt=_STATE_SALT)
        self._client = client  # injectable for tests

    def _creds(self, provider: str) -> tuple[str, str]:
        if provider == "google":
            return self.s.google_oauth_client_id, self.s.google_oauth_client_secret
        return self.s.github_oauth_client_id, self.s.github_oauth_client_secret

    # ---- start: build authorize URL + signed state cookie --------------------
    def _authorize_url(self, provider: str, state: str) -> str:
        # Build the provider authorization URL for an already-chosen `state`.
        # Shared by the web (`start`) and CLI (`start_cli`) entrypoints so the
        # exact provider params (scopes, google prompt hints) stay identical.
        # Caller guarantees `provider` is supported.
        spec = get_provider(provider)
        client_id, _ = self._creds(provider)
        params = {
            "client_id": client_id,
            "redirect_uri": self.s.redirect_uri(provider),
            "response_type": "code",
            "scope": " ".join(spec.scopes),
            "state": state,
        }
        if provider == "google":
            params["access_type"] = "online"
            params["include_granted_scopes"] = "true"
            params["prompt"] = "select_account"
        return f"{spec.authorize_url}?{urlencode(params)}"

    def start(self, *, provider: str, invite_code: str | None,
              username: str | None = None) -> tuple[str, str]:
        # Returns (authorization_url, signed_state_cookie_value). The frontend
        # sets window.location = authorization_url (navigation model, not XHR).
        # `username` is the slug the user picked in the sign-up flow BEFORE
        # choosing a provider; it rides inside the signed cookie (never a
        # client-editable field) so a newly provisioned account gets the chosen
        # clawmeets.ai/<username> instead of an email-derived one.
        spec = get_provider(provider)
        if spec is None:
            raise OAuthError("PROVIDER_UNSUPPORTED", field="provider")
        state = secrets.token_urlsafe(24)
        cookie = self._state.dumps(
            {"state": state, "code": invite_code, "provider": provider, "username": username}
        )
        return self._authorize_url(provider, state), cookie

    # ---- CLI start: authorize URL for a store-backed (cookieless) state -------
    def start_cli(self, *, provider: str, state: str) -> str:
        # The CLI has no cookie jar, so the pending flow params live server-side
        # in CliOAuthStateStore keyed by `state` (minted + stored by the route).
        # We only build the provider authorize URL that echoes `state` back.
        if get_provider(provider) is None:
            raise OAuthError("PROVIDER_UNSUPPORTED", field="provider")
        return self._authorize_url(provider, state)

    # ---- CLI complete: provider round-trip only (state already validated) ----
    async def fetch_identity_for_cli(self, *, provider: str, code: str | None) -> ProviderIdentity:
        # The route validated `state` against CliOAuthStateStore before calling
        # this (the cookieless analogue of `complete`'s cookie check), so here we
        # only exchange the provider code for a verified identity.
        spec = get_provider(provider)
        if spec is None:
            raise OAuthError("PROVIDER_UNSUPPORTED", field="provider")
        if not code:
            raise OAuthError("OAUTH_STATE_INVALID")
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=10.0)
        try:
            token = await self._exchange(client, spec, provider, code)
            return await self._fetch_identity(client, spec, provider, token)
        finally:
            if owns_client:
                await client.aclose()

    # ---- complete: verify state, exchange code, fetch verified identity ------
    async def complete(self, *, provider: str, code: str | None, state_cookie: str | None,
                       query_state: str | None) -> tuple[ProviderIdentity, str | None, str | None]:
        spec = get_provider(provider)
        if spec is None:
            raise OAuthError("PROVIDER_UNSUPPORTED", field="provider")
        if not code or not state_cookie or not query_state:
            raise OAuthError("OAUTH_STATE_INVALID")
        try:
            payload = self._state.loads(state_cookie, max_age=_STATE_MAX_AGE)
        except (BadSignature, SignatureExpired):
            raise OAuthError("OAUTH_STATE_INVALID")
        if payload.get("state") != query_state or payload.get("provider") != provider:
            raise OAuthError("OAUTH_STATE_INVALID")
        invite_code = payload.get("code")
        desired_username = payload.get("username")

        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=10.0)
        try:
            token = await self._exchange(client, spec, provider, code)
            identity = await self._fetch_identity(client, spec, provider, token)
        finally:
            if owns_client:
                await client.aclose()
        return identity, invite_code, desired_username

    async def _exchange(self, client, spec, provider, code) -> str:
        client_id, client_secret = self._creds(provider)
        data = {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": self.s.redirect_uri(provider),
        }
        try:
            resp = await client.post(spec.token_url, data=data, headers={"Accept": "application/json"})
        except httpx.HTTPError:
            raise OAuthError("OAUTH_EXCHANGE_FAILED")
        if resp.status_code != 200:
            raise OAuthError("OAUTH_EXCHANGE_FAILED")
        body = resp.json()
        access_token = body.get("access_token")
        if not access_token:
            raise OAuthError("OAUTH_EXCHANGE_FAILED")
        return access_token

    async def _fetch_identity(self, client, spec, provider, access_token) -> ProviderIdentity:
        headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
        try:
            if provider == "google":
                r = await client.get(spec.userinfo_url, headers=headers)
                if r.status_code != 200:
                    raise OAuthError("OAUTH_EXCHANGE_FAILED")
                info = r.json()
                email = info.get("email")
                if not email:
                    raise OAuthError("OAUTH_EMAIL_MISSING")
                if not info.get("email_verified", False):
                    raise OAuthError("OAUTH_EMAIL_UNVERIFIED")
                return ProviderIdentity(
                    provider="google",
                    provider_subject=str(info.get("sub")),
                    verified_email=email,
                    display_name=info.get("name"),
                    avatar_url=info.get("picture"),
                )
            # github
            r = await client.get(spec.userinfo_url, headers=headers)
            if r.status_code != 200:
                raise OAuthError("OAUTH_EXCHANGE_FAILED")
            info = r.json()
            re_ = await client.get(spec.emails_url, headers=headers)
            if re_.status_code != 200:
                raise OAuthError("OAUTH_EXCHANGE_FAILED")
            emails = re_.json()
            primary = next((e for e in emails if e.get("primary") and e.get("verified")), None)
            if primary is None:
                # a verified primary is required; distinguish missing vs unverified
                if not any(e.get("primary") for e in emails):
                    raise OAuthError("OAUTH_EMAIL_MISSING")
                raise OAuthError("OAUTH_EMAIL_UNVERIFIED")
            return ProviderIdentity(
                provider="github",
                provider_subject=str(info.get("id")),
                verified_email=primary["email"],
                display_name=info.get("name") or info.get("login"),
                avatar_url=info.get("avatar_url"),
            )
        except httpx.HTTPError:
            raise OAuthError("OAUTH_EXCHANGE_FAILED")
