import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { makeSession, seedSessions } from '../../test/authFixtures'
import type { AgentCard } from '../../types'
import AgentViewActions from './AgentViewActions'

/** The Home folder entry follows the server's per-viewer
 *  home_folder_browsable, never ownership: absent or false hides it. */

vi.mock('../../hooks/useAgents', () => ({ useDeleteAgent: () => ({ mutate: vi.fn(), isPending: false }) }))

const agent = (o: Partial<AgentCard> = {}) =>
  ({ id: 'a1', name: 'owner-wine', registered_by: 'u1', status: 'online', ...o }) as AgentCard

function renderActions(a: AgentCard) {
  render(
    <MemoryRouter>
      <AgentViewActions agent={a} agentLabel="wine" active="start" />
    </MemoryRouter>,
  )
}

beforeEach(() => seedSessions([makeSession({ id: 'u1', username: 'owner' })], 'u1'))
afterEach(() => cleanup())

describe('the Home folder entry', () => {
  it('shows when the server says the folder is browsable', () => {
    renderActions(agent({ home_folder_browsable: true }))
    expect(screen.getByRole('link', { name: 'Home folder of wine' }).getAttribute('href')).toBe('/dm/owner-wine?view=home')
  })

  it('is hidden when false or absent, even for the owner', () => {
    renderActions(agent({ home_folder_browsable: false }))
    expect(screen.queryByRole('link', { name: 'Home folder of wine' })).toBeNull()
    cleanup()
    renderActions(agent())
    expect(screen.queryByRole('link', { name: 'Home folder of wine' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Settings for wine' })).toBeTruthy()
  })
})
