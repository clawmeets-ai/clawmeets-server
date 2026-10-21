import { useCallback, useMemo, useState } from 'react'
import {
  assembleAgentDraft,
  assembleProjectDraft,
  type AgentDraftValues,
  type ProjectDraftValues,
} from '../components/sidebar/dmPrefill'

export type ComposeMode = 'agent' | 'project'
export type ComposeValues = AgentDraftValues | ProjectDraftValues

// Scalar (single-string) fields the form exposes across both modes.
export type ScalarField = 'name' | 'expertise' | 'other' | 'task'

export interface ComposeForm {
  mode: ComposeMode
  values: ComposeValues // narrow by `mode` at the call site
  setField: (key: ScalarField, value: string) => void // set one scalar field
  setAgents: (next: string[]) => void // project mode: replace the agent chip list
  assembled: string // derived send-ready body (feeds preview + send)
  isValid: boolean // required fields non-empty after trim (+ >=1 agent for project)
  isDirty: boolean // any field touched — drives the discard guard
}

const EMPTY_AGENT: AgentDraftValues = { name: '', expertise: '', other: '' }
const EMPTY_PROJECT: ProjectDraftValues = { agents: [], task: '' }

// Mode-selected form state + derived assembly for DmComposeModal. Holds the
// right value shape for `mode` (fixed for the modal's lifetime, chosen by the
// launching panel), exposes typed setters and (project) the chip-list setter,
// and derives `assembled`/`isValid`/`isDirty` on every render via the dmPrefill
// assemble helpers. Pure/no effects; recomputation is cheap at this size.
export function useComposeForm(mode: ComposeMode): ComposeForm {
  const [agentValues, setAgentValues] = useState<AgentDraftValues>(EMPTY_AGENT)
  const [projectValues, setProjectValues] = useState<ProjectDraftValues>(EMPTY_PROJECT)

  const setField = useCallback(
    (key: ScalarField, value: string) => {
      if (key === 'task') {
        setProjectValues((v) => ({ ...v, task: value }))
      } else {
        setAgentValues((v) => ({ ...v, [key]: value }))
      }
    },
    [],
  )

  const setAgents = useCallback((next: string[]) => {
    setProjectValues((v) => ({ ...v, agents: next }))
  }, [])

  const values = mode === 'agent' ? agentValues : projectValues

  const assembled = useMemo(
    () =>
      mode === 'agent'
        ? assembleAgentDraft(agentValues)
        : assembleProjectDraft(projectValues),
    [mode, agentValues, projectValues],
  )

  const isValid = useMemo(() => {
    if (mode === 'agent') {
      return agentValues.name.trim().length > 0 && agentValues.expertise.trim().length > 0
    }
    return (
      projectValues.agents.some((a) => a.trim().length > 0) &&
      projectValues.task.trim().length > 0
    )
  }, [mode, agentValues, projectValues])

  const isDirty = useMemo(() => {
    if (mode === 'agent') {
      return !!(agentValues.name || agentValues.expertise || agentValues.other)
    }
    return projectValues.agents.length > 0 || !!projectValues.task
  }, [mode, agentValues, projectValues])

  return { mode, values, setField, setAgents, assembled, isValid, isDirty }
}
