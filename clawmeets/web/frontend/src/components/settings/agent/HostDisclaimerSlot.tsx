import { AlertTriangle } from 'lucide-react'
import { DOCTOR_FIX_COPY, HOST_DISCLAIMER_COPY } from '../../../utils/agentAccessCopy'

/**
 * The host disclaimer slot, in a fixed order: the title (placeholder wording
 * until the user supplies it), "N conversations are waiting" when N > 0, then
 * the fix. Renders whenever `isolation` is not 'sandboxed': absent or an
 * unknown value counts as unavailable, the server's own default.
 */
export default function HostDisclaimerSlot({ isolation, heldConversations }: {
  isolation: string | undefined
  heldConversations: number | undefined
}) {
  if (isolation === 'sandboxed') return null
  const held = heldConversations ?? 0
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
      data-testid="host-disclaimer"
    >
      <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-semibold" data-testid="host-disclaimer-title">{HOST_DISCLAIMER_COPY.title}</p>
        {held > 0 && <p data-testid="host-disclaimer-held">{HOST_DISCLAIMER_COPY.waiting(held)}</p>}
        <p data-testid="host-disclaimer-fix">{DOCTOR_FIX_COPY.fix}</p>
      </div>
    </div>
  )
}
