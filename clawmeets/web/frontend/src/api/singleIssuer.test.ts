import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * STATIC enforcement of the one structural property this milestone buys.
 *
 * The per-project chatroom fan-out was collapsed by swapping the batch in at
 * ONE place — `getChatrooms` (api/endpoints/projects.ts) — rather than at each
 * of the five call sites. That choice is only durable if a sixth call site
 * cannot quietly reintroduce the fan-out, which is exactly how FrontDeskPanel's
 * x130 stayed invisible for five milestones. A checklist someone has to
 * remember is not enforcement; this file is.
 *
 * These assertions read SOURCE TEXT, not behaviour, on purpose: a runtime test
 * only covers the code paths it happens to render.
 */

const SRC = join(process.cwd(), 'src')

/**
 * Scan CODE, not prose. Several of the deletions below are documented in
 * comments that necessarily quote the thing they deleted (`['unread']`, the old
 * `/projects/{id}/chatrooms` route); matching those would make the guard fire on
 * its own explanation. `://` is excluded so URLs survive.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const FILES = sourceFiles(SRC).map((f) => ({
  path: relative(SRC, f).split(sep).join('/'),
  text: stripComments(readFileSync(f, 'utf8')),
}))

/** Files whose source matches `re`, as repo-relative paths. */
function filesMatching(re: RegExp): string[] {
  return FILES.filter((f) => re.test(f.text)).map((f) => f.path).sort()
}

describe('chatroom fetching has exactly one issuer', () => {
  it('no module issues the single-project chatrooms-LIST route', () => {
    // `/projects/{id}/chatrooms` with nothing after it. The negative lookahead
    // spares the per-room routes that legitimately remain
    // (`/chatrooms/{room}`, `/chatrooms/{room}/messages`, router paths, ...).
    const LIST_ROUTE = /\/projects\/[^`'"\n]*\/chatrooms(?![\w/])/
    expect(filesMatching(LIST_ROUTE)).toEqual([])
  })

  it('only getChatrooms reaches the coalescing loader', () => {
    // api/loaders.ts defines it; api/endpoints/projects.ts consumes it. A third
    // module here means someone bypassed getChatrooms — the batch would still
    // work, but the single-entry-point guarantee would be gone.
    expect(filesMatching(/chatroomsLoader/)).toEqual([
      'api/endpoints/projects.ts',
      'api/loaders.ts',
    ])
  })

  it('only the loader calls the raw batch endpoint', () => {
    expect(filesMatching(/getChatroomsBatch/)).toEqual([
      'api/endpoints/batch.ts',
      'api/loaders.ts',
    ])
  })

  it('getChatrooms delegates to the loader rather than fetching directly', () => {
    const projects = FILES.find((f) => f.path === 'api/endpoints/projects.ts')!
    const body = /export async function getChatrooms\([^)]*\)[^{]*\{([^}]*)\}/.exec(
      projects.text,
    )
    expect(body).not.toBeNull()
    expect(body![1]).toContain('chatroomsLoader.load(projectId)')
  })
})

describe('the deleted unread machinery stays deleted', () => {
  // P3 regression gates. Each of these was a x N fan-out on cold mount; they
  // were deleted rather than batched, and `userCommId` was established
  // DEFINITIVE DEAD with all four consumers enumerated in M6.
  it('nothing fetches the user-communication-chatroom route', () => {
    expect(filesMatching(/user-communication-chatroom/)).toEqual([])
  })

  it('nothing fetches an unread-count route', () => {
    expect(filesMatching(/unread-count/)).toEqual([])
  })

  it("no ['unread', ...] query key or invalidation survives", () => {
    expect(filesMatching(/\[\s*'unread'/)).toEqual([])
  })

  // The count is a change-detector, not the invariant: it forces anyone adding
  // a family to look at this test and confirm ['unread'] is still gone. It went
  // 12 -> 13 when ['announcements'] landed on main (runner-version banners), and
  // 13 -> 17 when the four desk/briefing families that had a push frame but no
  // reconnect path were added: ['desk-todos'], ['desk-labels'], ['brief-tabs']
  // and ['brief-tab']. That omission is the bug the count is meant to catch, so
  // the number going UP here is the healthy direction. 17 -> 18 when
  // ['computers'] landed: a HOST_SYNC missed while the socket was down otherwise
  // leaves the Computers page asserting a machine is online hours after it
  // slept, which is the exact wrong answer that surface exists to stop giving.
  // 18 -> 19 when ['install-progress'] landed: a user watching the one-command
  // install through a socket blip would otherwise see it freeze on whichever
  // step was reported last, which reads as a hung install rather than a missed
  // push — on the one screen where they have no other way to tell.
  // The reconnect catch-up became tiered + paced (reconnectTiers + the
  // stale-only staleOnlyKeys); the count spans both and is taken over UNIQUE
  // families so a key named again in a comment doesn't inflate it. 19 plus the
  // desk's batched feed, which is keyed by a constant rather than a literal.
  it('the reconnect invalidation list carries no unread family', () => {
    const ws = FILES.find((f) => f.path === 'hooks/useWebSocket.ts')!
    const list = /const reconnectTiers[^=]*= \[([\s\S]*?)\n {4}const staleOnlyKeys = \[([^\n]*)\]/.exec(ws.text)
    expect(list).not.toBeNull()
    const families = [...new Set((list![1] + list![2]).match(/\['[^']+'\]/g) ?? [])]
    expect(families).toHaveLength(19)
    expect(list![1]).toContain('[DESK_LATEST_MESSAGES_KEY]')
    expect(families).not.toContain("['unread']")
    // The one that must still be there: it is what makes a reconnect cost one
    // batch instead of N requests.
    expect(families).toContain("['chatrooms']")
  })

  it('the unreadStore keeps only the desk-facing surface', () => {
    const store = FILES.find((f) => f.path === 'stores/unreadStore.ts')!
    // `markAsSeen` is NOT dead — useMarkDeskRead calls it for the desk's
    // optimistic mark-read. The count map and its accessors were.
    for (const dead of ['setUnreadCount', 'getUnreadCount', 'getLastSeenMessageId']) {
      expect(store.text.includes(`${dead}:`)).toBe(false)
    }
    expect(store.text).toContain('markAsSeen:')
    expect(store.text).toContain('mergeServerReadState:')
  })
})
