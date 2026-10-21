// Smart routing as a mode: the toggle, route ordering and the attempt-limit
// hint. The endpoints module is mocked, so every assertion reads either what
// the section rendered or exactly what it sent to the server.
//
// vitest runs with `globals: false`, so `cleanup` is registered explicitly; and
// jest-dom is not a dependency, so the assertions are plain DOM reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ModelConfig } from '../../types'
import type { ModelConfigList } from '../../api/endpoints/modelConfigs'

const api = vi.hoisted(() => ({
  getModelConfigs: vi.fn(),
  createModelConfig: vi.fn(),
  updateModelConfig: vi.fn(),
  deleteModelConfig: vi.fn(),
  setDefaultModelConfig: vi.fn(),
  reorderModelConfigs: vi.fn(),
  setSmartRouting: vi.fn(),
}))
vi.mock('../../api/endpoints/modelConfigs', async (orig) => ({
  ...(await orig<typeof import('../../api/endpoints/modelConfigs')>()),
  ...api,
}))

import ModelConfigSection from './ModelConfigSection'

const cfg = (name: string, provider: ModelConfig['provider'], extra: Partial<ModelConfig> = {}): ModelConfig => ({
  name,
  provider,
  model: null,
  base_url: null,
  source: 'manual',
  created_at: '2026-10-01T00:00:00Z',
  ...extra,
})

function list(configs: ModelConfig[], def: string | null, max_attempts = 3): ModelConfigList {
  return { configs, default: def, routing: { max_attempts, cooldown_seconds: 300 } }
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ModelConfigSection agentId="a1" canEdit />
    </QueryClientProvider>,
  )
}

beforeEach(() => Object.values(api).forEach((fn) => fn.mockReset()))
afterEach(cleanup)

describe('ModelConfigSection smart routing', () => {
  it('turning on creates a router config and makes it the default', async () => {
    api.getModelConfigs.mockResolvedValue(list([cfg('claude', 'claude'), cfg('codex', 'openai')], 'claude'))
    api.createModelConfig.mockResolvedValue(cfg('Smart routing', 'smart'))
    api.setDefaultModelConfig.mockResolvedValue(list([], null))
    renderSection()
    const toggle = await screen.findByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.setDefaultModelConfig).toHaveBeenCalledWith('a1', 'Smart routing'))
    expect(api.createModelConfig).toHaveBeenCalledWith('a1', { name: 'Smart routing', provider: 'smart' })
  })

  it('turning off makes route 1 the single model', async () => {
    api.getModelConfigs.mockResolvedValue(
      list([cfg('auto', 'smart'), cfg('codex', 'openai'), cfg('claude', 'claude')], 'auto'),
    )
    api.setDefaultModelConfig.mockResolvedValue(list([], null))
    renderSection()
    const toggle = await screen.findByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(api.setDefaultModelConfig).toHaveBeenCalledWith('a1', 'codex'))
    expect(api.createModelConfig).not.toHaveBeenCalled()
  })

  it('never shows the router config as a route, and reorders routes behind it', async () => {
    api.getModelConfigs.mockResolvedValue(
      list([cfg('auto', 'smart'), cfg('codex', 'openai'), cfg('claude', 'claude')], 'auto'),
    )
    api.reorderModelConfigs.mockImplementation(async (_id: string, names: string[]) => list([], 'auto', names.length))
    renderSection()
    await screen.findByText('Route priority')
    expect(screen.queryByText('auto')).toBeNull()
    fireEvent.click(screen.getByLabelText('Move claude up'))
    await waitFor(() =>
      expect(api.reorderModelConfigs).toHaveBeenCalledWith('a1', ['auto', 'claude', 'codex']),
    )
  })

  it('flags routes past the attempt limit and routes that need a key', async () => {
    api.getModelConfigs.mockResolvedValue(
      list(
        [cfg('auto', 'smart'), cfg('codex', 'openai'), cfg('gem', 'gemini-api', { api_key_set: false })],
        'auto',
        1,
      ),
    )
    renderSection()
    await screen.findByText('Route priority')
    expect(screen.getByText(/Past the 1-attempt limit/)).toBeTruthy()
    expect(screen.getByText('Key needed')).toBeTruthy()
    expect(screen.getByText(/1 route needs an API key/)).toBeTruthy()
  })
})
