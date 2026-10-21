import { Bot, Package, SquareTerminal, Terminal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * The Computer page shows ONE section at a time, picked from a left-hand list
 * and addressed by `?section=<id>` — the same shape as Agent Settings, so the
 * two pages that manage an agent's machine read alike.
 */
export type ComputerSectionId = 'agents' | 'software' | 'terminal' | 'manual'

export const COMPUTER_SECTIONS: readonly { id: ComputerSectionId; label: string; icon: LucideIcon }[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'software', label: 'ClawMeets software', icon: Package },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'manual', label: 'Command line', icon: Terminal },
]

/** Unknown / missing → 'agents'. */
export function parseComputerSection(raw: string | null): ComputerSectionId {
  return COMPUTER_SECTIONS.some((s) => s.id === raw) ? (raw as ComputerSectionId) : 'agents'
}
