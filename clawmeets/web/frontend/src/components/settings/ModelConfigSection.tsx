import { useState, type DragEvent } from 'react'
import {
  Cpu,
  Plus,
  Star,
  Pencil,
  Trash2,
  Loader2,
  KeyRound,
  Sparkles,
  GripVertical,
  ChevronUp,
  ChevronDown,
  ArrowDown,
  CheckCircle2,
  AlertTriangle,
  SlidersHorizontal,
} from 'lucide-react'
import type { ModelConfig } from '../../types'
import { getLlmProvider, isRouterProvider } from '../../config/llmProviders'
import { useModelConfigsFor, useModelConfigMutationsFor } from '../../hooks/useModelConfigs'
import { modelConfigErrorMessage, modelConfigErrorField } from '../../api/endpoints/modelConfigs'
import type {
  CreateModelConfigInput,
  UpdateModelConfigInput,
  SmartRoutingSettings,
  ModelConfigTarget,
} from '../../api/endpoints/modelConfigs'
import { SectionCard, SectionHeader, Alert } from './primitives'
import ModelConfigDialog from './ModelConfigDialog'

const DEFAULT_ROUTING: SmartRoutingSettings = { max_attempts: 3, cooldown_seconds: 300 }
const SMART_CONFIG_NAME = 'Smart routing'
const COOLDOWN_CHOICES: { seconds: number; label: string }[] = [
  { seconds: 0, label: 'No cooldown' },
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
]

function cooldownLabel(seconds: number): string {
  const choice = COOLDOWN_CHOICES.find((c) => c.seconds === seconds)
  if (choice) return choice.seconds === 0 ? 'no cooldown' : `${choice.label} cooldown`
  return seconds % 60 === 0 ? `${seconds / 60} minute cooldown` : `${seconds}s cooldown`
}

/** A route can run only if its credentials are in place (key-based providers need a stored key). */
function routeReady(c: ModelConfig): boolean {
  return getLlmProvider(c.provider)?.kind !== 'api' || !!c.api_key_set
}

function uniqueName(base: string, configs: ModelConfig[]): string {
  const taken = new Set(configs.map((c) => c.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let i = 2
  while (taken.has(`${base} ${i}`.toLowerCase())) i += 1
  return `${base} ${i}`
}

/**
 * Agent Settings → Model. Two modes, chosen by one toggle:
 *
 * - **Single model**: the starred config answers every message.
 * - **Smart routing**: the default is a `smart` (router) config, and every
 *   other config is a route, tried in list order with safe fallback
 *   (`llm/smart_router.py`). Rows are numbered and reorderable — the stored
 *   config order IS the routing priority (PUT /model-configs/order) — and
 *   attempts / cooldown live under "Advanced routing behavior"
 *   (PUT /model-configs/routing).
 *
 * Router configs are never shown as rows or offered as a provider: the toggle
 * is the whole surface for them. Turning smart routing on reuses an existing
 * router config or creates one; turning it off makes route 1 the single model.
 * `canEdit=false` (foreign agent) hides every mutating control.
 *
 * `target={kind:'userDefault'}` drives the user's DEFAULT model config
 * (Account Settings) with the same editor; key-based providers are not
 * offered there, because the default stores no API keys.
 */
export default function ModelConfigSection({
  agentId,
  target: targetProp,
  canEdit,
}: {
  agentId?: string
  target?: ModelConfigTarget
  canEdit: boolean
}) {
  const target: ModelConfigTarget = targetProp ?? { kind: 'agent', agentId: agentId ?? '' }
  const isUserDefault = target.kind === 'userDefault'
  const { data, isLoading, error: loadError } = useModelConfigsFor(target)
  const mut = useModelConfigMutationsFor(target)
  const [dialog, setDialog] = useState<{ mode: 'create' | 'edit'; config?: ModelConfig } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const configs = data?.configs ?? []
  const defaultName = data?.default ?? null
  const routing = data?.routing ?? DEFAULT_ROUTING
  const routers = configs.filter((c) => isRouterProvider(c.provider))
  const routes = configs.filter((c) => !isRouterProvider(c.provider))
  const smartOn = routers.some((c) => c.name === defaultName)
  const readyCount = routes.filter(routeReady).length
  const notReady = routes.length - readyCount

  const openCreate = () => {
    mut.reset()
    setDialog({ mode: 'create' })
  }
  const openEdit = (config: ModelConfig) => {
    mut.reset()
    setDialog({ mode: 'edit', config })
  }

  const handleSave = async (input: CreateModelConfigInput | UpdateModelConfigInput) => {
    try {
      if (dialog?.mode === 'edit' && dialog.config) {
        await mut.update(dialog.config.name, input as UpdateModelConfigInput)
      } else {
        await mut.create(input as CreateModelConfigInput)
      }
      setDialog(null)
    } catch {
      // Keep the dialog open; the error renders inline via `mut.error`.
    }
  }

  const handleDelete = (config: ModelConfig) => {
    const promo = smartOn
      ? routes.length === 1
        ? ' This is the only route — smart routing will have nothing to try until you add one.'
        : ''
      : config.name === defaultName && routes.length > 1
      ? ' The next model will become the default.'
      : routes.length === 1
      ? ' This is the last model — the agent will have no default until you add one.'
      : ''
    if (!window.confirm(`Delete “${config.name}”?${promo}`)) return
    mut.remove(config.name).catch(() => {})
  }

  const toggleSmart = async () => {
    mut.reset()
    try {
      if (smartOn) {
        // Off: the highest-priority route becomes the single model.
        if (routes[0]) await mut.setDefault(routes[0].name)
        return
      }
      let name = routers[0]?.name
      if (!name) {
        name = uniqueName(SMART_CONFIG_NAME, configs)
        await mut.create({ name, provider: 'smart' })
      }
      await mut.setDefault(name)
    } catch {
      // Rendered via `mut.error`.
    }
  }

  // Router configs keep their place at the front; only routes are ranked.
  const moveRoute = (from: number, to: number) => {
    if (from === to || to < 0 || to >= routes.length) return
    const next = [...routes]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    mut.reorder([...routers, ...next].map((c) => c.name)).catch(() => {})
  }

  const dragHandlers = (index: number) =>
    canEdit && smartOn && routes.length > 1
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            setDragIndex(index)
            e.dataTransfer.effectAllowed = 'move'
          },
          onDragOver: (e: DragEvent) => {
            if (dragIndex === null) return
            e.preventDefault()
            setDropIndex(index)
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault()
            if (dragIndex !== null) moveRoute(dragIndex, index)
            setDragIndex(null)
            setDropIndex(null)
          },
          onDragEnd: () => {
            setDragIndex(null)
            setDropIndex(null)
          },
        }
      : {}

  const addButton = (label: string) => (
    <button
      type="button"
      onClick={openCreate}
      className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-accent-deep"
    >
      <Plus className="w-3.5 h-3.5" />
      {label}
    </button>
  )

  return (
    <div className="space-y-5">
      {mut.error && !dialog && <Alert type="error" message={modelConfigErrorMessage(mut.error)} />}

      {isLoading ? (
        <SectionCard>
          <div className="flex items-center gap-2 px-6 py-5 text-sm text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        </SectionCard>
      ) : loadError ? (
        <SectionCard>
          <p className="px-6 py-5 text-sm text-gray-500">
            {loadError.status === 403
              ? 'Model configs are managed by this agent’s owner.'
              : modelConfigErrorMessage(loadError)}
          </p>
        </SectionCard>
      ) : (
        <>
          {/* Mode: single model vs smart routing. */}
          <SectionCard>
            <div
              className={`flex items-center justify-between gap-4 rounded-xl px-6 py-5 ${
                smartOn ? 'bg-gradient-to-r from-purple-50/70 to-white' : ''
              }`}
            >
              <div className="flex items-center gap-3.5">
                <span
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                    smartOn ? 'bg-accent text-white shadow-sm' : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  <Sparkles className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-bold text-gray-900">
                    Smart routing {smartOn ? 'is on' : 'is off'}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {smartOn
                      ? 'Each message starts with route 1 and safely falls back to the next when a route is unavailable.'
                      : 'One model answers every message. Turn on to try your models in priority order with safe fallback.'}
                  </p>
                </div>
              </div>
              {canEdit && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={smartOn}
                  aria-label="Smart routing"
                  onClick={toggleSmart}
                  disabled={mut.isPending || (!smartOn && routes.length === 0)}
                  title={!smartOn && routes.length === 0 ? 'Add a model first' : undefined}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                    smartOn ? 'bg-accent' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
                      smartOn ? 'left-[23px]' : 'left-[3px]'
                    }`}
                  />
                </button>
              )}
            </div>
            {smartOn && (
              <div className="px-6 pb-5">
                <div
                  className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs ${
                    readyCount === 0
                      ? 'border-amber-200 bg-amber-50 text-amber-800'
                      : 'border-purple-100 bg-purple-50/60 text-accent-deep'
                  }`}
                >
                  {readyCount === 0 ? (
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  )}
                  <span>
                    <b className="font-bold">
                      {routes.length === 0
                        ? 'No routes yet.'
                        : readyCount === 0
                        ? 'No route is ready.'
                        : 'Ready to route.'}
                    </b>{' '}
                    {routes.length === 0
                      ? 'Add a model below — smart routing has nothing to try.'
                      : `${routes.length} model${routes.length === 1 ? '' : 's'} configured · up to ${Math.min(
                          routing.max_attempts,
                          routes.length,
                        )} attempt${Math.min(routing.max_attempts, routes.length) === 1 ? '' : 's'} per message`}
                    {notReady > 0 && readyCount > 0 &&
                      ` · ${notReady} route${notReady === 1 ? '' : 's'} need${notReady === 1 ? 's' : ''} an API key`}
                  </span>
                </div>
              </div>
            )}
          </SectionCard>

          {/* Routes (smart) or models (single). */}
          <SectionCard>
            <SectionHeader
              title={smartOn ? 'Route priority' : 'Models'}
              icon={<Cpu className="w-4 h-4" />}
              subtitle={
                smartOn
                  ? 'Drag to choose which model is tried first. Changes apply to the next message.'
                  : isUserDefault
                  ? 'The starred model answers for new agents'
                  : 'The starred model answers by default — pick another per message from the composer'
              }
              action={canEdit ? addButton('Add model') : undefined}
            />
            <div id="model-config" className="scroll-mt-20 px-6 py-5">
              {routes.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50/50 px-4 py-6 text-center">
                  <p className="text-sm font-medium text-gray-700">No models yet</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {isUserDefault
                      ? 'Add one, or re-run the install command — it sets this from the model tools signed in on your computer.'
                      : canEdit
                      ? 'Add one to give this agent a model. New agents start with a copy of your default model (Account Settings).'
                      : 'This agent has no models configured yet.'}
                  </p>
                  {canEdit && <div className="mt-3">{addButton('Add model')}</div>}
                </div>
              ) : (
                <ol className="space-y-0">
                  {routes.map((c, i) => {
                    const isDefault = c.name === defaultName
                    const providerOpt = getLlmProvider(c.provider)
                    const ready = routeReady(c)
                    const beyondLimit = smartOn && i >= routing.max_attempts
                    return (
                      <li key={c.name}>
                        <div
                          {...dragHandlers(i)}
                          className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
                            dropIndex === i && dragIndex !== i
                              ? 'border-purple-300 bg-purple-50/50'
                              : 'border-gray-100'
                          } ${dragIndex === i ? 'opacity-50' : ''} ${beyondLimit ? 'bg-gray-50/60' : 'bg-white'}`}
                        >
                          {smartOn ? (
                            <>
                              {canEdit && routes.length > 1 && (
                                <GripVertical
                                  className="h-4 w-4 shrink-0 cursor-grab text-gray-300"
                                  aria-hidden
                                />
                              )}
                              <span
                                className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-extrabold ${
                                  i === 0 ? 'bg-accent text-white' : 'bg-purple-50 text-accent-deep'
                                }`}
                                aria-label={`Route ${i + 1}`}
                              >
                                {i + 1}
                              </span>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => canEdit && !isDefault && mut.setDefault(c.name).catch(() => {})}
                              disabled={!canEdit || isDefault || mut.isPending}
                              title={isDefault ? 'Default model' : canEdit ? 'Set as default' : 'Default model'}
                              className={`shrink-0 transition-colors ${
                                isDefault ? 'text-amber-400' : 'text-gray-300 enabled:hover:text-amber-400'
                              } disabled:cursor-default`}
                            >
                              <Star className="w-4 h-4" fill={isDefault ? 'currentColor' : 'none'} />
                            </button>
                          )}

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold text-gray-800">{c.name}</span>
                              {!smartOn && isDefault && (
                                <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600">
                                  Default
                                </span>
                              )}
                              {smartOn && i === 0 && (
                                <span className="shrink-0 rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-deep">
                                  Highest priority
                                </span>
                              )}
                              {providerOpt?.kind === 'cli' && (
                                <span
                                  className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500"
                                  title="Runs the model's command-line tool on this agent's computer"
                                >
                                  CLI
                                </span>
                              )}
                              {providerOpt?.kind === 'api' && (
                                <span
                                  className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                                    ready ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                                  }`}
                                  title={ready ? 'An API key is stored for this model' : 'No API key stored for this model'}
                                >
                                  <KeyRound className="h-2.5 w-2.5" aria-hidden />
                                  {ready ? 'Key set' : 'Key needed'}
                                </span>
                              )}
                              {c.source === 'auto' && (
                                <span
                                  className="shrink-0 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500"
                                  title="Detected at registration"
                                >
                                  auto
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-gray-500">
                              {providerOpt?.label ?? c.provider}
                              {c.model ? ` · ${c.model}` : ' · provider default'}
                              {c.base_url ? ` · ${c.base_url}` : ''}
                            </div>
                            {beyondLimit && (
                              <div className="mt-0.5 text-[11px] text-gray-400">
                                Past the {routing.max_attempts}-attempt limit — tried only while an earlier route is cooling down
                              </div>
                            )}
                          </div>

                          {canEdit && (
                            <div className="flex shrink-0 items-center gap-0.5">
                              {smartOn && routes.length > 1 && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => moveRoute(i, i - 1)}
                                    disabled={i === 0 || mut.isPending}
                                    title="Move up"
                                    aria-label={`Move ${c.name} up`}
                                    className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
                                  >
                                    <ChevronUp className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => moveRoute(i, i + 1)}
                                    disabled={i === routes.length - 1 || mut.isPending}
                                    title="Move down"
                                    aria-label={`Move ${c.name} down`}
                                    className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30"
                                  >
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                onClick={() => openEdit(c)}
                                disabled={mut.isPending}
                                title="Edit"
                                className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(c)}
                                disabled={mut.isPending}
                                title="Delete"
                                className="rounded p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                        {smartOn && i < routes.length - 1 ? (
                          <div className="flex items-center gap-2 py-1.5 pl-[22px] text-[11px] text-gray-400">
                            <ArrowDown className="h-3 w-3" aria-hidden />
                            If unavailable or rate-limited, try the next route
                          </div>
                        ) : (
                          !smartOn && i < routes.length - 1 && <div className="h-2" />
                        )}
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </SectionCard>

          {/* Advanced routing behavior (smart only). */}
          {smartOn && (
            <SectionCard>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                aria-expanded={showAdvanced}
                className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left"
              >
                <span className="flex items-center gap-2.5">
                  <SlidersHorizontal className="h-4 w-4 text-purple-600" />
                  <span>
                    <span className="block text-sm font-bold text-gray-900">Advanced routing behavior</span>
                    <span className="block text-xs text-gray-500">
                      {routing.max_attempts} maximum attempt{routing.max_attempts === 1 ? '' : 's'} ·{' '}
                      {cooldownLabel(routing.cooldown_seconds)} · safe fallback only
                    </span>
                  </span>
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                />
              </button>
              {showAdvanced && (
                <div className="space-y-4 border-t border-gray-100 px-6 py-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-semibold text-gray-700">Maximum attempts per message</span>
                      <select
                        value={routing.max_attempts}
                        disabled={!canEdit || mut.isPending}
                        onChange={(e) => mut.setRouting({ max_attempts: Number(e.target.value) }).catch(() => {})}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20 disabled:opacity-60"
                      >
                        {Array.from({ length: 10 }, (_, k) => k + 1).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[11px] text-gray-400">
                        How many routes one message may try before giving up.
                      </span>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-semibold text-gray-700">Cooldown after a failure</span>
                      <select
                        value={routing.cooldown_seconds}
                        disabled={!canEdit || mut.isPending}
                        onChange={(e) => mut.setRouting({ cooldown_seconds: Number(e.target.value) }).catch(() => {})}
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-purple-400 focus:ring-2 focus:ring-purple-500/20 disabled:opacity-60"
                      >
                        {!COOLDOWN_CHOICES.some((c) => c.seconds === routing.cooldown_seconds) && (
                          <option value={routing.cooldown_seconds}>{cooldownLabel(routing.cooldown_seconds)}</option>
                        )}
                        {COOLDOWN_CHOICES.map((c) => (
                          <option key={c.seconds} value={c.seconds}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[11px] text-gray-400">
                        A route that fails is skipped for this long.
                      </span>
                    </label>
                  </div>
                  <p className="rounded-lg bg-gray-50 px-3.5 py-2.5 text-xs leading-relaxed text-gray-600">
                    <b className="font-semibold text-gray-800">Safe fallback only.</b> Smart routing moves to the
                    next route only when the failure proves nothing ran — a missing model tool, a rate limit, or
                    an authentication or billing error. A timeout or server error stops routing instead, so no
                    action is ever performed twice.
                  </p>
                </div>
              )}
            </SectionCard>
          )}
        </>
      )}

      {dialog && (
        <ModelConfigDialog
          mode={dialog.mode}
          initial={dialog.config}
          saving={mut.isPending}
          error={mut.error ? modelConfigErrorMessage(mut.error) : null}
          errorField={mut.error ? modelConfigErrorField(mut.error) : null}
          keylessOnly={isUserDefault}
          onSave={handleSave}
          onCancel={() => {
            mut.reset()
            setDialog(null)
          }}
        />
      )}
    </div>
  )
}
