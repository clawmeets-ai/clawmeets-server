# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/skill_registry.py

Skill registry that reads from the skills/ directory.
Provides search and SKILL.md content serving.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

from clawmeets.models.skill_version import skill_version
from clawmeets.utils.jsonc import parse_jsonc

logger = logging.getLogger("clawmeets.server")


class SkillAuthMeta(BaseModel):
    """OAuth declaration on a skill's registry entry.

    Surfaced via ``GET /skills/<name>`` so the frontend renders an
    "Authenticate" button on `SkillConfigModal`. The runner reads the
    same block on SKILL_SYNC install to fire auto-auth.
    """
    method: str  # currently only "google_oauth_installed"
    scopes: list[str] = []
    token_file: str = "token.json"


class SkillMeta(BaseModel):
    """Skill metadata from registry.json."""
    name: str
    summary: str | None = None  # short "what it achieves"; UI falls back to description
    description: str
    tags: list[str] = []
    version: str = "1.0.0"
    attribution: str | None = None
    auth: SkillAuthMeta | None = None


class SkillRegistry:
    """
    Loads skills from a registry.json file and serves SKILL.md content.

    The skills directory layout:
        skills/
        ├── registry.json
        ├── pdf/
        │   └── SKILL.md
        └── web-artifacts/
            └── SKILL.md
    """

    def __init__(self, skills_dir: Path) -> None:
        self._skills_dir = skills_dir
        self._skills: dict[str, SkillMeta] = {}
        self.reload()

    def reload(self) -> None:
        """Reload registry.json from disk."""
        registry_path = self._skills_dir / "registry.json"
        if not registry_path.exists():
            logger.warning(f"Skills registry not found at {registry_path}")
            self._skills = {}
            return

        raw = json.loads(registry_path.read_text())
        self._skills = {}
        for entry in raw:
            meta = SkillMeta.model_validate(entry)
            self._skills[meta.name] = meta
        logger.info(f"Loaded {len(self._skills)} skills from registry")

    def list_skills(self, query: Optional[str] = None) -> list[SkillMeta]:
        """List all skills, optionally filtered by search query."""
        skills = list(self._skills.values())
        if query:
            q = query.lower()
            skills = [
                s for s in skills
                if q in s.name.lower()
                or (s.summary is not None and q in s.summary.lower())
                or q in s.description.lower()
                or any(q in t.lower() for t in s.tags)
            ]
        return sorted(skills, key=lambda s: s.name)

    def get_skill(self, name: str) -> Optional[SkillMeta]:
        """Get skill metadata by name."""
        return self._skills.get(name)

    def get_skill_content(self, name: str) -> Optional[str]:
        """Read the SKILL.md content for a skill."""
        skill_md = self._skills_dir / name / "SKILL.md"
        if skill_md.exists():
            return skill_md.read_text()
        return None

    def get_skill_starter_config_text(self, name: str) -> Optional[str]:
        """Read ``skills/<name>/starter_config.jsonc`` verbatim (with comments
        and trailing commas intact). Drives the Configure modal's editor
        seed in the web UI. Returns None for skills without a sibling file
        (non-configurable skills such as ``pdf``, ``web-artifacts``,
        ``marketing-*``).
        """
        path = self._skills_dir / name / "starter_config.jsonc"
        if path.exists():
            return path.read_text()
        return None

    def get_skill_starter_config(self, name: str) -> Optional[dict]:
        """Parse ``skills/<name>/starter_config.jsonc`` into a dict (comments
        stripped). Returns None for skills without a sibling file. Raises
        ``json.JSONDecodeError`` if the stripped JSONC is malformed — that's
        a startup bug for whoever authored the template, not a user error.
        """
        text = self.get_skill_starter_config_text(name)
        if text is None:
            return None
        parsed = parse_jsonc(text)
        return parsed if isinstance(parsed, dict) else None

    def get_skill_files(self, name: str) -> dict[str, bytes]:
        """Return runtime sibling files for a skill, keyed by forward-slash
        relpath under ``skills/<name>/``. Excludes ``SKILL.md`` (carried
        separately as ``skill_content``) and ``starter_config.jsonc`` (a
        server-side editor seed, not runner state — the saved per-agent config
        rides ``AGENT_SETTINGS_CHANGE`` to ``{agent_dir}/skill-hub/configs/``).
        Dotfiles (``.DS_Store``, ``.gitignore``, …) are skipped.

        Used by skill sync to ship multi-file skills (e.g. ``template.html``
        + ``render.py``) so SKILL.md procedures can reference them via
        ``$CLAWMEETS_AGENT_DIR/skill-hub/skills/<name>/...``.
        """
        skill_dir = self._skills_dir / name
        if not skill_dir.is_dir():
            return {}
        files: dict[str, bytes] = {}
        for path in sorted(skill_dir.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(skill_dir)
            if any(seg.startswith(".") for seg in rel.parts):
                continue
            relpath = rel.as_posix()
            if relpath in ("SKILL.md", "starter_config.jsonc"):
                continue
            files[relpath] = path.read_bytes()
        return files

    def get_skill_version(self, name: str) -> Optional[str]:
        """Content version of a skill (``models/skill_version``) over exactly
        what ``GET /skills/{name}`` ships: SKILL.md plus ``get_skill_files``.
        None if the skill has no SKILL.md. Computed per call — skills are a few
        KB and change only on a server restart after ``git pull``."""
        content = self.get_skill_content(name)
        if content is None:
            return None
        return skill_version(content, self.get_skill_files(name))
