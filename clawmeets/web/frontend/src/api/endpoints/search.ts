import { get } from '../client'
import type { MessageSearchResponse } from '../../types'

export interface MessageSearchParams {
  q: string
  limit?: number
  offset?: number
}

/**
 * GET /me/search/messages — chat message search (SEARCH_API_CONTRACT.md v1.0 §1).
 *
 * The user JWT is attached by api/client; there is no user, project or room
 * selector — the server derives the searchable scope from the credential alone.
 * `q` goes out RAW and unescaped (§2.2): the server sanitizes and tokenizes, and
 * there is no query DSL to escape against. `signal` comes from React Query so a
 * superseded request is aborted rather than left to land late.
 */
export async function searchMessages(
  params: MessageSearchParams,
  signal?: AbortSignal,
): Promise<MessageSearchResponse> {
  const qs = new URLSearchParams({ q: params.q })
  if (params.limit !== undefined) qs.set('limit', String(params.limit))
  if (params.offset !== undefined) qs.set('offset', String(params.offset))
  return get<MessageSearchResponse>(`/me/search/messages?${qs.toString()}`, signal)
}
