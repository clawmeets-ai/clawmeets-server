import { get, post, put, del } from '../client'
import type { SkillMeta, SkillDetail, SkillConfigResponse } from '../../types'

export async function getAvailableSkills(query?: string): Promise<SkillMeta[]> {
  const params = query ? `?q=${encodeURIComponent(query)}` : ''
  return get<SkillMeta[]>(`/skills${params}`)
}

export async function getSkillDetail(name: string): Promise<SkillDetail> {
  return get<SkillDetail>(`/skills/${name}`)
}

export async function getAgentSkills(agentId: string): Promise<string[]> {
  const data = await get<{ installed_skills: string[] }>(`/agents/${agentId}/skills`)
  return data.installed_skills
}

export async function installSkills(agentId: string, skills: string[]): Promise<{ installed_skills: string[]; added: string[] }> {
  return post(`/agents/${agentId}/skills`, { skills })
}

export async function uninstallSkill(agentId: string, skillName: string): Promise<{ installed_skills: string[]; removed: string }> {
  return del(`/agents/${agentId}/skills/${skillName}`)
}

export async function reauthSkill(agentId: string, skillName: string): Promise<{ ok: boolean }> {
  return post(`/agents/${agentId}/skills/${skillName}/reauth`, {})
}

/** Result of a disconnect (revoke) request. `dispatched: true` on a 200 means
 *  the revoke was INITIATED async runner-side — NOT confirmed at Google. Tokens
 *  live runner-side and never transit the server, so there is no completion
 *  callback and no `revoked_at_google` signal (see backend's
 *  plan-disconnect-revoke.html §3). */
export interface DisconnectResult {
  ok: boolean
  dispatched: boolean
}

/**
 * Withdraw a skill's Google grant: `POST /agents/{id}/skills/{name}/disconnect`
 * (Bearer auth, no body). Resolves on 200 `{ ok, dispatched }`. Non-2xx throws
 * the shared `ApiError` (carrying `.status` + a `.message` from the server
 * `detail`) so callers can branch on status:
 *   400 non-OAuth skill · 404 not installed · 401/403 auth ·
 *   503 runner offline ("Agent runner is not connected").
 * Distinct from `uninstallSkill` (removes the skill code) and `reauthSkill`
 * (mints a fresh grant) — disconnect leaves the skill installed but de-authed.
 */
export async function disconnectIntegration(
  agentId: string,
  skillName: string,
): Promise<DisconnectResult> {
  return post(`/agents/${agentId}/skills/${skillName}/disconnect`, {})
}

export async function getSkillConfig(agentId: string, skillName: string): Promise<SkillConfigResponse> {
  return get<SkillConfigResponse>(`/agents/${agentId}/skills/${skillName}/config`)
}

export async function putSkillConfig(
  agentId: string,
  skillName: string,
  config: Record<string, unknown>,
): Promise<{ config: Record<string, unknown> }> {
  return put(`/agents/${agentId}/skills/${skillName}/config`, { config })
}
