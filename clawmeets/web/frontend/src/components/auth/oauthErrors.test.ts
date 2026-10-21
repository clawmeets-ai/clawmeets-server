import { describe, it, expect } from 'vitest'
import { messageForCode, isInviteFieldError, needsInvite } from './oauthErrors'

// The 13 stable backend error codes wired on both surfaces.
const ALL_CODES = [
  'INVITE_MALFORMED',
  'INVITE_REQUIRED',
  'INVITE_NOT_FOUND',
  'INVITE_ALREADY_REDEEMED',
  'INVITE_EXPIRED',
  'INVITE_REVOKED',
  'PROVIDER_UNSUPPORTED',
  'OAUTH_ACCESS_DENIED',
  'OAUTH_STATE_INVALID',
  'OAUTH_EXCHANGE_FAILED',
  'OAUTH_EMAIL_UNVERIFIED',
  'OAUTH_EMAIL_MISSING',
  'NO_SESSION',
]

describe('messageForCode', () => {
  it('returns a non-empty, token-free message for every stable code', () => {
    for (const code of ALL_CODES) {
      const msg = messageForCode(code)
      expect(msg.length).toBeGreaterThan(0)
      expect(msg).not.toContain('{provider}')
    }
  })

  it('interpolates the provider label when supplied', () => {
    expect(messageForCode('OAUTH_EMAIL_UNVERIFIED', 'google')).toContain('Google')
    expect(messageForCode('OAUTH_EMAIL_MISSING', 'github')).toContain('GitHub')
  })

  it('falls back to "the provider" when no provider is known (redirect path)', () => {
    expect(messageForCode('OAUTH_EMAIL_UNVERIFIED')).toContain('the provider')
  })

  it('explains EMAIL_UNPROVEN and points at the password sign-in', () => {
    const msg = messageForCode('EMAIL_UNPROVEN')
    expect(msg).not.toBe('Something went wrong. Please try again.')
    expect(msg).toContain('never confirmed')
    expect(msg).toContain('password')
    expect(isInviteFieldError('EMAIL_UNPROVEN')).toBe(false)
    expect(needsInvite('EMAIL_UNPROVEN')).toBe(false)
  })

  it('degrades unknown/future codes to a generic message (never blank)', () => {
    expect(messageForCode('SOME_FUTURE_CODE')).toBe('Something went wrong. Please try again.')
  })
})

describe('isInviteFieldError', () => {
  it('is true for the five invite-field codes, false for INVITE_REQUIRED and non-invite codes', () => {
    for (const c of ['INVITE_MALFORMED', 'INVITE_NOT_FOUND', 'INVITE_ALREADY_REDEEMED', 'INVITE_EXPIRED', 'INVITE_REVOKED']) {
      expect(isInviteFieldError(c)).toBe(true)
    }
    expect(isInviteFieldError('INVITE_REQUIRED')).toBe(false)
    expect(isInviteFieldError('OAUTH_STATE_INVALID')).toBe(false)
  })
})

describe('needsInvite', () => {
  it('is true only for INVITE_REQUIRED', () => {
    expect(needsInvite('INVITE_REQUIRED')).toBe(true)
    expect(needsInvite('INVITE_EXPIRED')).toBe(false)
  })
})

// ===========================================================================
// AUTH_CONTRACT §4/§5 — the password-auth codes added to the shared map
// ===========================================================================
describe('password sign-in copy', () => {
  const PASSWORD_CODES = ['invalid_credentials', 'email_not_verified', 'invalid_request']

  it('returns non-empty, token-free copy for each contract code', () => {
    for (const code of PASSWORD_CODES) {
      const msg = messageForCode(code)
      expect(msg.length).toBeGreaterThan(0)
      expect(msg).not.toBe('Something went wrong. Please try again.')
      expect(msg).not.toContain('{provider}')
    }
  })

  it('names no field and reveals no account existence', () => {
    // §4.1: the four failure cases must be indistinguishable, so the copy for
    // invalid_credentials cannot hint at which half of the pair was wrong.
    const msg = messageForCode('invalid_credentials').toLowerCase()
    for (const leak of ['no such', 'not found', 'unknown user', 'does not exist', 'wrong password']) {
      expect(msg).not.toContain(leak)
    }
  })

  it('keeps rate_limited on the generic fallback (§7 — deliberate, not an oversight)', () => {
    expect(messageForCode('rate_limited')).toBe('Something went wrong. Please try again.')
  })

  it('keeps the login reader synthetic code on the generic fallback', () => {
    expect(messageForCode('unknown_error')).toBe('Something went wrong. Please try again.')
  })

  it('does not collide with the OAuth namespace', () => {
    // OAuth codes are SCREAMING_SNAKE, the contract's are lower_snake.
    expect(messageForCode('NO_SESSION')).toBe('Please sign in to continue.')
    expect(messageForCode('invalid_credentials')).not.toBe(messageForCode('NO_SESSION'))
  })
})
