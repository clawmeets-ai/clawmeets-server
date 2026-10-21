import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateAgent } from '../../../api/endpoints/agents'
import type { AgentCard } from '../../../types'

/**
 * The fields that share one Save button: card fields (description,
 * capabilities, teams) + the runner-local knowledge folder, git binding and
 * storage folders. Held at
 * page level so an edit survives switching sections.
 */
export interface AgentSettingsDraft {
  description: string
  capabilities: string[]
  userTeams: string[]
  knowledgeDir: string
  gitUrl: string
  gitBaseBranch: string
  localStorageDir: string
  sharedStorageDir: string
  extraDirs: string[]
}

function draftFromAgent(agent: AgentCard): AgentSettingsDraft {
  return {
    description: agent.description,
    capabilities: agent.capabilities,
    userTeams: agent.user_teams || [],
    knowledgeDir: agent.local_settings?.knowledge_dir || '',
    gitUrl: agent.local_settings?.git_url || '',
    gitBaseBranch: agent.local_settings?.git_base_branch || '',
    localStorageDir: agent.local_settings?.local_storage_dir || '',
    sharedStorageDir: agent.local_settings?.shared_storage_dir || '',
    extraDirs: agent.local_settings?.extra_dirs || [],
  }
}

function sameDraft(a: AgentSettingsDraft, b: AgentSettingsDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function useAgentSettingsDraft(agent: AgentCard | undefined) {
  const queryClient = useQueryClient()
  const saved = useMemo(() => (agent ? draftFromAgent(agent) : null), [agent])
  const [draft, setDraft] = useState<AgentSettingsDraft | null>(saved)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  // The "Saved" confirmation fades after a moment.
  useEffect(() => {
    if (!justSaved) return
    const t = setTimeout(() => setJustSaved(false), 2500)
    return () => clearTimeout(t)
  }, [justSaved])

  // Re-seed whenever the server copy changes (initial load, after save, a
  // background refetch) — but never over edits the user hasn't saved yet.
  const prevSaved = useRef(saved)
  useEffect(() => {
    const prev = prevSaved.current
    prevSaved.current = saved
    setDraft((d) => {
      if (!d || !saved) return saved
      if (sameDraft(d, saved)) return d // nothing new; keep the reference
      return prev && sameDraft(d, prev) ? saved : d
    })
  }, [saved])

  const set = useCallback(<K extends keyof AgentSettingsDraft>(key: K, value: AgentSettingsDraft[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d))
    setJustSaved(false)
  }, [])

  const isDirty = !!draft && !!saved && !sameDraft(draft, saved)

  const mutation = useMutation({
    mutationFn: (d: AgentSettingsDraft) =>
      updateAgent(agent!.id, {
        description: d.description,
        capabilities: d.capabilities,
        user_teams: d.userTeams,
        local_settings: {
          // PUT /agents replaces local_settings wholesale, so spread the agent's
          // current settings first to preserve keys this form doesn't render
          // (mcp_configs, skill_configs, reasoning_effort, llm_* …). Known keys
          // below override; an empty field → undefined → omitted → cleared.
          ...agent?.local_settings,
          knowledge_dir: d.knowledgeDir || undefined,
          git_url: d.gitUrl || undefined,
          git_base_branch: d.gitBaseBranch || undefined,
          local_storage_dir: d.localStorageDir || undefined,
          shared_storage_dir: d.sharedStorageDir || undefined,
          extra_dirs: d.extraDirs.length ? d.extraDirs : undefined,
        },
      }),
    onSuccess: (updated) => {
      setError(null)
      setJustSaved(true)
      // Seed the cache with the PUT response so `saved` catches up with the
      // draft at once (no "unsaved" flash while the refetch is in flight).
      queryClient.setQueryData(['agent', agent?.id], updated)
      queryClient.invalidateQueries({ queryKey: ['agent', agent?.id] })
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  return {
    // `draft` is seeded by the effect above, which runs after the first
    // render that has `agent`; fall back to `saved` so that render doesn't
    // read as "Agent not found".
    draft: draft ?? saved,
    saved,
    set,
    isDirty,
    isSaving: mutation.isPending,
    error,
    justSaved,
    save: () => {
      if (draft) mutation.mutate(draft)
    },
    discard: () => {
      setDraft(saved)
      setError(null)
    },
  }
}

export type AgentSettingsDraftApi = ReturnType<typeof useAgentSettingsDraft>
