import { get, post } from '../client'
import { fetchRetryingTransient } from '../transientRetry'
import type {
  ErrorEnvelope,
  InviteValidateResponse,
  LoginResponse,
  OAuthProvider,
  RefreshResponse,
  StartResponse,
  User,
  UsernameAvailableResponse,
} from '../../types'

// --- The shared error envelope ---------------------------------------------
//
// { error: {code, message, field} } is now the ONE error shape across auth:
// password sign-in (400/401/403 on /auth/login, AUTH_CONTRACT §4-§5), the
// lowercase-username rule on /auth/register, and the 13-code OAuth surface.
// The reader below is shared by all three; only "which error class" and "what
// to do with a body that isn't the envelope" ever differed per endpoint family,
// so those are the two knobs an EnvelopeReader carries.

// Carrier for the envelope. `code` is the machine-readable discriminator the UI
// maps to copy via messageForCode — callers render THAT, not `message`, so a
// server string never leaks into the DOM verbatim.
export class AuthContractError extends Error {
  constructor(
    public code: string,
    message: string,
    public field: string | null,
  ) {
    super(message)
    this.name = 'AuthContractError'
  }
}

interface EnvelopeReader {
  // Build the error to throw for a well-formed envelope.
  make: (code: string, message: string, field: string | null) => AuthContractError
  // Fallback for a body that ISN'T the envelope (proxy HTML, empty 5xx, or a
  // legacy FastAPI {detail} body). Gets the parsed body so a reader can mine it.
  synthesize: (status: number, body: unknown) => { code: string; message: string }
}

// Read an auth response: ok -> parsed JSON; !ok -> parse the {error:{...}}
// envelope and throw via reader.make. A non-envelope error body degrades through
// reader.synthesize so the caller never sees a blank error. Never returns for a
// non-2xx.
async function readEnvelope<T>(response: Response, reader: EnvelopeReader): Promise<T> {
  if (response.ok) {
    return response.json() as Promise<T>
  }
  const body: unknown = await response.json().catch(() => null)
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as ErrorEnvelope).error?.code === 'string'
  ) {
    const { code, message, field } = (body as ErrorEnvelope).error
    throw reader.make(code, message, field ?? null)
  }
  const { code, message } = reader.synthesize(response.status, body)
  throw reader.make(code, message, null)
}

// Password sign-in. Degrades a non-envelope body to 'unknown_error', which
// messageForCode resolves to the generic fallback — never an OAuth-named code on
// a login failure, and never a raw server string.
const PASSWORD_READER: EnvelopeReader = {
  make: (code, message, field) => new AuthContractError(code, message, field),
  synthesize: (status) => ({
    code: 'unknown_error',
    message: `Login request failed (HTTP ${status})`,
  }),
}

// /auth/register. The lowercase-username rule (Decision 11) returns the envelope,
// but the endpoint's other failures still raise FastAPI HTTPExceptions and so
// still return {detail: "..."} — email already registered, bad invite code, short
// username. Reading `detail` HERE, in the one fallback that owns legacy bodies,
// is what lets the call site route everything through readEnvelope; the message
// is surfaced through 'registration_failed' -> the caller's own copy otherwise.
const REGISTER_READER: EnvelopeReader = {
  make: (code, message, field) => new AuthContractError(code, message, field),
  synthesize: (_status, body) => {
    const detail =
      body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string'
        ? (body as { detail: string }).detail
        : null
    return { code: 'registration_failed', message: detail ?? 'Registration failed' }
  },
}

// POST /auth/login {identifier, password} -> 200 LoginResponse.
// `identifier` is a username OR an email address; the client NEVER inspects
// which and NEVER sends a type/mode discriminator (AUTH_CONTRACT §2.2). The
// deprecated `username` alias is for released runner wheels only and must not
// appear here. `password` is passed through verbatim — leading/trailing
// whitespace is significant, so no trim here or anywhere upstream.
//
// Content-Type: application/json is REQUIRED (§2.1) and the server rejects a
// request without it with 400. fetch does not set it for a string body, so the
// header below is load-bearing, not decoration. Asserted by authLogin.test.ts.
//
// Raw fetch, no Bearer, no client.ts wrapper: this must stay off the
// 401 -> refresh -> retry -> logout ladder in api/client.ts.
//
// Throws AuthContractError with code invalid_credentials (401) /
// email_not_verified (403) / invalid_request (400) / rate_limited (reserved 429).
export async function loginUser(identifier: string, password: string): Promise<LoginResponse> {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('bypass-tunnel-reminder', 'true')

  const BASE_URL = import.meta.env.DEV ? '/api' : ''
  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ identifier, password }),
  })

  return readEnvelope<LoginResponse>(response, PASSWORD_READER)
}

// Exchange a refresh token for a fresh access + refresh pair. Uses a raw
// fetch (no Bearer / no client.ts wrapper) so it can't recurse through the
// 401-refresh retry logic in the API client. It does ride out a server restart:
// a refresh that failed on a gateway error page would sign the user out. No
// Idempotency-Key — the refresh is stateless and the old token stays valid, so a
// repeat is harmless, and a key would make the server store the new tokens.
export async function refreshSession(refreshToken: string): Promise<RefreshResponse> {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('bypass-tunnel-reminder', 'true')

  const BASE_URL = import.meta.env.DEV ? '/api' : ''
  const response = await fetchRetryingTransient(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ refresh_token: refreshToken }),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Session refresh failed')
  }

  return response.json()
}

export interface UserResponse {
  user_id: string
  username: string
  user_created_at: string
  // True when the account starts verified (a trusted email domain): sign in now.
  email_verified?: boolean
}

// GET /auth/signup-config -> whether this server takes sign-ups and needs an
// invitation code (CLAWMEETS_SIGNUP_MODE: invite | open | closed).
export interface SignupConfig {
  mode: 'invite' | 'open' | 'closed'
  invitation_code_required: boolean
}

export async function getSignupConfig(): Promise<SignupConfig> {
  const BASE_URL = import.meta.env.DEV ? '/api' : ''
  const response = await fetch(`${BASE_URL}/auth/signup-config`, {
    headers: { 'bypass-tunnel-reminder': 'true' },
  })
  if (!response.ok) throw new Error(`signup-config ${response.status}`)
  return (await response.json()) as SignupConfig
}

// POST /auth/register -> 200 UserResponse.
// Throws AuthContractError. A username with any uppercase character returns the
// envelope 400 {code:'invalid_request', field:'username'} carrying the actionable
// "Username must be lowercase. Use 'alice' instead of 'Alice'." — surfacing that
// verbatim is the point of routing this through readEnvelope. The endpoint's
// other failures still come back as {detail}; REGISTER_READER carries them.
export async function registerUser(
  username: string,
  password: string,
  email: string,
  invitation_code: string,
): Promise<UserResponse> {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('bypass-tunnel-reminder', 'true')

  const BASE_URL = import.meta.env.DEV ? '/api' : ''
  const response = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username, password, email, invitation_code }),
  })

  return readEnvelope<UserResponse>(response, REGISTER_READER)
}

export async function joinWaitlist(email: string): Promise<{ message: string }> {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('bypass-tunnel-reminder', 'true')

  const BASE_URL = import.meta.env.DEV ? '/api' : ''
  const response = await fetch(`${BASE_URL}/auth/waitlist`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email }),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Failed to join waitlist')
  }

  return response.json()
}

export async function verifyEmail(token: string): Promise<{ message: string; username: string }> {
  const headers = new Headers()
  headers.set('bypass-tunnel-reminder', 'true')

  const BASE_URL = import.meta.env.DEV ? '/api' : ''
  const response = await fetch(`${BASE_URL}/auth/verify-email?token=${encodeURIComponent(token)}`, {
    headers,
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Verification failed')
  }

  return response.json()
}

// GET /auth/username-available?username= -> 200 {available, reason}. Advisory,
// non-consuming, unauthenticated — safe to call on every debounced keystroke in
// the sign-up username step. Raw fetch (no Bearer / no client.ts wrapper), like
// the other public auth endpoints.
export async function checkUsername(username: string): Promise<UsernameAvailableResponse> {
  const headers = new Headers()
  headers.set('bypass-tunnel-reminder', 'true')

  const BASE_URL = import.meta.env.DEV ? '/api' : ''
  const response = await fetch(
    `${BASE_URL}/auth/username-available?username=${encodeURIComponent(username)}`,
    { headers },
  )

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.detail || 'Username check failed')
  }

  return response.json()
}

export async function getCurrentUser(): Promise<User> {
  return get<User>('/auth/user/me')
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ message: string }> {
  return post<{ message: string }>('/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  })
}

// --- OAuth invite-login (POST /auth/oauth/*) ------------------------------------
//
// These endpoints share the envelope with password sign-in (see the reader at the
// top of this file). They are unauthenticated (no Bearer) and MUST NOT route
// through client.ts's post() — that would trip the 401 -> refresh -> logout retry
// and mis-parse the envelope. So each uses a raw fetch mirroring loginUser/
// refreshSession, plus credentials:'include' so the HttpOnly oauth_login_state
// cookie the backend sets on /start rides along to the provider callback.

const OAUTH_BASE_URL = import.meta.env.DEV ? '/api' : ''

// OAuth-flavoured subclass. Adds no behaviour: it exists so the existing
// `err instanceof OAuthContractError` call sites (OAuthCallbackPage,
// ProviderButtons, SignupPage) keep working unchanged now that the envelope
// reader is shared. `code` is one of the 13 stable OAuth error codes; the UI maps
// it to copy via messageForCode. The two code namespaces cannot collide — OAuth's
// are SCREAMING_SNAKE, the password contract's are lower_snake.
export class OAuthContractError extends AuthContractError {
  constructor(code: string, message: string, field: string | null) {
    super(code, message, field)
    this.name = 'OAuthContractError'
  }
}

// Today's OAuth behaviour, preserved exactly: OAuthContractError, and a
// non-envelope body degrades to NO_SESSION (401) / OAUTH_EXCHANGE_FAILED (else).
const OAUTH_READER: EnvelopeReader = {
  make: (code, message, field) => new OAuthContractError(code, message, field),
  synthesize: (status) => ({
    code: status === 401 ? 'NO_SESSION' : 'OAUTH_EXCHANGE_FAILED',
    message: `OAuth request failed (HTTP ${status})`,
  }),
}

function oauthHeaders(): Headers {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('bypass-tunnel-reminder', 'true')
  return headers
}

// POST /auth/oauth/invite/validate {code} -> 200 {valid:true}. Advisory and
// non-consuming — safe to call on every invite-field blur/debounce. Throws
// OAuthContractError (e.g. INVITE_EXPIRED) on a bad/used/expired code.
export async function validateInvite(code: string): Promise<InviteValidateResponse> {
  const response = await fetch(`${OAUTH_BASE_URL}/auth/oauth/invite/validate`, {
    method: 'POST',
    headers: oauthHeaders(),
    credentials: 'include',
    body: JSON.stringify({ code }),
  })
  return readEnvelope<InviteValidateResponse>(response, OAUTH_READER)
}

// POST /auth/oauth/{provider}/start {code?, username?} -> 200 {authorization_url}.
// Omit `code` on Login (pure sign-in), pass it on Signup (invite-gated). `username`
// is the slug picked in the sign-up flow before choosing a provider; it rides in
// the signed state cookie so a newly provisioned account gets that slug (advisory —
// a taken/invalid one falls back server-side). The backend sets the HttpOnly
// oauth_login_state cookie on this response; the caller then assigns
// window.location = authorization_url (full-page nav, not XHR-followed).
export async function startOAuth(
  provider: OAuthProvider,
  code?: string,
  username?: string,
): Promise<StartResponse> {
  const body: { code?: string; username?: string } = {}
  if (code) body.code = code
  if (username) body.username = username
  const response = await fetch(`${OAUTH_BASE_URL}/auth/oauth/${provider}/start`, {
    method: 'POST',
    headers: oauthHeaders(),
    credentials: 'include',
    body: JSON.stringify(body),
  })
  return readEnvelope<StartResponse>(response, OAUTH_READER)
}

// POST /auth/oauth/exchange {code} -> 200 <byte-identical /auth/login payload>.
// The single-use handoff code is ~120s; a missing/expired/replayed code is
// 401 NO_SESSION -> throws OAuthContractError('NO_SESSION').
export async function exchangeOAuthCode(code: string): Promise<LoginResponse> {
  const response = await fetch(`${OAUTH_BASE_URL}/auth/oauth/exchange`, {
    method: 'POST',
    headers: oauthHeaders(),
    credentials: 'include',
    body: JSON.stringify({ code }),
  })
  return readEnvelope<LoginResponse>(response, OAUTH_READER)
}
