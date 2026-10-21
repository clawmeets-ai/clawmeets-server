import { SlidersHorizontal, Cpu, Star, Link2, MessageCircle, Package, HardDrive, GitBranch } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * The Agent Settings page shows ONE section at a time, picked from a left-hand
 * list and addressed by `?section=<id>` so a section can be deep-linked
 * (e.g. the composer's "Setup Model" → `?section=model`).
 */
export type SettingsSectionId = 'general' | 'model' | 'skills' | 'integrations' | 'channels' | 'knowledge' | 'storage' | 'runtime'

export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'model', label: 'Model & routing', icon: Cpu },
  { id: 'skills', label: 'Skills', icon: Star },
  { id: 'integrations', label: 'Integrations', icon: Link2 },
  { id: 'channels', label: 'Channels', icon: MessageCircle },
  { id: 'knowledge', label: 'Knowledge', icon: Package },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'runtime', label: 'Code & runtime', icon: GitBranch },
]

// Older links used `?section=model-config` (the scroll anchor of the previous
// single-scroll page); keep them landing on the right section.
const LEGACY_ALIASES: Record<string, SettingsSectionId> = { 'model-config': 'model' }

/** Unknown / missing → 'general'. */
export function parseSection(raw: string | null): SettingsSectionId {
  if (!raw) return 'general'
  if (raw in LEGACY_ALIASES) return LEGACY_ALIASES[raw]
  return SETTINGS_SECTIONS.some((s) => s.id === raw) ? (raw as SettingsSectionId) : 'general'
}

export function agentSettingsHref(agentId: string, section?: SettingsSectionId): string {
  const base = `/agents/${agentId}/settings`
  return section && section !== 'general' ? `${base}?section=${section}` : base
}
