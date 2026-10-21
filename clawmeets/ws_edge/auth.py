# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/ws_edge/auth.py

The two credentials a socket can be checked against WITHOUT core: a user's
access JWT (``/ws/user/{id}``) and a terminal ticket (``/ws/terminal/{id}``).
Both are signed with the deployment's ``CLAWMEETS_JWT_SECRET``, so the edge
needs nothing but that secret. Agent and computer tokens are hashed in files
only core reads; those sockets are checked by asking core (``auth_req``).

Core mints terminal tickets with :func:`mint_terminal_ticket` (the ticket
route), and whichever process holds the terminal socket — the edge, or core in
in-process mode — spends them through ``TerminalRelay.redeem_ticket``, which keeps the
spent set. A ticket is
a JWT so that it survives a core restart between the click and the socket.
"""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from typing import Optional

import jwt

JWT_ALGORITHM = "HS256"
TICKET_TTL_SECONDS = 60
_TICKET_TYPE = "terminal"


@dataclass
class TicketGrant:
    user_id: str
    host_id: str
    cols: int
    rows: int
    expires_at: float  # unix time
    jti: str


def user_jwt_check(token: object, user_id: str, secret: str) -> Optional[str]:
    """None when ``token`` is a valid access token for ``user_id``; otherwise
    the close reason the in-process endpoint gives for the same failure."""
    if not isinstance(token, str):
        token = ""
    try:
        payload = jwt.decode(token, secret, algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError as e:
        return f"Invalid token: {e}"
    if payload.get("type") != "access":
        return "Invalid token type"
    if payload.get("user_id") != user_id:
        return "User ID mismatch"
    return None


def mint_terminal_ticket(
    secret: str, user_id: str, host_id: str, cols: int, rows: int,
) -> str:
    """A 60-second ticket for one terminal socket on ``host_id``."""
    now = int(time.time())
    return jwt.encode(
        {
            "type": _TICKET_TYPE,
            "user_id": user_id,
            "host_id": host_id,
            "cols": cols,
            "rows": rows,
            "iat": now,
            "exp": now + TICKET_TTL_SECONDS,
            "jti": secrets.token_urlsafe(16),
        },
        secret,
        algorithm=JWT_ALGORITHM,
    )


def decode_terminal_ticket(ticket: object, secret: str) -> Optional[TicketGrant]:
    """The grant ``ticket`` carries, if it is a valid unexpired ticket — for
    whichever computer it names. Does NOT enforce single use: the caller keeps
    the spent ``jti`` set (``TerminalRelay.redeem_ticket``)."""
    if not isinstance(ticket, str) or not ticket:
        return None
    try:
        payload = jwt.decode(ticket, secret, algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError:
        return None
    if payload.get("type") != _TICKET_TYPE:
        return None
    try:
        return TicketGrant(
            user_id=str(payload["user_id"]),
            host_id=str(payload["host_id"]),
            cols=int(payload["cols"]),
            rows=int(payload["rows"]),
            expires_at=float(payload["exp"]),
            jti=str(payload["jti"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def ticket_is_for(grant: TicketGrant, host_id: str) -> bool:
    return secrets.compare_digest(grant.host_id, host_id)
