import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuthStore } from '../../../stores/authStore'
import { makeSession, seedSessions } from '../../../test/authFixtures'
import { ApiError } from '../../../api/client'
import RuntimeSection from './RuntimeSection'
import type { AgentSettingsDraft } from './useAgentSettingsDraft'

/**
 * Agent Settings → Code & runtime manages the agent's env vars in place. Every
 * read and write goes to the agent's own runner (via the server), which answers
 * with key names only — so the page can show names behind a mask and nothing
 * else.
 */

const getAgentEnvKeys = vi.fn()
const setAgentEnvVar = vi.fn()
const unsetAgentEnvVar = vi.fn()
vi.mock('../../../api/endpoints/agentEnv', () => ({
  getAgentEnvKeys: (...a: unknown[]) => getAgentEnvKeys(...a),
  setAgentEnvVar: (...a: unknown[]) => setAgentEnvVar(...a),
  unsetAgentEnvVar: (...a: unknown[]) => unsetAgentEnvVar(...a),
}))

const SECRET = 'sk_live_typed-once'

function renderSection(extraDirs: string[] = [], set: (k: string, v: unknown) => void = () => {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <RuntimeSection
          agentId="a1"
          agentName="chengtao-backend"
          draft={{ gitUrl: '', gitBaseBranch: '', extraDirs } as AgentSettingsDraft}
          set={set as never}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => seedSessions([makeSession({ id: 'u1' })], 'u1'))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAuthStore.getState().logout()
})

describe('Environment variables card', () => {
  it('lists key names behind a fixed mask, never a value', async () => {
    getAgentEnvKeys.mockResolvedValue({ keys: ['GITHUB_TOKEN', 'STRIPE_API_KEY'] })
    renderSection()
    expect(await screen.findByText('GITHUB_TOKEN')).toBeTruthy()
    expect(screen.getByText('STRIPE_API_KEY')).toBeTruthy()
    expect(screen.getAllByText('••••••••')).toHaveLength(2)
    expect(getAgentEnvKeys).toHaveBeenCalledWith('a1')
  })

  it('adds a key: sends it once, clears the field, and shows the answer', async () => {
    getAgentEnvKeys.mockResolvedValue({ keys: [] })
    setAgentEnvVar.mockResolvedValue({ keys: ['OPENAI_API_KEY'] })
    renderSection()
    fireEvent.change(await screen.findByLabelText('Variable name'), { target: { value: 'openai_api_key' } })
    // Upper-cased as you type.
    expect((screen.getByLabelText('Variable name') as HTMLInputElement).value).toBe('OPENAI_API_KEY')
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: SECRET } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add$/ }))
    })
    expect(setAgentEnvVar).toHaveBeenCalledWith('a1', 'OPENAI_API_KEY', SECRET)
    expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('')
    expect(await screen.findByText('OPENAI_API_KEY')).toBeTruthy()
    expect(screen.queryByText(SECRET)).toBeNull()
  })

  it('asks before replacing an existing key, and sends nothing until confirmed', async () => {
    getAgentEnvKeys.mockResolvedValue({ keys: ['GITHUB_TOKEN'] })
    setAgentEnvVar.mockResolvedValue({ keys: ['GITHUB_TOKEN'] })
    renderSection()
    fireEvent.change(await screen.findByLabelText('Variable name'), { target: { value: 'GITHUB_TOKEN' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: SECRET } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add$/ }))
    })
    expect(screen.getByText(/Replace its value\?/)).toBeTruthy()
    expect(setAgentEnvVar).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    })
    expect(setAgentEnvVar).toHaveBeenCalledWith('a1', 'GITHUB_TOKEN', SECRET)
  })

  it('removes a key only after the inline confirm', async () => {
    getAgentEnvKeys.mockResolvedValue({ keys: ['GITHUB_TOKEN'] })
    unsetAgentEnvVar.mockResolvedValue({ keys: [] })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove GITHUB_TOKEN' }))
    expect(screen.getByText(/The value can't be recovered/)).toBeTruthy()
    expect(unsetAgentEnvVar).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    })
    expect(unsetAgentEnvVar).toHaveBeenCalledWith('a1', 'GITHUB_TOKEN')
    expect(screen.queryByText('GITHUB_TOKEN')).toBeNull()
  })

  it('refuses a reserved key name in the browser', async () => {
    getAgentEnvKeys.mockResolvedValue({ keys: [] })
    renderSection()
    fireEvent.change(await screen.findByLabelText('Variable name'), { target: { value: 'CLAWMEETS_TOKEN' } })
    expect(screen.getByText('CLAWMEETS_ is reserved')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Add$/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("names the key when the agent refuses a change", async () => {
    getAgentEnvKeys.mockResolvedValue({ keys: [] })
    setAgentEnvVar.mockRejectedValue(new ApiError(400, 'disk full'))
    renderSection()
    fireEvent.change(await screen.findByLabelText('Variable name'), { target: { value: 'A_KEY' } })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add$/ }))
    })
    expect(screen.getByRole('alert').textContent).toContain("Couldn't add A_KEY. disk full")
  })

  it("says so when the agent isn't running, and offers the terminal command", async () => {
    getAgentEnvKeys.mockRejectedValue(
      new ApiError(409, "chengtao-backend isn't running, so its environment variables can't be reached."),
    )
    renderSection()
    expect((await screen.findByRole('alert')).textContent).toContain("isn't running")
    expect(screen.queryByLabelText('Variable name')).toBeNull()
    expect(screen.getByText('clawmeets env set KEY --agent chengtao-backend')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })
})

describe('Extra directories list', () => {
  beforeEach(() => getAgentEnvKeys.mockResolvedValue({ keys: [] }))

  it('lists each folder with its own remove button', () => {
    const set = vi.fn()
    renderSection(['~/OpenMontage', '/opt/tools'], set)
    expect(screen.getByRole('list', { name: 'Extra directories' }).textContent).toContain('/opt/tools')
    fireEvent.click(screen.getByRole('button', { name: 'Remove ~/OpenMontage' }))
    expect(set).toHaveBeenCalledWith('extraDirs', ['/opt/tools'])
  })

  it('adds a trimmed folder and refuses a repeat', () => {
    const set = vi.fn()
    renderSection(['~/OpenMontage'], set)
    const input = screen.getByLabelText('Folder path') as HTMLInputElement
    fireEvent.change(input, { target: { value: ' ~/OpenMontage ' } })
    expect(screen.getByText('Already added')).toBeTruthy()
    fireEvent.change(input, { target: { value: ' /opt/tools ' } })
    fireEvent.submit(input.closest('form')!)
    expect(set).toHaveBeenCalledWith('extraDirs', ['~/OpenMontage', '/opt/tools'])
    expect(input.value).toBe('')
  })
})
