import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// The config fetch is the only network dependency; useMyAgents is stubbed so the
// roster never drives pruning in these cases (its own behaviour is covered in
// announcementStore.test.ts).
vi.mock('../../api/endpoints/announcements', () => ({
  fetchAnnouncements: vi.fn(),
}))
vi.mock('../../hooks/useMyAgents', () => ({
  useMyAgents: () => ({ data: [], isLoading: false, error: null }),
}))

import AnnouncementBanners from './AnnouncementBanners'
import { fetchAnnouncements } from '../../api/endpoints/announcements'
import { useRunnerVersionStore } from '../../stores/runnerVersionStore'
import { useAnnouncementStore } from '../../stores/announcementStore'
import { useAuthStore } from '../../stores/authStore'

const OLD_A = { id: 'a1', name: 'runner-alpha', version: '1.2.9' }
const OLD_B = { id: 'b2', name: 'runner-beta', version: null }

const CONFIG = {
  announcements: [
    {
      id: 'upgrade-1-2-9',
      target: { clawmeets_version: '<=1.2.9', match_unknown_version: true },
      severity: 'warning',
      title: 'Upgrade clawmeets',
      body: 'Runners on 1.2.9 or older are missing important functionality.',
    },
  ],
}

let queryClient: QueryClient

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

function renderBanners() {
  return render(createElement(AnnouncementBanners), { wrapper })
}

/** The config query must resolve before anything renders (`pending`). */
async function settle() {
  await screen.findByRole('status')
}

beforeEach(() => {
  localStorage.clear()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useRunnerVersionStore.setState({ runners: null })
  useAnnouncementStore.setState({ dismissed: {}, userId: null })
  useAuthStore.setState({ user: null })
  vi.mocked(fetchAnnouncements).mockResolvedValue(CONFIG)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('renders nothing while pending (§4.7)', () => {
  it('renders null while runners === null (no push yet)', async () => {
    const { container } = renderBanners()
    // Let the config query resolve; the snapshot is still absent.
    await vi.waitFor(() => expect(fetchAnnouncements).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('renders null while the config query has not resolved', () => {
    useRunnerVersionStore.setState({ runners: [OLD_A] })
    vi.mocked(fetchAnnouncements).mockReturnValue(new Promise(() => {}))
    const { container } = renderBanners()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the server affirmatively says zero live runners', async () => {
    useRunnerVersionStore.setState({ runners: [] })
    const { container } = renderBanners()
    await vi.waitFor(() => expect(fetchAnnouncements).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })
})

describe('banner content', () => {
  beforeEach(() => {
    useRunnerVersionStore.setState({ runners: [OLD_A, OLD_B] })
  })

  it('renders one banner with role="status" and the message intact', async () => {
    renderBanners()
    await settle()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.getByText('Upgrade clawmeets')).toBeDefined()
    expect(screen.getByText(/missing important functionality/)).toBeDefined()
  })

  it('headline count equals the expanded list length', async () => {
    renderBanners()
    await settle()
    const disclosure = screen.getByRole('button', { name: /2 runners affected/ })
    fireEvent.click(disclosure)
    // The number IS the length of the list it expands — they are the same array.
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
  })

  it('is singular at 1', async () => {
    useRunnerVersionStore.setState({ runners: [OLD_A] })
    renderBanners()
    await settle()
    expect(screen.getByRole('button', { name: /^1 runner affected/ })).toBeDefined()
  })

  it('shows each runner\'s version, and "version unknown" for null', async () => {
    renderBanners()
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /2 runners affected/ }))
    expect(screen.getByText(/runner-alpha — 1\.2\.9/)).toBeDefined()
    expect(screen.getByText(/runner-beta — version unknown/)).toBeDefined()
  })

  it('carries the a11y attributes: aria-expanded/aria-controls and a dismiss aria-label', async () => {
    renderBanners()
    await settle()
    const disclosure = screen.getByRole('button', { name: /2 runners affected/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    const listId = disclosure.getAttribute('aria-controls')
    expect(listId).toBeTruthy()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(listId!)).toBeTruthy()

    expect(screen.getByRole('button', { name: 'Dismiss Upgrade clawmeets' })).toBeDefined()
  })
})

describe('unknown severity still renders (never swallow the message)', () => {
  it('degrades to neutral styling with the message intact', async () => {
    vi.mocked(fetchAnnouncements).mockResolvedValue({
      announcements: [{ ...CONFIG.announcements[0], severity: 'catastrophe' }],
    })
    useRunnerVersionStore.setState({ runners: [OLD_A] })
    renderBanners()
    await settle()

    // severity is free-form by contract, so the unknown branch is genuinely
    // reachable. It must never hide the announcement.
    expect(screen.getByText('Upgrade clawmeets')).toBeDefined()
    expect(screen.getByText(/missing important functionality/)).toBeDefined()
    // Neutral styling, and the severity is still carried by a TEXT label —
    // never by colour alone.
    expect(screen.getByText('Notice')).toBeDefined()
  })

  it('a recognised severity gets its own label', async () => {
    useRunnerVersionStore.setState({ runners: [OLD_A] })
    renderBanners()
    await settle()
    expect(screen.getByText('Warning')).toBeDefined()
  })

  // A severity that collides with an Object.prototype key is NOT an exotic
  // input: it is the same "unknown severity" case as 'catastrophe' above, and
  // the config is hand-edited on a server the browser does not control. Before
  // the own-key guard in styleFor(), the inherited value was truthy, so `??`
  // never fell through — `Icon` came back undefined and the render THREW, and
  // with no error boundary anywhere in this app that unmounts the entire shell
  // on every authenticated route. These strings are the whole inherited set.
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'severity %j is treated as unknown, not as an inherited prototype value',
    async severity => {
      vi.mocked(fetchAnnouncements).mockResolvedValue({
        announcements: [{ ...CONFIG.announcements[0], severity }],
      })
      useRunnerVersionStore.setState({ runners: [OLD_A] })
      renderBanners()
      await settle()

      // Rendered at all — i.e. did not throw — with neutral styling and the
      // message intact, exactly like any other unrecognised severity.
      expect(screen.getByText('Notice')).toBeDefined()
      expect(screen.getByText('Upgrade clawmeets')).toBeDefined()
      expect(screen.getByText(/missing important functionality/)).toBeDefined()
    },
  )
})

describe('dismissal', () => {
  it('dismiss hides the banner, and a newly affected runner brings it back', async () => {
    useRunnerVersionStore.setState({ runners: [OLD_A, OLD_B] })
    renderBanners()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Upgrade clawmeets' }))
    expect(screen.queryByRole('status')).toBeNull()

    // A runner the user has NOT yet seen resurfaces the same announcement.
    const NEW = { id: 'c3', name: 'runner-gamma', version: '1.0.0' }
    useRunnerVersionStore.setState({ runners: [OLD_A, OLD_B, NEW] })
    await settle()
    expect(screen.getByRole('button', { name: /^1 runner affected/ })).toBeDefined()
  })

  it('a dismissed runner merely reconnecting does not bring it back', async () => {
    useRunnerVersionStore.setState({ runners: [OLD_A] })
    renderBanners()
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Upgrade clawmeets' }))
    expect(screen.queryByRole('status')).toBeNull()

    // Same id, fresh snapshot.
    useRunnerVersionStore.setState({ runners: [{ ...OLD_A }] })
    await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })
})
