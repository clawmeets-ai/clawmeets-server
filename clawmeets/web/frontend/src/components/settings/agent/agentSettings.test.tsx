import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentCard } from '../../../types'
import { AgentStatus } from '../../../types'
import { agentSettingsHref, parseSection } from './sections'

vi.mock('../../../api/endpoints/agents', () => ({ updateAgent: vi.fn() }))
const { useAgentSettingsDraft } = await import('./useAgentSettingsDraft')
const { updateAgent } = await import('../../../api/endpoints/agents')

describe('parseSection', () => {
  it('defaults missing / unknown values to general', () => {
    expect(parseSection(null)).toBe('general')
    expect(parseSection('nope')).toBe('general')
  })
  it('accepts every real section id', () => {
    expect(parseSection('skills')).toBe('skills')
    expect(parseSection('runtime')).toBe('runtime')
    expect(parseSection('storage')).toBe('storage')
  })
  it('maps the legacy model-config anchor onto the Model section', () => {
    expect(parseSection('model-config')).toBe('model')
  })
  it('builds hrefs without a query for General', () => {
    expect(agentSettingsHref('a1')).toBe('/agents/a1/settings')
    expect(agentSettingsHref('a1', 'general')).toBe('/agents/a1/settings')
    expect(agentSettingsHref('a1', 'model')).toBe('/agents/a1/settings?section=model')
  })
})

const agent = (description: string, git_url = ''): AgentCard => ({
  id: 'a1',
  name: 'backend',
  description,
  capabilities: ['x'],
  status: AgentStatus.ONLINE,
  registered_at: '',
  last_heartbeat: null,
  discoverable_through_registry: false,
  is_verified: false,
  local_settings: { git_url },
})

let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
})
afterEach(cleanup)

describe('useAgentSettingsDraft', () => {
  it('tracks dirtiness and discards back to the saved copy', () => {
    const a = agent('old')
    const { result } = renderHook(() => useAgentSettingsDraft(a), { wrapper })
    expect(result.current.isDirty).toBe(false)
    act(() => result.current.set('gitUrl', 'git@x:y.git'))
    expect(result.current.isDirty).toBe(true)
    act(() => result.current.discard())
    expect(result.current.isDirty).toBe(false)
    expect(result.current.draft?.gitUrl).toBe('')
  })

  it('a background refetch does not clobber unsaved edits', () => {
    const { result, rerender } = renderHook(({ a }) => useAgentSettingsDraft(a), {
      wrapper,
      initialProps: { a: agent('old') },
    })
    act(() => result.current.set('description', 'my edit'))
    rerender({ a: agent('old') }) // same content, new object — e.g. window-focus refetch
    expect(result.current.draft?.description).toBe('my edit')
  })

  it('re-seeds from the server when there are no unsaved edits', () => {
    const { result, rerender } = renderHook(({ a }) => useAgentSettingsDraft(a), {
      wrapper,
      initialProps: { a: agent('old') },
    })
    rerender({ a: agent('changed elsewhere') })
    expect(result.current.draft?.description).toBe('changed elsewhere')
    expect(result.current.isDirty).toBe(false)
  })
})

describe('extra directories', () => {
  it('seeds the list from the saved list and saves it back as a list', async () => {
    const a = { ...agent('d'), local_settings: { extra_dirs: ['~/OpenMontage'], skill_configs: { x: {} } } } as AgentCard
    vi.mocked(updateAgent).mockResolvedValue(a)
    const { result } = renderHook(() => useAgentSettingsDraft(a), { wrapper })
    expect(result.current.draft?.extraDirs).toEqual(['~/OpenMontage'])
    act(() => result.current.set('extraDirs', ['~/OpenMontage', '/opt/tools']))
    await act(async () => result.current.save())
    const sent = vi.mocked(updateAgent).mock.calls[0][1].local_settings
    expect(sent?.extra_dirs).toEqual(['~/OpenMontage', '/opt/tools'])
    expect((sent as Record<string, unknown>).skill_configs).toEqual({ x: {} })
  })

  it('clears the saved list when every folder is removed', async () => {
    const a = { ...agent('d'), local_settings: { extra_dirs: ['~/OpenMontage'] } } as AgentCard
    vi.mocked(updateAgent).mockResolvedValue(a)
    const { result } = renderHook(() => useAgentSettingsDraft(a), { wrapper })
    act(() => result.current.set('extraDirs', []))
    await act(async () => result.current.save())
    expect(vi.mocked(updateAgent).mock.calls[0][1].local_settings?.extra_dirs).toBeUndefined()
  })
})
