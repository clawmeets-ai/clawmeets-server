# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/config.py
Env-driven server configuration.

The **CORS allowlist** — ``allow_origins=["*"]`` combined with
``allow_credentials=True`` is both unsafe and spec-incompatible.
``cors_allow_origins`` builds the explicit allowlist from the environment
(``CLAWMEETS_CORS_ORIGINS`` + ``CLAWMEETS_APP_URL``).
"""
from __future__ import annotations

import os


def cors_allow_origins() -> list[str]:
    """Explicit CORS allowlist, replacing ``allow_origins=['*']``.

    Order-preserving union of:
      - ``CLAWMEETS_CORS_ORIGINS`` — comma-separated explicit origins (the public
        app origin plus any extra, e.g. ``https://ics.clawmeets.ai``),
      - ``CLAWMEETS_APP_URL``      — the public app origin.

    De-duplicated. When nothing is configured, falls back to ``['*']`` so dev and
    the test suite keep working unchanged; production is expected to set at least
    one origin (``['*']`` + credentials cannot reject a cross-origin caller).
    """
    origins: list[str] = []

    def _add(value: str | None) -> None:
        cleaned = (value or "").strip().rstrip("/")
        if cleaned and cleaned not in origins:
            origins.append(cleaned)

    for item in os.environ.get("CLAWMEETS_CORS_ORIGINS", "").split(","):
        _add(item)
    _add(os.environ.get("CLAWMEETS_APP_URL"))

    return origins or ["*"]


def public_app_url() -> str:
    """The origin a user's own machine should be told to talk to.

    Needed by anything that hands a URL to something OUTSIDE this process — the
    one-command installer bakes it into a script that a laptop will use for
    weeks, so guessing it from an inbound ``Host`` header (which a proxy may have
    rewritten) is not good enough.

    Precedence mirrors ``server/email.APP_BASE_URL``, which has the same problem
    for links in verification mail: ``CLAWMEETS_APP_URL`` first, then
    ``CLAWMEETS_VERIFICATION_URL``. Returns "" when neither is set rather than
    inventing ``https://clawmeets.ai`` — a self-hosted deployment that forgot to
    configure this must produce an obviously broken command, not one that
    silently sends its users' tokens to someone else's server.
    """
    for name in ("CLAWMEETS_APP_URL", "CLAWMEETS_VERIFICATION_URL"):
        value = (os.environ.get(name) or "").strip().rstrip("/")
        if value:
            return value
    return ""


NON_PRODUCTION_ENVIRONMENTS = frozenset({"development", "dev", "staging", "test"})


def deployment_environment() -> str:
    """Which deployment this server is: ``CLAWMEETS_ENVIRONMENT``, lowercased.

    Unset or empty means ``"production"``. Fail closed on purpose: whatever is
    held back from production (``is_production``) must stay held back on a box
    whose operator forgot this line. Dev and staging set it explicitly
    (``development`` / ``staging``).
    """
    return (os.environ.get("CLAWMEETS_ENVIRONMENT") or "").strip().lower() or "production"


def is_production() -> bool:
    """True unless ``CLAWMEETS_ENVIRONMENT`` names a non-production deployment
    (``NON_PRODUCTION_ENVIRONMENTS``). An unrecognised value counts as production."""
    return deployment_environment() not in NON_PRODUCTION_ENVIRONMENTS
