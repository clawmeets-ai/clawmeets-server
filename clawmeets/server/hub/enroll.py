# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/enroll.py
The browser-driven twin of ``clawmeets server hub register | verify``, plus
the per-owner email check (``/me/channels/hub/enrollment``).

**Two things get enrolled, with one code where possible.**

- *This server.* In mode ``auto`` with ``CLAWMEETS_HUB_ENROLL=auto``, the
  first user who turns an agent on (or searches the hub) registers it: the
  name is the host of a public https ``CLAWMEETS_SERVER_URL`` (the hub checks
  the deployment document there), else ``{username}-{4 random}``; the contact
  address is that user's verified ClawMeets email, so they get the hub's
  revoke and reclaim mail. The request carries their ``owner_ref``, so the
  one code the hub mails activates the deployment AND verifies them as an
  owner. With ``CLAWMEETS_HUB_ENROLL=operator`` only the CLI registers.
- *Each owner.* The hub lists an agent only once its owner has proved an
  email address to the hub, once per server: ``OwnerVerifyStart`` (the hub
  mails a code) and ``OwnerVerifyConfirm``. A server that is already
  registered goes straight to this step.

**One enrollment at a time.** Starts and confirms are serialized by one lock.
While the server's own registration waits for its code, a different user
starting gets ``enroll_busy``, unless the wait is older than the code's
lifetime, in which case they take it over (the hub replaces the pending
contact address and mails them).

**Threads.** HTTP runs in a worker thread; every ``channels.db`` read and
write stays on the event loop (the store's connection belongs to it).
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import logging
import re
import secrets
from typing import TYPE_CHECKING, Any, Callable, Optional
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken
from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import sign_object, to_wire
from clawmeets.hub_protocol.constants import TOS_URL, TOS_VERSION
from clawmeets.hub_protocol.http import (
    OwnerVerifyConfirm,
    OwnerVerifyResponse,
    OwnerVerifyStart,
    VerifyEmailRequest,
)
from clawmeets.hub_protocol.ids import DEPLOYMENT_NAME_PATTERN

from . import operator
from .browser import HubEnrollment, HubError
from .http import HubHttp, HubRefused, HubUnreachable
from .identity import load_identity
from .trust import HubUntrusted, accept_pushed_key_set, seed_trust

if TYPE_CHECKING:
    from clawmeets.models.user import User

    from .runtime import HubRuntime

logger = logging.getLogger(__name__)

#: The hub's code lifetime (clawmeets_hub.http_api.CODE_TTL_S): a pending
#: registration older than this may be taken over by another user.
CODE_TTL_S = 1800
#: Names to try when the hub refuses one (conflict, reserved word).
NAME_ATTEMPTS = 3
_NAME_RE = re.compile(DEPLOYMENT_NAME_PATTERN)
_B32 = "abcdefghijklmnopqrstuvwxyz234567"
_PRIVATE_SUFFIXES = (".local", ".internal", ".lan", ".localhost", ".home", ".corp", ".intranet")
#: Hub refusals that a different name can get past.
_NAME_REFUSALS = {"name_conflict", "invalid_name", "name_reserved", "name_requires_verified_url"}


def mask_email(email: Optional[str]) -> Optional[str]:
    """``alice@corp.com`` -> ``a***@corp.com``."""
    if not email or "@" not in email:
        return None
    local, _, domain = email.rpartition("@")
    return f"{local[:1]}***@{domain}"


def _email_hash(email: str) -> str:
    # The same hash operator.py stores as the registration's contact_email_hash.
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def public_server_url(server_url: str) -> Optional[str]:
    """``server_url`` when it is a public https origin the hub can fetch the
    deployment document from (host root, no path), else None."""
    parts = urlsplit(server_url or "")
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or "." not in host or parts.path not in ("", "/") or parts.query:
        return None
    if host.endswith(_PRIVATE_SUFFIXES):
        return None
    try:
        ipaddress.ip_address(host)
        return None                                   # an IP is never a deployment name
    except ValueError:
        pass
    if not _NAME_RE.fullmatch(host):
        return None
    return f"https://{host}" + (f":{parts.port}" if parts.port else "")


def private_name(username: str) -> str:
    """``{username}-{4 base32}``, folded into the hub's name alphabet."""
    base = re.sub(r"[^a-z0-9-]+", "-", username.lower()).strip("-")[:40] or "server"
    return f"{base}-{''.join(secrets.choice(_B32) for _ in range(4))}"


class HubEnrollmentService:
    def __init__(self, runtime: "HubRuntime") -> None:
        self.runtime = runtime
        self._lock = asyncio.Lock()

    # ── reads ────────────────────────────────────────────────────────────

    @property
    def _config(self):
        return self.runtime.config

    def _server_state(self) -> str:
        if not self._config.enabled:
            return "off"
        reg = self.runtime.registration()
        status = reg.status if reg is not None else "none"
        if status == "active":
            return "active"
        # Only mode auto lets members register the server; full and
        # discover_only are operator-configured, so the CLI registers them.
        # Checked before pending: a member's resend of the operator's pending
        # registration would make the member the hub contact.
        if (status in ("suspended", "held_for_reclaim") or self._config.enroll == "operator"
                or not self._config.lazy):
            return "operator_only"
        if status == "pending_email":
            return "pending"
        return "none"

    def owner_verified(self, user_id: str) -> bool:
        owner = self.runtime.hub.owner(self._config.hub_url, user_id)
        return owner is not None and owner.status == "verified"

    def view(self, user: "User") -> HubEnrollment:
        server = self._server_state()
        owner = self.runtime.hub.owner(self._config.hub_url, user.id) if self._config.hub_url else None
        reg = self.runtime.registration()
        email = user.email or ""
        contact_is_you = bool(email and reg is not None and reg.status != "none"
                              and reg.contact_email_hash == _email_hash(email))
        state = "none"
        if owner is not None:
            state = "verified" if owner.status == "verified" else "code_sent" if owner.status == "code_sent" else "none"
        expires = (owner.code_sent_at + CODE_TTL_S
                   if owner is not None and state == "code_sent" and owner.code_sent_at else None)
        return HubEnrollment(
            server=server, owner=state, email_masked=mask_email(email), becomes_contact=server == "none",
            contact_is_you=contact_is_you, tos_version=TOS_VERSION, tos_url=TOS_URL, code_expires_at=expires,
        )

    # ── start: accept the terms, send a code ─────────────────────────────

    async def start(self, user: "User", accept_tos_version: str) -> HubEnrollment:
        self._check_usable()
        if accept_tos_version != TOS_VERSION:
            raise HubError("tos_outdated", f"accept the current hub terms (version {TOS_VERSION})")
        if not user.email or not user.email_verified:
            raise HubError("enroll_email_unverified", "verify your ClawMeets email address first")
        async with self._lock:
            if self.owner_verified(user.id):
                return self.view(user)
            state = self._server_state()
            if state == "operator_only":
                raise HubError("enroll_operator_only", "only this server's operator can connect it to the hub")
            if state == "active":
                await self._owner_start(user)
            else:
                reg = self.runtime.registration()
                if (state == "pending" and reg is not None
                        and reg.contact_email_hash != _email_hash(user.email)
                        and self._now() - reg.updated_at < CODE_TTL_S):
                    raise HubError("enroll_busy", "another member is finishing this server's hub setup; "
                                                  "try again in a minute")
                await self._register(user)
        return self.view(user)

    async def _register(self, user: "User") -> None:
        config, hub = self._config, self.runtime.hub
        await self._refresh_trust()
        reg = self.runtime.registration()
        public_url = public_server_url(getattr(self.runtime.gateway.config, "server_url", "") or "")
        names: list[tuple[str, Optional[str]]] = []
        # The saved name goes first, whatever the status: the hub may hold this
        # key under it (a lost answer), and a same-name, same-key retry is the
        # only request it accepts then (it resends the code).
        saved = reg is not None and reg.status in ("none", "pending_email") and bool(reg.name)
        if saved:
            names.append((reg.name, reg.public_url))
        if public_url and (urlsplit(public_url).hostname or "") != (reg.name if saved else None):
            names.append((urlsplit(public_url).hostname or "", public_url))
        names += [(private_name(user.username), None) for _ in range(NAME_ATTEMPTS)]
        last: Optional[HubRefused] = None
        for index, (name, url) in enumerate(names):
            now = self._now()
            try:
                pending, key, body = operator.prepare_first_register(
                    self.runtime.gateway.store, hub, config, self.runtime.registration(), name=name, label=name,
                    email=user.email or "", public_url=url, now=now, owner_user_id=user.id)
            except operator.OperatorError as exc:
                raise HubError("enroll_refused", exc.message) from None
            try:
                raw = await self._http(lambda http: http.register(body))
            except HubRefused as exc:
                # A refused pending name is final: the hub answered it before,
                # so a new name under the same key cannot fare better. A saved
                # name still ``none`` was never accepted, so other names may be.
                if exc.code in _NAME_REFUSALS and not (index == 0 and saved and reg.status == "pending_email"):
                    last = exc
                    continue
                raise self._refused(exc) from None
            try:
                operator.finish_first_register(hub, config, pending, key, raw, now=now)
            except operator.OperatorError as exc:
                raise HubError("hub_unreachable" if exc.code == "hub_unreachable" else "hub_untrusted",
                               exc.message) from None
            hub.owner_code_sent(config.hub_url, user.id, hub.owner_ref(config.hub_url, config.fernet, user.id),
                                email_hash=_email_hash(user.email or ""), via_registration=True, now=now)
            logger.info("Hub: registration started from the browser as %s (status %s)", name,
                        self.runtime.registration().status if self.runtime.registration() else "?")
            return
        raise self._refused(last) if last is not None else HubError("enroll_refused", "the hub refused every name")

    async def _owner_start(self, user: "User") -> None:
        config, hub = self._config, self.runtime.hub
        reg, key = self._identity()
        owner_ref = hub.owner_ref(config.hub_url, config.fernet, user.id)
        now = self._now()
        request = OwnerVerifyStart(aud=config.hub_url, deployment_id=reg.deployment_id, owner_ref=owner_ref,
                                   email=user.email, tos_version=TOS_VERSION, ts=int(now))
        body = sign_object(to_wire(request), key, purpose=OwnerVerifyStart.SIGNING_PURPOSE)
        try:
            raw = await self._http(lambda http: http.owner_start(reg.deployment_id, body))
            answer = OwnerVerifyResponse.model_validate(raw)
        except HubRefused as exc:
            raise self._refused(exc) from None
        except ValidationError:
            raise HubError("hub_unreachable", "the hub's answer did not fit its schema") from None
        hub.owner_code_sent(config.hub_url, user.id, owner_ref, email_hash=_email_hash(user.email or ""),
                            via_registration=False, now=now)
        if answer.status == "verified":
            hub.set_owner_status(config.hub_url, user.id, "verified", now=now)

    # ── confirm: the code ────────────────────────────────────────────────

    async def confirm(self, user: "User", code: str) -> HubEnrollment:
        self._check_usable()
        async with self._lock:
            config, hub = self._config, self.runtime.hub
            owner = hub.owner(config.hub_url, user.id)
            if owner is not None and owner.status == "verified":
                return self.view(user)
            if owner is None or owner.status != "code_sent":
                raise HubError("enroll_code_expired", "no code is waiting; send a new one")
            reg = self.runtime.registration()
            if owner.via_registration and reg is not None and reg.status == "pending_email":
                await self._confirm_registration(code)
            elif reg is not None and reg.status == "active":
                await self._owner_confirm(user, owner.owner_ref, code)
            else:
                raise HubError("enroll_code_expired", "that code is no longer waiting; send a new one")
        self.runtime.demand.touch(self._now())
        await self.runtime.reconcile()
        return self.view(user)

    async def _confirm_registration(self, code: str) -> None:
        config, hub = self._config, self.runtime.hub
        reg = self.runtime.registration()
        assert reg is not None and reg.deployment_id is not None
        key = self._load_key(reg)
        now = self._now()
        try:
            request = VerifyEmailRequest(aud=config.hub_url, deployment_id=reg.deployment_id, code=code, ts=int(now))
        except ValidationError:
            raise HubError("enroll_code_invalid", "that code is not right") from None
        body = sign_object(to_wire(request), key, purpose=VerifyEmailRequest.SIGNING_PURPOSE)
        try:
            raw = await self._http(lambda http: http.verify_email(reg.deployment_id, body))
        except HubRefused as exc:
            raise self._refused(exc) from None
        # The hub's answer is checked and saved on the loop (operator.submit_code
        # with a client that replays the answer: no second request).
        try:
            operator.submit_code(hub, config, _Answered(raw), reg, key, request, now=now)
        except (HubUntrusted, ValidationError, HubUnreachable) as exc:
            raise HubError("hub_untrusted" if isinstance(exc, HubUntrusted) else "hub_unreachable",
                           "the hub's answer did not check out") from None
        logger.info("Hub: registration active (confirmed from the browser)")

    async def _owner_confirm(self, user: "User", owner_ref: str, code: str) -> None:
        config, hub = self._config, self.runtime.hub
        reg, key = self._identity()
        now = self._now()
        try:
            request = OwnerVerifyConfirm(aud=config.hub_url, deployment_id=reg.deployment_id, owner_ref=owner_ref,
                                         code=code, ts=int(now))
        except ValidationError:
            raise HubError("enroll_code_invalid", "that code is not right") from None
        body = sign_object(to_wire(request), key, purpose=OwnerVerifyConfirm.SIGNING_PURPOSE)
        try:
            raw = await self._http(lambda http: http.owner_verify(reg.deployment_id, owner_ref, body))
            answer = OwnerVerifyResponse.model_validate(raw)
        except HubRefused as exc:
            raise self._refused(exc) from None
        except ValidationError:
            raise HubError("hub_unreachable", "the hub's answer did not fit its schema") from None
        if answer.status != "verified" or answer.owner_ref != owner_ref:
            raise HubError("hub_unreachable", "the hub did not confirm the code")
        hub.set_owner_status(config.hub_url, user.id, "verified", now=now)

    # ── helpers ──────────────────────────────────────────────────────────

    def _now(self) -> float:
        return self.runtime._now()

    def _check_usable(self) -> None:
        config = self._config
        if not config.enabled:
            raise HubError("hub_off_on_server", "the hub is off on this server")
        if config.refusal is not None or self.runtime.untrusted_reason is not None or config.fernet is None:
            raise HubError("hub_untrusted", "the ClawMeets Hub isn't available on this server yet")

    def _load_key(self, reg) -> Any:
        try:
            return load_identity(self.runtime.gateway.store, reg.identity_connection_id or "", self._config.fernet)
        except (KeyError, InvalidToken):
            raise HubError("enroll_operator_only", "this server's hub identity key cannot be loaded; "
                                                   "ask the operator") from None

    def _identity(self):
        reg = self.runtime.registration()
        if reg is None or reg.status != "active" or reg.deployment_id is None:
            raise HubError("hub_not_registered", "this server is not registered with the hub")
        return reg, self._load_key(reg)

    async def _refresh_trust(self) -> None:
        config, hub = self._config, self.runtime.hub
        try:
            seed_trust(hub, config, now=self._now())
            key_set = await self._http(lambda http: http.key_set())
            accept_pushed_key_set(hub, config, key_set, now=self._now())
        except HubUntrusted:
            raise HubError("hub_untrusted", "the hub's keys do not check out") from None
        except HubRefused as exc:
            raise self._refused(exc) from None

    async def _http(self, call: Callable[[HubHttp], dict]) -> dict:
        transport = self.runtime.options.http_transport

        def _run() -> dict:
            with HubHttp(self._config.hub_url, transport=transport) as http:
                return call(http)

        try:
            return await asyncio.to_thread(_run)
        except HubUnreachable as exc:
            raise HubError("hub_unreachable", f"the hub cannot be reached ({exc.reason})") from None

    @staticmethod
    def _refused(exc: HubRefused) -> HubError:
        code = exc.code
        if code == "bad_code":
            return HubError("enroll_code_invalid", "that code is not right")
        if code == "expired":
            return HubError("enroll_code_expired", "that code expired; send a new one")
        if code == "rate_limited":
            return HubError("rate_limited", exc.message or "too many tries", retry_after=int(exc.retry_after or 60))
        if code in ("owner_banned", "tos_outdated"):
            return HubError(code, exc.message or code)
        if code in ("registration_closed", "deployment_suspended", "name_held_for_reclaim", "key_revoked"):
            return HubError("enroll_operator_only", exc.message or code)
        return HubError("enroll_refused", exc.message or code)


class _Answered:
    """A HubHttp stand-in that hands back an answer already fetched (so
    ``operator.submit_code`` checks and saves it on the loop)."""

    def __init__(self, raw: dict) -> None:
        self._raw = raw

    def verify_email(self, _deployment_id: str, _body: Any) -> dict:
        return self._raw

