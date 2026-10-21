import { get, put, post, del } from '../client'
import type { AgentCard, AgentConnectionInfo } from '../../types'
// The provider union lives in the catalog; this module defers to it rather
// than re-listing ids (config/llmProviders imports nothing — no cycle).
import type { LlmProviderId } from '../../config/llmProviders'

export async function getMe(): Promise<AgentCard> {
  return get<AgentCard>('/auth/me')
}

export async function registerAgent(fields: {
  name: string
  description?: string
  capabilities?: string[]
  discoverable_through_registry?: boolean
  user_teams?: string[]
}): Promise<{ agent_id: string }> {
  return post<{ agent_id: string }>('/agents/register', fields)
}

export async function getAgents(): Promise<AgentCard[]> {
  return get<AgentCard[]>('/agents')
}

export async function getAgent(agentId: string): Promise<AgentCard> {
  return get<AgentCard>(`/agents/${agentId}`)
}

export async function deleteAgent(agentId: string): Promise<{ status: string }> {
  return del<{ status: string }>(`/agents/${agentId}`)
}

export async function updateAgent(
  agentId: string,
  fields: {
    description?: string
    capabilities?: string[]
    discoverable_through_registry?: boolean
    user_teams?: string[]
    local_settings?: {
      knowledge_dir?: string
      git_url?: string
      git_base_branch?: string
      local_storage_dir?: string
      shared_storage_dir?: string
      extra_dirs?: string[]
      // Provider ids come from the catalog — never re-listed here. Adding a
      // provider is one edit, in config/llmProviders.ts.
      llm_provider?: LlmProviderId
      llm_model?: string
      // The agent-level API key is gone (move-apikey-to-model-config): keys are
      // per model config now, set via the model-config dialog / model-configs
      // CRUD, never through this wholesale agent PUT.
      llm_base_url?: string
      output_mode?: 'tool' | 'native'
    }
    default_invitable_agents?: string[]
    default_invitable_teams?: string[]
  },
): Promise<AgentCard> {
  return put<AgentCard>(`/agents/${agentId}`, fields)
}

export async function getAgentConnection(agentId: string): Promise<AgentConnectionInfo> {
  return get<AgentConnectionInfo>(`/agents/${agentId}/connection`)
}
