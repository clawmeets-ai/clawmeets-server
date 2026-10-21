import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Cpu, Loader2 } from 'lucide-react'

import {
  applyModelDefaults,
  modelConfigErrorMessage,
  type ApplyModelDefaultsInput,
  type ApplyModelDefaultsResult,
  type ModelDefaults,
} from '../../api/endpoints/modelConfigs'
import { useModelConfigsFor } from '../../hooks/useModelConfigs'
import { Alert, SectionCard, SectionHeader } from './primitives'
import ModelConfigSection from './ModelConfigSection'

const MODEL_AGENTS_TEAM = 'Model agents'

const primaryBtnClasses =
  'px-4 py-2 text-xs font-bold bg-accent text-white rounded-lg hover:bg-accent-deep focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
const secondaryBtnClasses =
  'px-4 py-2 text-xs font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50'

/**
 * Account Settings → Default model. The model config every NEW agent starts
 * with (a copy made at registration — existing agents are not changed), edited
 * with the same editor as Agent Settings → Model. "Apply to all my agents…"
 * copies it onto existing agents after showing exactly which will change.
 */
export default function DefaultModelSection() {
  const { data } = useModelConfigsFor({ kind: 'userDefault' })
  const configured = (data as ModelDefaults | undefined)?.configured ?? false
  const [applyOpen, setApplyOpen] = useState(false)

  return (
    <div className="space-y-3">
      <SectionCard>
        <SectionHeader
          title="Default model"
          icon={<Cpu className="w-4 h-4" />}
          subtitle="New agents start with a copy of this. Changing it does not change your existing agents."
          action={
            configured ? (
              <button type="button" className={secondaryBtnClasses} onClick={() => setApplyOpen(true)}>
                Apply to all my agents…
              </button>
            ) : undefined
          }
        />
        {!configured && data && (
          <p className="px-6 pb-5 text-xs text-gray-500">
            Not set yet — new agents get whichever model tools the server finds. Add a model below, or
            re-run the install command to set it from the tools signed in on your computer.
          </p>
        )}
      </SectionCard>
      <ModelConfigSection target={{ kind: 'userDefault' }} canEdit />
      {applyOpen && <ApplyDefaultDialog onClose={() => setApplyOpen(false)} />}
    </div>
  )
}

/** A dry run lists the agents that would change; confirming applies the same request. */
export function ApplyDefaultDialog({
  agents,
  onClose,
}: {
  /** Limit to these agents (Agent Settings' "Reset to my default"); omitted = all. */
  agents?: string[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [includeModelAgents, setIncludeModelAgents] = useState(!!agents)
  const [preview, setPreview] = useState<ApplyModelDefaultsResult | null>(null)
  const [done, setDone] = useState<ApplyModelDefaultsResult | null>(null)

  const body = (dry_run: boolean): ApplyModelDefaultsInput => ({
    dry_run,
    ...(includeModelAgents ? { exclude_teams: [] } : {}),
    ...(agents ? { agents } : {}),
  })

  const dryRun = useMutation({
    mutationFn: () => applyModelDefaults(body(true)),
    onSuccess: setPreview,
  })
  const apply = useMutation({
    mutationFn: () => applyModelDefaults(body(false)),
    onSuccess: (result) => {
      setDone(result)
      result.changed.forEach((a) => qc.invalidateQueries({ queryKey: ['model-configs', a.agent_id] }))
      qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  // Re-preview whenever the scope changes. `mutate` is stable across renders.
  const runDryRun = dryRun.mutate
  useEffect(() => {
    setPreview(null)
    runDryRun()
  }, [includeModelAgents, runDryRun])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shown = done ?? preview
  const error = dryRun.error ?? apply.error

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Apply default model"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
      >
        <div className="border-b border-gray-100 px-5 py-3.5">
          <h3 className="text-sm font-bold text-gray-800">
            {done ? 'Default model applied' : agents ? 'Reset to your default model?' : 'Apply your default model?'}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Each agent switches on its next message. Models holding an API key are kept, after your default's.
          </p>
        </div>

        <div className="max-h-80 space-y-3 overflow-y-auto px-5 py-4 text-sm">
          {error && <Alert type="error" message={modelConfigErrorMessage(error)} />}
          {!shown && !error && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking your agents…
            </div>
          )}
          {shown && (
            <>
              {shown.changed.length === 0 ? (
                <p className="text-xs text-gray-500">Every agent already matches your default.</p>
              ) : (
                <div>
                  <p className="mb-1.5 text-xs font-semibold text-gray-700">
                    {done ? 'Changed' : 'Will change'} ({shown.changed.length})
                  </p>
                  <ul className="space-y-1">
                    {shown.changed.map((a) => (
                      <li key={a.agent_id} className="text-xs text-gray-700">
                        <span className="font-semibold">{a.agent_name}</span>
                        {a.removed.length > 0 && (
                          <span className="text-gray-500"> · replaces {a.removed.join(', ')}</span>
                        )}
                        {a.kept.length > 0 && <span className="text-gray-500"> · keeps {a.kept.join(', ')}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {shown.skipped.length > 0 && (
                <p className="text-xs text-gray-500">
                  Left alone: {shown.skipped.map((s) => s.agent_name).join(', ')} ({MODEL_AGENTS_TEAM} each stay on
                  their own model).
                </p>
              )}
            </>
          )}
          {!agents && !done && (
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={includeModelAgents}
                onChange={(e) => setIncludeModelAgents(e.target.checked)}
              />
              Include the “{MODEL_AGENTS_TEAM}” team
            </label>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button type="button" className={secondaryBtnClasses} onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button
              type="button"
              className={primaryBtnClasses}
              disabled={!preview || preview.changed.length === 0 || apply.isPending}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? 'Applying…' : `Apply to ${preview?.changed.length ?? 0} agent${preview?.changed.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Agent Settings → Model: "Reset to my default" (shown once a default exists). */
export function ResetToDefaultModel({ agentId }: { agentId: string }) {
  const { data } = useModelConfigsFor({ kind: 'userDefault' })
  const [open, setOpen] = useState(false)
  if (!(data as ModelDefaults | undefined)?.configured) return null
  return (
    <div className="mt-3 text-xs text-gray-500">
      <button type="button" onClick={() => setOpen(true)} className="font-semibold text-accent hover:underline">
        Reset to my default model
      </button>{' '}
      — replaces this agent's models with your default (Account Settings). Models holding an API key are kept.
      {open && <ApplyDefaultDialog agents={[agentId]} onClose={() => setOpen(false)} />}
    </div>
  )
}
