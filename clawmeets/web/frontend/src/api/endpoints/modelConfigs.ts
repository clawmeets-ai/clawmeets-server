// Typed client for the per-agent named model-config endpoints
// (model-config-selection-revamp, spec #1). All routes live under the agents
// router; auth = agent-self / owner JWT / owner's -assistant — a
// foreign user gets 403. The wire contract is LOCKED (see the milestone-1
// frontend plan §2a); this module is the single place the paths + bodies live.

import { get, post, patch, put, delNoContent, ApiError } from '../client'
import type { LlmProviderId } from '../../config/llmProviders'
import type { ModelConfig } from '../../types'

/** Body for POST (create). `name` + `provider` required; `model`/`base_url` optional. */
export interface CreateModelConfigInput {
  name: string
  provider: LlmProviderId
  model?: string | null
  base_url?: string | null
  /**
   * Write-only per-config API key (move-apikey-to-model-config). REQUIRED on
   * create for key-based (`kind:'api'`) providers — the backend 422s
   * ("api_key is required") if empty, and the dialog blocks Save before the
   * call. Optional for CLI-tier providers. Never returned by a read (GET
   * exposes only `ModelConfig.api_key_set`).
   */
  api_key?: string | null
}

/**
 * Body for PATCH (partial update). Every key optional; only provided keys
 * change. A new `name` renames the config. Send `model: null` / `base_url: null`
 * to CLEAR a field (distinct from omitting it, which leaves it untouched).
 *
 * Tri-state on `api_key`: OMIT the field to leave the stored key unchanged;
 * send a non-empty string to set/replace it; send `""` to clear it.
 */
export type UpdateModelConfigInput = Partial<CreateModelConfigInput>

/** Smart-routing knobs (stored server-side in `local_settings.smart_*`). */
export interface SmartRoutingSettings {
  /** How many routes one request may try (1–10). */
  max_attempts: number
  /** How long a failed route is skipped, in seconds (0–86400). */
  cooldown_seconds: number
}

/**
 * GET / PUT-default / PUT-order / PUT-routing response envelope. `default` is a
 * config NAME (or null when empty). `configs` is in stored order, which is
 * the smart-routing priority.
 */
export interface ModelConfigList {
  configs: ModelConfig[]
  default: string | null
  routing: SmartRoutingSettings
}

export function getModelConfigs(agentId: string): Promise<ModelConfigList> {
  return get<ModelConfigList>(`/agents/${agentId}/model-configs`)
}

export function createModelConfig(
  agentId: string,
  body: CreateModelConfigInput,
): Promise<ModelConfig> {
  return post<ModelConfig>(`/agents/${agentId}/model-configs`, body)
}

// PATCH (partial). `name` is the CURRENT key; `body.name`, if present, renames.
export function updateModelConfig(
  agentId: string,
  name: string,
  body: UpdateModelConfigInput,
): Promise<ModelConfig> {
  return patch<ModelConfig>(
    `/agents/${agentId}/model-configs/${encodeURIComponent(name)}`,
    body,
  )
}

// DELETE → 204, no body. NEVER 409 — delete is always allowed. Deleting the
// default auto-promotes the first remaining config; deleting the last leaves
// default=null. 404 only if the name is absent.
export function deleteModelConfig(agentId: string, name: string): Promise<void> {
  return delNoContent(
    `/agents/${agentId}/model-configs/${encodeURIComponent(name)}`,
  )
}

// PUT /default with a { name } body (NOT /{name}/default). Returns the whole
// { configs, default } so the caller re-derives the star badge from one response.
export function setDefaultModelConfig(
  agentId: string,
  name: string,
): Promise<ModelConfigList> {
  return put<ModelConfigList>(`/agents/${agentId}/model-configs/default`, {
    name,
  })
}

// PUT /order with every config name, highest routing priority first. 422 if
// the list is partial, repeats a name or names an unknown config.
export function reorderModelConfigs(
  agentId: string,
  names: string[],
): Promise<ModelConfigList> {
  return put<ModelConfigList>(`/agents/${agentId}/model-configs/order`, { names })
}

// PUT /routing — omitted fields stay unchanged; 422 when out of range.
export function setSmartRouting(
  agentId: string,
  body: Partial<SmartRoutingSettings>,
): Promise<ModelConfigList> {
  return put<ModelConfigList>(`/agents/${agentId}/model-configs/routing`, body)
}

// ─── The user's default model config (/me/model-defaults) ───────────────────
// What every new agent starts with (a COPY, made at registration). The routes
// mirror the per-agent ones path for path; the default stores no API keys, so
// key-based providers are refused (422).

/** Which config list an editor drives: one agent's, or the user's default. */
export type ModelConfigTarget = { kind: 'agent'; agentId: string } | { kind: 'userDefault' }

/** GET /me/model-defaults — `configured=false` means the user never set one. */
export interface ModelDefaults extends ModelConfigList {
  configured: boolean
  updated_at: string | null
}

const DEFAULTS = '/me/model-defaults'

export function getModelDefaults(): Promise<ModelDefaults> {
  return get<ModelDefaults>(DEFAULTS)
}

export function createDefaultConfig(body: CreateModelConfigInput): Promise<ModelConfig> {
  return post<ModelConfig>(DEFAULTS, body)
}

export function updateDefaultConfig(name: string, body: UpdateModelConfigInput): Promise<ModelConfig> {
  return patch<ModelConfig>(`${DEFAULTS}/${encodeURIComponent(name)}`, body)
}

export function deleteDefaultConfig(name: string): Promise<void> {
  return delNoContent(`${DEFAULTS}/${encodeURIComponent(name)}`)
}

export function setDefaultDefaultConfig(name: string): Promise<ModelDefaults> {
  return put<ModelDefaults>(`${DEFAULTS}/default`, { name })
}

export function reorderDefaultConfigs(names: string[]): Promise<ModelDefaults> {
  return put<ModelDefaults>(`${DEFAULTS}/order`, { names })
}

export function setDefaultSmartRouting(body: Partial<SmartRoutingSettings>): Promise<ModelDefaults> {
  return put<ModelDefaults>(`${DEFAULTS}/routing`, body)
}

export interface ApplyModelDefaultsInput {
  dry_run?: boolean
  /** Agents in any of these teams are skipped. Server default: ["Model agents"]. */
  exclude_teams?: string[]
  /** Only these agents (ids or names). Omitted = every agent the user owns. */
  agents?: string[]
}

export interface ApplyModelDefaultsResult {
  dry_run: boolean
  changed: { agent_id: string; agent_name: string; removed: string[]; kept: string[] }[]
  unchanged: string[]
  skipped: { agent_id: string; agent_name: string; reason: string }[]
}

/**
 * Copy the default onto existing agents. Each changed agent keeps its configs
 * that hold an API key (after the default's) and switches on its next turn.
 * `dry_run` returns the same lists and changes nothing. 409 when no default.
 */
export function applyModelDefaults(body: ApplyModelDefaultsInput): Promise<ApplyModelDefaultsResult> {
  return post<ApplyModelDefaultsResult>(`${DEFAULTS}/apply`, body)
}

/**
 * Human-readable message for a model-config API error, covering BOTH FastAPI
 * error shapes: a 4xx HTTPException `{ detail: "message" }` and a 422 Pydantic
 * `{ detail: [{ loc, msg, type }] }` list. `ApiError.message` already
 * stringifies the string form, but a list detail stringifies to
 * "[object Object]", so we flatten the Pydantic list into its `msg` fields here.
 */
export function modelConfigErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.data as { detail?: unknown } | undefined)?.detail
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((d) => (d && typeof d === 'object' ? (d as { msg?: string }).msg : String(d)))
        .filter(Boolean)
      if (msgs.length) return msgs.join('; ')
    }
    // String detail (e.g. 422 "api_key is required", 409 duplicate name) is
    // already stringified onto `err.message` by ApiError.
    return err.message
  }
  return err instanceof Error ? err.message : 'Something went wrong'
}

/**
 * Classify a model-config API error so the dialog can attach it inline to the
 * offending field instead of only rendering a generic banner:
 *   - a 409, or any detail mentioning "duplicate"/"name" → 'name'
 *   - any detail mentioning "api_key" (e.g. the 422 "api_key is required") →
 *     'api_key'
 *   - otherwise → null (caller shows the message as a banner)
 * Matching on the "api_key" substring keeps this robust to the exact 422
 * wording (with or without a trailing "for provider '<p>'").
 */
export function modelConfigErrorField(err: unknown): 'name' | 'api_key' | null {
  if (!(err instanceof ApiError)) return null
  const detail = (err.data as { detail?: unknown } | undefined)?.detail
  const text = (
    Array.isArray(detail)
      ? detail
          .map((d) => (d && typeof d === 'object' ? (d as { msg?: string }).msg : String(d)))
          .join('; ')
      : typeof detail === 'string'
      ? detail
      : err.message
  ).toLowerCase()
  if (text.includes('api_key')) return 'api_key'
  if (err.status === 409 || text.includes('duplicate') || text.includes('already')) return 'name'
  return null
}
