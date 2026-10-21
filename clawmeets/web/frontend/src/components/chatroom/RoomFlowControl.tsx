import { ApiError } from '../../api/client'
import { hubError, type RoomFlow } from '../../api/endpoints/hub'
import { useSetRoomFlow } from '../../hooks/useAgentAccess'
import { accessErrorText, FLOW_COPY } from '../../utils/agentAccessCopy'

/** The sentence for a refused flow change. */
export function flowErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 503) return FLOW_COPY.unavailable
  return accessErrorText(hubError(e)) ?? FLOW_COPY.failed
}

/**
 * "Stop outside messages" / "Resume" for the room's owner. The caller decides
 * it is shown (the owner's browser, a room that takes outside messages:
 * utils/roomTrust.roomTakesOutsideMessages). Resuming a room the monitor
 * stopped asks once. The error shows inline, under the button.
 */
export default function RoomFlowControl({ projectId, room, flow }: {
  projectId: string
  room: string
  flow: RoomFlow | undefined
}) {
  const set = useSetRoomFlow(projectId, room)
  const stopped = flow?.inbound_flow === 'stopped'
  const run = () => {
    if (set.isPending) return
    if (stopped && flow?.stopped_by === 'inspector' && !window.confirm(FLOW_COPY.resumeAfterMonitor)) return
    set.mutate(stopped ? 'open' : 'stopped')
  }
  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={run}
        disabled={set.isPending}
        title={stopped ? undefined : FLOW_COPY.stopTitle}
        className="rounded border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        data-testid="room-flow-control"
      >
        {set.isPending
          ? (stopped ? FLOW_COPY.resuming : FLOW_COPY.stopping)
          : (stopped ? FLOW_COPY.resume : FLOW_COPY.stop)}
      </button>
      {set.isError && (
        <p role="alert" className="mt-1 text-[11px] text-red-700" data-testid="room-flow-error">{flowErrorText(set.error)}</p>
      )}
    </div>
  )
}
