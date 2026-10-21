import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { useUIStore } from '../../stores/uiStore'
import { SAMPLE_BRIEF_SLUG } from '../../api/endpoints/briefTabs'
import { ApiError } from '../../api/client'
import BriefingPage from './BriefingPage'

/**
 * THE ROUTE PAGE, and specifically the two things it owes that come from files
 * nobody would open to debug a briefing.
 *
 * Both are one line in this component and both fail SILENTLY and far from
 * here: a missing scroll container reads as an AC-3.3 sizing bug in a frame
 * that sized perfectly, and a missing rail context reads as a sidebar bug.
 * Neither would be caught by looking at this file, so they are pinned here.
 *
 * The data hook is mocked rather than driven through a QueryClient: the
 * question each case asks is "what does the page render for this state", and a
 * real query would add a network fixture to every one of them.
 */

const useBriefTabDocument = vi.fn()
vi.mock('../../hooks/useBriefTabs', () => ({
  useBriefTabDocument: (slug: string | null) => useBriefTabDocument(slug),
}))

const DOCUMENT = {
  slug: 'wine',
  title: 'Wine inventory',
  owner_user_id: 'u1',
  owner_agent_id: 'a1',
  owner_agent_name: 'sommelier',
  generated_at: '2026-09-08T10:00:00Z',
  html: '<!doctype html><html><head></head><body>cases</body></html>',
}

const idle = { data: undefined, isLoading: false, isError: false }

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/desk/briefings/${slug}`]}>
      <Routes>
        <Route path="/desk/briefings/:slug" element={<BriefingPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  // Arrive from somewhere that is NOT the desk, which is the case Sidebar's
  // mount-only path sync cannot cover.
  useUIStore.getState().setRailContext('dms')
  useBriefTabDocument.mockReturnValue({ ...idle, data: DOCUMENT })
})

afterEach(cleanup)

describe('BriefingPage — the two layout gotchas', () => {
  it('owns its own scroll container', () => {
    // AppLayout's VIEW_ROUTE regex matches "/desk/briefings/x", so <main> is
    // `overflow-hidden`. Without this wrapper a tall briefing is clipped by
    // the LAYOUT — an AC-3.3 failure sourced from a file nobody would look in.
    const { container } = renderAt('wine')

    expect((container.firstChild as HTMLElement).className).toContain('overflow-y-auto')
  })

  it("sets the rail context to 'desk' on mount", () => {
    // Sidebar syncs rail context from the path in a useLayoutEffect with []
    // deps — mount only, by design. That covers a reload of this URL and
    // misses every in-app arrival from another context, which would leave the
    // rail showing DMs beside a briefing.
    renderAt('wine')

    expect(useUIStore.getState().railContext).toBe('desk')
  })
})

describe('BriefingPage — what it renders', () => {
  it('renders the document in a frame, with provenance in app chrome', () => {
    renderAt('wine')

    const frame = screen.getByTitle('Wine inventory') as HTMLIFrameElement
    expect(frame.getAttribute('srcdoc')).toContain('<body>cases</body>')
    // Provenance is app chrome and stays app chrome — putting it inside the
    // document would hand the author the app's own chrome to restyle.
    expect(screen.getByText(/sommelier/)).toBeTruthy()
  })

  it('renders the sample WITHOUT issuing a request', () => {
    renderAt(SAMPLE_BRIEF_SLUG)

    // `null` is what disables the query. The sample is a local constant and no
    // request for its slug would ever succeed — the server never issues it.
    expect(useBriefTabDocument).toHaveBeenCalledWith(null)
    const frame = screen.getByTitle('Sample Briefing') as HTMLIFrameElement
    expect(frame.getAttribute('srcdoc')).toContain('<!doctype html>')
    // It goes through the same frame, bootstrap and sizing path as a published
    // briefing, which is what AC-1.4's "renders like any published one" means.
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-popups allow-popups-to-escape-sandbox',
    )
  })

  it('says so plainly when the briefing is gone', () => {
    // A slug deleted between the list render and the click is ordinary, not
    // exceptional; a legacy artifact the server now skips arrives here too,
    // and both are the same 404 by design.
    //
    // The error is a REAL 404 rather than a bare `isError: true`, because
    // which error it is has become the whole question — see the case below.
    useBriefTabDocument.mockReturnValue({
      ...idle,
      isError: true,
      error: new ApiError(404, 'Not Found'),
    })
    renderAt('vanished')

    expect(screen.getByText(/no longer published/i)).toBeTruthy()
    expect(screen.getByText(/Back to My Desk/i)).toBeTruthy()
  })

  it('does not call a non-404 failure "unpublished"', () => {
    // THE INCIDENT. A server older than this bundle has no
    // `GET /me/brief/tabs/{slug}` — only PUT and DELETE — so the path matches
    // and the verb does not, and every briefing answered 405. The page called
    // that "no longer published", so the owner asked their agent to republish;
    // the agent's new-shape upload hit that same old server's PUT, which
    // ignored the field it could not store and overwrote the briefing with an
    // empty record. The wrong sentence chose the wrong repair.
    useBriefTabDocument.mockReturnValue({
      ...idle,
      isError: true,
      error: new ApiError(405, 'Method Not Allowed'),
    })
    renderAt('fitness')

    expect(screen.queryByText(/no longer published/i)).toBeNull()
    expect(screen.getByText(/couldn’t be loaded/i)).toBeTruthy()
    // The status is the detail that separates "server is older than this page"
    // from "server is down"; without it the message is just a shrug.
    expect(screen.getByText(/405/)).toBeTruthy()
    expect(screen.getByText(/Try again/i)).toBeTruthy()
  })

  it('says the request never landed when there is no status at all', () => {
    // A network/CORS failure throws something that is not an `ApiError`, so
    // there is no status to name. It is still not an unpublish.
    useBriefTabDocument.mockReturnValue({
      ...idle,
      isError: true,
      error: new TypeError('Failed to fetch'),
    })
    renderAt('fitness')

    expect(screen.queryByText(/no longer published/i)).toBeNull()
    expect(screen.getByText(/did not reach the server/i)).toBeTruthy()
  })

  it('still reads as gone when the server resolves with no document', () => {
    // Not an error at all — the query succeeded and carried nothing. That is
    // the server answering, so it keeps the lifecycle message.
    useBriefTabDocument.mockReturnValue({ ...idle, data: undefined })
    renderAt('vanished')

    expect(screen.getByText(/no longer published/i)).toBeTruthy()
  })

  it('holds frame-sized space while loading, so the page does not jump', () => {
    useBriefTabDocument.mockReturnValue({ ...idle, isLoading: true })
    renderAt('wine')

    expect(screen.getByLabelText('Loading briefing')).toBeTruthy()
  })
})
