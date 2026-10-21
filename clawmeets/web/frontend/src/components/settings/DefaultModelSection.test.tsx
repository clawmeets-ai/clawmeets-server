// Account Settings → Default model: the shared editor drives /me/model-defaults,
// key-based providers are not offered, and "Apply to all my agents…" shows the
// dry run before it changes anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ModelConfig } from '../../types'

const api = vi.hoisted(() => ({
  getModelDefaults: vi.fn(),
  createDefaultConfig: vi.fn(),
  setDefaultDefaultConfig: vi.fn(),
  applyModelDefaults: vi.fn(),
  getModelConfigs: vi.fn(),
}))
vi.mock('../../api/endpoints/modelConfigs', async (orig) => ({
  ...(await orig<typeof import('../../api/endpoints/modelConfigs')>()),
  ...api,
}))

import DefaultModelSection from './DefaultModelSection'

const cfg = (name: string, provider: ModelConfig['provider']): ModelConfig => ({
  name,
  provider,
  model: null,
  base_url: null,
  source: 'default',
  created_at: '2026-10-01T00:00:00Z',
})

const defaults = (configured: boolean) => ({
  configs: configured ? [cfg('Smart routing', 'smart'), cfg('claude', 'claude'), cfg('openai', 'openai')] : [],
  default: configured ? 'Smart routing' : null,
  routing: { max_attempts: 3, cooldown_seconds: 300 },
  configured,
  updated_at: null,
})

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DefaultModelSection />
    </QueryClientProvider>,
  )
}

beforeEach(() => Object.values(api).forEach((fn) => fn.mockReset()))
afterEach(cleanup)

describe('DefaultModelSection', () => {
  it('reads the user default, not an agent', async () => {
    api.getModelDefaults.mockResolvedValue(defaults(true))
    renderSection()
    await screen.findByText('Smart routing is on')
    expect(api.getModelDefaults).toHaveBeenCalled()
    expect(api.getModelConfigs).not.toHaveBeenCalled()
  })

  it('explains an unset default and offers no apply', async () => {
    api.getModelDefaults.mockResolvedValue(defaults(false))
    renderSection()
    await screen.findByText(/Not set yet/)
    expect(screen.queryByText('Apply to all my agents…')).toBeNull()
  })

  it('offers no key-based provider when adding a model', async () => {
    api.getModelDefaults.mockResolvedValue(defaults(true))
    renderSection()
    fireEvent.click((await screen.findAllByText('Add model'))[0])
    const options = Array.from(document.querySelectorAll('option')).map((o) => o.value)
    expect(options).toContain('claude')
    expect(options).not.toContain('openrouter-api')
  })

  it('previews with a dry run, then applies the same scope', async () => {
    api.getModelDefaults.mockResolvedValue(defaults(true))
    const result = (dry_run: boolean) => ({
      dry_run,
      changed: [{ agent_id: 'a1', agent_name: 'alice-writer', removed: ['gemini'], kept: [] }],
      unchanged: [],
      skipped: [{ agent_id: 'a2', agent_name: 'alice-codex', reason: "team 'Model agents'" }],
    })
    api.applyModelDefaults.mockImplementation(async (body: { dry_run?: boolean }) => result(!!body.dry_run))
    renderSection()
    fireEvent.click(await screen.findByText('Apply to all my agents…'))
    await screen.findByText('alice-writer')
    expect(screen.getByText(/Left alone: alice-codex/)).toBeTruthy()
    expect(api.applyModelDefaults).toHaveBeenCalledWith({ dry_run: true })

    fireEvent.click(screen.getByText('Apply to 1 agent'))
    await waitFor(() => expect(api.applyModelDefaults).toHaveBeenCalledWith({ dry_run: false }))
    await screen.findByText('Default model applied')
  })
})
