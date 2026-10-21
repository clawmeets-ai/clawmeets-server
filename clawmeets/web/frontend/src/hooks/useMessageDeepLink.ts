import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Owns the `?msg=` deep-link param end-to-end for BOTH destination views
 * (ChatroomView and DMChatView). Reads the scroll-and-highlight target and
 * hands back a stripper, mirroring the consume-and-clear pattern DMChatView
 * already uses for `?draft=` — so a refresh or a back-nav doesn't re-fire the
 * jump at a user who has since scrolled somewhere else.
 *
 * `clearTarget` is stable, so it is safe as an effect dependency in MessageList.
 */
export function useMessageDeepLink(): {
  targetMessageId: string | null
  clearTarget: () => void
} {
  const [searchParams, setSearchParams] = useSearchParams()
  const targetMessageId = searchParams.get('msg')

  const clearTarget = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('msg')
        return next
      },
      { replace: true },
    )
  }, [setSearchParams])

  return { targetMessageId, clearTarget }
}
