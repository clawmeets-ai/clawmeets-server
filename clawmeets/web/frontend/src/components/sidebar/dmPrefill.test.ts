import { describe, it, expect } from 'vitest'
import {
  assembleAgentDraft,
  assembleProjectDraft,
  AGENT_DRAFT_TEMPLATE,
  PROJECT_DRAFT_TEMPLATE,
} from './dmPrefill'

// These assemblers are the single source of truth shared by the design and the
// DmComposeModal send path — assert the exact strings so a template edit that
// silently breaks assembly is caught here.
describe('assembleAgentDraft', () => {
  it('substitutes name + expertise and keeps the optional clause when present', () => {
    expect(
      assembleAgentDraft({
        name: 'research-analyst',
        expertise: 'market research',
        other: 'Focus on EU markets.',
      }),
    ).toBe(
      'Please create an agent named research-analyst specialized in market research. Focus on EU markets.',
    )
  })

  it('drops a blank optional clause cleanly — no dangling token, double period, or trailing space', () => {
    const out = assembleAgentDraft({ name: 'scout', expertise: 'recon', other: '   ' })
    expect(out).toBe('Please create an agent named scout specialized in recon.')
    expect(out).not.toContain('<other')
    expect(out).not.toContain('..')
    expect(out.endsWith('. ')).toBe(false)
  })

  it('trims each field before substituting', () => {
    expect(
      assembleAgentDraft({ name: '  a  ', expertise: '  b  ', other: '' }),
    ).toBe('Please create an agent named a specialized in b.')
  })

  it('leaves no unresolved placeholders from the template', () => {
    const out = assembleAgentDraft({ name: 'x', expertise: 'y', other: 'z' })
    for (const token of ['<name>', '<expertise>', '<other relevant description>']) {
      expect(AGENT_DRAFT_TEMPLATE).toContain(token)
      expect(out).not.toContain(token)
    }
  })
})

describe('assembleProjectDraft', () => {
  it('joins the agent list and substitutes the task', () => {
    expect(
      assembleProjectDraft({ agents: ['alice', 'bob'], task: 'ship the report' }),
    ).toBe('Please create a project with alice, bob to ship the report.')
  })

  it('trims, drops blanks, and de-dupes case-insensitively (first casing kept)', () => {
    expect(
      assembleProjectDraft({
        agents: ['  Alice ', 'bob', '', 'ALICE', 'Bob '],
        task: 'do work',
      }),
    ).toBe('Please create a project with Alice, bob to do work.')
  })

  it('keeps the same lexical skeleton as PROJECT_DRAFT_TEMPLATE', () => {
    expect(PROJECT_DRAFT_TEMPLATE.startsWith('Please create a project with ')).toBe(true)
    const out = assembleProjectDraft({ agents: ['solo'], task: 'go' })
    expect(out).toBe('Please create a project with solo to go.')
  })
})
