# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/channels/config.py
Boot-time environment check for the channel gateway.

``load_channel_config()`` reads the channel environment variables and returns a
validated ``ChannelConfig``, or ``None`` when the gateway must stay off.
``create_app`` calls it once at boot through ``gateway.build_channel_gateway``,
whose own catch-all logs one ``Channel gateway OFF`` line with the exception
type only. It never raises, so it can never stop the server from booting:

- ``CLAWMEETS_CHANNELS_ENABLED`` unset or false → ``None``, one INFO line.
- enabled, but a required variable is missing or malformed → ``None`` and ONE
  ERROR line naming every bad variable and why. Values are never logged — only
  variable names and what is wrong with them.
- anything unexpected while checking → ``None`` and ONE ERROR line with the
  exception type only (its message could quote a value).

Variables (see deploy/clawmeets.env.example for the operator-facing comments):

- ``CLAWMEETS_CHANNELS_ENABLED``     kill switch; ``true``/``1``/``yes``/``on``.
- ``CLAWMEETS_CHANNEL_SECRET_KEY``   one or more comma-separated Fernet keys.
  The FIRST key encrypts; every key decrypts (``MultiFernet``), which is what
  makes rotation possible without losing stored channel credentials.
- ``CLAWMEETS_SERVER_URL``           existing public origin; webhooks are served
  under it. Must be https (plain http allowed only for localhost).
- ``CLAWMEETS_INBOUND_EMAIL_DOMAIN`` receiving domain for agent addresses;
  defaults to ``agents.clawmeets.ai``.
- ``CLAWMEETS_EMAIL_PROVIDER``       ``sendgrid`` (default) | ``mailgun``: who
  carries agent email both ways (the app's own mail reads the same variable,
  ``utils/email.get_mailer``). Only the chosen provider's variables are read:
- ``SENDGRID_INBOUND_SECRET``        shared secret on the Inbound Parse URL.
- ``SENDGRID_API_KEY``               existing outbound SendGrid key; channel
  email replies are sent with it.
- ``MAILGUN_AGENTS_API_KEY``         a Mailgun sending key for the inbound
  domain; channel email replies are sent with it.
- ``MAILGUN_WEBHOOK_SIGNING_KEY``    checks the signature on every inbound POST.
- ``MAILGUN_API_BASE``               ``https://api.mailgun.net`` (default) or the
  EU region's ``https://api.eu.mailgun.net``.

Also installs the webhook query-string redaction on uvicorn's access log (see
``log_redaction.py``) — enabled or not, so a probe of the webhook paths can't
put a secret into the server log either way. ``cli_server.py`` installs it too,
before ``uvicorn.run``.

**The hub's settings** are checked here too, but by their own rules
(``validate_hub_only``), because the hub needs none of the channel variables
except the secret key:

- ``CLAWMEETS_HUB_MODE``    ``auto`` (default: unset or empty) | ``off`` |
  ``discover_only`` | ``full``. ``auto`` relays like ``full``, but the server
  registers itself with the hub the first time a user turns an agent on (or
  searches the hub) and keeps a hub connection only while something needs it
  (``server/hub/enroll.py``, ``server/hub/demand.py``). ``off`` is the kill
  switch: nothing else is read and no hub request is ever made.
- ``CLAWMEETS_HUB_ENROLL``  ``auto`` (default) | ``operator``. ``operator``:
  no user may register this server; only ``clawmeets server hub register``
  does (clawmeets.ai). Users still verify themselves as agent owners. Only
  mode ``auto`` lets users register at all: in ``discover_only`` and ``full``
  the operator registers, whatever this says.
- ``CLAWMEETS_HUB_URL``     default ``https://hub.clawmeets.ai``; compared in
  its canonical form (``canonical_hub_url``), so ``https://hub.clawmeets.ai.``
  IS the default hub, with its pins and its placeholder refusal.
- ``CLAWMEETS_HUB_PUBKEY``  ``<kid>:<base64url key>[,...]``, required for any
  other hub URL and ignored (one WARNING) for the default one, so no variable
  can add a key for the default hub or lift its placeholder refusal.

Unlike a channel problem, a hub problem STOPS the server when the mode is
``discover_only`` or ``full`` (``hub_config_for_boot`` raises
:class:`HubConfigError`, naming every variable at fault). With the mode ``off``
nothing else is read and boot is never affected, whatever the other hub
variables hold. With ``auto`` — which nobody chose explicitly on an upgraded
server — a problem is logged once and the hub stays unusable (refusal
``config_invalid``, link ``untrusted``); boot goes on.

**The secret key in ``auto``.** ``CLAWMEETS_CHANNEL_SECRET_KEY`` still wins.
Unset, the key is read from ``{data_dir}/channels/secret.key`` (mode 0600),
which is generated at boot when missing (``resolve_secret_keys``): every
stored hub secret and the gateway's file links read the key from this boot
config, so it must exist before them. A copy of the data dir is then a copy of
the hub identity; set the variable to keep the key elsewhere. Once the
variable is set, an existing key file is appended to it as a decrypt-only key
(in any mode but ``off``), so what the file encrypted still opens.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Literal, Mapping, Optional
from urllib.parse import urlsplit

from cryptography.fernet import Fernet, MultiFernet

from clawmeets.hub_protocol.canonical import b64url_decode
from clawmeets.hub_protocol.constants import DEFAULT_HUB_URL, MAX_SAFE_INT
from clawmeets.hub_protocol.ids import HubUrlError, canonical_hub_url
from clawmeets.hub_protocol.keys import PINNED_HUB_KEYS, TrustedKey, pins_are_placeholder

from .log_redaction import WEBHOOK_PATH_PREFIX, install_webhook_log_redaction

logger = logging.getLogger(__name__)

DEFAULT_INBOUND_EMAIL_DOMAIN = "agents.clawmeets.ai"
MIN_INBOUND_SECRET_LENGTH = 32
EMAIL_PROVIDERS = ("sendgrid", "mailgun")
DEFAULT_MAILGUN_API_BASE = "https://api.mailgun.net"

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"", "0", "false", "no", "off"}
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)


HubMode = Literal["off", "auto", "discover_only", "full"]
HUB_MODES: tuple[HubMode, ...] = ("off", "auto", "discover_only", "full")
HubEnroll = Literal["auto", "operator"]
HUB_ENROLLS: tuple[HubEnroll, ...] = ("auto", "operator")
#: Why a valid hub configuration must still never connect. ``config_invalid``:
#: mode ``auto`` with settings ``validate_hub_only`` would refuse.
HubRefusal = Literal["placeholder_pin", "config_invalid"]
#: Where ``auto`` keeps a generated secret key, under the server data dir.
SECRET_KEY_FILE = ("channels", "secret.key")

_KID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")


class HubConfigError(ValueError):
    """The hub settings are invalid. ``problems`` name variables, never values."""

    def __init__(self, problems: list[str] | tuple[str, ...]) -> None:
        self.problems = tuple(problems)
        super().__init__("; ".join(self.problems))


@dataclass(frozen=True)
class HubConfig:
    """Validated hub settings. Secret fields are excluded from ``repr``."""

    mode: HubMode = "off"
    #: Who may register this deployment: any user (``auto``) or the operator only.
    enroll: HubEnroll = "auto"
    #: Canonical. "" only on an inspected config whose URL did not parse.
    hub_url: str = DEFAULT_HUB_URL
    is_default: bool = True
    #: The operator's keys (``CLAWMEETS_HUB_PUBKEY``); always empty on the default hub.
    configured_keys: Mapping[str, TrustedKey] = field(default_factory=dict)
    #: From ``CLAWMEETS_CHANNEL_SECRET_KEY``; None when no usable key is set.
    fernet: Optional[MultiFernet] = None
    key_count: int = 0
    #: The same keys as text, current first; () when ``fernet`` is None.
    secret_keys: tuple[str, ...] = ()
    #: Set: the config is valid but this server must never connect (status hub_untrusted).
    refusal: Optional[HubRefusal] = None
    #: ``inspect_hub_config`` only: what ``validate_hub_only`` would refuse.
    problems: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()

    @property
    def enabled(self) -> bool:
        return self.mode != "off"

    @property
    def lazy(self) -> bool:
        """Connect only on demand, and let users register the deployment."""
        return self.mode == "auto"

    @property
    def effective_mode(self) -> HubMode:
        """What the socket does: ``auto`` relays like ``full``."""
        return "full" if self.mode == "auto" else self.mode

    def __repr__(self) -> str:
        return (
            f"HubConfig(mode={self.mode!r}, enroll={self.enroll!r}, hub_url={self.hub_url!r}, "
            f"is_default={self.is_default}, kids={sorted(self.configured_keys)}, "
            f"refusal={self.refusal!r}, problems={len(self.problems)}, secrets=<redacted>)"
        )


HUB_OFF = HubConfig()


@dataclass(frozen=True)
class ChannelConfig:
    """Validated channel settings. Secret fields are excluded from ``repr``."""

    server_url: str
    inbound_email_domain: str
    fernet: MultiFernet
    key_count: int
    #: The same keys as text, first (current) key first. Webhook secrets that
    #: are derived rather than stored (Telegram's) are HMACs under them.
    secret_keys: tuple[str, ...]
    sendgrid_inbound_secret: str
    sendgrid_api_key: str
    #: ``sendgrid`` | ``mailgun``: whose webhook route and send API are live.
    email_provider: str = "sendgrid"
    mailgun_agents_api_key: str = ""
    mailgun_webhook_signing_key: str = ""
    mailgun_api_base: str = DEFAULT_MAILGUN_API_BASE
    #: The hub settings this server booted with (``HUB_OFF`` unless set).
    hub: HubConfig = HUB_OFF
    #: False on a hub-only gateway: no provider adapter, and every provider,
    #: connection and webchat route answers 404 as if channels were off.
    providers_enabled: bool = True

    def __repr__(self) -> str:
        return (
            f"ChannelConfig(server_url={self.server_url!r}, "
            f"inbound_email_domain={self.inbound_email_domain!r}, "
            f"email_provider={self.email_provider!r}, "
            f"key_count={self.key_count}, hub_mode={self.hub.mode!r}, "
            f"providers_enabled={self.providers_enabled}, secrets=<redacted>)"
        )

    @classmethod
    def hub_only(cls, hub: HubConfig, server_url: str = "") -> "ChannelConfig":
        """The config of a gateway that runs only the hub's outbox rows and
        their sweep: no email, no provider. ``hub.fernet`` is required (it
        decrypts the hub's stored keys). The secret keys sign file links;
        ``server_url`` ("" when unset or unusable: ``hub_only_server_url``)
        makes them absolute, and without it a hub thread's files go out by
        name with no link."""
        if hub.fernet is None:
            raise ValueError("a hub-only gateway needs CLAWMEETS_CHANNEL_SECRET_KEY")
        return cls(
            server_url=server_url, inbound_email_domain="", fernet=hub.fernet,
            key_count=hub.key_count, secret_keys=hub.secret_keys,
            sendgrid_inbound_secret="", sendgrid_api_key="",
            hub=hub, providers_enabled=False,
        )

    def webhook_url(self, path: str) -> str:
        """Public URL for a webhook path, e.g. ``webhook_url("telegram/<id>")``."""
        return f"{self.server_url}{WEBHOOK_PATH_PREFIX}/{path.lstrip('/')}"


def _parse_enabled(raw: str) -> Optional[bool]:
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    return None


def _check_server_url(raw: str, problems: list[str]) -> str:
    url = raw.strip().rstrip("/")
    if not url:
        problems.append("CLAWMEETS_SERVER_URL is not set (webhooks are served under it)")
        return ""
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:  # e.g. "https://[bad" — unbalanced IPv6 bracket
        problems.append("CLAWMEETS_SERVER_URL is not a parseable URL")
        return url
    if parts.scheme not in ("https", "http") or not host:
        problems.append("CLAWMEETS_SERVER_URL is not an http(s) URL")
    elif parts.scheme == "http" and host not in _LOCAL_HOSTS:
        problems.append(
            "CLAWMEETS_SERVER_URL must be https (providers only call https webhooks)"
        )
    elif parts.path or parts.query or parts.fragment:
        problems.append("CLAWMEETS_SERVER_URL must be an origin with no path")
    return url


def _split_keys(raw: str) -> list[str]:
    return [k.strip() for k in raw.split(",") if k.strip()]


def _check_secret_keys(raw: str, problems: list[str]) -> Optional[list[Fernet]]:
    keys = _split_keys(raw)
    if not keys:
        problems.append("CLAWMEETS_CHANNEL_SECRET_KEY is not set")
        return None
    fernets: list[Fernet] = []
    for index, key in enumerate(keys, start=1):
        try:
            fernets.append(Fernet(key))
        except (ValueError, TypeError):
            problems.append(
                f"CLAWMEETS_CHANNEL_SECRET_KEY key #{index} is not a valid Fernet key "
                "(32 url-safe base64 bytes; generate with Fernet.generate_key())"
            )
    if len(fernets) != len(keys):
        return None
    return fernets


def _check_email_domain(raw: str, problems: list[str]) -> str:
    domain = (raw.strip() or DEFAULT_INBOUND_EMAIL_DOMAIN).lower().rstrip(".")
    if not _HOSTNAME_RE.match(domain):
        problems.append(
            "CLAWMEETS_INBOUND_EMAIL_DOMAIN is not a bare hostname "
            "(e.g. agents.clawmeets.ai, no scheme or @)"
        )
    return domain


def load_channel_config(env: Optional[Mapping[str, str]] = None) -> Optional[ChannelConfig]:
    """Validate the channel env vars; return the config, or ``None`` to keep channels off.

    ``env`` defaults to ``os.environ`` (tests pass a dict). Never raises.
    """
    try:
        install_webhook_log_redaction()
        return _load(os.environ if env is None else env)
    except Exception as exc:  # noqa: BLE001 — the never-crash rule
        logger.error(
            "Channel gateway OFF: unexpected %s while checking the configuration",
            type(exc).__name__,
        )
        return None


def _load(env: Mapping[str, str]) -> Optional[ChannelConfig]:
    enabled = _parse_enabled(env.get("CLAWMEETS_CHANNELS_ENABLED", ""))
    if enabled is None:
        logger.error(
            "Channel gateway OFF: CLAWMEETS_CHANNELS_ENABLED is not a boolean "
            "(use true or false)"
        )
        return None
    if not enabled:
        logger.info("Channel gateway off (CLAWMEETS_CHANNELS_ENABLED is not true)")
        return None

    problems: list[str] = []
    server_url = _check_server_url(env.get("CLAWMEETS_SERVER_URL", ""), problems)
    fernets = _check_secret_keys(env.get("CLAWMEETS_CHANNEL_SECRET_KEY", ""), problems)
    domain = _check_email_domain(env.get("CLAWMEETS_INBOUND_EMAIL_DOMAIN", ""), problems)

    provider = env.get("CLAWMEETS_EMAIL_PROVIDER", "").strip().lower() or "sendgrid"
    inbound_secret = api_key = mailgun_key = mailgun_signing = ""
    mailgun_base = DEFAULT_MAILGUN_API_BASE
    if provider not in EMAIL_PROVIDERS:
        problems.append("CLAWMEETS_EMAIL_PROVIDER is not one of: " + ", ".join(EMAIL_PROVIDERS))
    elif provider == "sendgrid":
        inbound_secret = env.get("SENDGRID_INBOUND_SECRET", "").strip()
        if len(inbound_secret) < MIN_INBOUND_SECRET_LENGTH:
            problems.append(
                f"SENDGRID_INBOUND_SECRET is missing or shorter than "
                f"{MIN_INBOUND_SECRET_LENGTH} characters"
            )
        api_key = env.get("SENDGRID_API_KEY", "").strip()
        if not api_key.startswith("SG."):
            problems.append("SENDGRID_API_KEY is missing or not a SendGrid key (SG....)")
    else:
        mailgun_key = env.get("MAILGUN_AGENTS_API_KEY", "").strip()
        if not mailgun_key:
            problems.append("MAILGUN_AGENTS_API_KEY is not set")
        mailgun_signing = env.get("MAILGUN_WEBHOOK_SIGNING_KEY", "").strip()
        if len(mailgun_signing) < 16:
            problems.append("MAILGUN_WEBHOOK_SIGNING_KEY is missing or shorter than 16 characters")
        mailgun_base = (env.get("MAILGUN_API_BASE", "").strip() or DEFAULT_MAILGUN_API_BASE).rstrip("/")
        if not mailgun_base.startswith("https://"):
            problems.append("MAILGUN_API_BASE must be an https URL")

    if problems:
        logger.error(
            "Channel gateway OFF: CLAWMEETS_CHANNELS_ENABLED is true but the "
            "configuration is invalid — %s",
            "; ".join(problems),
        )
        return None

    assert fernets is not None
    config = ChannelConfig(
        server_url=server_url,
        inbound_email_domain=domain,
        fernet=MultiFernet(fernets),
        key_count=len(fernets),
        secret_keys=tuple(_split_keys(env.get("CLAWMEETS_CHANNEL_SECRET_KEY", ""))),
        sendgrid_inbound_secret=inbound_secret,
        sendgrid_api_key=api_key,
        email_provider=provider,
        mailgun_agents_api_key=mailgun_key,
        mailgun_webhook_signing_key=mailgun_signing,
        mailgun_api_base=mailgun_base,
    )
    logger.info(
        "Channel gateway ON: webhooks under %s%s/, inbound email @%s via %s, %d secret key(s)",
        server_url,
        WEBHOOK_PATH_PREFIX,
        domain,
        provider,
        config.key_count,
    )
    return config


# ── the hub ───────────────────────────────────────────────────────────────

# The curve Ed25519 lives on, for the "is this a public key at all" check.
_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P


def _is_curve_point(raw: bytes) -> bool:
    """True if ``raw`` (32 bytes) decodes to a point on Ed25519 (RFC 8032
    5.1.3): y < p, and (y^2 - 1) / (d*y^2 + 1) is a square mod p. The default
    hub's placeholder pin fails this by construction; so does random junk,
    about half the time, which is why a key is also checked for length."""
    y = int.from_bytes(raw, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    if y >= _P:
        return False
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P) % _P
    if x2 == 0:
        return sign == 0
    return pow(x2, (_P - 1) // 2, _P) == 1


def _parse_hub_mode(raw: str) -> Optional[HubMode]:
    value = raw.strip().lower().replace("-", "_")
    if value == "":
        return "auto"
    return value if value in HUB_MODES else None  # type: ignore[return-value]


def _parse_hub_enroll(raw: str) -> Optional[HubEnroll]:
    value = raw.strip().lower()
    if value == "":
        return "auto"
    return value if value in HUB_ENROLLS else None  # type: ignore[return-value]


def secret_key_path(data_dir: Path) -> Path:
    return Path(data_dir).joinpath(*SECRET_KEY_FILE)


def resolve_secret_keys(env: Mapping[str, str], data_dir: Optional[Path], *, create: bool) -> str:
    """The secret key text for the hub: ``CLAWMEETS_CHANNEL_SECRET_KEY`` when
    set, else the key file under ``data_dir`` — generated (0600, never
    overwritten) when ``create`` and missing. "" when there is none.

    When the variable is set and the key file exists too, the file's key is
    appended LAST: it no longer encrypts, but what it encrypted (the hub
    identity of a server that registered in ``auto`` before the variable was
    set) still decrypts. Without it the hub would turn itself off."""
    raw = env.get("CLAWMEETS_CHANNEL_SECRET_KEY", "")
    if data_dir is None:
        return raw
    path = secret_key_path(data_dir)
    if raw.strip():
        old = _read_key_file(path)
        if not old or old in _split_keys(raw):
            return raw
        return f"{raw},{old}"
    if not path.exists() and create:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass                                    # another process made it first: read theirs
        else:
            with os.fdopen(fd, "wb") as fh:
                fh.write(Fernet.generate_key())
            logger.info("Hub: generated a secret key at %s", path)
    return _read_key_file(path)


def _read_key_file(path: Path) -> str:
    try:
        return path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeDecodeError):
        return ""


def _with_key(env: Mapping[str, str], data_dir: Optional[Path], *, create: bool) -> Mapping[str, str]:
    """``env`` with CLAWMEETS_CHANNEL_SECRET_KEY filled from the key file in
    mode ``auto``. Explicit modes keep needing the variable, but an existing
    key file is still appended to it as a decrypt-only key (a server that
    registered in ``auto`` and then moved to ``full``)."""
    mode = _parse_hub_mode(env.get("CLAWMEETS_HUB_MODE", ""))
    if mode in (None, "off") or data_dir is None:
        return env
    if mode != "auto" and not env.get("CLAWMEETS_CHANNEL_SECRET_KEY", "").strip():
        return env
    raw = resolve_secret_keys(env, data_dir, create=create and mode == "auto")
    return {**env, "CLAWMEETS_CHANNEL_SECRET_KEY": raw} if raw else env


def _check_hub_pubkeys(raw: str, problems: list[str]) -> dict[str, TrustedKey]:
    keys: dict[str, TrustedKey] = {}
    for index, item in enumerate((k.strip() for k in raw.split(",") if k.strip()), start=1):
        kid, sep, pub = item.partition(":")
        kid, pub = kid.strip(), pub.strip()
        if not sep or not _KID_RE.fullmatch(kid):
            problems.append(
                f"CLAWMEETS_HUB_PUBKEY entry #{index} is not <kid>:<base64url key> "
                "(kid: letters, digits, - and _)"
            )
            continue
        try:
            raw_key = b64url_decode(pub, length=32)
        except ValueError:
            problems.append(
                f"CLAWMEETS_HUB_PUBKEY entry #{index} is not a 32-byte unpadded base64url key"
            )
            continue
        if not _is_curve_point(raw_key):
            problems.append(f"CLAWMEETS_HUB_PUBKEY entry #{index} is not an Ed25519 public key")
            continue
        if kid in keys:
            problems.append(f"CLAWMEETS_HUB_PUBKEY entry #{index} repeats a kid")
            continue
        keys[kid] = TrustedKey(pub=raw_key, not_before=0, not_after=MAX_SAFE_INT)
    return keys


def _placeholder_host(hub_url: str) -> bool:
    """Whether ``hub_url`` is on the host of a hub with only a placeholder
    pinned, under any path or port: an operator key for
    ``https://hub.clawmeets.ai/api`` must not reach the default hub's host
    either."""
    if not hub_url:
        return False
    if pins_are_placeholder(hub_url):
        return True
    host = urlsplit(hub_url).hostname
    return any(urlsplit(url).hostname == host and pins_are_placeholder(url) for url in PINNED_HUB_KEYS)


def _check_hub(env: Mapping[str, str], *, require_key: bool) -> tuple[HubConfig, list[str]]:
    """Every hub rule; returns the config as far as it could be read, and the
    problems. Never raises; never logs."""
    problems: list[str] = []
    warnings: list[str] = []
    mode = _parse_hub_mode(env.get("CLAWMEETS_HUB_MODE", ""))
    if mode is None:
        problems.append("CLAWMEETS_HUB_MODE is not one of auto, off, discover_only, full")
    enroll = _parse_hub_enroll(env.get("CLAWMEETS_HUB_ENROLL", ""))
    if enroll is None:
        problems.append("CLAWMEETS_HUB_ENROLL is not one of auto, operator")

    raw_url = env.get("CLAWMEETS_HUB_URL", "").strip()
    hub_url = ""
    try:
        hub_url = canonical_hub_url(raw_url or DEFAULT_HUB_URL)
    except HubUrlError as exc:
        problems.append(f"CLAWMEETS_HUB_URL is not a usable hub URL ({_url_reason(exc)})")
    is_default = hub_url == DEFAULT_HUB_URL

    raw_pubkey = env.get("CLAWMEETS_HUB_PUBKEY", "")
    configured: dict[str, TrustedKey] = {}
    if is_default:
        if raw_pubkey.strip():
            warnings.append(
                "CLAWMEETS_HUB_PUBKEY is ignored for the default hub (its keys are pinned)"
            )
    elif hub_url:
        configured = _check_hub_pubkeys(raw_pubkey, problems)
        if not configured and not raw_pubkey.strip():
            problems.append("CLAWMEETS_HUB_PUBKEY is not set (required for a hub other than the default)")

    fernets: Optional[list[Fernet]] = None
    raw_keys = env.get("CLAWMEETS_CHANNEL_SECRET_KEY", "")
    if require_key or (mode not in (None, "off")) or raw_keys.strip():
        fernets = _check_secret_keys(raw_keys, problems)

    refusal: Optional[HubRefusal] = "placeholder_pin" if _placeholder_host(hub_url) else None
    config = HubConfig(
        mode=mode or "off", enroll=enroll or "auto", hub_url=hub_url, is_default=is_default,
        configured_keys=configured, fernet=MultiFernet(fernets) if fernets else None,
        key_count=len(fernets or ()), secret_keys=tuple(_split_keys(raw_keys)) if fernets else (),
        refusal=refusal,
        problems=tuple(problems), warnings=tuple(warnings),
    )
    return config, problems


def _url_reason(exc: HubUrlError) -> str:
    """The reason without the URL: ``canonical_hub_url`` may quote what it was given."""
    text = str(exc)
    return text.split(":", 1)[0] if ":" in text else text


def validate_hub_only(
    env: Optional[Mapping[str, str]] = None, *, require_key: bool = False,
    data_dir: Optional[Path] = None,
) -> HubConfig:
    """The strict check of the hub settings alone: the mode, the hub URL,
    the operator's hub keys, and the secret key whenever the mode is not
    ``off`` (or ``require_key``). Never needs SendGrid, ``CLAWMEETS_SERVER_URL``
    or ``CLAWMEETS_CHANNELS_ENABLED``. Raises :class:`HubConfigError` listing
    EVERY problem; messages name variables, never values. Warnings (an
    ignored ``CLAWMEETS_HUB_PUBKEY``) are logged once each. In mode ``auto``
    with ``data_dir``, the key file stands in for an unset variable (never
    created here).

    A placeholder-pinned hub URL is NOT an error: the config is valid, and
    ``refusal`` says this server must never connect to it."""
    env = os.environ if env is None else env
    config, problems = _check_hub(_with_key(env, data_dir, create=False), require_key=require_key)
    if problems:
        raise HubConfigError(problems)
    for warning in config.warnings:
        logger.warning("Hub: %s", warning)
    return config


def inspect_hub_config(env: Optional[Mapping[str, str]] = None) -> HubConfig:
    """What ``validate_hub_only`` sees, without raising or logging: the
    config as far as it reads, with ``problems`` listing what it would refuse.
    For ``hub status``, which must work whatever the settings hold."""
    config, _ = _check_hub(os.environ if env is None else env, require_key=False)
    return config


def hub_config_for_boot(
    env: Optional[Mapping[str, str]] = None, *, data_dir: Optional[Path] = None,
) -> HubConfig:
    """The hub settings at server boot.

    ``CLAWMEETS_HUB_MODE`` unset, empty or ``off``: nothing else is checked
    and boot is never affected; the result is mode ``off``, carrying the
    secret key only if it parses (the sweep-only gateway needs it).

    ``auto`` (also unset or empty): the key file under ``data_dir`` stands in
    for an unset secret key and is generated if missing; a problem is logged
    and makes the hub unusable (refusal ``config_invalid``), never stops boot.

    ``discover_only`` / ``full``: ``validate_hub_only`` — and its
    :class:`HubConfigError` propagates, so the server refuses to start with a
    message naming every setting at fault. An unrecognised mode is refused the
    same way."""
    env = os.environ if env is None else env
    set_keys = _split_keys(env.get("CLAWMEETS_CHANNEL_SECRET_KEY", ""))
    if set_keys and data_dir is not None and _read_key_file(secret_key_path(data_dir)) not in ("", *set_keys) \
            and _parse_hub_mode(env.get("CLAWMEETS_HUB_MODE", "")) not in (None, "off"):
        logger.info("Hub: CLAWMEETS_CHANNEL_SECRET_KEY is set, and the key file %s still decrypts what it "
                    "encrypted. To retire the file, add its key after yours in the variable, then delete it.",
                    secret_key_path(data_dir))
    if _parse_hub_mode(env.get("CLAWMEETS_HUB_MODE", "")) == "auto":
        config, problems = _check_hub(_with_key(env, data_dir, create=True), require_key=True)
        for warning in config.warnings:
            logger.warning("Hub: %s", warning)
        if problems:
            logger.warning("Hub (mode auto) unusable until fixed: %s", "; ".join(problems))
            return replace(config, refusal="config_invalid")
        logger.info("Hub mode auto (connects on demand), hub %s%s", config.hub_url,
                    " (the default hub)" if config.is_default else "")
        if config.refusal is not None:
            logger.info("Hub: %s has only a placeholder key pinned; hub features stay "
                        "unavailable until a release pins its real key", config.hub_url)
        return config
    if _parse_hub_mode(env.get("CLAWMEETS_HUB_MODE", "")) == "off":
        raw_keys = env.get("CLAWMEETS_CHANNEL_SECRET_KEY", "")
        fernets = _check_secret_keys(raw_keys, [])
        return HubConfig(
            fernet=MultiFernet(fernets) if fernets else None, key_count=len(fernets or ()),
            secret_keys=tuple(_split_keys(raw_keys)) if fernets else (),
        )
    try:
        config = validate_hub_only(env, data_dir=data_dir)
    except HubConfigError as exc:
        logger.error("Hub configuration invalid, refusing to start: %s", exc)
        raise
    logger.info(
        "Hub mode %s, hub %s%s", config.mode, config.hub_url,
        " (the default hub)" if config.is_default else "",
    )
    if config.refusal is not None:
        logger.warning(
            "Hub: %s has only a placeholder key pinned; this server will never "
            "connect to it (status hub_untrusted) until a release pins its real key",
            config.hub_url,
        )
    return config


def hub_only_server_url(env: Optional[Mapping[str, str]] = None) -> str:
    """``CLAWMEETS_SERVER_URL`` for a hub-only gateway's file links, or "":
    unset, or not an origin a contact could download from (logged once,
    naming the variable). Never raises: a hub-only gateway boots without it,
    and its hub threads' files then go out by name with no link."""
    raw = (os.environ if env is None else env).get("CLAWMEETS_SERVER_URL", "")
    if not raw.strip():
        return ""
    problems: list[str] = []
    url = _check_server_url(raw, problems)
    if problems:
        logger.warning("Hub: %s; files on hub threads are sent by name, without a link", problems[0])
        return ""
    return url
