import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ApiError } from '../../../api/client'
import { listRequests } from '../../../api/endpoints/channels'
import type { ChannelRequest } from '../../../api/endpoints/channels'

/** Pieces shared by the Channels section and the per-channel files beside it. */

export const CONNECTIONS_KEY = ['channel-connections']

export const requestsKey = (connectionId: string) => ['channel-requests', connectionId]

/** Requests still waiting for the owner's Allow or Block. */
export const waitingRequests = (requests: readonly ChannelRequest[]) =>
  requests.filter((r) => r.state === 'pending' || r.state === 'allowing')

/** One connection's requests. The Requests card, the tab badge and the Hub
 *  tab's banner share this query, so an Allow updates all three. */
export function useChannelRequests(connectionId: string | undefined) {
  return useQuery({
    queryKey: requestsKey(connectionId ?? ''),
    queryFn: () => listRequests(connectionId!),
    enabled: !!connectionId,
  })
}

/** What differs between channels on the page; everything else is shared. */
export interface ChannelKind {
  channel: 'telegram' | 'email' | 'line' | 'whatsapp' | 'hub'
  removeTitle: string
  removeBody: string
  disableTitle: string
  disableBody: string
  allowlistHelp: string
  /** null: no free-text input — entries arrive only by allowing a request. */
  allowlistPlaceholder: string | null
  /** The allowlist input's label; "Add to allowlist" when absent. */
  allowlistLabel?: string
  requestsHelp: string
  /** Label for `token_rejected`: the bot's own token, or the server's key. */
  tokenRejected: string
  /** This channel's own sentence for a status code whose remedy differs. */
  statusLabels?: Readonly<Record<string, string>>
  /** Status codes for which this channel offers Reconnect. */
  reconnectCodes: readonly string[]
  /** Appended to the "anyone" banner and its confirmation. */
  anyoneExtra?: string
  /** Shown under the reply to people waiting. */
  fixedReplyNote?: string
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return 'Something went wrong. Try again.'
}

export function when(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString()
}

/** Runs one request at a time; a second click while it runs does nothing. */
export function useAction() {
  const running = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(name)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    } finally {
      running.current = false
      setBusy(null)
    }
  }
  return { busy, error, setError, run }
}
