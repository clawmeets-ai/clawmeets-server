import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PublicAgentsAccount, { matches } from './PublicAgentsAccount'
import type { PublicAgent, PublicDirectory } from './api'

const agent = (over: Partial<PublicAgent>): PublicAgent => ({
  id: 'a', display_name: 'A', team_id: null, description: '', skills: [],
  takes_direct_requests: true, online: true, starter_questions: [], chat_key: 'cmw_a', ...over,
})

const DIR: PublicDirectory = {
  account: { handle: 'chu', display_name: "Chu's Wine", bio: '', website: null, avatar_url: null },
  teams: [{ id: 'video', name: 'video', description: '' }],
  agents: [
    agent({ id: 'assets', display_name: 'Asset Producer', team_id: 'video', takes_direct_requests: false,
      skills: ['voiceover'], chat_key: 'cmw_assets' }),
    agent({ id: 'coord', display_name: 'Production Coordinator', team_id: 'video', chat_key: 'cmw_coord' }),
    agent({ id: 'support', display_name: 'Customer Support', chat_key: 'cmw_support' }),
  ],
  default_agent: 'support',
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.ClawMeetsChat
  document.querySelectorAll('script[data-clawmeets-widget]').forEach((s) => s.remove())
})

function mockDirectory(dir: PublicDirectory | null) {
  vi.stubGlobal('fetch', vi.fn(async () => dir
    ? new Response(JSON.stringify(dir), { status: 200 })
    : new Response('{}', { status: 404 })))
}

describe('matches', () => {
  it('searches name, handle, description and skills', () => {
    expect(matches(DIR.agents[0], 'VOICE', 'all')).toBe(true)
    expect(matches(DIR.agents[0], 'assets', 'all')).toBe(true)
    expect(matches(DIR.agents[0], '', 'direct')).toBe(false)
    expect(matches(DIR.agents[0], 'nothing', 'all')).toBe(false)
  })
})

describe('PublicAgentsAccount', () => {
  it('groups by team, filters, and searches', async () => {
    mockDirectory(DIR)
    render(<PublicAgentsAccount username="chu" />)
    expect(await screen.findByRole('heading', { name: "Chu's Wine" })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'video' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Other agents' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Takes requests' }))
    expect(screen.queryByText('Asset Producer')).toBeNull()
    fireEvent.change(screen.getByLabelText('Search agents'), { target: { value: 'zzz' } })
    expect(screen.getByText('No agents match.')).toBeTruthy()
  })

  it('loads the widget dock, lists every agent, and opens chats in it', async () => {
    mockDirectory(DIR)
    render(<PublicAgentsAccount username="chu" />)
    await screen.findByRole('heading', { name: "Chu's Wine" })
    const script = document.querySelector('script[data-clawmeets-widget]')!
    expect(script.getAttribute('src')).toContain('/api/channels/widget.js')
    expect(script.getAttribute('data-mode')).toBe('dock')
    // The widget is not loaded in jsdom, so calls sit in its queue.
    const queue = () => window.ClawMeetsChat as unknown as unknown[][]
    expect(queue()).toEqual(expect.arrayContaining([['add', 'cmw_assets'], ['add', 'cmw_coord'], ['add', 'cmw_support']]))

    const card = screen.getByText('Asset Producer').closest('a')!
    expect(card.getAttribute('href')).toBe('/users/chu/agents/assets/chat')
    fireEvent.click(card)
    expect(queue().at(-1)).toEqual(['open', 'cmw_assets'])
    fireEvent.click(screen.getByRole('link', { name: "Ask Chu's Wine" }))
    expect(queue().at(-1)).toEqual(['open', 'cmw_support'])
    // A modified click follows the link to the full-page chat instead.
    const before = queue().length
    fireEvent.click(card, { metaKey: true })
    expect(queue().length).toBe(before)
  })

  it('says so when the account has no public agents', async () => {
    mockDirectory(null)
    render(<PublicAgentsAccount username="nobody" />)
    expect(await screen.findByText('This account has no public agents.')).toBeTruthy()
  })
})
