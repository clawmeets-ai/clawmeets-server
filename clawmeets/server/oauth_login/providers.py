# SPDX-License-Identifier: BUSL-1.1
"""Per-provider constants for OAuth invite-login — EXACT non-sensitive scopes
only (publishes with zero verification review). {provider} in {google, github}.

Ported verbatim from the standalone ``oauth_invite_login`` module; the scopes
are load-bearing for the "no OAuth verification review" guarantee and must not
be widened here.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    scopes: list[str]
    authorize_url: str
    token_url: str
    userinfo_url: str
    emails_url: str | None = None  # GitHub: verified-primary lookup


GOOGLE = ProviderSpec(
    name="google",
    scopes=["openid", "email", "profile"],              # non-sensitive only
    authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
    token_url="https://oauth2.googleapis.com/token",
    userinfo_url="https://openidconnect.googleapis.com/v1/userinfo",
)

GITHUB = ProviderSpec(
    name="github",
    scopes=["read:user", "user:email"],                 # non-sensitive only
    authorize_url="https://github.com/login/oauth/authorize",
    token_url="https://github.com/login/oauth/access_token",
    userinfo_url="https://api.github.com/user",
    emails_url="https://api.github.com/user/emails",    # + verified primary email
)

PROVIDERS: dict[str, ProviderSpec] = {GOOGLE.name: GOOGLE, GITHUB.name: GITHUB}


def get_provider(name: str) -> ProviderSpec | None:
    return PROVIDERS.get(name)
