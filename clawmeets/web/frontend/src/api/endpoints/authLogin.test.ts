import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuthContractError, OAuthContractError, loginUser, registerUser } from './auth'

// The wire contract for POST /auth/login, per AUTH_CONTRACT §2-§5. The four
// §4.1 failure cases are byte-identical on the wire; these tests pin that the
// client sends the right thing and parses the envelope — the RENDERING half of
// the no-oracle property is asserted in LoginPage.test.tsx.

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

function envelope(status: number, code: string, message: string, field: string | null = null): Response {
  return new Response(JSON.stringify({ error: { code, message, field } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const LOGIN_PAYLOAD = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  user: { id: 'u1', username: 'ada' },
  assistant_agent_id: 'agent-1',
  assistant_agent_name: 'ada-assistant',
}

function lastCall() {
  const [url, opts] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
  return { url: String(url), opts: opts as RequestInit }
}

// Header lookup that works whether the call site passed a Headers instance or a
// plain object — the assertion must not depend on which the implementation used.
function headerValue(opts: RequestInit, name: string): string | null {
  return new Headers(opts.headers).get(name)
}

// ---------------------------------------------------------------------------
// Test 10 — request body shape + the required content type
// ---------------------------------------------------------------------------
describe('loginUser request', () => {
  it('POSTs exactly {identifier, password} to /auth/login', async () => {
    fetchMock.mockResolvedValue(ok(LOGIN_PAYLOAD))
    await loginUser('ada', 'hunter2')

    const { url, opts } = lastCall()
    expect(url).toContain('/auth/login')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(String(opts.body))).toEqual({ identifier: 'ada', password: 'hunter2' })
  })

  it('never sends the deprecated `username` alias or a type/mode discriminator', async () => {
    fetchMock.mockResolvedValue(ok(LOGIN_PAYLOAD))
    await loginUser('ada@example.com', 'hunter2')

    const body = JSON.parse(String(lastCall().opts.body))
    // The §2.2 alias exists for released runner wheels only. New client code
    // must not use it, and the client must never tell the server which KIND of
    // identifier it sent.
    expect(body).not.toHaveProperty('username')
    expect(body).not.toHaveProperty('email')
    expect(body).not.toHaveProperty('type')
    expect(body).not.toHaveProperty('mode')
    expect(Object.keys(body).sort()).toEqual(['identifier', 'password'])
  })

  // The single highest-risk mismatch in this milestone: the server requires
  // Content-Type: application/json (§2.1) and answers 400 without it, and
  // fetch does NOT set it for a string body the way httpx's json= does. A
  // missing header here is invisible to both test suites and fatal in a browser.
  it('sends Content-Type: application/json (the server 400s without it)', async () => {
    fetchMock.mockResolvedValue(ok(LOGIN_PAYLOAD))
    await loginUser('ada', 'hunter2')

    expect(headerValue(lastCall().opts, 'Content-Type')).toBe('application/json')
  })

  it('passes the password through verbatim — whitespace is significant', async () => {
    fetchMock.mockResolvedValue(ok(LOGIN_PAYLOAD))
    await loginUser('ada', '  pw  ')

    expect(JSON.parse(String(lastCall().opts.body)).password).toBe('  pw  ')
  })
})

// ---------------------------------------------------------------------------
// Test 11 — envelope parsing (the data.detail migration)
// ---------------------------------------------------------------------------
describe('loginUser envelope parsing', () => {
  it('throws AuthContractError carrying the contract code on 401', async () => {
    fetchMock.mockResolvedValue(envelope(401, 'invalid_credentials', 'Invalid credentials'))
    await expect(loginUser('ada', 'wrong')).rejects.toMatchObject({
      code: 'invalid_credentials',
      field: null,
    })
    await expect(loginUser('ada', 'wrong')).rejects.toBeInstanceOf(AuthContractError)
  })

  it('throws AuthContractError(email_not_verified) on 403', async () => {
    fetchMock.mockResolvedValue(
      envelope(403, 'email_not_verified', 'Email not verified. Check your email for the verification link.'),
    )
    await expect(loginUser('ada', 'pw')).rejects.toMatchObject({ code: 'email_not_verified' })
  })

  it('throws AuthContractError(invalid_request) with the offending field on 400', async () => {
    fetchMock.mockResolvedValue(
      envelope(400, 'invalid_request', 'Identifier and password are required.', 'identifier'),
    )
    await expect(loginUser('', 'pw')).rejects.toMatchObject({
      code: 'invalid_request',
      field: 'identifier',
    })
  })

  // The regression guard for the deleted `throw new Error(data.detail || ...)`.
  // A legacy FastAPI body must NOT drive the message any more; it is not the
  // envelope, so it degrades like any other non-envelope body.
  it('no longer reads a legacy {detail} body', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Incorrect username or password' }), { status: 401 }),
    )
    const err = await loginUser('ada', 'wrong').catch((e) => e)
    expect(err).toBeInstanceOf(AuthContractError)
    expect(err.message).not.toContain('Incorrect username or password')
    expect(err.code).toBe('unknown_error')
  })
})

// ---------------------------------------------------------------------------
// Test 12 — non-envelope degradation, and never an OAuth-named code
// ---------------------------------------------------------------------------
describe('loginUser non-envelope degradation', () => {
  it('degrades a 500 HTML body to a non-OAuth code, never blank', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 500 }))
    const err = await loginUser('ada', 'pw').catch((e) => e)

    expect(err).toBeInstanceOf(AuthContractError)
    expect(err).not.toBeInstanceOf(OAuthContractError)
    expect(err.code).toBe('unknown_error')
    expect(err.message.length).toBeGreaterThan(0)
  })

  it('degrades an empty 401 body without synthesizing NO_SESSION', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }))
    const err = await loginUser('ada', 'pw').catch((e) => e)

    // NO_SESSION / OAUTH_EXCHANGE_FAILED are the OAuth reader's synthetic codes.
    // A password sign-in failure must never surface an OAuth-named code.
    expect(err.code).not.toBe('NO_SESSION')
    expect(err.code).not.toBe('OAUTH_EXCHANGE_FAILED')
    expect(err.code).toBe('unknown_error')
  })
})

// ---------------------------------------------------------------------------
// Test 13 — assistant_agent_id nullability (§3 / §10.2 item 1)
// ---------------------------------------------------------------------------
describe('loginUser success payload', () => {
  it('parses a 200 with assistant_agent_id: null', async () => {
    fetchMock.mockResolvedValue(ok({ ...LOGIN_PAYLOAD, assistant_agent_id: null }))
    const res = await loginUser('ada', 'pw')
    expect(res.assistant_agent_id).toBeNull()
    expect(res.access_token).toBe('access-1')
  })

  it('parses a 200 with the key omitted entirely', async () => {
    const { assistant_agent_id: _omitted, ...withoutKey } = LOGIN_PAYLOAD
    fetchMock.mockResolvedValue(ok(withoutKey))
    const res = await loginUser('ada', 'pw')
    expect(res.assistant_agent_id).toBeUndefined()
  })

  it('returns the same shape whether the identifier was a username or an email', async () => {
    fetchMock.mockResolvedValue(ok(LOGIN_PAYLOAD))
    const byUsername = await loginUser('ada', 'pw')
    fetchMock.mockResolvedValue(ok(LOGIN_PAYLOAD))
    const byEmail = await loginUser('ada@example.com', 'pw')
    expect(byUsername).toEqual(byEmail)
  })
})

// ---------------------------------------------------------------------------
// The register path — auth.ts:81's `data.detail`, the second call site
// ---------------------------------------------------------------------------
describe('registerUser envelope parsing (Decision 11)', () => {
  it('surfaces the actionable lowercase-username 400 instead of generic copy', async () => {
    fetchMock.mockResolvedValue(
      envelope(
        400,
        'invalid_request',
        "Username must be lowercase. Use 'alice' instead of 'Alice'.",
        'username',
      ),
    )
    const err = await registerUser('Alice', 'pw', 'a@b.com', 'CODE').catch((e) => e)

    expect(err).toBeInstanceOf(AuthContractError)
    expect(err.code).toBe('invalid_request')
    expect(err.field).toBe('username')
    expect(err.message).toBe("Username must be lowercase. Use 'alice' instead of 'Alice'.")
    // The old code rendered EVERY register failure as this string.
    expect(err.message).not.toBe('Registration failed')
  })

  it('still carries the endpoint failures that remain on the legacy {detail} shape', async () => {
    // /auth/register raises plain HTTPExceptions for these, so the body is
    // {detail: ...}, not the envelope. Losing them to generic copy would be a
    // regression, so REGISTER_READER mines detail in its fallback.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Email already registered' }), { status: 400 }),
    )
    const err = await registerUser('alice', 'pw', 'a@b.com', 'CODE').catch((e) => e)

    expect(err).toBeInstanceOf(AuthContractError)
    expect(err.code).toBe('registration_failed')
    expect(err.message).toBe('Email already registered')
  })

  it('sends Content-Type: application/json', async () => {
    fetchMock.mockResolvedValue(ok({ user_id: 'u1', username: 'alice', user_created_at: 'now' }))
    await registerUser('alice', 'pw', 'a@b.com', 'CODE')
    expect(headerValue(lastCall().opts, 'Content-Type')).toBe('application/json')
  })
})
