import { get } from '../client'
import type { Chatroom } from '../../types'

/**
 * The project-ids multi-get envelope.
 *
 * Contract (interface-contract-FINAL §3), all four clauses load-bearing:
 *  1. EVERY requested id appears in exactly one of `results` / `errors`. An id
 *     in neither is a server bug — the loader hard-rejects it rather than
 *     leaving a promise pending forever.
 *  2. `results[pid] === []` means "this project has no rooms" and is DISTINCT
 *     from `errors[pid]`. Real for 8 of 552 live projects, so membership must
 *     be tested by key presence, never by truthiness.
 *  3. Partial success is 200. Never 207, never 4xx — one bad id cannot fail
 *     the batch.
 *  4. Error codes are the opaque pair {'unavailable', 'internal'}.
 *     `unavailable` deliberately collapses unknown-id / not-authorized /
 *     corrupt-metadata into one code, because distinguishing them would be a
 *     project-existence oracle. There is no per-cause UI to build.
 */
export interface BatchEnvelope<T> {
  results: Record<string, T>
  errors: Record<string, string>
}

/** Rejection for one project id inside an otherwise-successful (200) batch. */
export class BatchItemError extends Error {
  constructor(
    public code: string,
    public projectId: string,
  ) {
    super(`batch item ${projectId}: ${code}`)
    this.name = 'BatchItemError'
  }
}

/**
 * Server cap on ids per request. The rationale is URL LENGTH, not cost
 * (50 x 37 chars ~= 1,850 B, under the 2,048 B budget; 60 would exceed it), so
 * it is not negotiable by measuring how cheap the server got. Mirrored here as
 * a compile-time constant — there is no shared module between the Python
 * server and this client, so drift is caught by the server's 400 rather than
 * prevented. Chunking against it is the MAIN path, not a fallback: a large
 * sidebar can hold hundreds of projects (~11 chunks at 539).
 */
export const MAX_PROJECT_IDS_PER_BATCH = 50

/**
 * GET /me/chatrooms?project_ids=a,b,c
 *
 * The raw wire call: no chunking, no dedupe, no retry — those are the loader's
 * job, which keeps this trivially mockable. Returns the envelope verbatim.
 * Throws ApiError (existing class) on any non-2xx.
 *
 * Requires the user JWT; `get` attaches it from authStore unconditionally.
 * Sends no conditional headers — R7 (ETag/304) was struck by the user, and the
 * response carries `Cache-Control: private, max-age=30` instead.
 */
export function getChatroomsBatch(
  projectIds: string[],
): Promise<BatchEnvelope<Chatroom[]>> {
  const ids = projectIds.map(encodeURIComponent).join(',')
  return get<BatchEnvelope<Chatroom[]>>(`/me/chatrooms?project_ids=${ids}`)
}
