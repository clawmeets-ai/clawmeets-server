import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { makeSession, seedSessions } from '../../test/authFixtures'
import type { AgentCard } from '../../types'

/**
 * The Forward dialog's contract with the server: it names the source message
 * and the attachments to carry — never the quoted text — and it offers only the
 * user's own agents, minus the original's author.
 */

const forwardToOwnAgent = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ projectId: 'dm-y', message: {} }),
)
vi.mock('../../api/endpoints/dm', () => ({
  forwardToOwnAgent: (...args: unknown[]) => forwardToOwnAgent(...args),
}))

const agent = (id: string, name: string, owner = 'u1') =>
  ({ id, name, registered_by: owner, status: 'online' }) as unknown as AgentCard
const AGENTS = [
  agent('a-x', 'owner-db_engineer'),
  agent('a-y', 'owner-backend'),
  agent('a-z', 'owner-frontend'),
  agent('a-f', 'someone-public', 'u2'),
]
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: AGENTS }) }))

const ForwardModal = (await import('./ForwardModal')).default

const TARGET = {
  projectId: 'dm-x',
  chatroomName: 'user-communication',
  messageIds: ['m1'],
  senderName: 'db_engineer',
  senderId: 'a-x',
  content: 'Index orders.\n\nUse Forward on this message to send it to @backend',
  files: ['plan.sql', 'notes.md'],
}

function renderModal(onSent = vi.fn()) {
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ForwardModal target={TARGET} onClose={() => {}} onSent={onSent} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return onSent
}

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'owner' })])
})

afterEach(() => {
  cleanup()
  forwardToOwnAgent.mockClear()
  seedSessions([])
})

describe('ForwardModal', () => {
  it('offers only own agents, excluding the author, with the suggested one pre-ticked', () => {
    renderModal()
    expect(screen.queryByText('db_engineer', { selector: 'span' })).toBeNull()
    expect(screen.queryByText('someone-public')).toBeNull()
    expect(screen.getByText('Suggested')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Forward' })).toHaveProperty('disabled', false)
  })

  it('sends the message id and chosen files, never the text', async () => {
    const onSent = renderModal()
    fireEvent.click(screen.getByLabelText('notes.md'))
    fireEvent.change(screen.getByPlaceholderText('Add context for the recipient'), {
      target: { value: 'please build this' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(['backend']))
    expect(forwardToOwnAgent).toHaveBeenCalledTimes(1)
    expect(forwardToOwnAgent).toHaveBeenCalledWith(
      'owner-backend',
      {
        projectId: 'dm-x',
        chatroomName: 'user-communication',
        messageIds: ['m1'],
        includeFiles: ['plan.sql'],
      },
      'please build this',
      expect.any(String),
    )
  })

  it('fans out to every ticked recipient', async () => {
    const onSent = renderModal()
    fireEvent.click(screen.getByText('frontend'))
    fireEvent.click(screen.getByRole('button', { name: 'Forward to 2 agents' }))
    await waitFor(() => expect(onSent).toHaveBeenCalled())
    expect(forwardToOwnAgent.mock.calls.map((c) => c[0])).toEqual([
      'owner-backend',
      'owner-frontend',
    ])
    // Each recipient gets its own new thread, so the thread keys differ.
    const [k1, k2] = forwardToOwnAgent.mock.calls.map((c) => c[3])
    expect(k1).not.toEqual(k2)
  })
})
