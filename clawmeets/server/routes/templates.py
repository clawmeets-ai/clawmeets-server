# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/templates.py
The agent catalog, read from the specialist agent pool: a clawmeets-agents
checkout (one setup.json at its root) given as --agent-pool-dir /
$CLAWMEETS_AGENT_POOL_DIR. A directory of per-team folders (``<id>/setup.json``,
the retired team-template layout) still reads, one template per folder.

  GET /agent-pool                 the pool's agents + where runners install from
  GET /templates[...]             the same data in the Welcome-page / DM
                                  zero-state shapes (the pool is template "agents")

No route serves an agent's files: `clawmeets agent install` fetches them from
the public clawmeets-agents repo and checks each against its sha256. With no
pool configured every route answers an empty catalog.

All routes are unauthenticated: the pool is public content.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from clawmeets.models.agent_bundle import DEFAULT_AGENT_POOL_URL
from clawmeets.utils.file_io import FileUtil

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")


# Avatar palette for per-agent tinted circles on the detail drawer. These
# match the design's source/avatar colors (tokens.css `--src-*` / `--av-*`
# plus the team source colors used in Welcome.html's TEAMS constant).
_AVATAR_PALETTE = [
    "#3b6fd1",  # indigo
    "#52217b",  # deep purple
    "#b4458d",  # pink
    "#d48a1c",  # amber
    "#0d6d57",  # green
    "#2aa37a",  # teal
    "#3043a8",  # blue
    "#6b2aa0",  # accent purple
    "#9a2540",  # wine
    "#c07a1a",  # orange
]


def _avatar_color(name: str) -> str:
    """Deterministic avatar color per agent name."""
    h = hashlib.md5(name.encode("utf-8")).digest()
    return _AVATAR_PALETTE[h[0] % len(_AVATAR_PALETTE)]


def _validate_id(template_id: str) -> None:
    """Reject ids that could escape the templates dir."""
    if not template_id or "/" in template_id or "\\" in template_id or template_id.startswith("."):
        raise HTTPException(404, "Template not found")


# The template id the pool's root setup.json is listed under.
POOL_TEMPLATE_ID = "agents"


def _setup_path(templates_dir: Path, template_id: str) -> Path:
    if template_id == POOL_TEMPLATE_ID and (templates_dir / "setup.json").is_file():
        return templates_dir / "setup.json"
    return templates_dir / template_id / "setup.json"


# Every template id under templates_dir: the pool's root setup.json, then any
# per-team folders. Empty when no directory is configured.
def _template_ids(templates_dir: Path | None) -> list[str]:
    if templates_dir is None or not templates_dir.is_dir():
        return []
    ids = [POOL_TEMPLATE_ID] if (templates_dir / "setup.json").is_file() else []
    ids += [e.name for e in sorted(templates_dir.iterdir())
            if e.is_dir() and e.name != POOL_TEMPLATE_ID and (e / "setup.json").is_file()]
    return ids


def _load(templates_dir: Path | None, template_id: str) -> dict | None:
    if templates_dir is None:
        return None
    path = _setup_path(templates_dir, template_id)
    if not path.is_file():
        return None
    data = FileUtil.read(path, "json")
    if not isinstance(data, dict):
        return None
    return data


def _summary(template_id: str, data: dict) -> dict:
    return {
        "id": template_id,
        "name": data.get("name") or template_id,
        "icon": data.get("icon") or "✨",
        "color": data.get("color") or "#6b2aa0",
        "cats": data.get("cats") or [],
        "blurb": data.get("blurb") or "",
        "agent_count": len(data.get("agents") or []),
        "sample_count": len(data.get("sample_requests") or []),
    }


def create_templates_router(ctx: "ServerContext", templates_dir: Path | None) -> APIRouter:
    router = APIRouter(tags=["templates"])

    @router.get("/agent-pool")
    async def agent_pool() -> dict:
        """The pool's agents, and the setup.json runners install from by
        default (`clawmeets agent install <name>`)."""
        data = _load(templates_dir, POOL_TEMPLATE_ID) or {}
        agents = [
            {
                "name": a["name"],
                "blurb": a.get("blurb") or "",
                "description": a.get("description") or "",
                "sample_requests": [s for s in (a.get("sample_requests") or []) if isinstance(s, dict)],
                "install": f"clawmeets agent install {a['name']}",
            }
            for a in data.get("agents") or []
            if isinstance(a, dict) and a.get("name")
        ]
        return {"source_url": DEFAULT_AGENT_POOL_URL, "agents": agents}

    @router.get("/templates")
    async def list_templates() -> list[dict]:
        """Summarize every template (the pool, then any team folders)."""
        result: list[dict] = []
        for template_id in _template_ids(templates_dir):
            data = _load(templates_dir, template_id)
            if data is not None:
                result.append(_summary(template_id, data))
        return result

    @router.get("/templates/agent-samples")
    async def agent_samples() -> dict[str, list[dict]]:
        """Aggregate per-agent `sample_requests` across every template's
        setup.json. Keyed by the template's bare agent name (e.g. "amy",
        "researcher"). Union-additive across templates with `(category,
        title)` dedup — parallel to how `user_teams` merges on re-register
        (see `agents.py` register handler). When two templates ship the
        same canonical sample (same category + title), first-occurrence
        wins; otherwise both surface, so a user who installs multiple
        templates defining the same bare agent name sees the full sample
        set in the DM zero-state. Template iteration is alphabetical, so
        ordering is stable.
        """
        out: dict[str, list[dict]] = {}
        seen_keys: dict[str, set[tuple[str, str]]] = {}
        for template_id in _template_ids(templates_dir):
            data = _load(templates_dir, template_id)
            if data is None:
                continue
            for agent in data.get("agents") or []:
                name = agent.get("name")
                samples = agent.get("sample_requests")
                if not (name and isinstance(samples, list) and samples):
                    continue
                bucket = out.setdefault(name, [])
                seen = seen_keys.setdefault(name, set())
                for sample in samples:
                    if not isinstance(sample, dict):
                        continue
                    key = (str(sample.get("category", "")), str(sample.get("title", "")))
                    if key in seen:
                        continue
                    seen.add(key)
                    bucket.append(sample)
        return out

    @router.get("/templates/{template_id}")
    async def get_template(template_id: str) -> dict:
        """Full detail: summary + agents (name/description/avatar) + samples."""
        _validate_id(template_id)
        data = _load(templates_dir, template_id)
        if data is None:
            raise HTTPException(404, f"Template {template_id!r} not found")

        agents = [
            {
                "name": a.get("name") or "",
                "blurb": a.get("blurb") or "",
                "description": a.get("description") or "",
                "avatar_color": _avatar_color(a.get("name") or template_id),
            }
            for a in (data.get("agents") or [])
        ]
        samples = [
            {
                "title": s.get("title") or "",
                "request": s.get("request") or "",
            }
            for s in (data.get("sample_requests") or [])
        ]
        return {
            **_summary(template_id, data),
            "agents": agents,
            "samples": samples,
        }

    @router.get("/templates/{template_id}/setup.json", include_in_schema=False)
    async def get_template_setup(template_id: str):
        """Raw setup.json (`clawmeets agent install <name> --from <this URL>`)."""
        _validate_id(template_id)
        path = _setup_path(templates_dir, template_id) if templates_dir is not None else None
        if path is None or not path.is_file():
            raise HTTPException(404, f"Template {template_id!r} not found")
        return FileResponse(path, media_type="application/json")

    return router
