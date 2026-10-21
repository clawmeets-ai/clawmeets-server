import { get } from '../client'

export interface TemplateSummary {
  id: string
  name: string
  icon: string
  color: string
  cats: string[]
  blurb: string
  agent_count: number
  sample_count: number
}

export interface TemplateAgent {
  name: string
  blurb: string
  description: string
  avatar_color: string
}

export interface TemplateSample {
  title: string
  request: string
}

export interface TemplateDetail extends TemplateSummary {
  agents: TemplateAgent[]
  samples: TemplateSample[]
}

// Per-agent sample request — flat array on each agent in the agent pool's setup.json,
// rendered as click-to-copy cards in the DM zero-state.
export interface AgentSampleRequest {
  category: string
  title: string
  request: string
}

export async function getAgentSampleRequests(): Promise<Record<string, AgentSampleRequest[]>> {
  return get<Record<string, AgentSampleRequest[]>>('/templates/agent-samples')
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  return get<TemplateSummary[]>('/templates')
}

export async function getTemplate(id: string): Promise<TemplateDetail> {
  return get<TemplateDetail>(`/templates/${encodeURIComponent(id)}`)
}

export interface TemplateSetupAgent {
  name: string
  user_teams?: string[]
  skills?: string[]
}

export interface TemplateSetup {
  name?: string
  agents?: TemplateSetupAgent[]
}

export async function getTemplateSetup(id: string): Promise<TemplateSetup> {
  return get<TemplateSetup>(`/templates/${encodeURIComponent(id)}/setup.json`)
}

export function templateSetupUrl(id: string): string {
  // Absolute URL so the copy-button hands the user a command they can paste
  // anywhere (not just against the current browser origin proxy). Falls back
  // to a relative path if window isn't available (SSR / tests).
  if (typeof window === 'undefined') return `/templates/${id}/setup.json`
  return `${window.location.origin}/templates/${id}/setup.json`
}
