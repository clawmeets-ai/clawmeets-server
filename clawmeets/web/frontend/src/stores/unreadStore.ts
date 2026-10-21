import { create } from 'zustand'

/**
 * Read-watermark store. After the sidebar unread badge was deleted this is a
 * DESK-only store: every surviving key is a `deskRoomKey(pid)`
 * (`${pid}|user-communication`) written by useDeskReadState / useMarkDeskRead
 * and read by useDeskUpdates.
 *
 * Deleted with the badge: `unreadCounts` (+ `setUnreadCount` / `getUnreadCount`)
 * and `getLastSeenMessageId`. The count map was written by `markAsSeen` and
 * `mergeServerReadState` and read by `getUnreadCount`, which had zero callers —
 * dead before this change, not made dead by it.
 *
 * `markAsSeen` is KEPT. It is not dead: `useMarkDeskRead` calls it for the
 * desk's optimistic mark-read (deskReadState.ts), which is the write that drops
 * a card from the feed before the PUT settles.
 *
 * ------------------------------------------------------------------ AC-3.5
 * PER-USER STORAGE, AND WHY THE `persist` MIDDLEWARE CAME OFF.
 *
 * This store used to persist under one flat name, `clawmeets-unread`. With N
 * signed-in accounts in one browser that is a leak in both directions: the
 * watermarks account A wrote are read back for account B, so B's desk hides
 * cards B has never seen, and B's own marks overwrite A's. The keys are
 * `${projectId}|user-communication` — project ids, which carry no user
 * identity and cannot be told apart after the fact.
 *
 * `persist` takes ONE static name. Re-pointing it at `<key>:<userId>` on a
 * switch means calling `rehydrate()`, which is a promise — so the desk renders
 * one frame against the PREVIOUS account's watermarks before the right blob
 * lands. `announcementStore` and `deskLabelViewStore` both read and write by
 * hand for exactly this reason, and this is the third instance of the same
 * rule: synchronous, and guarded in BOTH directions, because Safari private
 * mode throws on `getItem` and quota throws on `setItem`.
 *
 * NOT MIGRATED, on purpose: the legacy flat `clawmeets-unread` blob is left
 * where it is and never read again. Adopting it into "whichever account
 * hydrates first" is a guess, and the cost of guessing wrong is one account's
 * read marks silently applied to another's desk — the exact failure this
 * criterion exists to close. The cost of not migrating is bounded and visible:
 * a handful of already-read desk cards resurface once, per account, on the
 * first load after this deploy. Logged as a followup rather than left implicit.
 */

const STORAGE_PREFIX = 'clawmeets-unread'

/** Per-user, following `announcementStore` and `deskLabelViewStore`. One
 *  interpolation; wrong by default if nobody says it. */
export function storageKey(userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}:${userId || 'anon'}`
}

/** Exactly the durable half of the state. */
export interface PersistedWatermarks {
  lastSeenMessages: Record<string, string>
  deskReadUpdatedAt: Record<string, string>
}

const EMPTY: PersistedWatermarks = { lastSeenMessages: {}, deskReadUpdatedAt: {} }

/** Only string-valued entries survive. Tolerates absent, corrupt and
 *  foreign-shaped blobs; a storage failure degrades to "nothing stored", never
 *  to a desk that will not render. */
function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>
}

export function loadWatermarks(userId: string | null | undefined): PersistedWatermarks {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(storageKey(userId))
  } catch {
    return { ...EMPTY }
  }
  if (!raw) return { ...EMPTY }
  try {
    const p = JSON.parse(raw) as Partial<PersistedWatermarks>
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { ...EMPTY }
    return {
      lastSeenMessages: stringMap(p.lastSeenMessages),
      deskReadUpdatedAt: stringMap(p.deskReadUpdatedAt),
    }
  } catch {
    return { ...EMPTY }
  }
}

function saveWatermarks(userId: string | null | undefined, next: PersistedWatermarks): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next))
  } catch {
    // Quota or disabled storage: the in-memory watermarks still hold for this
    // session, which is the useful half.
  }
}

interface UnreadState extends PersistedWatermarks {
  /** Which account these watermarks belong to. `null` before the first
   *  hydrate and after `reset()` — writes then land under the 'anon' key,
   *  which is what the pre-authenticated state should look like. */
  userId: string | null

  // Actions
  markAsSeen: (chatroomName: string, messageId: string) => void
  // Apply a server-authoritative desk watermark. No-op unless `updatedAt` is
  // strictly newer than the stored clock for this key (last-writer-wins), so a
  // stale WS event or hydration row can never un-do a newer mark. Advances only;
  // never deletes keys, so a pre-existing local read (no server clock yet)
  // survives until the next PUT backfills the server.
  mergeServerReadState: (
    key: string,
    messageId: string,
    updatedAt: string,
  ) => void
  // Restore one desk key to a pre-optimistic snapshot after a failed PUT.
  // `undefined` means the key did not exist and should be removed.
  rollbackDeskRead: (
    key: string,
    messageId: string | undefined,
    updatedAt: string | undefined,
  ) => void
  /** Point the store at a user and load that user's watermarks. No-op when the
   *  user is unchanged, so it is safe in an effect keyed on `userId` — which is
   *  how `App.tsx`'s authenticated shell calls it. `switchTo` calls it too, as
   *  its LAST step, so the desk never renders a frame against the outgoing
   *  account's marks. */
  hydrate: (userId: string | null) => void
  /** Clears the IN-MEMORY watermarks only. The stored blobs stay: they are
   *  still true for their users and should survive the next sign-in, and the
   *  key is already per-user so nothing leaks through storage. It is the
   *  in-memory carry-over that leaks. Called from the shared per-user reset
   *  list (`stores/perUserStores.ts`). */
  reset: () => void
}

/** Persist the durable half after every mutation. One helper so a new verb
 *  cannot forget — the failure mode otherwise is "this one mark doesn't survive
 *  a reload", which nobody reports and everybody works around. Mirrors
 *  `deskLabelViewStore`'s `persisted()`. */
function persisted(
  set: (fn: (s: UnreadState) => Partial<UnreadState>) => void,
  update: (s: UnreadState) => Partial<PersistedWatermarks> | null,
) {
  set((s) => {
    const patch = update(s)
    // `null` means the update decided it was a no-op (the LWW comparison), and
    // a no-op must not re-write storage.
    if (patch === null) return s
    const next: PersistedWatermarks = {
      lastSeenMessages: patch.lastSeenMessages ?? s.lastSeenMessages,
      deskReadUpdatedAt: patch.deskReadUpdatedAt ?? s.deskReadUpdatedAt,
    }
    saveWatermarks(s.userId, next)
    return next
  })
}

export const useUnreadStore = create<UnreadState>()((set, get) => ({
  ...EMPTY,
  userId: null,

  markAsSeen: (chatroomName: string, messageId: string) =>
    persisted(set, (s) => ({
      lastSeenMessages: { ...s.lastSeenMessages, [chatroomName]: messageId },
    })),

  mergeServerReadState: (key: string, messageId: string, updatedAt: string) =>
    persisted(set, (s) => {
      const prev = s.deskReadUpdatedAt[key]
      // Last-writer-wins: ignore anything not strictly newer than what we have
      // already applied (message ids are non-sortable uuid4, so the server
      // clock is the only ordering).
      if (prev != null && updatedAt <= prev) return null
      return {
        lastSeenMessages: { ...s.lastSeenMessages, [key]: messageId },
        deskReadUpdatedAt: { ...s.deskReadUpdatedAt, [key]: updatedAt },
      }
    }),

  rollbackDeskRead: (
    key: string,
    messageId: string | undefined,
    updatedAt: string | undefined,
  ) =>
    persisted(set, (s) => {
      const lastSeenMessages = { ...s.lastSeenMessages }
      const deskReadUpdatedAt = { ...s.deskReadUpdatedAt }
      if (messageId === undefined) delete lastSeenMessages[key]
      else lastSeenMessages[key] = messageId
      if (updatedAt === undefined) delete deskReadUpdatedAt[key]
      else deskReadUpdatedAt[key] = updatedAt
      return { lastSeenMessages, deskReadUpdatedAt }
    }),

  hydrate: (userId) => {
    if (get().userId === userId) return
    set({ userId, ...loadWatermarks(userId) })
  },

  reset: () => set({ userId: null, ...EMPTY }),
}))
