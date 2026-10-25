# SPDX-License-Identifier: MIT
"""
clawmeets/hub_protocol/ids.py

Identifiers on the hub wire: the canonical hub URL, name rules, how an agent
is addressed, the reporter id, and what every schema is built from: the
constrained string and number types and the ``WireModel`` base.

An agent is addressed on the wire as two fields, ``deployment_fingerprint``
and ``agent_name`` (``AgentRef``; ``agent_ref()`` joins them with ``~`` for
the browser-facing id). ``name@deployment`` is a display label only and is
never parsed.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from clawmeets.hub_protocol.constants import MAX_SAFE_INT

# Name rules, as bare patterns (re.fullmatch here; anchored for pydantic below).
# Deployment names: 3-63 chars, the design's rule.
DEPLOYMENT_NAME_PATTERN = r"[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])"
# Agent names: also "_", so existing agents such as nyc_culture can be listed.
# Never "~", which separates the two halves of an agent_ref.
AGENT_NAME_PATTERN = r"[a-z0-9](?:[a-z0-9._-]{0,62})"
FINGERPRINT_PATTERN = r"[a-z2-7]{16}"
DEPLOYMENT_NAME_RE = re.compile(DEPLOYMENT_NAME_PATTERN)
AGENT_NAME_RE = re.compile(AGENT_NAME_PATTERN)
FINGERPRINT_RE = re.compile(FINGERPRINT_PATTERN)

MIN_REPORTER_SECRET_BYTES = 32


def _anchored(pattern: str) -> StringConstraints:
    return StringConstraints(pattern=f"^{pattern}$")


class HubUrlError(ValueError):
    """Not a usable hub URL (not https, userinfo, query, fragment, bad host or port)."""


# Lowercase scheme and host (an IDNA host becomes punycode), require https,
# drop :443 and one trailing "." on the host (the same host to DNS), refuse
# userinfo, query, fragment, "." and ".." path segments and percent-encoding,
# strip trailing "/" from the path ("" at the root). Idempotent.
def canonical_hub_url(url: str) -> str:
    if not isinstance(url, str) or not url or not url.isprintable() or any(c.isspace() for c in url):
        raise HubUrlError("hub URL must be a non-empty string without spaces")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise HubUrlError(f"unparseable hub URL: {exc}") from exc
    if parts.scheme.lower() != "https":
        raise HubUrlError("hub URL must use https")
    if "@" in parts.netloc:
        raise HubUrlError("hub URL must not carry userinfo")
    if "?" in url or "#" in url:
        raise HubUrlError("hub URL must not carry a query or fragment")
    host = parts.hostname
    if not host:
        raise HubUrlError("hub URL has no host")
    if ":" in host:
        host = f"[{host}]"
    else:
        try:
            host = host.encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise HubUrlError(f"invalid host: {exc}") from exc
        host = host[:-1] if host.endswith(".") else host
        if not host or host.endswith("."):
            raise HubUrlError("invalid host: empty label")
    path = parts.path.rstrip("/")
    if "%" in path or any(segment in (".", "..") for segment in path.split("/")):
        raise HubUrlError("hub URL path must not carry '.', '..' or percent-encoding")
    netloc = host if port in (None, 443) else f"{host}:{port}"
    return f"https://{netloc}{path}"


def _is_canonical_hub_url(value: str) -> str:
    if canonical_hub_url(value) != value:
        raise ValueError("hub URL is not in canonical form")
    return value


# --------------------------------------------------------------------------
# Constrained wire types
# --------------------------------------------------------------------------

Fingerprint = Annotated[str, _anchored(FINGERPRINT_PATTERN)]
AgentName = Annotated[str, _anchored(AGENT_NAME_PATTERN)]
DeploymentName = Annotated[str, _anchored(DEPLOYMENT_NAME_PATTERN)]
# Hub-assigned or locally minted ids: deployment ids, serials, kids, session
# ids, project and user ids.
OpaqueId = Annotated[str, _anchored(r"[A-Za-z0-9_-]{1,64}")]
# ChatMessage.id today is a uuid4; a ULID also fits.
MessageId = Annotated[str, _anchored(r"[0-9A-Za-z-]{20,40}")]
PublicKeyB64 = Annotated[str, _anchored(r"[A-Za-z0-9_-]{43}")]
SignatureB64 = Annotated[str, _anchored(r"[A-Za-z0-9_-]{86}")]
NonceB64 = Annotated[str, _anchored(r"[A-Za-z0-9_-]{16,64}")]
Sha256Hex = Annotated[str, _anchored(r"[0-9a-f]{64}")]
HubUrl = Annotated[str, StringConstraints(max_length=200), AfterValidator(_is_canonical_hub_url)]
EpochS = Annotated[int, Field(ge=0, le=MAX_SAFE_INT)]
EpochFloat = Annotated[float, Field(ge=0, le=MAX_SAFE_INT, allow_inf_nan=False)]
Count = Annotated[int, Field(ge=0, le=MAX_SAFE_INT)]


class WireModel(BaseModel):
    """Base of every hub payload.

    extra="ignore": a field added by a newer peer within the same version
    parses (the signature still covers it, because verification runs on the
    received dict). strict=True: no coercion ("1" is not 1). frozen: a parsed
    payload is never edited in place. Optional fields are always
    ``T | None = None`` and never get a non-None default, so a field added
    later does not change an older sender's bytes.
    """

    model_config = ConfigDict(extra="ignore", strict=True, frozen=True, str_strip_whitespace=False)


# --------------------------------------------------------------------------
# Agent addressing
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class AgentRef:
    """How an agent is addressed on the wire."""

    deployment_fingerprint: str
    agent_name: str


# "{fp}~{agent_name}" with the GENESIS fingerprint: the browser-facing hub_agent_id.
def agent_ref(deployment_fingerprint: str, agent_name: str) -> str:
    if not FINGERPRINT_RE.fullmatch(deployment_fingerprint or ""):
        raise ValueError("invalid deployment fingerprint")
    if not AGENT_NAME_RE.fullmatch(agent_name or ""):
        raise ValueError("invalid agent name")
    return f"{deployment_fingerprint}~{agent_name}"


# Inverse of agent_ref; ValueError on anything else.
def parse_agent_ref(ref: str) -> AgentRef:
    if not isinstance(ref, str) or ref.count("~") != 1:
        raise ValueError("an agent ref is '<fingerprint>~<agent_name>'")
    fp, name = ref.split("~")
    agent_ref(fp, name)
    return AgentRef(deployment_fingerprint=fp, agent_name=name)


# "name@deployment": display only, never parsed.
def display_label(agent_name: str, deployment_name: str) -> str:
    return f"{agent_name}@{deployment_name}"


# The message id of one hub-dispatched copy of an ask: the first 32 hex chars of
# sha256("{ask_id}:{slot}"). Both ends derive it, so the hub's route row, the
# host's dedupe and the requester's delivery probe all name the same message.
def dispatched_message_id(ask_id: str, slot: str) -> str:
    return hashlib.sha256(f"{ask_id}:{slot}".encode("utf-8")).hexdigest()[:32]


# HMAC-SHA256(secret, user_id) as lowercase hex. The secret is the deployment's
# reporter secret (>= 32 bytes) and never leaves it, so the hub can neither
# recover a user id nor link one user across deployments.
def reporter_id(secret: bytes, user_id: str) -> str:
    if not isinstance(secret, (bytes, bytearray)) or len(secret) < MIN_REPORTER_SECRET_BYTES:
        raise ValueError(f"reporter secret must be at least {MIN_REPORTER_SECRET_BYTES} bytes")
    return hmac.new(bytes(secret), user_id.encode("utf-8"), hashlib.sha256).hexdigest()
