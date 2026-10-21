import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '../../stores/authStore'
import { makeSession, seedSessions } from '../../test/authFixtures'
import type { BriefTab } from '../../api/endpoints/briefTabs'
import { ApiError } from '../../api/client'
import MyDeskRailPanel from './MyDeskRailPanel'

/**
 * DELETING A BRIEFING FROM THE RAIL.
 *
 * The mock boundary is the ENDPOINT MODULE, not the hooks — `useBriefTabs` and
 * `useDeleteBriefTab` run for real against a real QueryClient. That is the
 * whole point: the thing most likely to be wrong here is not the button, it is
 * whether the delete's cache write actually reaches the key the rail reads
 * from, and a mocked hook would assert that away. So "the row disappears" is
 * observed the way the owner observes it — the list refetches and the row is
 * not in the answer.
 *
 * `window.confirm` does not exist in jsdom as anything callable, so every test
 * stubs it explicitly. A test that forgot to would throw rather than silently
 * delete, which is the right way round.
 *
 * The desk-feed hooks ARE mocked: the rail renders three nav sections above the
 * briefings that need agents, projects, DM threads and read-state to resolve,
 * and none of that is under test here.
 */

const getBriefTabs = vi.fn()
const getBriefTab = vi.fn()
const deleteBriefTab = vi.fn()

vi.mock('../../api/endpoints/briefTabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/endpoints/briefTabs')>()
  return {
    ...actual,
    getBriefTabs: () => getBriefTabs(),
    getBriefTab: (slug: string) => getBriefTab(slug),
    deleteBriefTab: (slug: string) => deleteBriefTab(slug),
  }
})

vi.mock('../../hooks/useDeskUpdates', () => ({
  useDeskUpdates: () => ({ updates: [], counts: {}, isLoading: false, ready: true }),
}))
vi.mock('../../hooks/useDeskRecentlyDone', () => ({
  useDeskRecentlyDone: () => ({ cards: [], lastSignedOffAt: null, isLoading: false }),
}))
vi.mock('../../hooks/useProjects', () => ({
  useUserProjects: () => ({ data: [] }),
}))
// The panel reads the plate to resolve the desk ↔ to-do cross-highlight on its
// sub-rows. Nothing under test here has sub-rows (the feed above is empty), so
// this is stubbed rather than left to reach for `GET /me/desk/todos` — an
// unmocked request that happens to resolve to nothing is not the same as no
// request, and the difference shows up as flake the day the client changes.
// `MyDeskRailPanel.crossHighlight.test.tsx` runs this hook for real.
vi.mock('../../hooks/useTodos', () => ({
  useTodos: () => ({ todos: [], isLoading: false }),
}))

const WINE: BriefTab = {
  slug: 'wine',
  title: 'Wine inventory',
  owner_user_id: 'u1',
  owner_agent_id: 'a1',
  owner_agent_name: 'sommelier',
  generated_at: '2026-09-08T10:00:00Z',
}
const SALES: BriefTab = { ...WINE, slug: 'sales', title: 'Weekly sales' }

let queryClient: QueryClient
let location: string

function Probe() {
  location = useLocation().pathname
  return null
}

function renderRail(at = '/desk') {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <Probe />
        <Routes>
          <Route path="*" element={<MyDeskRailPanel />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const click = (el: HTMLElement) => act(async () => {
  fireEvent.click(el)
})

const deleteControl = (title: string) =>
  screen.getByRole('button', { name: `Delete briefing "${title}"` })

beforeEach(() => {
  // The sanctioned fixture, not a bare `setState({ user })`: the rail's reads
  // key on the signed-in user's id AND the delete goes out on that session's
  // bearer, so seeding the identity without the session would be seeding half
  // of what is under test. `suiteHygiene` polices exactly this.
  seedSessions([makeSession({ id: 'u1' })], 'u1')
  getBriefTabs.mockResolvedValue([WINE, SALES])
  deleteBriefTab.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  useAuthStore.getState().logout()
})

describe('the delete control on a briefing row', () => {
  it('is a real button, named for the briefing, and reachable by keyboard', async () => {
    // AC-1.1. "Reachable by tabbing" is not the same as "rendered": a control
    // revealed only by a CSS :hover rule is still in the tab order, so the
    // assertion that matters is that focus lands on it and that what a screen
    // reader then reads names the briefing rather than saying "button".
    renderRail()
    const row = await screen.findByText('Wine inventory')

    const trash = deleteControl('Wine inventory')
    expect(trash).toBeDefined()
    expect(row).toBeDefined()

    trash.focus()
    expect(document.activeElement).toBe(trash)
    // Revealed on focus, not on hover alone — otherwise a keyboard user tabs
    // onto a control they cannot see.
    expect(trash.className).toContain('group-focus-within:opacity-100')
  })

  it('every briefing gets its own, named for itself', async () => {
    renderRail()
    await screen.findByText('Wine inventory')

    expect(deleteControl('Wine inventory')).not.toBe(deleteControl('Weekly sales'))
  })

  it('declining the confirmation deletes nothing and leaves the row', async () => {
    // AC-1.2. The failure this guards is the one that cannot be walked back:
    // a confirm whose return value is ignored.
    const confirm = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirm)
    renderRail()
    await screen.findByText('Wine inventory')

    await click(deleteControl('Wine inventory'))

    expect(confirm).toHaveBeenCalledOnce()
    expect(deleteBriefTab).not.toHaveBeenCalled()
    expect(screen.getByText('Wine inventory')).toBeDefined()

    vi.unstubAllGlobals()
  })

  it('confirming deletes that slug and the row goes', async () => {
    // AC-1.3. The row's disappearance is driven by the refetch, not by the
    // component crossing it out locally — which is why the list mock changes
    // its answer rather than the test asserting on component state.
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    renderRail()
    await screen.findByText('Wine inventory')

    getBriefTabs.mockResolvedValue([SALES])
    await click(deleteControl('Wine inventory'))

    expect(deleteBriefTab).toHaveBeenCalledWith('wine')
    await waitFor(() => expect(screen.queryByText('Wine inventory')).toBeNull())
    // The one it was NOT asked to delete is untouched.
    expect(screen.getByText('Weekly sales')).toBeDefined()

    vi.unstubAllGlobals()
  })

  it('the onboarding sample row offers no delete control', async () => {
    // AC-1.4. `__sample__` is a local constant the server has never issued, so
    // a delete for it could only ever 404. The row must not invite one.
    getBriefTabs.mockResolvedValue([])
    renderRail()
    await screen.findByText('Sample Briefing')

    expect(
      screen.queryByRole('button', { name: /^Delete briefing/ }),
    ).toBeNull()
  })
})

describe('a delete that fails', () => {
  it('says so, and the briefing stays on the rail', async () => {
    // AC-3.1. Silently dropping the row here would tell the owner the exact
    // opposite of what happened, and the next reload would bring it back with
    // no explanation.
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    deleteBriefTab.mockRejectedValue(new ApiError(404, 'Brief tab not found'))
    renderRail()
    await screen.findByText('Wine inventory')

    await click(deleteControl('Wine inventory'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Wine inventory')
    expect(screen.getByText('Wine inventory')).toBeDefined()

    vi.unstubAllGlobals()
  })

  it('retires the message when the row it names goes away anyway', async () => {
    // The message says the briefing is STILL ON YOUR DESK, and that sentence
    // can be overtaken by events with nobody pressing anything: the owner
    // already deleted this briefing in another tab, so the delete here 404s —
    // and then the broadcast for that other delete lands and takes the row
    // off. A message slot that only cleared on the next click would sit there
    // insisting the row exists, beside the space where it used to be.
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    deleteBriefTab.mockRejectedValue(new ApiError(404, 'Brief tab not found'))
    renderRail()
    await screen.findByText('Wine inventory')

    await click(deleteControl('Wine inventory'))
    expect((await screen.findByRole('alert')).textContent).toContain('Wine inventory')

    // What the websocket handler does, and all it does: invalidate the list.
    getBriefTabs.mockResolvedValue([SALES])
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['brief-tabs'] })
    })

    await waitFor(() => expect(screen.queryByText('Wine inventory')).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()

    vi.unstubAllGlobals()
  })
})

describe('deleting the briefing that is open', () => {
  it('takes the owner who pressed delete back to the desk', async () => {
    // AC-2.2, the half this tab owns. The other half — a delete arriving over
    // the websocket from ANOTHER of the owner's tabs — deliberately does not
    // navigate, and is pinned in BriefingPage.wsDelete.test.tsx instead.
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    renderRail('/desk/briefings/wine')
    await screen.findByText('Wine inventory')

    getBriefTabs.mockResolvedValue([SALES])
    await click(deleteControl('Wine inventory'))

    await waitFor(() => expect(location).toBe('/desk'))

    vi.unstubAllGlobals()
  })

  it('leaves the reader alone when a DIFFERENT briefing is deleted', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true))
    renderRail('/desk/briefings/wine')
    await screen.findByText('Weekly sales')

    getBriefTabs.mockResolvedValue([WINE])
    await click(deleteControl('Weekly sales'))

    await waitFor(() => expect(deleteBriefTab).toHaveBeenCalledWith('sales'))
    expect(location).toBe('/desk/briefings/wine')

    vi.unstubAllGlobals()
  })
})
