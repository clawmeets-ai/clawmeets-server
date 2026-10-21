import { useState } from 'react'
import { Eraser, Loader2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { clearChatroomHistory } from '../../api/endpoints/messages'
import { ApiError } from '../../api/client'

interface Props {
  projectId: string
  chatroomName: string
  // Optional label shown inside the confirmation dialog. Defaults to the
  // chatroom name; pass a friendlier value (e.g. "@agent-name" in DMs)
  // when the room name is opaque to the user.
  confirmLabel?: string
  // Optional extra invalidations after a successful clear. The messages
  // query for this room is always invalidated; the WS CHANGELOG_UPDATE
  // refetch normally handles everything else, but FD's user-communication
  // surface keys differently in places — pass those keys here.
  extraInvalidateKeys?: unknown[][]
}

export default function ClearHistoryButton({
  projectId,
  chatroomName,
  confirmLabel,
  extraInvalidateKeys,
}: Props) {
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const clearMutation = useMutation({
    mutationFn: () => clearChatroomHistory(projectId, chatroomName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', projectId, chatroomName] })
      for (const key of extraInvalidateKeys || []) {
        queryClient.invalidateQueries({ queryKey: key })
      }
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Failed to clear history')
    },
  })

  const handleClick = () => {
    setError(null)
    const label = confirmLabel || chatroomName
    if (window.confirm(`Clear all messages in ${label}? This cannot be undone.`)) {
      clearMutation.mutate()
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={clearMutation.isPending}
        className="p-2 rounded-md hover:bg-sidebar-hover transition-colors text-channel hover:text-red-600 disabled:opacity-50"
        aria-label="Clear chat history"
        title="Clear chat history"
      >
        {clearMutation.isPending ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Eraser className="w-5 h-5" />
        )}
      </button>
      {error && (
        <span className="text-xs text-red-600 ml-2" role="alert">
          {error}
        </span>
      )}
    </>
  )
}
