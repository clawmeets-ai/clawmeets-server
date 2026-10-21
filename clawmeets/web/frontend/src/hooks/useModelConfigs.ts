import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { ApiError } from '../api/client'
import {
  getModelConfigs,
  createModelConfig,
  updateModelConfig,
  deleteModelConfig,
  setDefaultModelConfig,
  reorderModelConfigs,
  setSmartRouting,
  getModelDefaults,
  createDefaultConfig,
  updateDefaultConfig,
  deleteDefaultConfig,
  setDefaultDefaultConfig,
  reorderDefaultConfigs,
  setDefaultSmartRouting,
  type CreateModelConfigInput,
  type UpdateModelConfigInput,
  type ModelConfigList,
  type ModelConfigTarget,
  type SmartRoutingSettings,
} from '../api/endpoints/modelConfigs'

const key = (target: ModelConfigTarget) =>
  target.kind === 'agent'
    ? (['model-configs', target.agentId] as const)
    : (['model-defaults'] as const)

/**
 * The seven calls for one target. The agent and user-default route families
 * are path-for-path the same, so the editor never branches on which it drives.
 */
function callsFor(target: ModelConfigTarget) {
  if (target.kind === 'agent') {
    const id = target.agentId
    return {
      list: (): Promise<ModelConfigList> => getModelConfigs(id),
      create: (body: CreateModelConfigInput) => createModelConfig(id, body),
      update: (name: string, body: UpdateModelConfigInput) => updateModelConfig(id, name, body),
      remove: (name: string) => deleteModelConfig(id, name),
      setDefault: (name: string): Promise<ModelConfigList> => setDefaultModelConfig(id, name),
      reorder: (names: string[]): Promise<ModelConfigList> => reorderModelConfigs(id, names),
      setRouting: (body: Partial<SmartRoutingSettings>): Promise<ModelConfigList> => setSmartRouting(id, body),
    }
  }
  return {
    list: (): Promise<ModelConfigList> => getModelDefaults(),
    create: createDefaultConfig,
    update: updateDefaultConfig,
    remove: deleteDefaultConfig,
    setDefault: (name: string): Promise<ModelConfigList> => setDefaultDefaultConfig(name),
    reorder: (names: string[]): Promise<ModelConfigList> => reorderDefaultConfigs(names),
    setRouting: (body: Partial<SmartRoutingSettings>): Promise<ModelConfigList> => setDefaultSmartRouting(body),
  }
}

/** Query one target's configs (the user default's response also carries `configured`). */
export function useModelConfigsFor(
  target: ModelConfigTarget | undefined,
): UseQueryResult<ModelConfigList, ApiError> {
  return useQuery<ModelConfigList, ApiError>({
    queryKey: target ? key(target) : ['model-configs', ''],
    queryFn: () => callsFor(target!).list(),
    enabled: !!target && (target.kind !== 'agent' || !!target.agentId),
  })
}

/**
 * Query the agent's model configs. Returns the raw `{ configs, default }`
 * envelope so callers get both the list AND the default config's NAME (the
 * selector preselects `default`; the section stars `cfg.name === default`).
 * Disabled until `agentId` is set.
 */
export function useModelConfigs(
  agentId: string | undefined,
): UseQueryResult<ModelConfigList, ApiError> {
  return useModelConfigsFor(agentId ? { kind: 'agent', agentId } : undefined)
}

export interface ModelConfigMutations {
  // Awaitable so callers can close a dialog on resolve / keep it open on reject
  // (the rejection also lands in `error` for inline display).
  create: (body: CreateModelConfigInput) => Promise<unknown>
  update: (name: string, body: UpdateModelConfigInput) => Promise<unknown>
  remove: (name: string) => Promise<unknown>
  setDefault: (name: string) => Promise<unknown>
  /** Persist a new config order (= smart-routing priority); optimistic. */
  reorder: (names: string[]) => Promise<unknown>
  setRouting: (body: Partial<SmartRoutingSettings>) => Promise<unknown>
  isPending: boolean
  error: ApiError | null
  /** Clear any lingering mutation error (e.g. when opening a fresh dialog). */
  reset: () => void
}

/**
 * create / update(PATCH) / remove / setDefault / reorder / setRouting
 * mutations for one target, keyed by config NAME. create / update / remove
 * invalidate the target's query; the PUTs return the whole envelope and seed
 * it straight into the cache so the UI flips without a refetch flash.
 */
export function useModelConfigMutationsFor(target: ModelConfigTarget): ModelConfigMutations {
  const qc = useQueryClient()
  const k = key(target)
  const calls = callsFor(target)
  const invalidate = () => qc.invalidateQueries({ queryKey: k })

  const create = useMutation<unknown, ApiError, CreateModelConfigInput>({
    mutationFn: (body) => calls.create(body),
    onSuccess: invalidate,
  })

  const update = useMutation<unknown, ApiError, { name: string; body: UpdateModelConfigInput }>({
    mutationFn: ({ name, body }) => calls.update(name, body),
    onSuccess: invalidate,
  })

  const remove = useMutation<unknown, ApiError, string>({
    mutationFn: (name) => calls.remove(name),
    onSuccess: invalidate,
  })

  const setDefault = useMutation<ModelConfigList, ApiError, string>({
    mutationFn: (name) => calls.setDefault(name),
    // The PUT returns the whole envelope — seed it so the star flips instantly.
    onSuccess: (data) => qc.setQueryData(k, data),
  })

  // Reorder applies optimistically so a dropped row doesn't snap back while
  // the PUT is in flight; a failure restores the previous list.
  const reorder = useMutation<
    ModelConfigList,
    ApiError,
    string[],
    { previous?: ModelConfigList }
  >({
    mutationFn: (names) => calls.reorder(names),
    onMutate: async (names) => {
      await qc.cancelQueries({ queryKey: k })
      const previous = qc.getQueryData<ModelConfigList>(k)
      if (previous) {
        const byName = new Map(previous.configs.map((c) => [c.name, c]))
        const configs = names.map((n) => byName.get(n)).filter((c) => !!c) as typeof previous.configs
        qc.setQueryData(k, { ...previous, configs })
      }
      return { previous }
    },
    onError: (_err, _names, context) => {
      if (context?.previous) qc.setQueryData(k, context.previous)
    },
    onSuccess: (data) => qc.setQueryData(k, data),
  })

  const setRouting = useMutation<ModelConfigList, ApiError, Partial<SmartRoutingSettings>>({
    mutationFn: (body) => calls.setRouting(body),
    onSuccess: (data) => qc.setQueryData(k, data),
  })

  const all = [create, update, remove, setDefault, reorder, setRouting]

  return {
    create: (body) => create.mutateAsync(body),
    update: (name, body) => update.mutateAsync({ name, body }),
    remove: (name) => remove.mutateAsync(name),
    setDefault: (name) => setDefault.mutateAsync(name),
    reorder: (names) => reorder.mutateAsync(names),
    setRouting: (body) => setRouting.mutateAsync(body),
    isPending: all.some((m) => m.isPending),
    error: all.find((m) => m.error)?.error ?? null,
    reset: () => all.forEach((m) => m.reset()),
  }
}

/** The agent form of {@link useModelConfigMutationsFor}. */
export function useModelConfigMutations(agentId: string): ModelConfigMutations {
  return useModelConfigMutationsFor({ kind: 'agent', agentId })
}
