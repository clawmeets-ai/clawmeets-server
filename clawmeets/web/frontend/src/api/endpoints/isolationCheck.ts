import { get, post } from '../client'

/** An agent's isolation check, re-run inside its RUNNING process.
 *
 *  The check decides whether the agent may take conversations from other
 *  people (each runs in a sandbox the runner must prove at start). POST asks
 *  the runner to re-run it and answers at once; GET is polled for the result.
 *  A 409 carries `{code, message}`: `agent_offline` or `runner_too_old`. */
export type IsolationCheckState = 'running' | 'passed' | 'failed' | 'unknown'

export interface IsolationCheckStatus {
  state: IsolationCheckState
  recheck_id: string | null
  provider: string | null
  /** temporary | needs_action | unsupported | crashed (failed), passed */
  kind: string | null
  failures: string[]
  checked_at: number | null
  isolated_turns: boolean
  held_conversations: number
  runner_connected: boolean
}

export interface IsolationCheckStarted {
  recheck_id: string
  state: 'running'
  already_running: boolean
}

export async function startIsolationCheck(agentId: string): Promise<IsolationCheckStarted> {
  return post<IsolationCheckStarted>(`/agents/${encodeURIComponent(agentId)}/isolation-check`)
}

export async function getIsolationCheck(agentId: string): Promise<IsolationCheckStatus> {
  return get<IsolationCheckStatus>(`/agents/${encodeURIComponent(agentId)}/isolation-check`)
}
