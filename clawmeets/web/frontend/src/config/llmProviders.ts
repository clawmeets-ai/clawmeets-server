// Single source of truth for the agent's LLM provider options.
//
// The composer <ModelSelector> and the Agent Settings page both consume this
// list so the two surfaces can never drift. The model lives at the AGENT level
// (`card.json.local_settings.llm_provider`), so picking a model in a composer
// is just a quick-edit shortcut for the same `PUT /agents/{id}` that Settings
// performs — never a per-message override.
//
// Two tiers, encoded in the provider id (see CLAUDE.md → "LLM provider
// selection"): bare `claude`/`openai`/`gemini`/`opencode`/`antigravity` shell a
// local Code CLI ("cli"); the `-api` suffix selects the in-process BYO-key
// provider ("api"), configured with a model slug + API key + server URL.
//
// This file is the frontend's ONLY enumeration of provider ids. `types/index.ts`,
// `api/endpoints/agents.ts` and the Create Agent form all defer to it; adding a
// provider is an edit HERE and nowhere else. `llmProviders.test.ts` fails if a
// second list ever reappears, and pins the id set against
// `providerIds.fixture.json` — the same fixture the backend drift gate greps.

export type LlmProviderId =
  | 'smart'
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'opencode'
  | 'antigravity'
  | 'claude-api'
  | 'openai-api'
  | 'gemini-api'
  | 'openrouter-api'
  | 'openrouter-native'

/** `cli` picks immediately; `api` opens a config dialog before it can be active. */
export type LlmProviderKind = 'cli' | 'api'

export interface LlmProviderOption {
  id: LlmProviderId
  /** Compact label for the composer chip + menu row. */
  label: string
  /** Longer descriptor used as the menu-row subtitle / Settings option text. */
  description: string
  kind: LlmProviderKind
  /** Placeholder for the model-slug field (mirrors Agent Settings). */
  modelPlaceholder?: string
  /**
   * Vendor/tech slug shown as the mono subtitle on the Create Agent form's
   * provider tiles. Optional; that form falls back to `id` when absent. Exists
   * so the form can consume this catalog instead of keeping its own copy.
   */
  vendor?: string
  /**
   * Meta-provider: routes across the agent's OTHER configs instead of calling
   * a model. Settings presents it as a mode toggle, never as a config row or a
   * provider choice (mirrors `ROUTER_PROVIDERS` in models/model_config.py).
   */
  router?: boolean
}

export const LLM_PROVIDERS: LlmProviderOption[] = [
  { id: 'smart', label: 'Smart routing', description: 'Use named model configs in priority order with safe fallback', kind: 'cli', vendor: 'automatic', router: true },
  { id: 'claude', label: 'Claude', description: 'Claude (Anthropic) — Code CLI', kind: 'cli', modelPlaceholder: 'leave blank for default', vendor: 'anthropic' },
  { id: 'openai', label: 'OpenAI', description: 'OpenAI — Codex CLI', kind: 'cli', modelPlaceholder: 'e.g. o3', vendor: 'openai' },
  { id: 'gemini', label: 'Gemini', description: 'Gemini (Google) — CLI', kind: 'cli', modelPlaceholder: 'e.g. gemini-2.5-pro', vendor: 'google' },
  { id: 'opencode', label: 'OpenCode', description: 'OpenCode — Zen gateway (provider/model slug)', kind: 'cli', modelPlaceholder: 'e.g. opencode/deepseek-v4-flash-free' },
  { id: 'antigravity', label: 'Antigravity', description: 'Antigravity (Google) — agy CLI', kind: 'cli', modelPlaceholder: 'e.g. gemini-3.1-pro-high', vendor: 'google' },
  { id: 'claude-api', label: 'Claude API', description: 'Claude — bring your own API key', kind: 'api', modelPlaceholder: 'e.g. claude-sonnet-4-6' },
  { id: 'openai-api', label: 'OpenAI API', description: 'OpenAI — bring your own API key', kind: 'api', modelPlaceholder: 'e.g. gpt-5' },
  { id: 'gemini-api', label: 'Gemini API', description: 'Gemini — bring your own API key', kind: 'api', modelPlaceholder: 'e.g. gemini-2.5-pro' },
  { id: 'openrouter-api', label: 'OpenRouter', description: 'OpenRouter — BYO key (slug or fallback chain)', kind: 'api', modelPlaceholder: 'e.g. anthropic/claude-opus-4-8' },
  { id: 'openrouter-native', label: 'OpenRouter (native)', description: 'OpenRouter — native provider, BYO key (slug or fallback chain)', kind: 'api', modelPlaceholder: 'e.g. anthropic/claude-opus-4-8' },
]

export const DEFAULT_LLM_PROVIDER: LlmProviderId = 'claude'

export const CLI_PROVIDERS = LLM_PROVIDERS.filter((p) => p.kind === 'cli')
export const API_PROVIDERS = LLM_PROVIDERS.filter((p) => p.kind === 'api')

/** Providers a user can pick for a single model config (everything but routers). */
export const MODEL_PROVIDERS = LLM_PROVIDERS.filter((p) => !p.router)

export function isRouterProvider(id: string | undefined | null): boolean {
  return !!getLlmProvider(id)?.router
}

export function getLlmProvider(id: string | undefined | null): LlmProviderOption | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id)
}

/**
 * Single switch for "must a per-model-config carry an API key to be saved?"
 * (move-apikey-to-model-config, owner-locked Option A). Under the REQUIRED
 * policy a key-based (`kind:'api'`) provider must have a key to save — the
 * dialog blocks Save + shows an inline "API key is required" when none will
 * exist post-save, and refuses Clear for such a provider. CLI-tier providers
 * (`kind:'cli'`) never require a key under either setting. Flip to `false` to
 * relax — no other code changes needed.
 */
export const KEY_REQUIRED_POLICY: boolean = true

/**
 * True iff a config for this provider must carry an API key to be saved: the
 * provider is key-based (`kind:'api'`) AND the REQUIRED policy is on. The set
 * of key-based ids — claude-api / openai-api / gemini-api / openrouter-api /
 * openrouter-native — is exactly the `kind:'api'` catalog entries, matching the
 * backend's key-required provider list.
 */
export function providerRequiresKey(id: LlmProviderId): boolean {
  return KEY_REQUIRED_POLICY && getLlmProvider(id)?.kind === 'api'
}
