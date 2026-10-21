import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  validateInvite,
  startOAuth,
  exchangeOAuthCode,
  OAuthContractError,
} from './auth'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function envelope(status: number, code: string, field: string | null = null): Response {
  return new Response(
    JSON.stringify({ error: { code, message: `msg-${code}`, field } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

// The byte-identical /auth/login payload the exchange returns.
const LOGIN_PAYLOAD = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  user: { id: 'u1', username: 'bob' },
  assistant_agent_id: 'agent-1',
  assistant_agent_name: 'bob-assistant',
}

function lastCall() {
  const [url, opts] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return { url: String(url), opts: opts as RequestInit }
}

describe('validateInvite', () => {
  it('POSTs the code and returns {valid:true} on 200', async () => {
    fetchMock.mockResolvedValue(ok({ valid: true }))
    const res = await validateInvite('GOODCODE')
    expect(res).toEqual({ valid: true })
    const { url, opts } = lastCall()
    expect(url).toContain('/auth/oauth/invite/validate')
    expect(opts.method).toBe('POST')
    expect(opts.credentials).toBe('include')
    expect(JSON.parse(String(opts.body))).toEqual({ code: 'GOODCODE' })
  })

  it('throws OAuthContractError with code+field from the envelope', async () => {
    fetchMock.mockResolvedValue(envelope(400, 'INVITE_EXPIRED', 'code'))
    await expect(validateInvite('OLD')).rejects.toMatchObject({
      name: 'OAuthContractError',
      code: 'INVITE_EXPIRED',
      field: 'code',
    })
  })
})

describe('startOAuth', () => {
  it('includes the invite code on Signup', async () => {
    fetchMock.mockResolvedValue(ok({ authorization_url: 'https://accounts.google.com/x' }))
    const res = await startOAuth('google', 'INV1')
    expect(res.authorization_url).toContain('https://')
    const { url, opts } = lastCall()
    expect(url).toContain('/auth/oauth/google/start')
    expect(JSON.parse(String(opts.body))).toEqual({ code: 'INV1' })
  })

  it('omits the code on Login (empty body)', async () => {
    fetchMock.mockResolvedValue(ok({ authorization_url: 'https://github.com/login/oauth' }))
    await startOAuth('github')
    const { url, opts } = lastCall()
    expect(url).toContain('/auth/oauth/github/start')
    expect(JSON.parse(String(opts.body))).toEqual({})
  })

  it('throws OAuthContractError on an envelope error', async () => {
    fetchMock.mockResolvedValue(envelope(400, 'PROVIDER_UNSUPPORTED'))
    await expect(startOAuth('google')).rejects.toBeInstanceOf(OAuthContractError)
  })
})

describe('exchangeOAuthCode', () => {
  it('returns the byte-identical /auth/login payload on 200', async () => {
    fetchMock.mockResolvedValue(ok(LOGIN_PAYLOAD))
    const res = await exchangeOAuthCode('HANDOFF')
    expect(res).toEqual(LOGIN_PAYLOAD)
    const { url, opts } = lastCall()
    expect(url).toContain('/auth/oauth/exchange')
    expect(JSON.parse(String(opts.body))).toEqual({ code: 'HANDOFF' })
    expect(opts.credentials).toBe('include')
  })

  it('maps a 401 envelope to OAuthContractError(NO_SESSION)', async () => {
    fetchMock.mockResolvedValue(envelope(401, 'NO_SESSION'))
    await expect(exchangeOAuthCode('SPENT')).rejects.toMatchObject({ code: 'NO_SESSION' })
  })

  it('synthesizes NO_SESSION when a 401 body is not the envelope', async () => {
    fetchMock.mockResolvedValue(new Response('gateway blurb', { status: 401 }))
    await expect(exchangeOAuthCode('SPENT')).rejects.toMatchObject({ code: 'NO_SESSION' })
  })
})
