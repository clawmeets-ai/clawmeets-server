import { useSyncExternalStore } from 'react'
import { useWebSocketStatus } from '../../hooks/useWebSocket'
import { isServerRetrying, onTransientRetry } from '../../api/transientRetry'

export const SERVER_RETRYING_TEXT = 'Reconnecting to the server... your changes will go through once it is back.'
export const SOCKET_RECONNECTING_TEXT = 'Reconnecting to real-time updates...'

export default function ConnectionStatus() {
  const isConnected = useWebSocketStatus()
  // A request is waiting out a server restart (api/transientRetry.ts). Said
  // first: it is the one where the user's own action is on hold.
  const serverRetrying = useSyncExternalStore(onTransientRetry, isServerRetrying)

  // Don't show anything when connected
  if (isConnected && !serverRetrying) return null

  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 z-50 bg-yellow-500 text-yellow-900 text-center py-1.5 text-sm font-medium shadow-md"
    >
      <span className="inline-flex items-center gap-2">
        <span className="inline-block w-2 h-2 bg-yellow-700 rounded-full animate-pulse" />
        {serverRetrying ? SERVER_RETRYING_TEXT : SOCKET_RECONNECTING_TEXT}
      </span>
    </div>
  )
}
