# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/mcps.py
MCP hub routes: browse MCP servers and manage per-agent installations.

Mirrors routes/skills.py. The server stores *which* MCP servers are installed
per agent (names + manifests), never credentials. OAuth tokens live on the
runner machine only.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException

from clawmeets.api.control import (
    AgentSettingsChangePayload,
    ControlEnvelope,
    ControlMessageType,
    McpSyncPayload,
)
from clawmeets.models.agent import Agent
from clawmeets.utils.file_io import FileUtil

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext
    from clawmeets.server.mcp_registry import McpRegistry

logger = logging.getLogger("clawmeets.server")

_mcp_write_lock = asyncio.Lock()


def create_mcps_router(ctx: "ServerContext", mcp_registry: "McpRegistry") -> APIRouter:
    """Create the MCPs router."""
    router = APIRouter(tags=["mcps"])

    def _agent_mcps_path(agent_id: str) -> Path:
        """Path to an agent's mcps.json file."""
        agents_dir = ctx.model_ctx.participants_dir / "agents"
        if not agents_dir.exists():
            return agents_dir / f"unknown-{agent_id}" / "mcps.json"
        for entry in agents_dir.iterdir():
            if entry.is_dir() and entry.name.endswith(f"-{agent_id}"):
                return entry / "mcps.json"
        return agents_dir / f"unknown-{agent_id}" / "mcps.json"

    def _read_installed_mcps(agent_id: str) -> list[str]:
        path = _agent_mcps_path(agent_id)
        data = FileUtil.read(path, "json")
        if data and isinstance(data, dict):
            return data.get("installed_mcps", [])
        return []

    def _write_installed_mcps(agent_id: str, mcps: list[str]) -> None:
        path = _agent_mcps_path(agent_id)
        FileUtil.write(path, {"installed_mcps": mcps}, "json")

    # --- MCP catalog (read-only) ---

    @router.get("/mcps")
    async def list_mcps(q: Optional[str] = None):
        """List available MCP servers, optionally filtered by search query."""
        mcps = mcp_registry.list_mcps(query=q)
        return [m.model_dump() for m in mcps]

    @router.get("/mcps/{mcp_name}")
    async def get_mcp(mcp_name: str):
        """Get MCP detail including the manifest and README.

        The manifest is enriched with ``starter_config`` from the sibling
        ``starter_config.jsonc`` (if present) so the web UI can gate the
        Configure pill on a single field. The pill needs only to know
        *whether* a starter template exists; the editor seed is fetched
        on click via ``GET /agents/{id}/mcps/{name}/config``.
        """
        meta = mcp_registry.get_mcp(mcp_name)
        if meta is None:
            raise HTTPException(404, f"MCP server {mcp_name!r} not found")
        manifest = mcp_registry.get_mcp_manifest(mcp_name)
        if manifest is not None:
            starter = mcp_registry.get_mcp_starter_config(mcp_name)
            if starter is not None:
                manifest = {**manifest, "starter_config": starter}
        readme = mcp_registry.get_mcp_readme(mcp_name)
        return {**meta.model_dump(), "manifest": manifest, "readme": readme}

    # --- Per-agent MCP management ---

    @router.get("/agents/{agent_id}/mcps")
    async def get_agent_mcps(
        agent_id: str,
        authorization: str = Header(default=""),
    ):
        """List MCP servers installed for an agent.

        Auth: agent self-token, owner JWT, the user's ``-assistant`` token
        (see ``authorize_agent_self_or_credential``).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        return {"installed_mcps": _read_installed_mcps(agent_id)}

    @router.post("/agents/{agent_id}/mcps")
    async def install_mcps(
        agent_id: str,
        mcps: list[str] = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Install MCP server(s) for an agent.

        Auth: agent self-token (worker self-installing), owner JWT, the
        user's ``-assistant`` token (assistant-on-peer).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        # Validate all requested MCPs exist in the registry (correctness at
        # the authoritative layer, not the runner).
        for mcp_name in mcps:
            if mcp_registry.get_mcp(mcp_name) is None:
                raise HTTPException(404, f"MCP server {mcp_name!r} not found in registry")

        async with _mcp_write_lock:
            installed = _read_installed_mcps(agent_id)
            new_mcps = [m for m in mcps if m not in installed]
            if not new_mcps:
                return {"installed_mcps": installed, "added": []}
            installed.extend(new_mcps)
            _write_installed_mcps(agent_id, installed)

        # Broadcast MCP_SYNC to the agent's runner for each newly installed server
        for mcp_name in new_mcps:
            manifest = mcp_registry.get_mcp_manifest(mcp_name)
            envelope = ControlEnvelope(
                type=ControlMessageType.MCP_SYNC,
                payload=McpSyncPayload(
                    agent_id=agent_id,
                    agent_name=agent.name,
                    action="install",
                    mcp_name=mcp_name,
                    manifest=manifest,
                ),
            )
            if await ctx.ws_hub.send_to(agent_id, envelope):
                logger.info(f"Sent MCP_SYNC(install) for {mcp_name} to agent {agent.name}")

        return {"installed_mcps": installed, "added": new_mcps}

    @router.delete("/agents/{agent_id}/mcps/{mcp_name}")
    async def uninstall_mcp(
        agent_id: str,
        mcp_name: str,
        authorization: str = Header(default=""),
    ):
        """Uninstall an MCP server from an agent.

        Auth: agent self-token (worker self-uninstalling), owner JWT, the
        user's ``-assistant`` token (assistant-on-peer).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        async with _mcp_write_lock:
            installed = _read_installed_mcps(agent_id)
            if mcp_name not in installed:
                raise HTTPException(404, f"MCP server {mcp_name!r} is not installed for this agent")
            installed.remove(mcp_name)
            _write_installed_mcps(agent_id, installed)

        envelope = ControlEnvelope(
            type=ControlMessageType.MCP_SYNC,
            payload=McpSyncPayload(
                agent_id=agent_id,
                agent_name=agent.name,
                action="uninstall",
                mcp_name=mcp_name,
            ),
        )
        if await ctx.ws_hub.send_to(agent_id, envelope):
            logger.info(f"Sent MCP_SYNC(uninstall) for {mcp_name} to agent {agent.name}")

        return {"installed_mcps": installed, "removed": mcp_name}

    # --- Per-MCP per-agent config (carried in card.local_settings.mcp_configs) ---
    #
    # Storage rides the existing AGENT_SETTINGS_CHANGE rail: the server stores
    # `card.local_settings.mcp_configs[mcp_name] = {...}`, broadcasts the
    # whole local_settings, and the runner's `_apply_local_settings` writes
    # the slice through to `{knowledge_dir}/config.json`. No new envelope.

    @router.get("/agents/{agent_id}/mcps/{mcp_name}/config")
    async def get_mcp_config(
        agent_id: str,
        mcp_name: str,
        authorization: str = Header(default=""),
    ):
        """Read the saved per-agent config for an MCP, plus its starter template.

        Auth: agent self-token, owner JWT, the user's ``-assistant`` token
        (mirrors GET /agents/{id}/mcps).
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        if mcp_registry.get_mcp(mcp_name) is None:
            raise HTTPException(404, f"MCP server {mcp_name!r} not found in registry")
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        local_settings = agent._load_card().get("local_settings") or {}
        mcp_configs = local_settings.get("mcp_configs") or {}
        return {
            "config": mcp_configs.get(mcp_name),
            # Parsed dict (kept for any consumer that wants a structured view).
            "starter_config": mcp_registry.get_mcp_starter_config(mcp_name),
            # Raw JSONC text (with comments) — drives the editor seed.
            "starter_config_text": mcp_registry.get_mcp_starter_config_text(mcp_name),
        }

    @router.put("/agents/{agent_id}/mcps/{mcp_name}/config")
    async def put_mcp_config(
        agent_id: str,
        mcp_name: str,
        config: dict = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Save the per-agent config for an MCP.

        Mutates `card.local_settings.mcp_configs[mcp_name]` and broadcasts
        the full `local_settings` via AGENT_SETTINGS_CHANGE so the runner's
        `_apply_local_settings` picks it up and writes through to
        `{agent_dir}/mcp-hub/configs/<mcp_name>.json`.

        Auth: agent self-token (worker self-config), owner JWT, the user's
        ``-assistant`` token (assistant-on-peer). Mirrors
        put_skill_config — same canonical channel that keeps the server-side
        mirror in sync with the runner's file.
        """
        await ctx.auth.authorize_agent_self_or_credential(agent_id, authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if mcp_registry.get_mcp(mcp_name) is None:
            raise HTTPException(404, f"MCP server {mcp_name!r} not found in registry")

        async with _mcp_write_lock:
            card = agent._load_card()
            local_settings = dict(card.get("local_settings") or {})
            mcp_configs = dict(local_settings.get("mcp_configs") or {})
            mcp_configs[mcp_name] = config
            local_settings["mcp_configs"] = mcp_configs
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
        logger.info(f"Saved MCP config for {mcp_name} on agent {agent.name}")
        return {"config": config}

    return router
