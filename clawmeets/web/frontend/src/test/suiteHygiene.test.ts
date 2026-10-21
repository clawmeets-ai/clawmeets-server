import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * TWO PROPERTIES OF THE TEST SUITE ITSELF, ASSERTED RATHER THAN PROMISED.
 *
 * Both were closed by hand in M5 — the AC-5.6 fixture sweep and the B11 cleanup
 * audit. Neither STAYS closed by hand. Both are re-introduced by writing an
 * ordinary-looking line in a new file, both leave the suite green when they are,
 * and the whole reason AC-5.6 exists is that a green suite over broken auth is
 * the worst outcome available here. A one-time audit that is not also a check is
 * a claim with a shelf life; this file is the check.
 *
 * It reads the source tree from disk on purpose. There is no other way to make a
 * statement about files that do not import each other, and "no file in this
 * suite does X" is exactly that kind of statement.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function testFiles(dir: string = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) testFiles(full, out)
    else if (/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Comments are prose ABOUT the patterns below and routinely quote them — this
 *  file's own header does. Scanning them would make every explanation a
 *  violation and the check unwritable. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** The object literal passed to one `setState(` call, brace-balanced. */
function setStateArguments(source: string): string[] {
  const found: string[] = []
  const needle = 'useAuthStore.setState('
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    let depth = 0
    let i = at + needle.length - 1
    do {
      if (source[i] === '(' || source[i] === '{') depth++
      else if (source[i] === ')' || source[i] === '}') depth--
      i++
    } while (depth > 0 && i < source.length)
    found.push(source.slice(at, i))
  }
  return found
}

/**
 * The checker excludes itself, and that is not a convenience. Its
 * not-vacuously-green case below carries a SAMPLE of the very text it looks
 * for, in a template literal — so scanning itself, it finds its own sample and
 * reports it. (Measured: it did, on the first run, with
 * `test/suiteHygiene.test.ts writes accessToken, isAuthenticated`. The check
 * proving itself by catching itself is a nice enough demonstration that the
 * sample stays.)
 */
const SELF = 'test/suiteHygiene.test.ts'
const relToSrc = (f: string) => relative(SRC, f)
const FILES = testFiles().filter((f) => relToSrc(f) !== SELF)

describe('AC-5.6 — no test seeds auth by writing the mirror', () => {
  /**
   * THE FAILURE THIS PREVENTS, restated because a future reader will meet this
   * check before they meet the story. `accessToken` / `refreshToken` /
   * `isAuthenticated` are a DERIVED mirror of `sessions[activeUserId]`, written
   * by one internal `syncActive()`. Writing them directly builds a state
   * production can never reach: no `Session` exists, so `bearerFor()` returns
   * null and every request the test drives goes out with NO Authorization
   * header — while the test passes, because a test that seeds auth this way is
   * almost never a test that asserts on headers.
   *
   * That is not hypothetical. `api/chatroomsBatch.test.tsx` was in exactly that
   * state for the length of M2 through M4, green the whole way, and the header
   * assertion added in M5 reported `expected [ null ] to deeply equal
   * [ 'Bearer …' ]` the moment it was pointed at the old fixture.
   *
   * `user:` is deliberately NOT in this list, and the omission is reasoned
   * rather than lazy — see the `user`-only case below.
   */
  const CLAIMS_A_SESSION = ['accessToken', 'refreshToken', 'isAuthenticated']

  it('no useAuthStore.setState() writes a token or the signed-in flag', () => {
    const offenders: string[] = []
    for (const file of FILES) {
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const call of setStateArguments(source)) {
        const claimed = CLAIMS_A_SESSION.filter((field) =>
          new RegExp(`\\b${field}\\s*:`).test(call),
        )
        if (claimed.length > 0) {
          offenders.push(`${relToSrc(file)} writes ${claimed.join(', ')}`)
        }
      }
    }
    // Build a session and install it with `seedSessions` from
    // `src/test/authFixtures.ts`, which hydrates through the same `setSession`
    // the login page and the OAuth exchange use.
    expect(offenders).toEqual([])
  })

  it('the check can see a violation (it is not vacuously green)', () => {
    // The check is only worth what it would catch, and its subject is source
    // text rather than behaviour — so the proof has to be a sample of that text.
    const sample = `
      // useAuthStore.setState({ accessToken: 'in a comment, not a violation' })
      useAuthStore.setState({ user: REGULAR })
      useAuthStore.setState({ accessToken: 't', isAuthenticated: true })
    `
    const calls = setStateArguments(stripComments(sample))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('user: REGULAR')
    expect(calls[1]).toContain('accessToken')
    expect(calls[1]).toContain('isAuthenticated')
  })

  /**
   * WHY `user:`-ONLY WRITES ARE OUT OF SCOPE, stated here rather than in a
   * report nobody will re-read.
   *
   * Five sites across four files (`PlanBand`, `PlanAcceptance`,
   * `PlanDestructiveAccept`, `AnnouncementBanners`) set
   * `user` and nothing else. They
   * are seeding an IDENTITY for a render — "who is reading this page" — not a
   * session. They claim no token, they issue no authenticated request through
   * the real `client.ts`, and the code under test reads `user` and stops.
   * AC-5.6's hazard is a fixture whose requests are silently unauthenticated,
   * and a fixture that makes no requests cannot have it.
   *
   * Converting them would also cost more than it buys: `seedSessions` opens
   * with a full `logout()`, which runs `tearDownPerUserState()` — eight store
   * resets plus `queryClient.clear()`. Three of those four files seed
   * `runnerVersionStore` / `announcementStore` / a QueryClient in the same
   * `beforeEach`, so the conversion introduces an ordering hazard into
   * fixtures that do not currently have one.
   *
   * It is not nothing, though: a `user:` write IS a mirror write, and any auth
   * action firing in one of those tests would have `syncActive()` revert it
   * underneath. Nothing in those files fires one today. Logged as B29 rather
   * than left to be rediscovered.
   */
  it('records the user-only sites that this criterion deliberately does not reach', () => {
    const userOnly: string[] = []
    for (const file of FILES) {
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const call of setStateArguments(source)) {
        if (/\buser\s*:/.test(call) && !/\baccessToken\s*:/.test(call)) {
          userOnly.push(relToSrc(file))
        }
      }
    }
    // If either of these moves, the narrowing above is being EXTENDED by
    // accident rather than decided. A new file here means a new fixture that
    // seeds identity through the mirror; re-read the reasoning above and
    // establish that it still applies before widening the list.
    expect([...new Set(userOnly)].sort()).toEqual([
      'components/common/AnnouncementBanners.test.tsx',
      'components/desk/PlanBand.test.tsx',
      'components/project/plan/PlanAcceptance.test.tsx',
      // DECIDED, NOT DRIFTED. This one is a `PlanAcceptance` sibling and the
      // reasoning above holds line for line: it seeds "who is reading" for a
      // render, mocks `api/client` wholesale so no request reaches the real
      // one, and builds a QueryClient in the same `beforeEach` that the
      // `seedSessions` teardown would clear underneath it.
      'components/project/plan/PlanDestructiveAccept.test.tsx',
    ])
    // Five sites: PlanBand 2, AnnouncementBanners 1, PlanAcceptance 1,
    // PlanDestructiveAccept 1.
    expect(userOnly).toHaveLength(5)
  })
})

describe('followup B11 — every render is torn down', () => {
  /**
   * `vitest.config.ts` sets `globals: false`. testing-library registers its
   * auto-cleanup by calling the AMBIENT `afterEach`, which under that setting
   * does not exist — so the registration silently does not happen and nothing
   * anywhere says so.
   *
   * A render that is never torn down stays MOUNTED for the rest of the file and
   * beyond: still subscribed to every store it reads, still holding every timer
   * and socket its effects started. The next test's fixture re-renders it and
   * re-fires those effects — in a file that has no idea the component exists.
   * That is not a tidiness problem. `authStore.multiSession.test.ts` counts
   * `wsManager.connectAsUser` calls to prove AC-2.12, and a stray mounted
   * `useWebSocketConnection` from an earlier file adds to that count.
   *
   * `vitest.config.ts` is outside this project's scope fence
   * (`web/frontend/src/`), so the fix is per-file and this is what keeps it
   * complete.
   */
  it('every test file that renders also calls cleanup() or unmounts', () => {
    const leaking: string[] = []
    for (const file of FILES) {
      const source = stripComments(readFileSync(file, 'utf8'))
      const renders = /(?<![.\w])(render|renderHook)\s*\(/.test(source)
      const tearsDown = /\bcleanup\b/.test(source) || /\bunmount\s*\(/.test(source)
      if (renders && !tearsDown) leaking.push(relToSrc(file))
    }
    // Add `afterEach(cleanup)` from '@testing-library/react', or unmount each
    // render explicitly the way the useWebSocket.* files do.
    expect(leaking).toEqual([])
  })
})
