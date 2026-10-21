# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/hub/http.py
The hub's HTTP routes the operator CLI calls, and nothing else: the key set,
register, verify-email and the sessionless revoke. Synchronous (the CLI has
no event loop).

Every answer is read as untrusted: redirects are never followed, TLS is
verified, a body larger than one JSON frame (``MAX_JSON_FRAME_BYTES``) is
refused before it is parsed, and parsing is ``loads_strict``. Signatures in
the body are the caller's job (``trust.py``).

- A 4xx whose body is the hub's ``HttpError`` -> :class:`HubRefused` (the
  hub's code, its message with invisible characters stripped, retry_after).
- A network error, timeout, TLS failure, 3xx, 5xx, any other 4xx, or a body
  that is oversized, not JSON or not an object -> :class:`HubUnreachable`,
  carrying only a short reason (never the URL, never the body).
"""
from __future__ import annotations

from typing import Any, Mapping, Optional

import httpx
from pydantic import ValidationError

from clawmeets.hub_protocol.canonical import CanonicalError, loads_strict
from clawmeets.hub_protocol.constants import MAX_JSON_FRAME_BYTES
from clawmeets.hub_protocol.http import HttpError
from clawmeets.hub_protocol.text import strip_invisible

KEY_SET_PATH = "/.well-known/clawmeets-hub-keys.json"
REGISTER_PATH = "/v1/deployments"


class HubUnreachable(Exception):
    """The hub did not give a usable answer. ``reason`` is a short code."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


class HubRefused(Exception):
    """The hub answered with its own error."""

    def __init__(self, code: str, message: str = "", retry_after: Optional[int] = None) -> None:
        self.code = code
        self.message = message
        self.retry_after = retry_after
        super().__init__(code)


class HubHttp:
    """One hub, by its canonical URL. ``transport`` replaces the network (tests)."""

    def __init__(
        self, hub_url: str, *, transport: Optional[httpx.BaseTransport] = None, timeout: float = 10.0,
    ) -> None:
        self._client = httpx.Client(
            base_url=hub_url, transport=transport, timeout=timeout,
            follow_redirects=False, verify=True,
            headers={"accept": "application/json"},
        )

    def __enter__(self) -> "HubHttp":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def key_set(self) -> dict:
        return self._call("GET", KEY_SET_PATH)

    def register(self, body: Mapping[str, Any]) -> dict:
        return self._call("POST", REGISTER_PATH, body)

    def verify_email(self, deployment_id: str, body: Mapping[str, Any]) -> dict:
        return self._call("POST", f"{REGISTER_PATH}/{deployment_id}/verify-email", body)

    def revoke(self, deployment_id: str, body: Mapping[str, Any]) -> dict:
        """The sessionless revoke: the same signed body as the socket's revoke frame."""
        return self._call("POST", f"{REGISTER_PATH}/{deployment_id}/revoke", body)

    def owner_start(self, deployment_id: str, body: Mapping[str, Any]) -> dict:
        """OwnerVerifyStart: the hub mails the owner a code."""
        return self._call("POST", f"{REGISTER_PATH}/{deployment_id}/owners", body)

    def owner_verify(self, deployment_id: str, owner_ref: str, body: Mapping[str, Any]) -> dict:
        """OwnerVerifyConfirm: the code the owner typed."""
        return self._call("POST", f"{REGISTER_PATH}/{deployment_id}/owners/{owner_ref}/verify", body)

    def _call(self, method: str, path: str, body: Optional[Mapping[str, Any]] = None) -> dict:
        try:
            with self._client.stream(method, path, json=body) as response:
                raw = b""
                for chunk in response.iter_bytes():
                    raw += chunk
                    if len(raw) > MAX_JSON_FRAME_BYTES:
                        raise HubUnreachable("oversized_body")
                status = response.status_code
        except httpx.HTTPError as exc:
            raise HubUnreachable(_network_reason(exc)) from None
        if 300 <= status < 400:
            raise HubUnreachable("redirect")
        if status >= 500:
            raise HubUnreachable(f"http_{status}")
        try:
            data = loads_strict(raw)
        except CanonicalError:
            data = None
        if 400 <= status < 500:
            raise _refusal(data, status)
        if status != 200 or not isinstance(data, dict):
            raise HubUnreachable("bad_body" if status == 200 else f"http_{status}")
        return data


def _refusal(data: Any, status: int) -> Exception:
    try:
        detail = HttpError.model_validate(data).detail
    except ValidationError:
        return HubUnreachable(f"http_{status}")
    return HubRefused(detail.code, strip_invisible(detail.message or "").strip(), detail.retry_after)


def _network_reason(exc: httpx.HTTPError) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, httpx.ConnectError):
        return "connect_error"
    return type(exc).__name__
