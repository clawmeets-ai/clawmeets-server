import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { BANNED_WORDS } from '../components/computer/computerCopy'
import {
  ACCESS_ERROR_COPY, accessErrorText, isIsolationUnavailable, ISOLATION_COPY, retryUnlessIsolated, waitText,
  type AccessErrorCode,
} from './agentAccessCopy'

const body = (code: string, extra: Record<string, unknown> = {}) => ({ code, message: '', ...extra })
const CODES: AccessErrorCode[] = [
  'agent_send_cap', 'user_only', 'not_retained', 'agent_name_unsupported',
  'isolation_unavailable', 'turn_scope', 'room_flow_stopped', 'remote_agent',
]

describe('the error copy of agent access', () => {
  it('maps each of the eight codes to a sentence', () => {
    expect(Object.keys(ACCESS_ERROR_COPY).sort()).toEqual([...CODES].sort())
    for (const c of CODES) {
      const t = accessErrorText(body(c))
      expect(t, c).toMatch(/\S.*[.!?]$/)
    }
  })

  it('agent_send_cap says when to try again from retry_after', () => {
    expect(accessErrorText(body('agent_send_cap', { retry_after: 45 }))).toContain('Try again in 45 s.')
    expect(accessErrorText(body('agent_send_cap', { retry_after: 600 }))).toContain('Try again in 10 min.')
    expect(accessErrorText(body('agent_send_cap', {}))).toContain('Try again later.')
    expect(waitText(7200)).toBe('2 h')
  })

  it('an unknown code or no body gives null (the caller keeps its own line)', () => {
    expect(accessErrorText(body('rate_limited'))).toBeNull()
    expect(accessErrorText(body('toString'))).toBeNull()
    expect(accessErrorText(null)).toBeNull()
  })

  it('no sentence says runner, daemon, host or process', () => {
    const all = [
      ...CODES.map((c) => accessErrorText(body(c, { retry_after: 30 })) ?? ''),
      ...Object.values(ISOLATION_COPY),
    ]
    for (const s of all) for (const w of BANNED_WORDS) expect(s.toLowerCase(), s).not.toContain(w)
  })

  it('isolation_unavailable is read off the 409 and never retried', () => {
    const iso = new ApiError(409, 'x', { detail: { code: 'isolation_unavailable', message: '' } })
    expect(isIsolationUnavailable(iso)).toBe(true)
    expect(isIsolationUnavailable(new ApiError(409, 'x', { detail: { code: 'room_flow_stopped', message: '' } }))).toBe(false)
    expect(retryUnlessIsolated(0, iso)).toBe(false)
    expect(retryUnlessIsolated(0, new ApiError(500, 'x'))).toBe(true)
    expect(retryUnlessIsolated(1, new ApiError(500, 'x'))).toBe(false)
  })
})
