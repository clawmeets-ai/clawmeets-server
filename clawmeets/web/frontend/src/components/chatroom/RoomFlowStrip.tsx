import { PauseCircle } from 'lucide-react'
import type { RoomFlow } from '../../api/endpoints/hub'
import { flowStripText } from '../../utils/agentAccessCopy'
import { formatHubTime } from '../../utils/hubDisplay'

/**
 * Above the composer while the room's outside messages are stopped; every
 * member sees it. "Outside messages are stopped (by you | by the monitor) ·
 * N held", the time it stopped, and the reason as text when there is one.
 */
export default function RoomFlowStrip({ flow, viewerIsOwner }: { flow: RoomFlow | undefined; viewerIsOwner: boolean }) {
  if (flow?.inbound_flow !== 'stopped') return null
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
      data-testid="room-flow-strip"
    >
      <PauseCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span data-testid="room-flow-strip-text">{flowStripText(flow, viewerIsOwner)}</span>
      {flow.stopped_at != null && <span className="text-amber-700">since {formatHubTime(flow.stopped_at)}</span>}
      {flow.reason && <span className="text-amber-700" data-testid="room-flow-reason">— {flow.reason}</span>}
    </div>
  )
}
