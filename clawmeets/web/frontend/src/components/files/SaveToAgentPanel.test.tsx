import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { FsListing } from '../../api/endpoints/agentFs'
import SaveToAgentPanel, { keepBothName, invalidFileName } from './SaveToAgentPanel'

/**
 * Save to agent copies a chatroom file into an owned agent's home folder.
 * What must hold: a fresh pick opens at storage/, a name clash defaults to
 * "keep both" (never a silent overwrite, even when the clash appears between
 * listing and saving), and the agent is told only when the box is ticked.
 */

const USER = { id: 'u1', username: 'alice' }
const AGENTS = [
  { id: 'a1', name: 'alice-backend', registered_by: 'u1', status: 'online' },
  { id: 'a2', name: 'alice-designer', registered_by: 'u1', status: 'offline' },
  { id: 'x1', name: 'bob-backend', registered_by: 'u2', status: 'online' },
]

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: USER, isAuthenticated: true }),
}))
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: AGENTS }) }))
vi.mock('../../hooks/useProjects', () => ({ useProject: () => ({ data: { participating_agents: ['a1'] } }) }))
vi.mock('../../api/endpoints/files', () => ({
  downloadFileAsBlob: vi.fn(async () => new Blob(['a,b\n1,2\n'])),
}))
vi.mock('../../api/endpoints/dm', () => ({
  ensureOwnDMProject: vi.fn(async () => ({ id: 'dm1', name: 'alice-dm-backend' })),
  sendDMMessage: vi.fn(async () => ({})),
}))

const listings: Record<string, FsListing> = {}
function folder(path: string, names: Array<[string, 'file' | 'dir', boolean?]>): FsListing {
  return {
    path,
    tier: 'open',
    writable: path !== '',
    truncated: false,
    entries: names.map(([name, type, writable = true]) => ({
      name, type, size: 1, mtime: 0, tier: writable ? 'open' : 'system', writable, readable: true,
    })),
  }
}

vi.mock('../../api/endpoints/agentFs', async (importActual) => {
  const actual = await importActual<typeof import('../../api/endpoints/agentFs')>()
  return {
    ...actual,
    listAgentFolder: vi.fn(async (_id: string, path: string) => listings[path]),
    writeAgentFile: vi.fn(async () => ({})),
    makeAgentFolder: vi.fn(async () => ({})),
    deleteAgentEntry: vi.fn(async () => undefined),
    downloadAgentFile: vi.fn(async () => new Blob(['old'])),
  }
})

const fs = await import('../../api/endpoints/agentFs')
const dm = await import('../../api/endpoints/dm')

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SaveToAgentPanel projectId="p1" chatroomName="user-communication" filename="report.csv" onClose={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  listings[''] = folder('', [['projects', 'dir', false], ['storage', 'dir']])
  listings['storage'] = folder('storage', [['notes.md', 'file']])
})
afterEach(cleanup)

describe('naming helpers', () => {
  it('keep both picks the first free (n)', () => {
    expect(keepBothName('report.csv', new Set(['report.csv']))).toBe('report (1).csv')
    expect(keepBothName('report.csv', new Set(['report.csv', 'report (1).csv']))).toBe('report (2).csv')
    expect(keepBothName('Makefile', new Set(['Makefile']))).toBe('Makefile (1)')
  })

  it('refuses separators and empty names', () => {
    expect(invalidFileName('')).toBeTruthy()
    expect(invalidFileName('a/b')).toBeTruthy()
    expect(invalidFileName('..')).toBeTruthy()
    expect(invalidFileName('ok.csv')).toBeNull()
  })
})

describe('SaveToAgentPanel', () => {
  it('lists only own agents, project members first', () => {
    renderPanel()
    expect(screen.getByText('In this project')).toBeTruthy()
    expect(screen.getByText('@backend')).toBeTruthy()
    expect(screen.getByText('@designer')).toBeTruthy()
    expect(screen.queryByText(/bob-backend/)).toBeNull()
  })

  it('opens at storage/, saves, and tells the agent', async () => {
    renderPanel()
    fireEvent.click(screen.getByText('@backend'))
    await screen.findByText('notes.md')
    expect(screen.getByText('@backend/storage/report.csv')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Open in folder')
    expect(fs.writeAgentFile).toHaveBeenCalledWith('a1', 'storage/report.csv', expect.any(Blob))
    await waitFor(() => expect(dm.sendDMMessage).toHaveBeenCalled())
    expect(vi.mocked(dm.sendDMMessage).mock.calls[0][2]).toContain('storage/report.csv')
  })

  it('a clash defaults to keep both and never overwrites', async () => {
    listings['storage'] = folder('storage', [['report.csv', 'file']])
    renderPanel()
    fireEvent.click(screen.getByText('@backend'))
    await screen.findByText(/already exists in this folder/)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Open in folder')
    expect(fs.writeAgentFile).toHaveBeenCalledWith('a1', 'storage/report (1).csv', expect.any(Blob))
    expect(dm.sendDMMessage).not.toHaveBeenCalled()
  })

  it('stops when the name appears between listing and saving', async () => {
    renderPanel()
    fireEvent.click(screen.getByText('@backend'))
    await screen.findByText('notes.md')
    listings['storage'] = folder('storage', [['notes.md', 'file'], ['report.csv', 'file']])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/was just created in this folder/)
    expect(fs.writeAgentFile).not.toHaveBeenCalled()
  })

  it('undo of a fresh save deletes the file', async () => {
    renderPanel()
    fireEvent.click(screen.getByText('@backend'))
    await screen.findByText('notes.md')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByText('Undo'))
    await waitFor(() => expect(fs.deleteAgentEntry).toHaveBeenCalledWith('a1', 'storage/report.csv'))
  })

  it('an offline agent cannot be saved to', () => {
    renderPanel()
    fireEvent.click(screen.getByText('@designer'))
    expect(screen.getByRole('alert').textContent).toContain('offline')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
