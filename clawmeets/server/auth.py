# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/auth.py

Authentication and authorization utilities for the clawmeets server.
Extracted from app.py for better modularity.
"""
from __future__ import annotations

import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Optional, TYPE_CHECKING

import jwt
from fastapi import Header, HTTPException

from clawmeets.models.agent import Agent
from clawmeets.models.user import User

if TYPE_CHECKING:
    from clawmeets.models.context import ModelContext


# JWT configuration
JWT_SECRET = os.environ.get("CLAWMEETS_JWT_SECRET", secrets.token_hex(32))
JWT_ALGORITHM = "HS256"
# Short-lived access token used as the Bearer on every request; long-lived
# refresh token exchanged at POST /auth/refresh for a fresh access token.
JWT_ACCESS_EXPIRATION_HOURS = 1
JWT_REFRESH_EXPIRATION_DAYS = 30


class AuthService:
    """
    Centralized authentication service for the clawmeets server.

    Handles:
    - Agent bearer token validation
    - User JWT token creation and validation
    - Owner-based access control
    """

    def __init__(
        self,
        model_ctx: "ModelContext",
    ) -> None:
        self._model_ctx = model_ctx

    async def check_agent_token(self, agent_id: str, auth: str) -> None:
        """Validate agent bearer token from Authorization header."""
        if not auth.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        token = auth[7:]
        if not Agent.verify_token(agent_id, token, self._model_ctx):
            raise HTTPException(401, "Invalid token")

    def create_access_token(self, user: User) -> str:
        """Create a short-lived access token for a user.

        Carries the full identity claims (consumed by ``get_current_user``)
        and ``type="access"`` so refresh tokens cannot be used as access
        tokens on protected endpoints.
        """
        payload = {
            "user_id": user.id,
            "username": user.username,
            "type": "access",
            "exp": datetime.now(UTC) + timedelta(hours=JWT_ACCESS_EXPIRATION_HOURS),
        }
        return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

    def create_refresh_token(self, user: User) -> str:
        """Create a long-lived refresh token for a user.

        Minimal claims — only enough to re-resolve the user at
        ``POST /auth/refresh``. ``type="refresh"`` keeps it out of every
        protected endpoint.
        """
        payload = {
            "user_id": user.id,
            "type": "refresh",
            "exp": datetime.now(UTC) + timedelta(days=JWT_REFRESH_EXPIRATION_DAYS),
        }
        return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

    async def get_current_user(self, authorization: str = Header(default="")) -> User:
        """Validate JWT token and return current user.

        Designed to be used as a FastAPI dependency.
        """
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        token = authorization[7:]
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
            # Refresh tokens are exchangeable only at POST /auth/refresh — never
            # accept one as the Bearer on a protected endpoint.
            if payload.get("type") != "access":
                raise HTTPException(401, "Invalid token type")
            user_id = payload.get("user_id")
            if not user_id:
                raise HTTPException(401, "Invalid token payload")
            user = User.get(user_id, self._model_ctx)
            if user is None:
                raise HTTPException(401, "User not found")
            return user
        except jwt.ExpiredSignatureError:
            raise HTTPException(401, "Token expired")
        except jwt.InvalidTokenError:
            raise HTTPException(401, "Invalid token")

    async def verify_refresh_token(self, token: str) -> User:
        """Validate a refresh token and return its user.

        Mirrors ``get_current_user`` but requires ``type="refresh"``. Used
        only by ``POST /auth/refresh`` to mint a fresh access token.
        """
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
            if payload.get("type") != "refresh":
                raise HTTPException(401, "Invalid token type")
            user_id = payload.get("user_id")
            if not user_id:
                raise HTTPException(401, "Invalid token payload")
            user = User.get(user_id, self._model_ctx)
            if user is None:
                raise HTTPException(401, "User not found")
            return user
        except jwt.ExpiredSignatureError:
            raise HTTPException(401, "Refresh token expired")
        except jwt.InvalidTokenError:
            raise HTTPException(401, "Invalid token")

    async def resolve_viewer(
        self,
        authorization: str,
        x_agent_id: Optional[str] = None,
    ) -> Optional[str]:
        """Resolve a viewer's user id from an Authorization header.

        Tries user JWT first; falls back to agent-token auth (with the agent's
        id supplied via the ``X-Agent-ID`` header that runners already send on
        every HTTP request). On agent-token auth the viewer is the agent's
        owner — same effect as if the owner had called the endpoint with their
        JWT. Returns ``None`` only for callers presenting no
        credentials; raises 401 when a Bearer token was presented but is
        invalid or expired, so clients refresh instead of silently receiving
        an anonymously-scoped (public-only) response.

        Used by listing endpoints (``GET /agents``, ``GET /agents/{id}``) so
        that an agent runner sees the same agent set as its owner — including
        non-discoverable owned agents that need to be resolvable for things
        like the Front Desk invitable-agents prompt block.
        """
        if not authorization or not authorization.startswith("Bearer "):
            return None

        # Try user JWT.
        try:
            user = await self.get_current_user(authorization)
            return user.id
        except HTTPException:
            pass

        # Try agent token (using X-Agent-ID to identify the calling agent).
        if x_agent_id:
            token = authorization[7:]
            if Agent.verify_token(x_agent_id, token, self._model_ctx):
                agent = Agent.get(x_agent_id, self._model_ctx)
                if agent and agent.registered_by:
                    return agent.registered_by

        raise HTTPException(401, "Invalid or expired credentials")

    async def authorize_agent_self_or_owner(
        self, agent_id: str, authorization: str
    ) -> None:
        """Allow either the agent itself (its own bearer token) or a user JWT
        belonging to the agent's owner. Used by read endpoints that the
        runner hits during catch-up and the web UI hits as the owner.
        """
        agent = Agent.get(agent_id, self._model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        token = authorization[7:]
        if Agent.verify_token(agent_id, token, self._model_ctx):
            return
        user = await self.get_current_user(authorization)
        if agent.registered_by != user.id:
            raise HTTPException(
                403, "Only the agent itself or its owner can access this"
            )

    async def authorize_agent_self_or_credential(
        self, agent_id: str, authorization: str
    ) -> None:
        """Accept agent self-token, owner JWT, the user's assistant-agent
        token. Composes ``authorize_agent_self_or_owner`` with the
        assistant-aware ``resolve_user_from_credential`` so a worker can
        self-mutate AND the user's ``-assistant`` can mutate any owned peer
        through the same endpoint without a user JWT.
        """
        agent = Agent.get(agent_id, self._model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        token = authorization[7:]
        if Agent.verify_token(agent_id, token, self._model_ctx):
            return
        user = await self.resolve_user_from_credential(authorization)
        if agent.registered_by != user.id:
            raise HTTPException(
                403,
                "Only the agent itself, its owner, or the user's assistant "
                "can access this",
            )

    async def resolve_user_from_credential(self, authorization: str) -> User:
        """Resolve a bearer token to a User, accepting either:

          - a user access token issued by ``create_access_token`` (browser
            sessions), or
          - the user's ``{username}-assistant`` agent's own bearer token
            (so system skills can shell ``clawmeets <cmd>`` from inside
            the assistant's runner with user-level authority).

        Used by route handlers that should accept owner operations from
        either the human in their browser OR the human's assistant agent
        acting on their behalf (skills/mcps install/uninstall/set-config,
        agent register).

        **It answers WHO and deliberately not HOW**, which is right for every
        caller that only has to decide whether an action is permitted: both
        credentials carry the owner's authority, and a route that branched on
        which one arrived would be inventing a second class of owner. A caller
        that must RECORD the actor — or refuse one specific act to a borrowed
        hand — wants :meth:`resolve_credential` instead, which returns the same
        user plus the agent it came through.
        """
        return (await self.resolve_credential(authorization))[0]

    async def resolve_credential(
        self, authorization: str
    ) -> tuple[User, Optional[Agent]]:
        """``(user, acting_agent)`` — the owner, and **how the credential got
        here**. ``acting_agent`` is ``None`` for a real user JWT.

        The sibling of :meth:`resolve_user_from_credential` and the
        implementation both share, added because discarding the second half was
        letting an assistant sign its owner's name. On
        ``onboard-angel-investor`` the coordinator — which on most projects IS
        the owner's assistant — ran ``plan resolve --dismiss --as-user`` against
        the plan's confirm note two seconds after its own plan write, and the
        acceptance record read ``accepted_by: user``, ``accepted_via: owner``,
        ``history: by user, verb approve``. Every field that could have told the
        owner apart from their assistant said the owner. Two server refusals
        that would have caught it were keyed on the caller's name and had
        already been handed ``"user"``.

        **The user is unchanged and that is the point.** Nothing here demotes an
        assistant bearer: it still resolves to the owner, and every ownership
        rule downstream still sees the owner. The only thing added is the
        ability to SAY which hand it was.
        """
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        # JWT path
        try:
            return await self.get_current_user(authorization), None
        except HTTPException:
            pass
        # Assistant-agent bearer path: find the agent whose token matches +
        # whose name ends with `-assistant`, then return its owner.
        token = authorization[7:]
        for agent in Agent.list_all(
            self._model_ctx, discoverable_only=False, include_private=True,
        ):
            if not agent.name.endswith("-assistant"):
                continue
            if not agent.registered_by:
                continue
            if Agent.verify_token(agent.id, token, self._model_ctx):
                owner = User.get(agent.registered_by, self._model_ctx)
                if owner is not None:
                    return owner, agent
        raise HTTPException(401, "Invalid token")

    async def resolve_owner_credential(
        self, authorization: str, x_agent_id: Optional[str] = None,
    ) -> tuple[User, Optional[Agent]]:
        """``(owner, acting_agent)`` for a user JWT (agent None) or the FULL
        token of an agent the user owns (any agent, not only the assistant).

        Turn tokens never reach a route that uses this (TurnTokenMiddleware
        answers them ``turn_scope``). Whether the acting agent may send is the
        caller's next check (its runner must currently advertise isolated
        turns). Used only by the hub routes agent send needs."""
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Missing bearer token")
        try:
            return await self.get_current_user(authorization), None
        except HTTPException:
            pass
        token = authorization[7:]
        candidates: list[Agent] = []
        if x_agent_id:
            agent = Agent.get(x_agent_id, self._model_ctx)
            if agent is not None:
                candidates = [agent]
        else:
            candidates = list(Agent.list_all(self._model_ctx, discoverable_only=False, include_private=True))
        for agent in candidates:
            if not agent.registered_by or not Agent.verify_token(agent.id, token, self._model_ctx):
                continue
            owner = User.get(agent.registered_by, self._model_ctx)
            if owner is not None:
                return owner, agent
        raise HTTPException(401, "Invalid token")

    def is_owner_assistant(self, agent: Agent) -> bool:
        """True iff ``agent`` is its own registering user's assistant.

        That is: the single agent whose bearer ``resolve_user_from_credential``
        accepts as that user. Prefers the authoritative passwd link
        (``User.assistant_id``), falling back to the ``{username}-assistant``
        name convention for accounts registered before ``assistant_agent_id``
        was recorded. False when the agent has no owner, or the owner record is
        missing.

        Used where a route already resolved an *agent* caller and needs to know
        whether to extend it owner-level authority — the assistant exemption on
        ``DELETE /me/desk/todos/{id}``. Routes that only need "is this the
        owner or their assistant?" should call
        ``resolve_user_from_credential`` instead: one call, no agent lookup.
        """
        if not agent.registered_by:
            return False
        owner = User.get(agent.registered_by, self._model_ctx)
        if owner is None:
            return False
        linked = owner.assistant_id
        if linked:
            return linked == agent.id
        return agent.name == f"{owner.username}-assistant"


def create_auth_service(
    model_ctx: "ModelContext",
) -> AuthService:
    """Factory function to create an AuthService instance."""
    return AuthService(model_ctx)
