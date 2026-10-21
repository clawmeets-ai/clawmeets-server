import { describe, expect, it } from 'vitest'
import { recheckResultText } from './IsolationRecheckButton'
import type { IsolationCheckStatus } from '../../../api/endpoints/isolationCheck'

const base: IsolationCheckStatus = {
  state: 'failed', recheck_id: 'r', provider: 'claude', kind: 'needs_action', failures: [],
  checked_at: 1, isolated_turns: false, held_conversations: 2, runner_connected: true,
}

describe('recheckResultText', () => {
  it('says a pass delivers waiting conversations', () => {
    expect(recheckResultText({ ...base, state: 'passed', kind: 'passed' })).toBe(
      'Check passed. Waiting conversations are being delivered.')
  })
  it('names the first failure line and the next step', () => {
    expect(recheckResultText({ ...base, failures: ['provider_turn_ran (rc=1, 401)\nmore'] })).toBe(
      'Check failed: provider_turn_ran (rc=1, 401). Fix what it reports (for a login error, sign the model CLI in again on that computer), then re-run.')
  })
  it('says an unsupported provider plainly', () => {
    expect(recheckResultText({ ...base, kind: 'unsupported', failures: ['provider cannot run isolated turns'] }))
      .toContain("can't serve conversations from other people yet")
  })
  it('is empty while running', () => {
    expect(recheckResultText({ ...base, state: 'running' })).toBe('')
  })
})
