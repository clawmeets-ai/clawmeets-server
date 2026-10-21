import { ShieldCheck } from 'lucide-react'
import { RECEIVING_COPY } from '../../../utils/agentAccessCopy'
import HostDisclaimerSlot from './HostDisclaimerSlot'

/**
 * On every channel card: whether strangers' conversations are kept apart.
 * `isolation` is the card's own (a channel connection's, or HubChannel's);
 * 'sandboxed' says they are, anything else shows the host disclaimer slot.
 */
export default function ChannelIsolationLine({ isolation, heldConversations }: {
  isolation: string | undefined
  heldConversations: number | undefined
}) {
  if (isolation !== 'sandboxed') return <HostDisclaimerSlot isolation={isolation} heldConversations={heldConversations} />
  return (
    <p className="flex items-start gap-1.5 text-xs text-emerald-800" title={RECEIVING_COPY.keptApartDetail} data-testid="channel-kept-apart">
      <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden />
      <span>{RECEIVING_COPY.keptApart}</span>
    </p>
  )
}
