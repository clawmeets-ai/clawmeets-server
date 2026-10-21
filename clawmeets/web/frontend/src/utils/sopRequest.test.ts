import { describe, it, expect } from 'vitest'
import { buildSopRequestMessage, buildSopScheduleMessage } from './sopRequest'
import type { DeskUpdate } from '../hooks/useDeskUpdates'

function card(over: Partial<DeskUpdate> = {}): DeskUpdate {
  return {
    projectId: '8f1c0a52-1f4e-4a90-9d33-0b2c7a91ba10',
    lane: 'read',
    kind: 'project',
    agent: null,
    agentName: 'chus-inventory',
    sourceName: 'weekly-restock',
    roomLabel: '# coordinator',
    title: 'Restock plan signed off',
    quote: '',
    ts: '2026-08-01T09:00:00Z',
    latestMessageId: 'm1',
    files: [],
    navTo: '/projects/8f1c0a52-1f4e-4a90-9d33-0b2c7a91ba10',
    ...over,
  }
}

describe('buildSopRequestMessage', () => {
  it('names the project by slug and coordinator', () => {
    const msg = buildSopRequestMessage(card())
    expect(msg).toContain('the project "weekly-restock"')
    expect(msg).toContain('coordinator @chus-inventory')
    expect(msg).toContain('addressed to @chus-inventory')
  })

  it('frames a DM card as a thread with the agent, not a project name', () => {
    const msg = buildSopRequestMessage(
      card({ kind: 'dm', agentName: 'clawmeets-frontend', sourceName: 'Desk CTA' }),
    )
    expect(msg).toContain('my DM thread with @clawmeets-frontend')
    expect(msg).not.toContain('Desk CTA')
  })

  it('carries the project uuid — the only handle the assistant can fetch the room with', () => {
    for (const kind of ['project', 'dm'] as const) {
      expect(buildSopRequestMessage(card({ kind }))).toContain(
        'project id: 8f1c0a52-1f4e-4a90-9d33-0b2c7a91ba10',
      )
    }
  })

  it('spells out the blank grammar so the SOP comes back parametrized', () => {
    const msg = buildSopRequestMessage(card())
    expect(msg).toContain('{{Client}}')
    expect(msg).toContain('{{Voice|select:warm,punchy}}')
    expect(msg).toContain('{{Deadline|date}}')
  })
})

describe('buildSopScheduleMessage', () => {
  const sop = {
    id: 'sop-f585940fa675',
    title: 'Weekly restock review',
    body: 'Review {{Inventory|select:Chelsea,Warehouse}} down to {{Par threshold|number:6}}.',
  }

  it('carries the SOP id, since that is what the assistant looks it up by', () => {
    expect(buildSopScheduleMessage(sop)).toContain('sop-f585940fa675')
    expect(buildSopScheduleMessage(sop)).toContain('Weekly restock review')
  })

  it('re-emits each blank verbatim so the composer renders them as chips', () => {
    const msg = buildSopScheduleMessage(sop)
    expect(msg).toContain('- Inventory: {{Inventory|select:Chelsea,Warehouse}}')
    expect(msg).toContain('- Par threshold: {{Par threshold|number:6}}')
  })

  it('always asks for a cadence, as a blank the user must fill', () => {
    expect(buildSopScheduleMessage(sop)).toContain('{{Cadence|text:every day at 9:00 AM}}')
  })

  it('asks the same blank once even when the body repeats it', () => {
    const msg = buildSopScheduleMessage({
      ...sop,
      body: 'Check {{Inventory}} then reconcile {{ inventory }}.',
    })
    expect(msg.match(/- Inventory:/g)).toHaveLength(1)
  })

  it('emits only the cadence line for a SOP with no blanks', () => {
    const msg = buildSopScheduleMessage({ ...sop, body: 'Run the close.' })
    expect(msg).not.toContain('Run it with these values')
    expect(msg).toContain('{{Cadence')
  })
})
