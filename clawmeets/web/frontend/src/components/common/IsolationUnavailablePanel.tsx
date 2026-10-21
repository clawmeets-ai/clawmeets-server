import { ShieldAlert } from 'lucide-react'
import { ISOLATION_COPY } from '../../utils/agentAccessCopy'

/** Shown instead of a room, plan or report of an isolated project whose read
 *  answered 409 isolation_unavailable. No retry button: the server delivers
 *  the work once a computer that can isolate it is back. */
export default function IsolationUnavailablePanel() {
  return (
    <div
      role="status"
      data-testid="isolation-unavailable"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
    >
      <ShieldAlert className="h-6 w-6 text-gray-400" aria-hidden />
      <p className="text-sm font-medium text-gray-700">{ISOLATION_COPY.waiting}</p>
      <p className="max-w-md text-xs text-gray-500">{ISOLATION_COPY.waitingDetail}</p>
    </div>
  )
}
