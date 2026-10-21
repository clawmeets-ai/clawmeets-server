import type { BridgeDelivery } from '../../api/endpoints/hub'
import { bridgeDeliveryText, type BridgeTone } from '../../utils/agentAccessCopy'

const TONE: Record<BridgeTone, string> = {
  quiet: 'text-gray-400',
  pending: 'text-sky-700',
  bad: 'text-red-700',
}

/**
 * Under a workroom message that addresses a retained agent: one line per
 * stand-in, from the room's bridge deliveries (owner only). `standInIds` are
 * the stand-ins the message addressed; one with no row yet reads "Queued".
 * `names` maps a hub_agent_id or stand-in id to its safe display name.
 */
export default function BridgeDeliveryLine({ standInIds, deliveries, names }: {
  standInIds: readonly string[]
  deliveries: readonly BridgeDelivery[]
  names: ReadonlyMap<string, string>
}) {
  if (standInIds.length === 0) return null
  const byAgent = new Map(deliveries.map((d) => [d.hub_agent_id, d]))
  return (
    <ul className="mt-0.5 space-y-0.5" data-testid="bridge-delivery-line">
      {standInIds.map((id) => {
        const d = byAgent.get(id)
        const { text, tone } = bridgeDeliveryText(d?.state ?? 'queued', d?.reason, names.get(id) ?? id)
        return (
          <li key={id} className={`text-[11px] ${TONE[tone]}`} data-state={d?.state ?? 'queued'}>
            {text}
          </li>
        )
      })}
    </ul>
  )
}
