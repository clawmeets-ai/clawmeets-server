# SPDX-License-Identifier: BUSL-1.1
"""
clawmeets/server/routes/model_defaults.py

The user's default model config (``models/model_defaults.py``): what every new
agent starts with, and "apply my default to all my agents".

The per-config routes deliberately mirror ``/agents/{id}/model-configs`` path
for path (``/me/model-defaults`` + ``/{name}``, ``/default``, ``/order``,
``/routing``), so the web editor drives either target with the same calls.
``PUT /me/model-defaults`` replaces the whole record in one call (the
installer's path).

Auth: the user's JWT or their assistant's token (``resolve_user_from_credential``)
— the same pair that may change any of the user's agents. A worker's own token
is refused: it may change its own config, never its owner's default.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel, Field

from clawmeets.api.responses import (
    ModelConfig,
    ModelConfigCreate,
    ModelConfigList,
    ModelConfigOrderBody,
    ModelConfigPatch,
    SetDefaultBody,
    SmartRoutingPatch,
)
from clawmeets.models import model_config as _mc
from clawmeets.models import model_defaults as _md
from clawmeets.models.agent import Agent
from clawmeets.server.routes import agents as _agents_routes

if TYPE_CHECKING:
    from clawmeets.server.context import ServerContext

logger = logging.getLogger("clawmeets.server.model_defaults")


class ModelDefaults(ModelConfigList):
    """``ModelConfigList`` plus whether the user has set a default at all
    (an empty list with ``configured=false`` means "never set": new agents
    still get the old per-server probe)."""
    configured: bool = False
    updated_at: Optional[str] = None


class ModelDefaultsPut(BaseModel):
    """PUT /me/model-defaults — the whole record, in priority order."""
    configs: list[ModelConfigCreate]
    default: Optional[str] = None
    routing: Optional[SmartRoutingPatch] = None


class ApplyRequest(BaseModel):
    dry_run: bool = False
    # Agents carrying any of these teams are skipped (model agents exist to be
    # one specific model). Pass [] to include them.
    exclude_teams: list[str] = Field(default_factory=lambda: list(_md.DEFAULT_EXCLUDED_TEAMS))
    # Limit to these agents (ids or full names); omitted = every owned agent.
    agents: Optional[list[str]] = None


class AppliedAgent(BaseModel):
    agent_id: str
    agent_name: str
    removed: list[str] = Field(default_factory=list)
    kept: list[str] = Field(default_factory=list)


class SkippedAgent(BaseModel):
    agent_id: str
    agent_name: str
    reason: str


class ApplyResult(BaseModel):
    dry_run: bool
    changed: list[AppliedAgent] = Field(default_factory=list)
    unchanged: list[str] = Field(default_factory=list)
    skipped: list[SkippedAgent] = Field(default_factory=list)


def create_model_defaults_router(ctx: "ServerContext") -> APIRouter:
    router = APIRouter(tags=["model-defaults"])
    base_dir = lambda: ctx.model_ctx.base_dir  # noqa: E731 — read at call time
    # One writer per process; per-user files, so one lock is plenty.
    lock = asyncio.Lock()

    def _response(record: Optional[dict]) -> ModelDefaults:
        record = record or _md.empty_record()
        configs, default = _mc.list_configs(record)
        return ModelDefaults(
            configs=configs,
            default=default,
            routing=_mc.routing_settings(record),
            configured=_md.is_configured(record),
            updated_at=record.get("updated_at"),
        )

    async def _mutate(authorization: str, mutate):
        user = await ctx.auth.resolve_user_from_credential(authorization)
        try:
            async with lock:
                record = _md.load(base_dir(), user.id) or _md.empty_record()
                result = mutate(record)
                _md.save(base_dir(), user.id, record)
        except _mc.DuplicateConfigError as e:
            raise HTTPException(409, str(e))
        except _mc.ConfigNotFoundError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(422, str(e))
        return record, result

    @router.get("/me/model-defaults", response_model=ModelDefaults)
    async def get_model_defaults(authorization: str = Header(default="")):
        user = await ctx.auth.resolve_user_from_credential(authorization)
        return _response(_md.load(base_dir(), user.id))

    @router.put("/me/model-defaults", response_model=ModelDefaults)
    async def put_model_defaults(
        body: ModelDefaultsPut = Body(...),
        authorization: str = Header(default=""),
    ):
        """Replace the whole default (the installer's call). 422 on an API
        key, a keyed provider, a duplicate name or an unknown default."""
        routing = body.routing or SmartRoutingPatch()

        def replace(record: dict) -> None:
            built = _md.build_record(
                [c.model_dump() for c in body.configs],
                body.default,
                max_attempts=routing.max_attempts,
                cooldown_seconds=routing.cooldown_seconds,
            )
            record.clear()
            record.update(built)

        record, _ = await _mutate(authorization, replace)
        return _response(record)

    @router.delete("/me/model-defaults", status_code=204)
    async def delete_model_defaults(authorization: str = Header(default="")):
        user = await ctx.auth.resolve_user_from_credential(authorization)
        async with lock:
            _md.delete(base_dir(), user.id)
        return None

    @router.post("/me/model-defaults", response_model=ModelConfig, status_code=201)
    async def create_default_config(
        body: ModelConfigCreate = Body(...),
        authorization: str = Header(default=""),
    ):
        def add(record: dict) -> dict:
            _md.check_config(body.model_dump())
            return _mc.add_config(record, body.model_dump(), source="default")

        _, created = await _mutate(authorization, add)
        return created

    @router.put("/me/model-defaults/default", response_model=ModelDefaults)
    async def set_default_default(
        body: SetDefaultBody = Body(...),
        authorization: str = Header(default=""),
    ):
        record, _ = await _mutate(authorization, lambda r: _mc.set_default(r, body.name))
        return _response(record)

    @router.put("/me/model-defaults/order", response_model=ModelDefaults)
    async def reorder_defaults(
        body: ModelConfigOrderBody = Body(...),
        authorization: str = Header(default=""),
    ):
        record, _ = await _mutate(authorization, lambda r: _mc.reorder_configs(r, body.names))
        return _response(record)

    @router.put("/me/model-defaults/routing", response_model=ModelDefaults)
    async def set_default_routing(
        body: SmartRoutingPatch = Body(...),
        authorization: str = Header(default=""),
    ):
        record, _ = await _mutate(
            authorization,
            lambda r: _mc.set_routing_settings(
                r, max_attempts=body.max_attempts, cooldown_seconds=body.cooldown_seconds,
            ),
        )
        return _response(record)

    @router.post("/me/model-defaults/apply", response_model=ApplyResult)
    async def apply_model_defaults(
        body: ApplyRequest = Body(default_factory=ApplyRequest),
        authorization: str = Header(default=""),
    ):
        """Copy the default onto the caller's existing agents.

        Skips agents in ``exclude_teams`` (default: Model agents). On each
        changed agent the keyless configs are replaced and keyed ones kept
        after the default's (``model_defaults.apply_default_to_card``), then
        AGENT_SETTINGS_CHANGE goes to its runner so it switches on its next
        turn. ``dry_run`` reports the same lists and changes nothing."""
        user = await ctx.auth.resolve_user_from_credential(authorization)
        record = _md.load(base_dir(), user.id)
        if not _md.is_configured(record):
            raise HTTPException(409, "set a default model config first")

        wanted = {a.strip() for a in body.agents or [] if a and a.strip()}
        excluded = set(body.exclude_teams)
        result = ApplyResult(dry_run=body.dry_run)
        owned = [
            a for a in Agent.list_all(ctx.model_ctx, discoverable_only=False, include_private=True)
            if a.registered_by == user.id and "~" not in a.id
        ]
        for agent in sorted(owned, key=lambda a: a.name or ""):
            if wanted and agent.id not in wanted and agent.name not in wanted \
                    and agent.short_name_for(user.username) not in wanted:
                continue
            teams = set(agent.user_teams or [])
            if teams & excluded:
                result.skipped.append(SkippedAgent(
                    agent_id=agent.id, agent_name=agent.name,
                    reason=f"team {sorted(teams & excluded)[0]!r}",
                ))
                continue
            async with _agents_routes._agent_write_lock:
                card = agent._load_card()
                outcome = _md.apply_default_to_card(card, record)
                if outcome["changed"] and not body.dry_run:
                    agent.update_card(
                        model_configs=card.get("model_configs") or [],
                        default_model_config_name=card.get("default_model_config_name"),
                        local_settings=card.get("local_settings") or {},
                    )
            if not outcome["changed"]:
                result.unchanged.append(agent.name)
                continue
            result.changed.append(AppliedAgent(
                agent_id=agent.id, agent_name=agent.name,
                removed=outcome["removed"], kept=outcome["kept"],
            ))
            if not body.dry_run:
                await _agents_routes.emit_model_config_change(ctx, agent, card)
        if not body.dry_run and result.changed:
            logger.info(
                "applied model default for %s to %d agent(s)",
                user.username, len(result.changed),
            )
        return result

    # Per-config routes LAST: "/me/model-defaults/{name}" must not shadow the
    # fixed paths above.
    @router.patch("/me/model-defaults/{name}", response_model=ModelConfig)
    async def update_default_config(
        name: str,
        body: ModelConfigPatch = Body(...),
        authorization: str = Header(default=""),
    ):
        patch = body.model_dump(exclude_unset=True)
        if patch.get("api_key"):
            raise HTTPException(422, "the default model config cannot store an API key")
        patch.pop("api_key", None)
        # A keyed provider is refused by validate_record on save (422).
        _, updated = await _mutate(authorization, lambda r: _mc.update_config(r, name, patch))
        return updated

    @router.delete("/me/model-defaults/{name}", status_code=204)
    async def delete_default_config(name: str, authorization: str = Header(default="")):
        await _mutate(authorization, lambda r: _mc.remove_config(r, name))
        return None

    return router
