import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { FP_ACME, FP_OTHER, hubProject, hubTarget } from '../../test/hubFixtures'
import type { AgentCard, Project } from '../../types'
import PublicPanel, { hubRowChip } from './PublicPanel'

/**
 * The Public sidebar's hub buckets: one per GENESIS fingerprint (a rotation
 * never splits one, two servers with one name never merge), same-named
 * servers carry the short fingerprint, unlisted and closed rows are greyed
 * with a chip, and a row opens /hub/{hub_agent_id}/{project_id}. No extra
 * request: the rows come from the user's project list.
 */

let agents: AgentCard[] = []
let projects: Project[] = []
vi.mock('../../hooks/useAgents', () => ({ useAgents: () => ({ data: agents }) }))
vi.mock('../../hooks/useProjects', () => ({ useUserProjects: () => ({ data: projects }) }))

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

function renderPanel(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<><PublicPanel /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

const buckets = () => screen.queryAllByTestId('hub-bucket')
const headers = () => screen.queryAllByTestId('hub-bucket-header').map((h) => h.textContent)

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1', username: 'carol' })], 'u1')
  agents = []
  projects = []
})
afterEach(cleanup)

describe('PublicPanel: hub buckets by fingerprint', () => {
  it('a look-alike server name gets the "contains unusual characters" chip in its header; a plain one does not', () => {
    projects = [
      hubProject('p1', hubTarget({ name: 'scout' })),
      hubProject('p2', hubTarget({ name: 'bob', deployment_name: '\u0430cme.dev', deployment_fingerprint: FP_OTHER })),
    ]
    renderPanel()
    const hs = screen.getAllByTestId('hub-bucket-header')
    const marked = hs.filter((h) => h.querySelector('[data-testid="chip-unusual"]'))
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toContain('\u0430cme.dev')
    expect(marked[0].textContent).toContain('contains unusual characters')
  })

  it('one bucket per genesis fingerprint; a rotated key (current_fingerprint) stays in the same bucket', () => {
    projects = [
      hubProject('p1', hubTarget({ name: 'scout' })),
      hubProject('p2', hubTarget({ name: 'lex', current_fingerprint: 'ffff0000' + FP_ACME.slice(8) })),
      hubProject('p3', hubTarget({ name: 'bob', deployment_name: 'lawbot', deployment_fingerprint: FP_OTHER })),
    ]
    renderPanel()
    expect(buckets()).toHaveLength(2)
    expect(headers()).toEqual(['@ acme.dev', '@ lawbot'])
    expect(within(buckets()[0]).getAllByTestId('hub-row-display').map((r) => r.textContent).sort()).toEqual(
      ['lex@acme.dev', 'scout@acme.dev'],
    )
  })

  it('two servers that share a name never merge, and both headers add the short fingerprint', () => {
    projects = [
      hubProject('p1', hubTarget({ name: 'scout' })),
      hubProject('p2', hubTarget({ name: 'scout', deployment_fingerprint: FP_OTHER })),
    ]
    renderPanel()
    expect(buckets()).toHaveLength(2)
    expect(headers().sort()).toEqual(
      [`@ acme.dev · ${FP_ACME.slice(0, 8)}`, `@ acme.dev · ${FP_OTHER.slice(0, 8)}`].sort(),
    )
  })

  it('greyed rows with a chip for listed false and for each closed_reason; open rows have none', () => {
    projects = [
      hubProject('p1', hubTarget({ name: 'open' })),
      hubProject('p2', hubTarget({ name: 'gone', listed: false })),
      hubProject('p3', hubTarget({ name: 'revoked', closed_reason: 'key_revoked' })),
      hubProject('p4', hubTarget({ name: 'moved', closed_reason: 'identity_changed' })),
    ]
    renderPanel()
    const rows = screen.getAllByTestId('hub-row')
    const byName = (n: string) => rows.find((r) => within(r).getByTestId('hub-row-display').textContent === `${n}@acme.dev`)!
    expect(within(byName('open')).queryByTestId('hub-row-chip')).toBeNull()
    expect(byName('open').className).not.toContain('opacity-60')
    expect(within(byName('gone')).getByTestId('hub-row-chip').textContent).toBe('no longer listed')
    expect(byName('gone').className).toContain('opacity-60')
    expect(within(byName('revoked')).getByTestId('hub-row-chip').textContent).toBe('key revoked')
    expect(within(byName('moved')).getByTestId('hub-row-chip').textContent).toBe('server changed')
  })

  it.each([
    [{ closed_reason: null, listed: true }, null],
    [{ closed_reason: null, listed: false }, 'no longer listed'],
    [{ closed_reason: 'agent_unlisted' }, 'no longer listed'],
    [{ closed_reason: 'deployment_suspended' }, 'server suspended'],
    [{ closed_reason: 'hub_off_on_server' }, 'hub off'],
    [{ closed_reason: 'conversation_closed' }, 'closed'],
    [{ closed_reason: 'something_new' }, 'closed'],
  ] as const)('hubRowChip(%o) is %s', (o, chip) => {
    expect(hubRowChip(hubTarget(o as never))).toBe(chip)
  })

  it('the row opens /hub/{hub_agent_id}/{project_id}, and the open thread is marked current', () => {
    projects = [hubProject('p1', hubTarget({ name: 'scout' }))]
    const id = `${FP_ACME.slice(0, 16)}~scout`
    renderPanel()
    fireEvent.click(screen.getByTestId('hub-row'))
    expect(screen.getByTestId('where').textContent).toBe(`/hub/${id}/p1`)
    expect(screen.getByTestId('hub-row').getAttribute('aria-current')).toBe('page')
  })

  it('a hostile display stays text, and hub threads never land in an owner bucket', () => {
    projects = [
      hubProject('p1', hubTarget({ display: '<img src=x>‮evil@acme.dev', name: 'evil' }), {
        coordinator_id: 'stand-in', created_by: 'u1',
      }),
    ]
    agents = [{ id: 'stand-in', name: 'zed-standin', registered_by: 'u2', status: 'online' } as AgentCard]
    const { container } = renderPanel()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByTestId('hub-row-display').textContent).toBe('<img src=x>evil@acme.dev')
    expect(screen.queryByText('zed')).toBeNull()
    expect(screen.queryByText('No public agents DMed yet')).toBeNull()
  })

  it('no hub projects: no hub bucket, and the empty line still shows', () => {
    projects = [hubProject('p1', null)]
    renderPanel()
    expect(buckets()).toHaveLength(0)
    expect(screen.getByText('No public agents DMed yet')).toBeTruthy()
  })
})
