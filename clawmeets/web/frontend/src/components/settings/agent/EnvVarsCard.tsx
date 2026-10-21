import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Loader2, Plus, X } from 'lucide-react'
import { getAgentEnvKeys, setAgentEnvVar, unsetAgentEnvVar } from '../../../api/endpoints/agentEnv'
import CopyCommand from '../../computer/CopyCommand'
import { inputClass } from './fields'

/** The store's key rule, restated for instant feedback as the user types. The
 *  server and the runner check the same rule again (`utils/env_store.py`);
 *  this copy only saves a round trip. */
export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/
export const ENV_RESERVED_PREFIX = 'CLAWMEETS_'
export const ENV_VALUE_MAX_BYTES = 8192

/** The fixed-length mask. Always eight, so not even a value's length shows. */
const ENV_MASK = '••••••••'

/** Why a key name cannot be added, or null when it can. Empty is not an error
 *  — the button is simply disabled until something is typed. */
export function envKeyProblem(key: string): string | null {
  if (!key) return null
  if (key.startsWith(ENV_RESERVED_PREFIX)) return `${ENV_RESERVED_PREFIX} is reserved`
  if (/^[0-9]/.test(key)) return "Can't start with a digit"
  if (!ENV_KEY_PATTERN.test(key)) return 'Letters, digits and _ only'
  return null
}

/** Why a value cannot be sent, or null. Counted in bytes, as the server does. */
export function envValueProblem(value: string): string | null {
  if (new TextEncoder().encode(value).length > ENV_VALUE_MAX_BYTES) {
    return `Values are limited to ${ENV_VALUE_MAX_BYTES / 1024} KB`
  }
  return null
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong.'
}

/**
 * This agent's env vars: key names, add, remove. Never a value.
 *
 * Every read and write is carried out by the agent's own runner, on the store
 * `clawmeets env` uses — so the agent has to be running. The value field is
 * write-only by construction: the runner answers with key names only, so there
 * is nothing to reveal and every key renders as the same mask. The eye toggle
 * shows only what the user is typing right now.
 *
 * Set and remove are plain calls, not `useMutation`s: a mutation keeps its
 * variables in the cache after it settles, and for a set those include the
 * secret. Each answer carries the fresh key list, which replaces the query
 * data directly.
 */
export default function EnvVarsCard({ agentId, agentName }: { agentId: string; agentName: string }) {
  const queryClient = useQueryClient()
  const queryKey = ['agent-env', agentId]
  const { data, error, isLoading, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: () => getAgentEnvKeys(agentId),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const keys = data?.keys ?? []

  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [valueDraft, setValueDraft] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const keyProblem = envKeyProblem(keyDraft)
  const valueProblem = envValueProblem(valueDraft)
  const canAdd = !!data && !!keyDraft && !keyProblem && !valueProblem && pendingKey === null

  const run = async (key: string, verb: string, call: () => Promise<{ keys: string[] }>) => {
    setActionError(null)
    setPendingKey(key)
    try {
      const next = await call()
      queryClient.setQueryData(queryKey, next)
    } catch (err) {
      setActionError(`Couldn't ${verb} ${key}. ${errorText(err)}`)
    } finally {
      setPendingKey(null)
    }
  }

  const submitAdd = (confirmed: boolean) => {
    if (!canAdd) return
    if (keys.includes(keyDraft) && !confirmed) {
      setConfirmReplace(true)
      return
    }
    const key = keyDraft
    const value = valueDraft
    // Cleared the moment it is sent: the secret should not sit in the page.
    setValueDraft('')
    setKeyDraft('')
    setShowValue(false)
    setConfirmReplace(false)
    void run(key, 'add', () => setAgentEnvVar(agentId, key, value))
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 space-y-3">
      <div>
        <div className="text-sm font-semibold text-gray-800">Environment variables</div>
        <p className="text-xs text-gray-500 leading-relaxed mt-0.5">
          Secrets and config this agent's skills read, such as API keys and endpoints. Stored only on the computer
          the agent runs on, never on the server. Values are write-only — nobody, including you, can read them back
          here. Changes apply on the agent's next turn.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Asking {agentName}…
        </div>
      ) : error ? (
        <div className="space-y-2">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
            {errorText(error)}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs font-semibold text-violet-700 hover:underline disabled:opacity-50"
          >
            {isFetching ? 'Trying…' : 'Try again'}
          </button>
          <p className="text-xs text-gray-500">Or set one in a terminal on that computer:</p>
          <CopyCommand command={`clawmeets env set KEY --agent ${agentName}`} />
        </div>
      ) : (
        <>
          {actionError && (
            <div
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
              role="alert"
            >
              <div className="flex-1">{actionError}</div>
              <button type="button" onClick={() => setActionError(null)} className="font-semibold shrink-0">
                Dismiss
              </button>
            </div>
          )}

          {(keys.length > 0 || (pendingKey && !keys.includes(pendingKey))) && (
            <ul className="space-y-1" aria-label="Environment variable names">
              {keys.map((key) =>
                confirmRemove === key ? (
                  <li
                    key={key}
                    className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs"
                  >
                    <span className="font-mono font-bold">{key}</span>
                    <span className="flex-1 text-gray-600">Remove? The value can't be recovered.</span>
                    <button
                      type="button"
                      onClick={() => setConfirmRemove(null)}
                      className="rounded border border-gray-300 bg-white px-2 py-0.5 font-semibold text-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmRemove(null)
                        void run(key, 'remove', () => unsetAgentEnvVar(agentId, key))
                      }}
                      className="rounded bg-red-600 px-2 py-0.5 font-semibold text-white"
                    >
                      Remove
                    </button>
                  </li>
                ) : (
                  <li
                    key={key}
                    className={`flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs ${
                      pendingKey === key ? 'border-dashed border-gray-300' : 'border-gray-200'
                    }`}
                  >
                    <span className="font-mono font-bold text-gray-800">{key}</span>
                    <span className="flex-1 font-mono text-gray-400" aria-label="value hidden">
                      {pendingKey === key ? '' : ENV_MASK}
                    </span>
                    {pendingKey === key ? (
                      <span className="inline-flex items-center gap-1 text-gray-500">
                        <Loader2 size={11} className="animate-spin" /> Saving…
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Remove ${key}`}
                        title={`Remove ${key}`}
                        disabled={pendingKey !== null}
                        onClick={() => setConfirmRemove(key)}
                        className="rounded p-0.5 text-gray-500 opacity-60 hover:opacity-100 disabled:cursor-not-allowed"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </li>
                ),
              )}
              {pendingKey && !keys.includes(pendingKey) && (
                <li className="flex items-center gap-2 rounded-md border border-dashed border-gray-300 px-2.5 py-1 text-xs">
                  <span className="font-mono font-bold text-gray-800">{pendingKey}</span>
                  <span className="flex-1" />
                  <span className="inline-flex items-center gap-1 text-gray-500">
                    <Loader2 size={11} className="animate-spin" /> Saving…
                  </span>
                </li>
              )}
            </ul>
          )}

          {confirmReplace ? (
            <div className="flex items-center gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs">
              <span className="flex-1">
                <span className="font-mono font-bold">{keyDraft}</span> is already set. Replace its value?
              </span>
              <button
                type="button"
                onClick={() => setConfirmReplace(false)}
                className="rounded border border-gray-300 bg-white px-2 py-0.5 font-semibold text-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => submitAdd(true)}
                className="rounded bg-violet-600 px-2 py-0.5 font-semibold text-white"
              >
                Replace
              </button>
            </div>
          ) : (
            <form
              className="flex flex-wrap items-start gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                submitAdd(false)
              }}
            >
              <div className="flex-1 min-w-[160px]">
                <input
                  aria-label="Variable name"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value.toUpperCase())}
                  placeholder="KEY_NAME"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${inputClass} font-mono ${keyProblem ? 'border-red-400' : ''}`}
                />
                <div className={`text-[11px] mt-0.5 ${keyProblem ? 'text-red-600' : 'text-gray-400'}`}>
                  {keyProblem ?? 'A–Z, 0–9, _ · no CLAWMEETS_ prefix'}
                </div>
              </div>
              <div className="flex-[1.4] min-w-[180px]">
                <div className="relative">
                  <input
                    aria-label="Value"
                    type={showValue ? 'text' : 'password'}
                    value={valueDraft}
                    onChange={(e) => setValueDraft(e.target.value)}
                    placeholder="value"
                    autoComplete="new-password"
                    spellCheck={false}
                    className={`${inputClass} font-mono pr-8 ${valueProblem ? 'border-red-400' : ''}`}
                  />
                  <button
                    type="button"
                    aria-label={showValue ? 'Hide value' : 'Show value'}
                    onClick={() => setShowValue((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 opacity-60 hover:opacity-100"
                  >
                    {showValue ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
                <div className={`text-[11px] mt-0.5 ${valueProblem ? 'text-red-600' : 'text-gray-400'}`}>
                  {valueProblem ?? 'Sent once to the agent, never stored on the server'}
                </div>
              </div>
              <button
                type="submit"
                disabled={!canAdd}
                className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                <Plus size={12} /> Add
              </button>
            </form>
          )}
        </>
      )}
    </div>
  )
}
