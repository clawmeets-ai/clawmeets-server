import { create } from 'zustand'
// Types only: api/client resets this store (perUserStores), so a value
// import of the endpoints here would close an import cycle.
import type { HeldForReview } from '../api/endpoints/hub'
import type { ChatMessage } from '../types'

/**
 * Posts the server answered 202 HeldForReview: stored, delivered later, and
 * never to be resent. HeldForReview carries no message id, so a held post is
 * kept only for this session, per room, and dropped when a message of the
 * viewer's with the same content arrives in the room (HeldNotices). A message
 * the server answered as delivered at once (`delivered`) is never taken for
 * a held post's later delivery, so re-sending the same text keeps the notice.
 * While such a send is in flight (`sending`), its content matches nothing:
 * the WebSocket echo can arrive before the HTTP answer that names its id.
 */

/** One room's in-flight content, as a key of `sending`. */
export function sendingKey(projectId: string, room: string, content: string): string {
  return JSON.stringify([projectId, room, content])
}

export interface HeldPost {
  key: string
  projectId: string
  room: string
  content: string
  held: HeldForReview
}

interface HeldPostsState {
  posts: HeldPost[]
  /** Ids of the viewer's posts the server delivered at once this session. */
  delivered: ReadonlySet<string>
  /** sendingKey → sends of that content in flight. */
  sending: ReadonlyMap<string, number>
  /** A send leaves (onMutate) and settles (onSettled). */
  begin: (projectId: string, room: string, content: string) => void
  end: (projectId: string, room: string, content: string) => void
  add: (projectId: string, room: string, content: string, held: HeldForReview) => void
  /** A send's answer: a 202 becomes a held post, a delivered message's id is
   *  remembered in `delivered`. */
  record: (projectId: string, room: string, content: string, result: ChatMessage | HeldForReview) => void
  remove: (key: string) => void
  reset: () => void
}

let seq = 0

export const useHeldPostsStore = create<HeldPostsState>((set, get) => ({
  posts: [],
  delivered: new Set(),
  sending: new Map(),
  begin: (projectId, room, content) => set((s) => {
    const k = sendingKey(projectId, room, content)
    return { sending: new Map(s.sending).set(k, (s.sending.get(k) ?? 0) + 1) }
  }),
  end: (projectId, room, content) => set((s) => {
    const k = sendingKey(projectId, room, content)
    const n = (s.sending.get(k) ?? 0) - 1
    const sending = new Map(s.sending)
    if (n > 0) sending.set(k, n)
    else sending.delete(k)
    return { sending }
  }),
  add: (projectId, room, content, held) =>
    set((s) => ({ posts: [...s.posts, { key: `held-${++seq}`, projectId, room, content, held }] })),
  record: (projectId, room, content, result) => {
    // isHeldForReview's test, inline for the reason at the import.
    if ((result as HeldForReview).held === true) get().add(projectId, room, content, result as HeldForReview)
    // Only worth remembering while a post in the room waits.
    else if (get().posts.some((p) => p.projectId === projectId && p.room === room)) {
      set((s) => ({ delivered: new Set([...s.delivered, (result as ChatMessage).id]) }))
    }
  },
  remove: (key) => set((s) => ({ posts: s.posts.filter((p) => p.key !== key) })),
  reset: () => set({ posts: [], delivered: new Set(), sending: new Map() }),
}))
