import { del, get, put } from '../client'

/** An agent's env vars, carried out by the agent's OWN runner.
 *
 *  Every call is relayed by the server to the running agent, which reads or
 *  writes its local store (`{agent_dir}/env.json`, the same one
 *  `clawmeets env` uses) and answers with the key NAMES — never a value. The
 *  server keeps nothing. A 409 means the agent isn't running, a 504 that it
 *  didn't answer in time; both carry a sentence the page shows as-is. */
export interface AgentEnvKeys {
  keys: string[]
}

export async function getAgentEnvKeys(agentId: string): Promise<AgentEnvKeys> {
  return get<AgentEnvKeys>(`/agents/${encodeURIComponent(agentId)}/env`)
}

export async function setAgentEnvVar(agentId: string, key: string, value: string): Promise<AgentEnvKeys> {
  return put<AgentEnvKeys>(`/agents/${encodeURIComponent(agentId)}/env/${encodeURIComponent(key)}`, { value })
}

export async function unsetAgentEnvVar(agentId: string, key: string): Promise<AgentEnvKeys> {
  return del<AgentEnvKeys>(`/agents/${encodeURIComponent(agentId)}/env/${encodeURIComponent(key)}`)
}
