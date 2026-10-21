import { useState } from 'react'
import type { OutboxItem } from '../../api/endpoints/channels'
import { DELIVERY_COPY, deliveryLine } from '../../utils/channelThreads'

const TONES = {
  quiet: 'text-gray-400',
  pending: 'text-gray-500',
  held: 'text-amber-700',
  warn: 'text-red-600',
} as const

/**
 * The line under one outgoing message in a channel thread: whether it reached
 * the contact, with the provider's own words when it refused. An owner's own
 * post that wasn't delivered gets a Copy text button, so they can send it
 * another way; nothing is resent automatically.
 */
export default function DeliveryStatusLine({ rows, channel, connectionEnabled, ownText }: {
  rows: OutboxItem[]
  channel: string
  connectionEnabled: boolean
  /** The owner's own message text: shown with Copy text when not delivered. */
  ownText?: string
}) {
  const [copied, setCopied] = useState(false)
  const line = deliveryLine(rows, channel, { connectionEnabled })
  return (
    <p data-testid="delivery-line" className={`mt-0.5 flex items-center gap-2 text-[11px] ${TONES[line.tone]}`}>
      <span>
        {line.text}
        {line.providerSaid && <span data-testid="delivery-provider-said"> — {line.providerSaid}</span>}
      </span>
      {line.notDelivered && ownText !== undefined && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(ownText).then(() => setCopied(true), () => setCopied(false))
          }}
          className="underline hover:no-underline"
        >
          {copied ? DELIVERY_COPY.copied : DELIVERY_COPY.copy}
        </button>
      )}
    </p>
  )
}
