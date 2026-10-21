import { useEffect, useMemo, useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { ModelConfig } from '../../types'
import {
  MODEL_PROVIDERS,
  getLlmProvider,
  providerRequiresKey,
  type LlmProviderId,
} from '../../config/llmProviders'
import type {
  CreateModelConfigInput,
  UpdateModelConfigInput,
} from '../../api/endpoints/modelConfigs'

/**
 * Add / edit modal for a named model config (model-config-selection-revamp,
 * spec #1). Fields: name (required, `^[A-Za-z0-9 _-]{1,64}$`), provider (from the
 * shared MODEL_PROVIDERS catalog — smart routing is a mode on the section, not a
 * choice here), model slug (optional), base_url (optional, local/gateway), and — for key-based (`kind:'api'`) providers — a per-config
 * API key (move-apikey-to-model-config). The key moved DOWN here from the old
 * agent-level section; each config now carries its own key.
 *
 * In edit mode the form pre-fills from `initial`; changing `name` performs a
 * rename (the caller PATCHes). `onSave` returns a create OR partial-update body.
 *
 * The API key is a 3-state machine so the PATCH body is unambiguous:
 *   'unchanged' → OMIT api_key           (edit only; a key is already stored)
 *   'set'       → api_key: "<typed>"     (or OMIT when the typed value is empty)
 *   'clear'     → api_key: ""            (explicit clear of a stored key)
 * The raw key is never read back (GET redacts it) — the masked "Key saved" chip
 * is driven purely by `initial.api_key_set`.
 *
 * Validation errors surface two ways: `error` (a generic banner message) and
 * `errorField` (attaches that message inline to 'name' or 'api_key'), both
 * supplied by the caller's mutation (409 duplicate name, 422 api_key required).
 */
type KeyMode = 'unchanged' | 'set' | 'clear'

export default function ModelConfigDialog({
  mode,
  initial,
  saving,
  error,
  errorField,
  keylessOnly = false,
  onSave,
  onCancel,
}: {
  mode: 'create' | 'edit'
  initial?: ModelConfig
  saving: boolean
  error: string | null
  errorField?: 'name' | 'api_key' | null
  /** Offer only providers that need no API key (the user's default stores none). */
  keylessOnly?: boolean
  onSave: (input: CreateModelConfigInput | UpdateModelConfigInput) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [provider, setProvider] = useState<LlmProviderId>(initial?.provider ?? 'claude')
  const [model, setModel] = useState(initial?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '')

  // A key is already stored for THIS config (edit + api_key_set). Independent of
  // the provider dropdown, so switching between two -api providers keeps it.
  const hasStoredKey = mode === 'edit' && !!initial?.api_key_set
  const [keyMode, setKeyMode] = useState<KeyMode>(hasStoredKey ? 'unchanged' : 'set')
  const [apiKey, setApiKey] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const trimmedName = name.trim()
  const nameValid = /^[A-Za-z0-9 _-]{1,64}$/.test(trimmedName)

  const providerOpt = getLlmProvider(provider)
  // base_url is effective ONLY for the in-process `-api` providers; the key
  // field follows the same gating (key-based providers only).
  const isKeyProvider = providerOpt?.kind === 'api'
  const baseUrlEffective = isKeyProvider
  const keyRequired = providerRequiresKey(provider) // false for CLI providers

  // A required key is satisfied when a key will exist AFTER save: either an
  // untouched/replaced stored key, or a freshly typed non-empty value.
  const keySatisfied =
    (hasStoredKey && keyMode !== 'clear') || (keyMode === 'set' && apiKey.trim() !== '')
  const keyError = isKeyProvider && keyRequired && !keySatisfied
    ? 'API key is required for this provider.'
    : null

  const canSave = nameValid && !saving && !keyError

  // Assemble ONLY the api_key portion of the body (tri-state — see header).
  const buildApiKeyPatch = (): Partial<CreateModelConfigInput> => {
    if (!isKeyProvider) {
      // Provider switched to CLI: clear an orphaned stored secret; else nothing.
      return hasStoredKey ? { api_key: '' } : {}
    }
    if (keyMode === 'unchanged') return {} // omit → leave unchanged
    if (keyMode === 'clear') return { api_key: '' } // explicit clear
    const t = apiKey.trim() // keyMode === 'set'
    return t ? { api_key: t } : {} // empty typed value → omit, not clear
  }

  const submit = () => {
    if (!canSave) return
    // Empty model / base_url ⇒ null (explicitly cleared), matching the wire
    // contract where a config's model/base_url are `string | null`.
    const body = {
      name: trimmedName,
      provider,
      model: model.trim() || null,
      base_url: baseUrl.trim() || null,
      ...buildApiKeyPatch(),
    }
    onSave(body)
  }

  const nameFieldError = errorField === 'name' ? error : null
  const keyFieldError = keyError ?? (errorField === 'api_key' ? error : null)
  // Generic banner only when the error isn't attached to a specific field.
  const bannerError = error && errorField !== 'name' && errorField !== 'api_key' ? error : null

  // The masked-key chip shows the redacted marker only — never the real key.
  const showKeyInput = isKeyProvider && (mode === 'create' || keyMode === 'set')
  const providerLabel = useMemo(() => providerOpt?.label ?? provider, [providerOpt, provider])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
      >
        <div className="border-b border-gray-100 px-5 py-3.5">
          <h3 className="text-sm font-bold text-gray-800">
            {mode === 'create' ? 'Add model config' : `Edit “${initial?.name}”`}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            {keylessOnly
              ? 'A model new agents start with. Models that need an API key are added on each agent.'
              : 'A named model this agent can use — pick one from the message composer per request.'}
          </p>
        </div>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-700">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Sonnet"
              autoFocus
              className="w-full rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2 text-sm placeholder-gray-400 transition-colors focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20"
            />
            {nameFieldError ? (
              <span className="mt-1 block text-[11px] font-medium text-red-600">{nameFieldError}</span>
            ) : (
              <span className="mt-1 block text-[11px] text-gray-400">
                Letters, numbers, spaces, hyphens, underscores — 1–64 characters.
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-700">Provider</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as LlmProviderId)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm transition-colors focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20"
            >
              {MODEL_PROVIDERS.filter((p) => !keylessOnly || p.kind !== 'api').map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.description}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-700">
              Model slug <span className="font-normal text-gray-400">(optional)</span>
            </span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={providerOpt?.modelPlaceholder || 'leave blank for provider default'}
              className="w-full rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2 text-sm font-mono placeholder-gray-400 transition-colors focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-gray-700">
              Server URL <span className="font-normal text-gray-400">(optional — local / gateway)</span>
            </span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={!baseUrlEffective}
              placeholder="https://api.example.com/v1"
              className="w-full rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2 text-sm font-mono placeholder-gray-400 transition-colors focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
            />
            {!baseUrlEffective && (
              <span className="mt-1 block text-[11px] text-amber-700">
                Server URL is not yet effective for CLI-tier providers — it applies only to the
                in-process BYO-key (<code className="font-mono">-api</code>) providers.
              </span>
            )}
          </label>

          {/* Per-config API key (move-apikey-to-model-config). Shown only for
              key-based providers; the tri-state machine builds the wire body. */}
          {isKeyProvider ? (
            <div className="block">
              <span className="mb-1 flex items-center gap-1 text-xs font-semibold text-gray-700">
                <KeyRound className="h-3 w-3" aria-hidden /> API key
                {keyRequired && <span className="text-red-500" title="Required">*</span>}
              </span>

              {showKeyInput ? (
                <>
                  <input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        submit()
                      }
                    }}
                    placeholder="sk-…"
                    className="w-full rounded-lg border border-gray-200 bg-gray-50/50 px-3 py-2 text-sm font-mono placeholder-gray-400 transition-colors focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20"
                  />
                  {hasStoredKey && (
                    <button
                      type="button"
                      onClick={() => {
                        setApiKey('')
                        setKeyMode('unchanged')
                      }}
                      className="mt-1 text-[11px] font-semibold text-gray-500 underline underline-offset-2 hover:text-gray-700"
                    >
                      Keep the current key instead
                    </button>
                  )}
                </>
              ) : keyMode === 'clear' ? (
                <div className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                  <span className="text-xs font-medium text-amber-800">
                    Key will be cleared on save
                  </span>
                  <button
                    type="button"
                    onClick={() => setKeyMode('unchanged')}
                    className="text-[11px] font-bold text-amber-800 underline underline-offset-2 hover:text-amber-900"
                  >
                    Undo
                  </button>
                </div>
              ) : (
                /* keyMode === 'unchanged' with a stored key */
                <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                    <KeyRound className="h-3 w-3" aria-hidden /> •••• Key saved
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setApiKey('')
                        setKeyMode('set')
                      }}
                      className="text-[11px] font-bold text-emerald-700 underline underline-offset-2 hover:text-emerald-800"
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => setKeyMode('clear')}
                      disabled={keyRequired}
                      title={keyRequired ? `${providerLabel} requires an API key` : 'Clear the stored key'}
                      className="text-[11px] font-bold text-red-600 underline underline-offset-2 hover:text-red-700 disabled:cursor-not-allowed disabled:text-gray-300 disabled:no-underline"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}

              {keyFieldError ? (
                <span className="mt-1 block text-[11px] font-medium text-red-600">{keyFieldError}</span>
              ) : (
                <span className="mt-1 block text-[11px] text-gray-400">
                  Stored write-only for this config — never shown again after saving. Replace or
                  clear it above.
                </span>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-gray-400">
              This provider runs through a local CLI and does not use an API key.
            </p>
          )}

          {bannerError && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {bannerError}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-bold text-gray-700 transition-colors hover:border-gray-300 hover:text-gray-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSave}
            className="rounded-lg bg-accent px-3.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-accent-deep disabled:opacity-50"
          >
            {saving ? 'Saving…' : mode === 'create' ? 'Add' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
