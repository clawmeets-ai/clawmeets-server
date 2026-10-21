import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, render, waitFor, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import { useProjectsWithChatrooms } from '../hooks/useProjectsWithChatrooms'
import FrontDeskPanel from '../components/sidebar/FrontDeskPanel'
import { makeSession, seedSessions } from '../test/authFixtures'
import type { Session } from '../stores/authStore'
import { AgentStatus, type Project, type AgentCard } from '../types'

/**
 * End-to-end request accounting for the batch cutover, through the REAL hooks,
 * the REAL `getChatrooms`, and the REAL module-singleton loader — only `fetch`
 * is stubbed. These are the numbers reported for AC9, re-measured rather than
 * quoted from the design.
 *
 * What this file measures: the per-project chatroom FAN-OUT, which is the only
 * term this milestone changes. The fixed tail of a session (`user-projects`,
 * `agents`, and a ChatroomView's 4 per-view requests) is unchanged by this work
 * and is enumerated, not measured, in the reported totals.
 *
 * ---------------------------------------------------------------------------
 * AC-5.6 / followup B12 — WHY THIS FILE'S FIXTURE WAS REWRITTEN IN M5.
 *
 * It used to seed auth by writing the MIRROR:
 *
 *     useAuthStore.setState({ accessToken: 'test-token', user: {...},
 *                             isAuthenticated: true })
 *
 * That built a state production can never reach. `sessions` was `[]` and
 * `activeUserId` was `null`, so once `api/client.ts` began resolving tokens
 * per-session, `captureContext()` returned null and EVERY request this file
 * drives went out with no `Authorization` header at all. The file stayed green
 * throughout, because it counted URLs and never once looked at a header.
 *
 * That is the "green tests over broken auth" failure the plan ranks third, and
 * it was measured here rather than argued: with the mirror fixture still in
 * place, the `rec.auth` assertion below reported
 *
 *     expected [ null ] to deeply equal [ 'Bearer test-token' ]
 *
 * Two things fixed it, and BOTH are load-bearing:
 *   1. The fixture hydrates through `seedSessions` — the same `setSession` the
 *      login page and the OAuth exchange use. A `Session` exists, so
 *      `bearerFor()` has something to answer with.
 *   2. The stub RECORDS `Authorization` and the tests ASSERT on it. Without
 *      this half, fixing the fixture would have made the file green again
 *      while restoring nothing that a future regression could trip over —
 *      which is the condition AC-5.6 exists to kill, not the one it exists to
 *      pass through.
 * ---------------------------------------------------------------------------
 */

const USER_ID = 'user-1'
const OWNER_AGENT = 'agent-desk-1'

/** The signed-in account these requests are issued FOR. Held so the header
 *  assertion can name its token rather than a literal. */
let session: Session

function seedAuth() {
  session = makeSession({ id: USER_ID, username: 'tester' })
  seedSessions([session], session.userId)
}

/** The header every request in this file must carry — the SEEDED SESSION's own
 *  access token, not the mirror's. Reading it from the session is what makes
 *  this an assertion about the request path rather than about the store
 *  agreeing with itself. */
function bearer(): string {
  return `Bearer ${session.accessToken}`
}

function makeProjects(n: number, surface: 'regular' | 'frontdesk'): Project[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    // Host-slug shape `{requester}-fd-{short}-{hex8}` so FrontDeskPanel groups.
    name: surface === 'frontdesk' ? `alice-fd-desk-0000000${i}` : `project-${i}`,
    status: 'active',
    coordinator_id: OWNER_AGENT,
    request: '',
    chatrooms: [],
    participating_agents: [],
    created_at: '2026-01-01T00:00:00Z',
    created_by: USER_ID,
    surface,
    last_modified: '2026-01-02T00:00:00Z',
  })) as unknown as Project[]
}

const FIELDING_AGENT: AgentCard = {
  id: OWNER_AGENT,
  name: 'desk-agent',
  description: '',
  capabilities: [],
  status: AgentStatus.ONLINE,
  registered_at: '2026-01-01T00:00:00Z',
  last_heartbeat: null,
  discoverable_through_registry: true,
  // `frontDeskSide` returns 'host' iff the viewer owns the fielding coordinator.
  registered_by: USER_ID,
  is_verified: true,
}

interface Recorder {
  urls: string[]
  batches: string[][]
  /** The `Authorization` header as SENT, per request, in issue order. */
  auth: (string | null)[]
}

/** Stub fetch for every route the sidebar touches; record what was asked for. */
function stubFetch(projects: Project[]): Recorder {
  const rec: Recorder = { urls: [], batches: [], auth: [] }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      rec.urls.push(url)
      rec.auth.push(new Headers(init?.headers).get('Authorization'))
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })

      if (url.includes('/me/chatrooms')) {
        const ids = decodeURIComponent(
          new URL(url, 'http://localhost').searchParams.get('project_ids') ?? '',
        )
          .split(',')
          .filter(Boolean)
        rec.batches.push(ids)
        return json({
          results: Object.fromEntries(
            ids.map((id) => [
              id,
              [
                {
                  id: 'user-communication',
                  name: 'user-communication',
                  project_id: id,
                  participants: [],
                  version: 1,
                  created_at: '2026-01-01T00:00:00Z',
                },
              ],
            ]),
          ),
          errors: {},
        })
      }
      if (url.includes('/projects') && url.includes('/chatrooms')) {
        // The pre-cutover shape. Reaching this in the "after" run is a failure.
        return json([])
      }
      if (url.includes('/participants/')) return json(projects)
      if (url.includes('/agents')) return json([FIELDING_AGENT])
      if (url.endsWith('/projects')) return json(projects)
      return json([])
    }),
  )
  return rec
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </MemoryRouter>
    )
  }
}

function freshClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  })
}

const chatroomFanout = (rec: Recorder) => ({
  batched: rec.urls.filter((u) => u.includes('/me/chatrooms')).length,
  perProject: rec.urls.filter(
    (u) => /\/projects\/[^/]+\/chatrooms(\?|$)/.test(u),
  ).length,
})

beforeEach(seedAuth)
afterEach(() => {
  // `globals: false` in vitest.config.ts means testing-library's auto-cleanup
  // never registers, so a render left standing here stays mounted and
  // subscribed into the NEXT file (followup B11). This file renders
  // FrontDeskPanel, which subscribes to the auth store.
  cleanup()
  vi.unstubAllGlobals()
  // Teardown through the real path too: a mirror write here would leave
  // `sessions` populated behind a nulled mirror, which is the same
  // unreachable state in the other direction.
  seedSessions([])
})

describe('Projects rail — sidebar fan-out (useProjectsWithChatrooms)', () => {
  for (const N of [15, 30]) {
    it(`collapses N=${N} per-project fetches into 1 batch`, async () => {
      const projects = makeProjects(N, 'regular')
      const rec = stubFetch(projects)
      const client = freshClient()

      const { result } = renderHook(() => useProjectsWithChatrooms(), {
        wrapper: wrapper(client),
      })

      await waitFor(() => expect(result.current.data).toHaveLength(N))
      await waitFor(() =>
        expect(result.current.data?.[N - 1]?.chatrooms).toHaveLength(1),
      )

      const { batched, perProject } = chatroomFanout(rec)
      expect(perProject).toBe(0) // nothing reaches the old route
      expect(batched).toBe(1) // ...and N ids ride one request
      expect(rec.batches[0]).toHaveLength(N)

      // AC-5.6. Counting URLs proves the SHAPE of the fan-out and nothing about
      // whether these requests would be honoured by a server.
      expect(rec.auth.length).toBeGreaterThan(0)
      // Asserted as the SET of distinct headers so a failure names what was
      // actually sent. `[null]` is the pre-rewrite fixture's answer.
      expect([...new Set(rec.auth)]).toEqual([bearer()])
    })
  }

  it('keeps per-project cache entries under the ["chatrooms", pid] key', async () => {
    const projects = makeProjects(15, 'regular')
    stubFetch(projects)
    const client = freshClient()

    const { result } = renderHook(() => useProjectsWithChatrooms(), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.data).toHaveLength(15))

    // 15 independent entries, batch-sourced — NOT one batch-shaped key. This is
    // what keeps scoped invalidation (useWebSocket ['chatrooms', pid]) working.
    const keys = client
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey)
      .filter((k) => Array.isArray(k) && k[0] === 'chatrooms')
    expect(keys).toHaveLength(15)
    expect(client.getQueryData(['chatrooms', 'p7'])).toHaveLength(1)
  })

  it('a scoped invalidation refetches only that project', async () => {
    const projects = makeProjects(15, 'regular')
    const rec = stubFetch(projects)
    const client = freshClient()

    const { result } = renderHook(() => useProjectsWithChatrooms(), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.data).toHaveLength(15))
    expect(rec.batches).toHaveLength(1)

    await client.invalidateQueries({ queryKey: ['chatrooms', 'p3'] })
    await waitFor(() => expect(rec.batches).toHaveLength(2))
    expect(rec.batches[1]).toEqual(['p3'])
  })
})

describe('Front Desk rail — the measured F=130 fan-out (FrontDeskPanel)', () => {
  it('collapses F=130 per-project fetches into 3 capped chunks', async () => {
    const projects = makeProjects(130, 'frontdesk')
    const rec = stubFetch(projects)
    const client = freshClient()

    render(<FrontDeskPanel />, { wrapper: wrapper(client) })

    await waitFor(() => expect(rec.batches.length).toBeGreaterThan(0))
    await waitFor(() => {
      const seen = rec.batches.flat()
      expect(new Set(seen).size).toBe(130)
    })

    const { batched, perProject } = chatroomFanout(rec)
    expect(perProject).toBe(0)
    // Every chunk is issued FOR the seeded account, chunking included — the
    // batcher must not lose the caller's identity on its way through the
    // module-singleton loader.
    expect([...new Set(rec.auth)]).toEqual([bearer()])
    // 130 ids against the 50-id cap: chunking is the MAIN path, not a fallback.
    expect(batched).toBe(3)
    expect(rec.batches.map((b) => b.length).sort((a, b) => b - a)).toEqual([
      50, 50, 30,
    ])
  })
})

describe('both rails mounted at once (the Back-button N+F state)', () => {
  it('coalesces F=130 and N=30 into 4 batches, not 3 + 1 separate flushes', async () => {
    // The two panels have no common React ancestor. They collapse together only
    // because the swap sits in getChatrooms behind a module-singleton loader —
    // this is the property a per-hook swap would not have bought.
    const fd = makeProjects(130, 'frontdesk')
    const regular = makeProjects(30, 'regular').map((p) => ({
      ...p,
      id: `r${p.id}`,
    }))
    const rec = stubFetch([...fd, ...regular] as Project[])
    const client = freshClient()

    function Both() {
      useProjectsWithChatrooms()
      return <FrontDeskPanel />
    }
    render(<Both />, { wrapper: wrapper(client) })

    await waitFor(() => {
      expect(new Set(rec.batches.flat()).size).toBe(160)
    })
    expect(rec.batches).toHaveLength(4)
    expect(chatroomFanout(rec).perProject).toBe(0)
    // Two panels with no common ancestor, coalesced behind one loader, and all
    // four batches still carry the one account's bearer.
    expect([...new Set(rec.auth)]).toEqual([bearer()])
  })
})

describe('partial failure degrades one row, not the sidebar', () => {
  it('renders the other projects when one id comes back in `errors`', async () => {
    const projects = makeProjects(15, 'regular')
    stubFetch(projects)
    // Re-stub: p7 fails, everyone else succeeds, all in one 200.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const json = (b: unknown) =>
          new Response(JSON.stringify(b), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        if (url.includes('/me/chatrooms')) {
          const ids = (
            new URL(url, 'http://localhost').searchParams.get('project_ids') ?? ''
          ).split(',')
          return json({
            results: Object.fromEntries(
              ids
                .filter((id) => id !== 'p7')
                .map((id) => [
                  id,
                  [
                    {
                      id: 'user-communication',
                      name: 'user-communication',
                      project_id: id,
                      participants: [],
                      version: 1,
                      created_at: '2026-01-01T00:00:00Z',
                    },
                  ],
                ]),
            ),
            errors: { p7: 'unavailable' },
          })
        }
        if (url.includes('/participants/')) return json(projects)
        if (url.includes('/agents')) return json([])
        return json([])
      }),
    )

    const client = freshClient()
    const { result } = renderHook(() => useProjectsWithChatrooms(), {
      wrapper: wrapper(client),
    })

    await waitFor(() => expect(result.current.data).toHaveLength(15))
    await waitFor(() =>
      expect(result.current.data?.[0]?.chatrooms).toHaveLength(1),
    )
    // Row 7 renders with zero chatrooms; every other row is populated. No
    // banner, no crash — byte-identical to today's single-request failure.
    const views = result.current.data!
    expect(views.find((v) => v.project_id === 'p7')?.chatrooms).toEqual([])
    expect(views.filter((v) => v.chatrooms.length === 1)).toHaveLength(14)
    expect(result.current.error).toBeNull()
  })
})
