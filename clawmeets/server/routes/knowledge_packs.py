# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/knowledge_packs.py

Knowledge pack registry routes — owner-scoped pack metadata plus per-agent
install/uninstall/listing.

A knowledge pack is the user's explicit promotion of agent-produced content
into the AUTHORITATIVE memory layer. Routes here cover:

- CRUD on the user's own pack registry (``/knowledge-packs``).
- Per-agent install/uninstall (``/agents/{id}/knowledge-packs``) — broadcasts
  a ``KNOWLEDGE_PACK_SYNC`` envelope so the runner writes the pack into the
  agent's ``knowledge_dir`` immediately.
- Per-agent listing for runner catch-up (``GET /agents/{id}/knowledge-packs``)
  returning slug + name + description + content + updated_at so the runner can
  rebuild ``KNOWLEDGE_PACKS.md`` without a per-pack round-trip.

Edits to a pack (PUT) and deletes (DELETE) fan out: the server scans every
agent owned by the user, finds the ones with this slug installed, and emits a
SYNC envelope for each so installed copies stay current with the registry.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException

from clawmeets.api.control import (
    ControlEnvelope,
    ControlMessageType,
    KnowledgePackSyncPayload,
)
from clawmeets.models.agent import Agent
from clawmeets.models.knowledge_pack import (
    create_pack,
    decode_pack_versions,
    delete_file,
    delete_pack,
    get_pack,
    get_pack_updated_at,
    list_packs,
    update_pack,
    upsert_file,
    validate_filepath,
    validate_slug,
)
from clawmeets.models.user import User
from clawmeets.utils.file_io import FileUtil

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server")

_install_lock = asyncio.Lock()


def create_knowledge_packs_router(ctx: "ServerContext") -> APIRouter:
    """Create the knowledge packs router."""
    router = APIRouter(tags=["knowledge-packs"])

    # ─────────────────────────────────────────────────────────
    # Per-agent install state on disk (mirrors skills.py:32-55)
    # ─────────────────────────────────────────────────────────

    def _agent_packs_path(agent_id: str) -> Path:
        agents_dir = ctx.model_ctx.participants_dir / "agents"
        if agents_dir.exists():
            for entry in agents_dir.iterdir():
                if entry.is_dir() and entry.name.endswith(f"-{agent_id}"):
                    return entry / "knowledge-packs.json"
        return agents_dir / f"unknown-{agent_id}" / "knowledge-packs.json"

    def _read_installed_packs(agent_id: str) -> list[str]:
        path = _agent_packs_path(agent_id)
        data = FileUtil.read(path, "json")
        if data and isinstance(data, dict):
            return data.get("installed_packs", [])
        return []

    def _write_installed_packs(agent_id: str, packs: list[str]) -> None:
        path = _agent_packs_path(agent_id)
        FileUtil.write(path, {"installed_packs": packs}, "json")

    def _agent_dirs() -> list[Path]:
        agents_dir = ctx.model_ctx.participants_dir / "agents"
        if not agents_dir.exists():
            return []
        return [d for d in agents_dir.iterdir() if d.is_dir()]

    def _agents_with_pack_installed(slug: str, owner_id: str) -> list[str]:
        """Return ids of every agent owned by ``owner_id`` that has ``slug`` installed.

        Pack slugs are per-user, so the fan-out must be scoped to the pack
        owner — otherwise editing user A's "foo" would push to user B's agents
        that happen to have an unrelated pack named "foo".
        """
        out: list[str] = []
        for d in _agent_dirs():
            data = FileUtil.read(d / "knowledge-packs.json", "json")
            if not (data and isinstance(data, dict)):
                continue
            if slug not in (data.get("installed_packs") or []):
                continue
            agent_id = d.name.rsplit("-", 1)[-1]
            agent = Agent.get(agent_id, ctx.model_ctx)
            if agent is None or agent.registered_by != owner_id:
                continue
            out.append(agent_id)
        return out

    # ─────────────────────────────────────────────────────────
    # Pack registry CRUD
    # ─────────────────────────────────────────────────────────

    @router.get("/knowledge-packs")
    async def list_user_packs(authorization: str = Header(default="")):
        """List every pack owned by the current user."""
        user = await ctx.auth.get_current_user(authorization)
        packs = list_packs(ctx.model_ctx.participants_dir, user.username)
        return [p.model_dump() for p in packs]

    @router.post("/knowledge-packs")
    async def create_user_pack(
        slug: str = Body(..., embed=True),
        name: str = Body(..., embed=True),
        description: str = Body("", embed=True),
        files: Optional[dict[str, str]] = Body(None, embed=True),
        file_descriptions: Optional[dict[str, str]] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Create a new pack, optionally seeded with a files dict and per-file
        "consult when" descriptions."""
        user = await ctx.auth.get_current_user(authorization)
        try:
            slug_clean = validate_slug(slug)
        except ValueError as e:
            raise HTTPException(400, str(e))
        name_clean = (name or "").strip()
        if not name_clean:
            raise HTTPException(400, "Pack name is required")
        try:
            pack = await create_pack(
                ctx.model_ctx.participants_dir,
                user.username,
                slug_clean,
                name_clean,
                description=(description or "").strip(),
                files=files or {},
                file_descriptions=file_descriptions or {},
            )
        except ValueError as e:
            # ValueErrors from the model cover both slug collision (existing
            # pack) and filename validation. Use 409 for collisions, 400 for
            # malformed input — the model raises with distinct messages but
            # the cheapest dispatch is by message prefix.
            msg = str(e)
            if "already exists" in msg:
                raise HTTPException(409, msg)
            raise HTTPException(400, msg)
        return pack.model_dump()

    @router.get("/knowledge-packs/{slug}")
    async def get_user_pack(
        slug: str,
        authorization: str = Header(default=""),
    ):
        user = await ctx.auth.get_current_user(authorization)
        try:
            slug_clean = validate_slug(slug)
        except ValueError as e:
            raise HTTPException(400, str(e))
        pack = get_pack(ctx.model_ctx.participants_dir, user.username, slug_clean)
        if pack is None:
            raise HTTPException(404, f"Knowledge pack {slug_clean!r} not found")
        return pack.model_dump()

    @router.put("/knowledge-packs/{slug}")
    async def update_user_pack(
        slug: str,
        name: Optional[str] = Body(None, embed=True),
        description: Optional[str] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Patch a pack's *metadata* (name / description). File-level edits go
        through ``PUT /knowledge-packs/{slug}/files/{filename}``."""
        user = await ctx.auth.get_current_user(authorization)
        try:
            slug_clean = validate_slug(slug)
        except ValueError as e:
            raise HTTPException(400, str(e))

        pack = await update_pack(
            ctx.model_ctx.participants_dir,
            user.username,
            slug_clean,
            name=(name.strip() if isinstance(name, str) else None),
            description=(description.strip() if isinstance(description, str) else None),
        )
        if pack is None:
            raise HTTPException(404, f"Knowledge pack {slug_clean!r} not found")

        # Metadata edits also affect installed copies (the index file shows
        # name + description), so fan out a fresh install snapshot.
        for agent_id in _agents_with_pack_installed(slug_clean, user.id):
            await _broadcast_install(agent_id, pack)

        return pack.model_dump()

    @router.put("/knowledge-packs/{slug}/files/{filepath:path}")
    async def upsert_pack_file(
        slug: str,
        filepath: str,
        content_b64: str = Body(..., embed=True),
        description: Optional[str] = Body(None, embed=True),
        authorization: str = Header(default=""),
    ):
        """Add or replace a single file inside a pack. ``filepath`` may contain
        ``/`` separators for nested files; ``content_b64`` is base64-encoded
        raw bytes. Optional ``description`` sets the file's "consult when" hint
        in the installed-pack index (omit to leave an existing hint untouched)."""
        user = await ctx.auth.get_current_user(authorization)
        try:
            slug_clean = validate_slug(slug)
            filepath_clean = validate_filepath(filepath)
        except ValueError as e:
            raise HTTPException(400, str(e))

        try:
            pack = await upsert_file(
                ctx.model_ctx.participants_dir,
                user.username,
                slug_clean,
                filepath_clean,
                content_b64 or "",
                description=(description.strip() if isinstance(description, str) else None),
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        if pack is None:
            raise HTTPException(404, f"Knowledge pack {slug_clean!r} not found")

        for agent_id in _agents_with_pack_installed(slug_clean, user.id):
            await _broadcast_install(agent_id, pack)

        return pack.model_dump()

    @router.delete("/knowledge-packs/{slug}/files/{filepath:path}")
    async def delete_pack_file(
        slug: str,
        filepath: str,
        authorization: str = Header(default=""),
    ):
        """Delete a single file from a pack. ``filepath`` may be nested."""
        user = await ctx.auth.get_current_user(authorization)
        try:
            slug_clean = validate_slug(slug)
            filepath_clean = validate_filepath(filepath)
        except ValueError as e:
            raise HTTPException(400, str(e))

        pack = await delete_file(
            ctx.model_ctx.participants_dir,
            user.username,
            slug_clean,
            filepath_clean,
        )
        if pack is None:
            raise HTTPException(404, f"File {filepath_clean!r} not found in pack {slug_clean!r}")

        for agent_id in _agents_with_pack_installed(slug_clean, user.id):
            await _broadcast_install(agent_id, pack)

        return pack.model_dump()

    @router.delete("/knowledge-packs/{slug}")
    async def delete_user_pack(
        slug: str,
        authorization: str = Header(default=""),
    ):
        """Delete a pack, cascading uninstall to every agent that has it."""
        user = await ctx.auth.get_current_user(authorization)
        try:
            slug_clean = validate_slug(slug)
        except ValueError as e:
            raise HTTPException(400, str(e))

        # Resolve installs FIRST so we can fan out after the registry delete.
        installed_on = _agents_with_pack_installed(slug_clean, user.id)

        existed = await delete_pack(ctx.model_ctx.participants_dir, user.username, slug_clean)
        if not existed:
            raise HTTPException(404, f"Knowledge pack {slug_clean!r} not found")

        # Strip from each agent's installed list and broadcast uninstall.
        async with _install_lock:
            for agent_id in installed_on:
                installed = _read_installed_packs(agent_id)
                if slug_clean in installed:
                    installed.remove(slug_clean)
                    _write_installed_packs(agent_id, installed)

        for agent_id in installed_on:
            await _broadcast_uninstall(agent_id, slug_clean)

        return {"status": "deleted", "slug": slug_clean, "uninstalled_from": installed_on}

    # ─────────────────────────────────────────────────────────
    # Per-agent install/uninstall + listing
    # ─────────────────────────────────────────────────────────

    @router.get("/agents/{agent_id}/knowledge-packs")
    async def get_agent_packs(
        agent_id: str,
        have: str = "",
        authorization: str = Header(default=""),
    ):
        """List packs installed on an agent — full payload for runner catch-up.

        Accepts agent self-token (runner) or user JWT (web UI).

        ``have`` (optional, base64url JSON ``{slug: updated_at}``) is the
        versions the runner already holds. A pack whose ``updated_at`` matches
        comes back as a stub ``{slug, updated_at, unchanged: true}`` with no
        files, so an unchanged catch-up ships no pack content. Every pack write
        path bumps ``updated_at``. A slug missing from the list still means
        "uninstall". Absent or malformed ``have`` → today's full payload.
        """
        await ctx.auth.authorize_agent_self_or_owner(agent_id, authorization)

        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")

        installed_slugs = _read_installed_packs(agent_id)
        owner = User.get(agent.registered_by, ctx.model_ctx) if agent.registered_by else None
        if owner is None:
            return {"installed_packs": []}
        held = decode_pack_versions(have)
        out: list[dict] = []
        for slug in installed_slugs:
            if slug in held:
                updated_at = get_pack_updated_at(
                    ctx.model_ctx.participants_dir, owner.username, slug
                )
                if updated_at is not None and updated_at == held[slug]:
                    out.append({"slug": slug, "updated_at": updated_at, "unchanged": True})
                    continue
            pack = get_pack(ctx.model_ctx.participants_dir, owner.username, slug)
            if pack is None:
                # Stale install — registry entry deleted but agent's file still
                # references it. Skip; the runner's sync will drop the local
                # file because it isn't in the response.
                continue
            out.append(pack.model_dump())
        return {"installed_packs": out}

    @router.post("/agents/{agent_id}/knowledge-packs")
    async def install_packs(
        agent_id: str,
        packs: list[str] = Body(..., embed=True),
        authorization: str = Header(default=""),
    ):
        """Install one or more packs on an agent. Owner-only."""
        current_user = await ctx.auth.get_current_user(authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if agent.registered_by != current_user.id:
            raise HTTPException(403, "Only the agent owner can install knowledge packs")

        # Resolve every requested slug against the AGENT OWNER's pack
        # registry (cross-user packs are out of scope).
        owner = User.get(agent.registered_by, ctx.model_ctx) if agent.registered_by else None
        if owner is None:
            raise HTTPException(404, f"Agent {agent_id!r} has no resolvable owner")
        validated: list = []
        for raw_slug in packs:
            try:
                slug_clean = validate_slug(raw_slug)
            except ValueError as e:
                raise HTTPException(400, str(e))
            pack = get_pack(ctx.model_ctx.participants_dir, owner.username, slug_clean)
            if pack is None:
                raise HTTPException(404, f"Knowledge pack {slug_clean!r} not found in registry")
            validated.append(pack)

        async with _install_lock:
            installed = _read_installed_packs(agent_id)
            new_packs = [p for p in validated if p.slug not in installed]
            if not new_packs:
                return {"installed_packs": installed, "added": []}
            installed.extend(p.slug for p in new_packs)
            _write_installed_packs(agent_id, installed)

        for pack in new_packs:
            await _broadcast_install(agent_id, pack)

        return {
            "installed_packs": installed,
            "added": [p.slug for p in new_packs],
        }

    @router.delete("/agents/{agent_id}/knowledge-packs/{slug}")
    async def uninstall_pack(
        agent_id: str,
        slug: str,
        authorization: str = Header(default=""),
    ):
        """Uninstall a single pack from an agent."""
        current_user = await ctx.auth.get_current_user(authorization)
        agent = Agent.get(agent_id, ctx.model_ctx)
        if agent is None:
            raise HTTPException(404, f"Agent {agent_id!r} not found")
        if agent.registered_by != current_user.id:
            raise HTTPException(403, "Only the agent owner can uninstall knowledge packs")
        try:
            slug_clean = validate_slug(slug)
        except ValueError as e:
            raise HTTPException(400, str(e))

        async with _install_lock:
            installed = _read_installed_packs(agent_id)
            if slug_clean not in installed:
                raise HTTPException(404, f"Knowledge pack {slug_clean!r} is not installed for this agent")
            installed.remove(slug_clean)
            _write_installed_packs(agent_id, installed)

        await _broadcast_uninstall(agent_id, slug_clean)
        return {"installed_packs": installed, "removed": slug_clean}

    # ─────────────────────────────────────────────────────────
    # Broadcast helpers
    # ─────────────────────────────────────────────────────────

    async def _broadcast_install(agent_id: str, pack) -> None:
        agent = Agent.get(agent_id, ctx.model_ctx)
        agent_name = agent.name if agent else agent_id
        envelope = ControlEnvelope(
            type=ControlMessageType.KNOWLEDGE_PACK_SYNC,
            payload=KnowledgePackSyncPayload(
                agent_id=agent_id,
                agent_name=agent_name,
                action="install",
                pack_slug=pack.slug,
                pack_name=pack.name,
                pack_description=pack.description,
                pack_files={path: pf.model_dump() for path, pf in pack.files.items()},
                pack_updated_at=pack.updated_at,
            ),
        )
        if await ctx.ws_hub.send_to(agent_id, envelope):
            logger.info(
                f"Sent KNOWLEDGE_PACK_SYNC(install) for {pack.slug} "
                f"({len(pack.files)} files) to agent {agent_name}"
            )

    async def _broadcast_uninstall(agent_id: str, slug: str) -> None:
        agent = Agent.get(agent_id, ctx.model_ctx)
        agent_name = agent.name if agent else agent_id
        envelope = ControlEnvelope(
            type=ControlMessageType.KNOWLEDGE_PACK_SYNC,
            payload=KnowledgePackSyncPayload(
                agent_id=agent_id,
                agent_name=agent_name,
                action="uninstall",
                pack_slug=slug,
            ),
        )
        if await ctx.ws_hub.send_to(agent_id, envelope):
            logger.info(f"Sent KNOWLEDGE_PACK_SYNC(uninstall) for {slug} to agent {agent_name}")

    return router
