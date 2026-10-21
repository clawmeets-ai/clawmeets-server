// One-time "account linked" reassurance. OAuthCallbackPage sets the
// OAUTH_LINKED_FLAG sessionStorage key when the backend reports status=linked
// (a provider's verified email matched an existing account and was attached to
// it). This banner reads-and-clears the flag on the first authenticated render
// and shows a dismissible confirmation. Provider-agnostic: the exchange payload
// and the callback redirect carry no provider name.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { OAUTH_LINKED_FLAG } from './OAuthCallbackPage'

export default function OAuthLinkedBanner() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (sessionStorage.getItem(OAUTH_LINKED_FLAG)) {
      sessionStorage.removeItem(OAUTH_LINKED_FLAG)
      setShow(true)
    }
  }, [])

  if (!show) return null

  return (
    <div
      className="flex items-center justify-between gap-3 px-4 py-2.5"
      style={{
        background: 'var(--prio-quick-bg)',
        color: 'var(--prio-quick-fg)',
        fontSize: 13,
      }}
    >
      <span>Your account is now linked for one-click sign-in.</span>
      <button
        type="button"
        onClick={() => setShow(false)}
        aria-label="Dismiss"
        className="flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
