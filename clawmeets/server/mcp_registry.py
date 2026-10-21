# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/mcp_registry.py

MCP registry that reads from the mcps/ directory.
Provides search and manifest serving, mirroring SkillRegistry.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

from clawmeets.utils.jsonc import parse_jsonc

logger = logging.getLogger("clawmeets.server")


class McpMeta(BaseModel):
    """MCP server metadata from registry.json."""
    name: str
    description: str
    tags: list[str] = []
    version: str = "1.0.0"
    attribution: str | None = None


class McpRegistry:
    """
    Loads MCP servers from a registry.json file and serves mcp.json manifests.

    The mcps directory layout:
        mcps/
        ├── registry.json
        ├── gmail/
        │   ├── mcp.json
        │   └── README.md
        └── google-calendar/
            ├── mcp.json
            └── README.md
    """

    def __init__(self, mcps_dir: Path) -> None:
        self._mcps_dir = mcps_dir
        self._mcps: dict[str, McpMeta] = {}
        self.reload()

    def reload(self) -> None:
        """Reload registry.json from disk."""
        registry_path = self._mcps_dir / "registry.json"
        if not registry_path.exists():
            logger.warning(f"MCP registry not found at {registry_path}")
            self._mcps = {}
            return

        raw = json.loads(registry_path.read_text())
        self._mcps = {}
        for entry in raw:
            meta = McpMeta.model_validate(entry)
            self._mcps[meta.name] = meta
        logger.info(f"Loaded {len(self._mcps)} MCP servers from registry")

    def list_mcps(self, query: Optional[str] = None) -> list[McpMeta]:
        """List all MCP servers, optionally filtered by search query."""
        mcps = list(self._mcps.values())
        if query:
            q = query.lower()
            mcps = [
                m for m in mcps
                if q in m.name.lower()
                or q in m.description.lower()
                or any(q in t.lower() for t in m.tags)
            ]
        return sorted(mcps, key=lambda m: m.name)

    def get_mcp(self, name: str) -> Optional[McpMeta]:
        """Get MCP metadata by name."""
        return self._mcps.get(name)

    def get_mcp_manifest(self, name: str) -> Optional[dict]:
        """Read the mcp.json manifest for an MCP server."""
        manifest_path = self._mcps_dir / name / "mcp.json"
        if manifest_path.exists():
            return json.loads(manifest_path.read_text())
        return None

    def get_mcp_readme(self, name: str) -> Optional[str]:
        """Read the README.md content for an MCP server (for the UI detail view)."""
        readme_path = self._mcps_dir / name / "README.md"
        if readme_path.exists():
            return readme_path.read_text()
        return None

    def get_mcp_starter_config_text(self, name: str) -> Optional[str]:
        """Read ``mcps/<name>/starter_config.jsonc`` verbatim (with comments
        and trailing commas intact). Drives the Configure modal's editor
        seed in the web UI. Returns None for MCPs without a sibling file
        (non-configurable MCPs such as ``chess``, ``homekit``, ``osxphotos``).
        """
        path = self._mcps_dir / name / "starter_config.jsonc"
        if path.exists():
            return path.read_text()
        return None

    def get_mcp_starter_config(self, name: str) -> Optional[dict]:
        """Parse ``mcps/<name>/starter_config.jsonc`` into a dict (comments
        stripped). Returns None for MCPs without a sibling file. Raises
        ``json.JSONDecodeError`` if the stripped JSONC is malformed — that's
        a startup bug for whoever authored the template, not a user error.
        """
        text = self.get_mcp_starter_config_text(name)
        if text is None:
            return None
        parsed = parse_jsonc(text)
        return parsed if isinstance(parsed, dict) else None
