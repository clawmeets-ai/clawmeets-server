import { get, post, put, del } from '../client'
import type { McpMeta, McpDetail, McpConfigResponse } from '../../types'

export async function getAvailableMcps(query?: string): Promise<McpMeta[]> {
  const params = query ? `?q=${encodeURIComponent(query)}` : ''
  return get<McpMeta[]>(`/mcps${params}`)
}

export async function getMcpDetail(name: string): Promise<McpDetail> {
  return get<McpDetail>(`/mcps/${name}`)
}

export async function getAgentMcps(agentId: string): Promise<string[]> {
  const data = await get<{ installed_mcps: string[] }>(`/agents/${agentId}/mcps`)
  return data.installed_mcps
}

export async function installMcps(agentId: string, mcps: string[]): Promise<{ installed_mcps: string[]; added: string[] }> {
  return post(`/agents/${agentId}/mcps`, { mcps })
}

export async function uninstallMcp(agentId: string, mcpName: string): Promise<{ installed_mcps: string[]; removed: string }> {
  return del(`/agents/${agentId}/mcps/${mcpName}`)
}

export async function getMcpConfig(agentId: string, mcpName: string): Promise<McpConfigResponse> {
  return get<McpConfigResponse>(`/agents/${agentId}/mcps/${mcpName}/config`)
}

export async function putMcpConfig(
  agentId: string,
  mcpName: string,
  config: Record<string, unknown>,
): Promise<{ config: Record<string, unknown> }> {
  return put(`/agents/${agentId}/mcps/${mcpName}/config`, { config })
}
