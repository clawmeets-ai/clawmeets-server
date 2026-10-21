# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/skills.py
Skill hub routes: browse skills and manage per-agent skill installations.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException

from clawmeets.api.control import (
    AgentSettingsChangePayload,
    ControlEnvelope,
    ControlMessageType,
    SkillSyncPayload,
)
from clawmeets.models.agent import Agent
from clawmeets.models.skill_version import skill_version
from clawmeets.utils.file_io import FileUtil

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext
    from clawmeets.server.skill_registry import SkillRegistry

logger = logging.getLogger("clawmeets.server")

_skill_write_lock = asyncio.Lock()


def _encode_skill_files(files: dict[str, bytes]) -> dict[str, dict]:
    """Base64-encode skill sibling files for JSON-safe wire transport.

    Returns ``{relpath: {"content_b64": <ascii>}}`` to mirror the
    ``KnowledgePackSyncPayload.pack_files`` shape so runner-side decode logic
    stays consistent across sync envelopes.
    """
    return {
        relpath: {"content_b64": base64.b64encode(body).decode("ascii")}
        for relpath, body in files.items()
    }


def create_skills_router(ctx: "ServerContext", skill_registry: "SkillRegistry") -> APIRouter:
    """Create the skills router."""
    router = APIRouter(tags=["skills"])

    def _agent_skills_path(agent_id: str) -> Path:
        """Path to an agent's skills.json file."""
        # Find the agent directory under agents/ (participants_dir is the
        # server's base data dir — ModelContext doesn't expose base_dir).
        agents_dir = ctx.model_ctx.participants_dir / "agents"
        if not agents_dir.exists():
            return agents_dir / f"unknown-{agent_id}" / "skills.json"
        for entry in agents_dir.iterdir():
            if entry.is_dir() and entry.name.endswith(f"-{agent_id}"):
                return entry / "skills.json"
        return agents_dir / f"unknown-{agent_id}" / "skills.json"

    def _read_installed_skills(agent_id: str) -> list[str]:
        """Read agent's installed skills list."""
        path = _agent_skills_path(agent_id)
        data = FileUtil.read(path, "json")
        if data and isinstance(data, dict):
            return data.get("installed_skills", [])
        return []

    def _write_installed_skills(agent_id: str, skills: list[str]) -> None:
        """Write agent's installed skills list."""
        path = _agent_skills_path(agent_id)
        FileUtil.write(path, {"installed_skills": skills}, "json")

    # --- Skill catalog (read-only) ---

    @router.get("/skills")
    async def list_skills(q: Optional[str] = None):
        """List available skills, optionally filtered by search query."""
        skills = skill_registry.list_skills(query=q)
        return [s.model_dump() for s in skills]

    @router.get("/skills/{skill_name}")
    async def get_skill(skill_name: str):
        """Get skill detail including full SKILL.md content.

        The response is enriched with ``starter_config`` from the sibling
        ``starter_config.jsonc`` (if present) so the web UI can gate the
        Configure pill on a single field. The pill needs only to know
        *whether* a starter template exists; the editor seed is fetched
        on click via ``GET /agents/{id}/skills/{name}/config``.
        """
        meta = skill_registry.get_skill(skill_name)
        if meta is None:
            raise HTTPException(404, f"Skill {skill_name!r} not found")
        content = skill_registry.get_skill_content(skill_name)
        files = skill_registry.get_skill_files(skill_name)
        return {
            **meta.model_dump(),
            "content": content,
            "files": _encode_skill_files(files),
            "version": skill_version(content, files) if content is not None else None,
            "starter_config": skill_registry.get_skill_starter_config(skill_name),
        }

    # --- Per-agent skill management ---

    @router.get("/agents/{agent_id}/skills")
    async def get_agent_skills(
        agent_id: str,
        authorization: str = Header(default=""),
    ):
        """List skills installed for an agent.

        Auth: agent self-token, owner JWT, the user's ``-assistant`` token
        (see ``authorize_agent_self_or_credential``).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        installed = _read_installed_skills(agent_id)
        # Content version per skill, so runner catch-up also re-downloads a
        # skill that changed on the server, not only one it is missing.
        versions = {
            name: version
            for name in installed
            if (version := skill_registry.get_skill_version(name)) is not None
        }
        return {"installed_skills": installed, "versions": versions}

    @router.post("/agents/{agent_id}/skills")
    async def install_skills(
        agent_id: str,
        skills: list[str] = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Install skill(s) for an agent.

        Auth: agent self-token (worker self-installing), owner JWT, the
        user's ``-assistant`` token (assistant-on-peer).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        # Validate all requested skills exist
        for skill_name in skills:
            if skill_registry.get_skill(skill_name) is None:
                raise HTTPException(404, f"Skill {skill_name!r} not found in registry")

        async with _skill_write_lock:
            installed = _read_installed_skills(agent_id)
            new_skills = [s for s in skills if s not in installed]
            if not new_skills:
                return {"installed_skills": installed, "added": []}
            installed.extend(new_skills)
            _write_installed_skills(agent_id, installed)

        # Broadcast SKILL_SYNC to the agent's runner for each new skill
        for skill_name in new_skills:
            content = skill_registry.get_skill_content(skill_name)
            sibling_files = skill_registry.get_skill_files(skill_name)
            meta = skill_registry.get_skill(skill_name)
            envelope = ControlEnvelope(
                type=ControlMessageType.SKILL_SYNC,
                payload=SkillSyncPayload(
                    agent_id=agent_id,
                    agent_name=agent.name,
                    action="install",
                    skill_name=skill_name,
                    skill_content=content,
                    skill_files=_encode_skill_files(sibling_files or {}),
                    auth=meta.auth.model_dump() if (meta and meta.auth) else None,
                    skill_version=(
                        skill_version(content, sibling_files or {}) if content is not None else None
                    ),
                ),
            )
            if await ctx.ws_hub.send_to(agent_id, envelope):
                logger.info(f"Sent SKILL_SYNC(install) for {skill_name} to agent {agent.name}")

        return {"installed_skills": installed, "added": new_skills}

    @router.post("/agents/{agent_id}/skills/{skill_name}/reauth")
    async def reauth_skill(
        agent_id: str,
        skill_name: str,
        authorization: str = Header(default=""),
    ):
        """Trigger a fresh OAuth flow for an already-installed skill.

        Auth: agent self-token (worker noticed its own token went stale),
        owner JWT, or the user's ``-assistant`` token (assistant-on-peer). The
        runner ignores the install-time token-exists guard for
        ``action == "reauth"`` and overwrites the on-disk token via the
        existing relay path (``SKILL_AUTH_URL_FOR_USER`` → user consent →
        ``SKILL_AUTH_CODE`` → ``exchange_code``).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        meta = skill_registry.get_skill(skill_name)
        if meta is None:
            raise HTTPException(404, f"Skill {skill_name!r} not found in registry")
        if meta.auth is None:
            raise HTTPException(400, f"Skill {skill_name!r} does not declare an OAuth flow")
        if skill_name not in _read_installed_skills(agent_id):
            raise HTTPException(404, f"Skill {skill_name!r} is not installed for this agent")

        envelope = ControlEnvelope(
            type=ControlMessageType.SKILL_SYNC,
            payload=SkillSyncPayload(
                agent_id=agent_id,
                agent_name=agent.name,
                action="reauth",
                skill_name=skill_name,
                skill_content="",
                auth=meta.auth.model_dump(),
            ),
        )
        if await ctx.ws_hub.send_to(agent_id, envelope):
            logger.info(f"Sent SKILL_SYNC(reauth) for {skill_name} to agent {agent.name}")
        else:
            raise HTTPException(503, "Agent runner is not connected")
        return {"ok": True}

    @router.post("/agents/{agent_id}/skills/{skill_name}/disconnect")
    async def disconnect_skill(
        agent_id: str,
        skill_name: str,
        authorization: str = Header(default=""),
    ):
        """Explicit user-initiated disconnect: withdraw a Google grant without
        uninstalling the skill.

        Dispatches a ``SKILL_SYNC(action="revoke")`` envelope to the agent's
        runner, which revokes the token on Google's side and deletes the local
        ``token.json``. The skill stays installed but tokenless, so the next
        use re-triggers auth (recovery path). Mirrors ``reauth_skill``.

        Auth: agent self-token, owner JWT, or the user's ``-assistant`` token
        (``authorize_agent_self_or_credential``).

        Responses:
          - 200 ``{"ok": True, "dispatched": True}`` — revoke command delivered
            to the runner. Revocation + token deletion complete asynchronously
            runner-side; 200 means *initiated*, not confirmed-revoked.
          - 400 — skill declares no OAuth flow (nothing to revoke).
          - 404 — agent/skill unknown, or skill not installed for this agent.
          - 503 — runner offline; the command could not be delivered.
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        meta = skill_registry.get_skill(skill_name)
        if meta is None:
            raise HTTPException(404, f"Skill {skill_name!r} not found in registry")
        if meta.auth is None:
            raise HTTPException(400, f"Skill {skill_name!r} does not declare an OAuth flow")
        if skill_name not in _read_installed_skills(agent_id):
            raise HTTPException(404, f"Skill {skill_name!r} is not installed for this agent")

        envelope = ControlEnvelope(
            type=ControlMessageType.SKILL_SYNC,
            payload=SkillSyncPayload(
                agent_id=agent_id,
                agent_name=agent.name,
                action="revoke",
                skill_name=skill_name,
                skill_content="",
                auth=meta.auth.model_dump(),
            ),
        )
        if await ctx.ws_hub.send_to(agent_id, envelope):
            logger.info(f"Sent SKILL_SYNC(revoke) for {skill_name} to agent {agent.name}")
        else:
            raise HTTPException(503, "Agent runner is not connected")
        return {"ok": True, "dispatched": True}

    @router.delete("/agents/{agent_id}/skills/{skill_name}")
    async def uninstall_skill(
        agent_id: str,
        skill_name: str,
        authorization: str = Header(default=""),
    ):
        """Uninstall a skill from an agent.

        Auth: agent self-token (worker self-uninstalling), owner JWT, the
        user's ``-assistant`` token (assistant-on-peer).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        async with _skill_write_lock:
            installed = _read_installed_skills(agent_id)
            if skill_name not in installed:
                raise HTTPException(404, f"Skill {skill_name!r} is not installed for this agent")
            installed.remove(skill_name)
            _write_installed_skills(agent_id, installed)

        # Broadcast SKILL_SYNC uninstall. ``skill_content`` is required on the
        # payload and carries the same SKILL.md the install path would send;
        # the runner ignores it on uninstall (action discriminates).
        content = skill_registry.get_skill_content(skill_name)
        envelope = ControlEnvelope(
            type=ControlMessageType.SKILL_SYNC,
            payload=SkillSyncPayload(
                agent_id=agent_id,
                agent_name=agent.name,
                action="uninstall",
                skill_name=skill_name,
                skill_content=content,
            ),
        )
        if await ctx.ws_hub.send_to(agent_id, envelope):
            logger.info(f"Sent SKILL_SYNC(uninstall) for {skill_name} to agent {agent.name}")

        return {"installed_skills": installed, "removed": skill_name}

    # --- Per-skill per-agent config (carried in card.local_settings.skill_configs) ---
    #
    # Storage rides the existing AGENT_SETTINGS_CHANGE rail: the server stores
    # `card.local_settings.skill_configs[skill_name] = {...}`, broadcasts the
    # whole local_settings, and the runner's `_apply_local_settings` writes
    # the slice through to `{agent_dir}/skill-hub/configs/<skill_name>.json`.
    # Same shape as MCP configs (see routes/mcps.py for the canonical pattern).

    @router.get("/agents/{agent_id}/skills/{skill_name}/config")
    async def get_skill_config(
        agent_id: str,
        skill_name: str,
        authorization: str = Header(default=""),
    ):
        """Read the saved per-agent config for a skill, plus its starter template.

        Auth: agent self-token, owner JWT, the user's ``-assistant`` token
        (mirrors GET /agents/{id}/skills).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        if skill_registry.get_skill(skill_name) is None:
            raise HTTPException(404, f"Skill {skill_name!r} not found in registry")
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        local_settings = agent._load_card().get("local_settings") or {}
        skill_configs = local_settings.get("skill_configs") or {}
        return {
            "config": skill_configs.get(skill_name),
            "starter_config": skill_registry.get_skill_starter_config(skill_name),
            "starter_config_text": skill_registry.get_skill_starter_config_text(skill_name),
        }

    @router.put("/agents/{agent_id}/skills/{skill_name}/config")
    async def put_skill_config(
        agent_id: str,
        skill_name: str,
        config: dict = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Save the per-agent config for a skill.

        Mutates `card.local_settings.skill_configs[skill_name]` and broadcasts
        the full `local_settings` via AGENT_SETTINGS_CHANGE so the runner's
        `_apply_local_settings` picks it up and writes through to
        `{agent_dir}/skill-hub/configs/<skill_name>.json`.

        Auth: agent self-token (worker self-config), owner JWT, the user's
        ``-assistant`` token (assistant-on-peer). The worker
        self-token path lets a worker shell `clawmeets skill set-config
        self ...` when its PLAN.md asks it to mutate its own config — the
        canonical channel that keeps the server's per-agent config mirror in
        sync with the runner's file.
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if skill_registry.get_skill(skill_name) is None:
            raise HTTPException(404, f"Skill {skill_name!r} not found in registry")

        async with _skill_write_lock:
            card = agent._load_card()
            local_settings = dict(card.get("local_settings") or {})
            skill_configs = dict(local_settings.get("skill_configs") or {})
            skill_configs[skill_name] = config
            local_settings["skill_configs"] = skill_configs
            agent.update_card(local_settings=local_settings)

        envelope = ControlEnvelope(
            type=ControlMessageType.AGENT_SETTINGS_CHANGE,
            payload=AgentSettingsChangePayload(
                agent_id=agent_id,
                agent_name=agent.name,
                local_settings=local_settings,
            ),
        )
        await ctx.ws_hub.send_to(agent_id, envelope)
        logger.info(f"Saved skill config for {skill_name} on agent {agent.name}")
        return {"config": config}

    return router
