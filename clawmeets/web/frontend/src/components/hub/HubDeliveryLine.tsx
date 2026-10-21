import { useState } from 'react'
import type { Delivery } from '../../api/endpoints/hub'
import { deliveryLine, SENDING_FRESH_MS, type DeliveryNames, type HubDeliveryTone } from '../../utils/hubDelivery'

const TONE: Record<HubDeliveryTone, string> = {
  quiet: 'text-gray-500',
  pending: 'text-gray-600',
  held: 'text-indigo-700',
  warn: 'text-red-700',
  amber: 'text-amber-700',
}

/**
 * The one line under a message the user sent to another server. Before any
 * delivery row arrives it reads "Sending…" for two minutes, then nothing. A
 * failed message offers "Copy text" so the user can send it elsewhere.
 */
export default function HubDeliveryLine({ delivery, names, text, sentAtMs, nowMs }: {
  delivery: Delivery | undefined
  names: DeliveryNames
  /** The message's own text, for Copy text. */
  text: string
  sentAtMs: number
  nowMs: number
}) {
  const [copied, setCopied] = useState(false)
  if (!delivery) {
    if (nowMs - sentAtMs > SENDING_FRESH_MS) return null
    return <p className="mt-1 text-right text-xs text-gray-500" data-testid="hub-delivery-line">Sending…</p>
  }
  const line = deliveryLine(delivery, names)
  return (
    <p className={`mt-1 text-right text-xs ${TONE[line.tone]}`} data-testid="hub-delivery-line" data-tone={line.tone}>
      {line.text}
      {line.copyable && (
        <button
          type="button"
          className="ml-2 underline hover:no-underline"
          onClick={() => {
            void navigator.clipboard?.writeText(text)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy text'}
        </button>
      )}
    </p>
  )
}
