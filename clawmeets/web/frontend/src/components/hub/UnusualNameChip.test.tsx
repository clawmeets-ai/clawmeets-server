import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { FP_ACME, hubAgent, NOW_S } from '../../test/hubFixtures'

/**
 * The "contains unusual characters" chip beside a server name: a look-alike
 * such as "аcme.dev" (Cyrillic а) is marked wherever the name is shown, and
 * plain ASCII names are not. The sidebar bucket and the thread header are
 * covered in PublicPanel.hub.test.tsx and HubChatView.test.tsx.
 */

const LOOKALIKE = 'аcme.dev' // Cyrillic а, then "cme.dev"

let blockedRows: unknown[] = []
vi.mock('../../hooks/useHub', async (orig) => ({
  ...(await orig<typeof import('../../hooks/useHub')>()),
  useHubAvatar: () => null,
  useBlockedDeployments: () => ({
    blocked: { data: blockedRows, isSuccess: true, error: null },
    unblock: { error: null, mutate: vi.fn(), isPending: false },
  }),
}))

import RemoteAgentCard from './RemoteAgentCard'
import HubDisclosure from './HubDisclosure'
import HubContactLabel from './HubContactLabel'
import BlockedDeploymentsCard from '../settings/agent/BlockedDeploymentsCard'
import UnusualNameChip, { UNUSUAL_CHARACTERS_TEXT } from './UnusualNameChip'
import { withQueryClient } from '../../test/queryWrapper'

const chips = () => screen.queryAllByTestId('chip-unusual')

afterEach(() => { cleanup(); blockedRows = [] })

describe('the "contains unusual characters" chip', () => {
  it('marks a non-ASCII name and nothing else', () => {
    const { rerender } = render(<UnusualNameChip name={LOOKALIKE} />)
    expect(chips().map((c) => c.textContent)).toEqual([UNUSUAL_CHARACTERS_TEXT])
    rerender(<UnusualNameChip name="acme.dev" />)
    expect(chips()).toHaveLength(0)
    rerender(<UnusualNameChip name={null} />)
    expect(chips()).toHaveLength(0)
  })

  it('on the directory card, beside a look-alike server name', () => {
    const { rerender } = render(
      <RemoteAgentCard agent={hubAgent({ deployment_name: LOOKALIKE })} onMessage={() => {}} />, { wrapper: withQueryClient },
    )
    expect(chips()).toHaveLength(1)
    rerender(<RemoteAgentCard agent={hubAgent()} onMessage={() => {}} />)
    expect(chips()).toHaveLength(0)
  })

  it('in the "hosted on" note', () => {
    const target = { deployment_name: LOOKALIKE, deployment_fingerprint: FP_ACME, deployment_url: null, deployment_url_verified: false }
    const { rerender } = render(<HubDisclosure target={target} senderLabel="carol @ clawmeets.ai" />)
    expect(chips()).toHaveLength(1)
    rerender(<HubDisclosure target={{ ...target, deployment_name: 'acme.dev' }} senderLabel="carol @ clawmeets.ai" />)
    expect(chips()).toHaveLength(0)
  })

  it('in the host-side contact label', () => {
    const { rerender } = render(
      <HubContactLabel fields={{ remote_username: 'carol', deployment_name: LOOKALIKE, deployment_fingerprint: FP_ACME }} fallbackName="x" />,
    )
    expect(chips()).toHaveLength(1)
    rerender(<HubContactLabel fields={{ remote_username: 'carol', deployment_name: 'acme.dev', deployment_fingerprint: FP_ACME }} fallbackName="x" />)
    expect(chips()).toHaveLength(0)
  })

  it('in Blocked servers', () => {
    blockedRows = [
      { deployment_fingerprint: FP_ACME, deployment_name: LOOKALIKE, created_at: NOW_S },
      { deployment_fingerprint: 'f'.repeat(32), deployment_name: 'acme.dev', created_at: NOW_S },
    ]
    render(<BlockedDeploymentsCard agentFullName="carol-scout" />)
    const rows = screen.getAllByTestId('blocked-deployment')
    expect(rows[0].querySelector('[data-testid="chip-unusual"]')).not.toBeNull()
    expect(rows[1].querySelector('[data-testid="chip-unusual"]')).toBeNull()
  })
})
