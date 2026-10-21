import { createBatchLoader, type BatchLoader } from './batchLoader'
import { getChatroomsBatch, MAX_PROJECT_IDS_PER_BATCH } from './endpoints/batch'
import type { Chatroom } from '../types'

/**
 * The one chatroom-list loader for the whole app.
 *
 * MUST be a module singleton, not per-hook or per-component: the entire point
 * is coalescing across call sites that have no common React ancestor to hang a
 * context off — the sidebar's N `useProjectsWithChatrooms` entries, the Front
 * Desk panel's F, `useContextFirstItem`, `useChatrooms`, and the imperative
 * `useCreateProject`. They all reach it through `getChatrooms`, so they all
 * join the same flush window.
 *
 * Imported by exactly one module (`api/endpoints/projects.ts`) — asserted by
 * singleIssuer.test.ts, which is what keeps the fan-out from being
 * reintroduced by a new call site.
 */
export const chatroomsLoader: BatchLoader<Chatroom[]> = createBatchLoader<Chatroom[]>({
  fetchChunk: getChatroomsBatch,
  maxChunk: MAX_PROJECT_IDS_PER_BATCH,
})
