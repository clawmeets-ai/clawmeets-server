import type { HubInputState } from '../../utils/hubThread'
import { HUB_COPY } from '../../utils/hubThread'

type Blocked = Extract<HubInputState, { enabled: false }>

/** Reasons where the thread itself is over, not just paused. */
const ENDED = new Set(['closed', 'unlisted'])

/**
 * Shown in place of the composer when the user can't send. The sentence comes
 * from hubThreadInputState; a closed or unlisted thread adds "You can't send
 * new messages", and a conversation the agent closed (still listed) offers
 * "Start a new one".
 */
export default function HubThreadBanner({ state, onStartNew }: { state: Blocked; onStartNew?: () => void }) {
  const ended = ENDED.has(state.reason)
  return (
    <div
      role="status"
      className={`rounded-lg border p-3 text-sm ${ended ? 'border-gray-200 bg-gray-50 text-gray-700' : 'border-amber-200 bg-amber-50 text-gray-800'}`}
      data-testid="hub-thread-banner"
      data-reason={state.reason}
    >
      <p>{state.text}</p>
      {ended && <p className="mt-1 font-medium text-gray-500">{HUB_COPY.cantSend}</p>}
      {state.canStartNew && onStartNew && (
        <button type="button" onClick={onStartNew} className="mt-2 rounded bg-indigo-600 px-3 py-1.5 text-white hover:bg-indigo-700">
          Start a new one
        </button>
      )}
    </div>
  )
}
