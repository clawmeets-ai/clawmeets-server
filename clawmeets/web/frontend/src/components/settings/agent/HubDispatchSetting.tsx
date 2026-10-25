import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { setHubDispatch, type HubChannel } from '../../../api/endpoints/hub'
import { hubChannelKey } from '../../../hooks/useHub'
import { HUB_CARD_COPY } from '../../../utils/hubChannelView'
import { errorText } from './channelsShared'

/** The server's bounds on the daily cap (DispatchSettingsRequest). */
export const DISPATCH_CAP_MIN = 1
export const DISPATCH_CAP_MAX = 200
const DEFAULT_CAP = 20

/**
 * Hub-ranked dispatch on the Hub tab: whether the hub may route requests that
 * name no agent to this one, and at most how many a day. PUT …/dispatch
 * answers with the whole channel, which replaces the cached card.
 */
export default function HubDispatchSetting({ channel, agentFullName }: { channel: HubChannel; agentFullName: string }) {
  const queryClient = useQueryClient()
  const accept = channel.accept_dispatch ?? false
  const savedCap = channel.dispatch_daily_cap ?? DEFAULT_CAP
  const [cap, setCap] = useState(String(savedCap))
  const save = useMutation({
    mutationFn: (next: { accept: boolean; cap: number }) => setHubDispatch(agentFullName, next.accept, next.cap),
    onSuccess: (updated) => queryClient.setQueryData(hubChannelKey(agentFullName), updated),
  })
  const parsed = Number.parseInt(cap, 10)
  const capValid = Number.isInteger(parsed) && parsed >= DISPATCH_CAP_MIN && parsed <= DISPATCH_CAP_MAX
  const busy = save.isPending

  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2 space-y-2" data-testid="hub-dispatch">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{HUB_CARD_COPY.dispatchLabel}</p>
          <p className="text-xs text-gray-600 mt-0.5">{HUB_CARD_COPY.dispatchBody}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={accept}
          aria-disabled={busy || !capValid}
          aria-label={HUB_CARD_COPY.dispatchLabel}
          onClick={() => { if (!busy && capValid) save.mutate({ accept: !accept, cap: parsed }) }}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
            accept ? 'bg-purple-600' : 'bg-gray-300'
          } ${busy || !capValid ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
        >
          <span
            aria-hidden="true"
            className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white shadow transition-transform ${
              accept ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs text-gray-700">
        <label htmlFor="hub-dispatch-cap">{HUB_CARD_COPY.dispatchCapLabel}</label>
        <input
          id="hub-dispatch-cap"
          type="number"
          min={DISPATCH_CAP_MIN}
          max={DISPATCH_CAP_MAX}
          value={cap}
          disabled={busy}
          onChange={(e) => setCap(e.target.value)}
          onBlur={() => { if (capValid && parsed !== savedCap) save.mutate({ accept, cap: parsed }) }}
          className="w-20 rounded border border-gray-300 px-2 py-1"
        />
        {busy && <span>{HUB_CARD_COPY.dispatchSaving}</span>}
        {accept && !busy && (
          <span data-testid="hub-dispatch-today">
            {HUB_CARD_COPY.dispatchToday(channel.dispatched_today ?? 0, savedCap)}
          </span>
        )}
      </div>
      {save.error && <p role="alert" className="text-xs text-red-700">{errorText(save.error)}</p>}
    </div>
  )
}
