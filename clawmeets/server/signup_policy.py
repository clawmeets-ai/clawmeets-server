# SPDX-License-Identifier: BUSL-1.1
"""Who may create an account on this server.

One rule, asked by both sign-up paths (password ``POST /auth/register`` and the
Google/GitHub provision in ``User.oauth_authenticate_or_provision``) so the two
cannot drift. Read once at boot from:

``CLAWMEETS_SIGNUP_MODE``
    ``invite`` (default): a new account spends one use of an invitation code,
    exactly as before this setting existed. ``open``: no code; one that is sent
    anyway is ignored and not consumed. ``closed``: no new accounts at all
    (operators still create them with ``clawmeets server admin create-user``).

``CLAWMEETS_SIGNUP_TRUSTED_DOMAINS``
    Comma-separated email domains whose new accounts start verified, so an
    intranet server with no mail service still works. Exact match only:
    ``corp.com`` does not cover ``eng.corp.com``. Independent of the mode.

A bad value raises ``ValueError`` naming the variable, which stops boot.
"""
from __future__ import annotations

import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import urlparse

from clawmeets.models.invitation_code import redeem

logger = logging.getLogger("clawmeets.server")

SignupMode = Literal["invite", "open", "closed"]
SIGNUP_MODES: tuple[str, ...] = ("invite", "open", "closed")

MODE_ENV = "CLAWMEETS_SIGNUP_MODE"
DOMAINS_ENV = "CLAWMEETS_SIGNUP_TRUSTED_DOMAINS"

# Refusal code for a closed server. The invite refusals reuse the existing
# INVITE_* codes from models/invitation_code.py.
SIGNUP_CLOSED = "signup_closed"

_DOMAIN_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


class SignupRefused(Exception):
    """A new account may not be created. ``code`` is ``signup_closed`` or an
    ``INVITE_*`` code; each caller renders it in its own error envelope."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class SignupPolicy:
    mode: SignupMode = "invite"
    trusted_domains: frozenset[str] = field(default_factory=frozenset)

    @property
    def invitation_code_required(self) -> bool:
        return self.mode == "invite"

    async def admit(self, invitation_code: Optional[str], *, username: str, data_dir: Path) -> None:
        """The single gate for creating a NEW account. Raises :class:`SignupRefused`.

        Call it after the username and email checks, so a bad username never
        costs an invitation code. In ``invite`` mode a use is consumed here.
        """
        if self.mode == "closed":
            raise SignupRefused(SIGNUP_CLOSED)
        if self.mode == "open":
            return
        err = await redeem(invitation_code, data_dir, username)
        if err is not None:
            raise SignupRefused(err)

    def pre_verified(self, email: str) -> bool:
        """True when ``email``'s domain is trusted (exact match, case-insensitive)."""
        _, at, domain = (email or "").strip().lower().rpartition("@")
        return bool(at) and domain in self.trusted_domains

    def public_config(self) -> dict:
        """What the sign-up page may know. The domain list stays out of it: it
        would tell a stranger which organisation runs this server."""
        return {"mode": self.mode, "invitation_code_required": self.invitation_code_required}


def load_signup_policy(env: Mapping[str, str] | None = None) -> SignupPolicy:
    """Read the two variables (``os.environ`` by default). Raises ``ValueError``."""
    env = os.environ if env is None else env
    mode = (env.get(MODE_ENV) or "").strip().lower() or "invite"
    if mode not in SIGNUP_MODES:
        raise ValueError(f"{MODE_ENV}={mode!r} is not one of {', '.join(SIGNUP_MODES)}")
    domains: set[str] = set()
    for raw in (env.get(DOMAINS_ENV) or "").split(","):
        d = raw.strip().lower().lstrip("@")
        if not d:
            continue
        if not _DOMAIN_RE.match(d):
            raise ValueError(f"{DOMAINS_ENV}: {raw.strip()!r} is not an email domain")
        domains.add(d)
    return SignupPolicy(mode=mode, trusted_domains=frozenset(domains))  # type: ignore[arg-type]


def warn_if_exposed(policy: SignupPolicy, server_url: str | None) -> None:
    """Log a warning when open sign-up meets a public https address: anyone who
    finds the server can make an account and use it as a relay."""
    if policy.mode != "open" or not server_url:
        return
    parsed = urlparse(server_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and "." in host and not host.endswith((".local", ".internal", ".lan")):
        logger.warning(
            "%s=open on a public address (%s): anyone can create an account. "
            "Set %s=invite to require invitation codes.", MODE_ENV, server_url, MODE_ENV,
        )
