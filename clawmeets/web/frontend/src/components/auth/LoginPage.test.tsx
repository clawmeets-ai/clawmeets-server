import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LoginPage from './LoginPage'
import { useAuthStore } from '../../stores/authStore'
import { loginUser } from '../../api/endpoints/auth'
import { seedSessions } from '../../test/authFixtures'

// Only the network layer is mocked. LoginPage -> authStore -> loginUser runs for
// real, so these tests exercise the whole submit chain: what reaches the wire,
// what the store records, and what the DOM renders for each branch.
vi.mock('../../api/endpoints/auth', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loginUser: vi.fn(),
    refreshSession: vi.fn(),
    startOAuth: vi.fn(),
  }
})

// Imported after the mock so the real class (used for `instanceof` in the store)
// is the same one these tests construct.
const { AuthContractError } = await import('../../api/endpoints/auth')

const PAYLOAD = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  user: { id: 'u1', username: 'ada' },
  assistant_agent_id: null,
  assistant_agent_name: 'ada-assistant',
}

// vitest.config.ts sets globals:false and there is no setup file, so RTL's
// auto-cleanup never registers — without this, every render stays mounted and
// getByRole finds N copies of the form.
afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  vi.mocked(loginUser).mockReset()
  // AC-5.6. Signed-OUT through the real path rather than by nulling the
  // mirror: the mirror is derived, so a hand-written null is a state the next
  // `syncActive()` recomputes over. `seedSessions([])` runs the real
  // `logout()`, which is what the Logout button does.
  //
  // `isLoading` is separate and stays a plain write — it is not auth state and
  // `logout()` does not own it.
  seedSessions([])
  useAuthStore.setState({ isLoading: false })
})

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <LoginPage />
    </MemoryRouter>,
  )
}

// The ONE identifier field, found by its visible label. Every test goes through
// this helper — if a second text field or a mode toggle were ever added, the
// structural test below fails rather than these silently picking the wrong one.
function identifierInput() {
  return screen.getByLabelText('Username or email')
}
function passwordInput() {
  return screen.getByLabelText('Password')
}
function submit() {
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

async function signInWith(identifier: string, password: string) {
  fireEvent.change(identifierInput(), { target: { value: identifier } })
  fireEvent.change(passwordInput(), { target: { value: password } })
  submit()
}

// ---------------------------------------------------------------------------
// Tests 1 + 2 — success by username and by email, same field, same code path
// ---------------------------------------------------------------------------
describe('submit success', () => {
  it('signs in with a username typed into the single field', async () => {
    vi.mocked(loginUser).mockResolvedValue(PAYLOAD)
    renderPage()

    await signInWith('ada', 'hunter2')

    await waitFor(() => expect(loginUser).toHaveBeenCalledWith('ada', 'hunter2'))
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('signs in with an email typed into the SAME field — no branching', async () => {
    vi.mocked(loginUser).mockResolvedValue(PAYLOAD)
    renderPage()

    await signInWith('ada@example.com', 'hunter2')

    // Identical call shape to the username case: the client never inspects the
    // identifier and never sends a discriminator.
    await waitFor(() => expect(loginUser).toHaveBeenCalledWith('ada@example.com', 'hunter2'))
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })

  it('trims the identifier but never the password', async () => {
    vi.mocked(loginUser).mockResolvedValue(PAYLOAD)
    renderPage()

    await signInWith('  ada  ', ' pw ')

    // Test 9: the §2.2 regression guard for the old `password.trim()`.
    await waitFor(() => expect(loginUser).toHaveBeenCalledWith('ada', ' pw '))
  })
})

// ---------------------------------------------------------------------------
// Test 3 — failure renders generic copy with no account-existence detail
// ---------------------------------------------------------------------------
describe('401 rendering', () => {
  it('renders generic copy and marks no field', async () => {
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_credentials', 'Invalid credentials', null),
    )
    const { container } = renderPage()

    await signInWith('ada', 'wrong')
    await waitFor(() => expect(screen.getByText(/invalid credentials/i)).toBeTruthy())

    const dom = container.innerHTML.toLowerCase()
    for (const leak of [
      'no such user',
      'user not found',
      'unknown user',
      "doesn't exist",
      'does not exist',
      'wrong password',
      'incorrect password',
      'no account',
    ]) {
      expect(dom).not.toContain(leak)
    }
    // A 401 carries field:null and the UI must not mark an input regardless.
    expect(identifierInput().getAttribute('aria-invalid')).toBeNull()
    expect(passwordInput().getAttribute('aria-invalid')).toBeNull()
  })

  it('renders messageForCode, never the server message verbatim', async () => {
    // If a backend regression ever leaked a specific string into `message`, the
    // UI must still render its own generic copy.
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_credentials', 'no such user: ada', null),
    )
    const { container } = renderPage()

    await signInWith('ada', 'wrong')
    await waitFor(() => expect(screen.getByText(/invalid credentials/i)).toBeTruthy())
    expect(container.innerHTML).not.toContain('no such user: ada')
  })
})

// ---------------------------------------------------------------------------
// Test 5 — the four §4.1 cases are indistinguishable in the DOM
// ---------------------------------------------------------------------------
describe('no account-existence oracle', () => {
  it('produces byte-identical DOM for two different 401s', async () => {
    // Same code (as the contract guarantees), different server messages — the
    // rendered DOM must not vary by even one byte.
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_credentials', 'Invalid credentials', null),
    )
    const first = renderPage()
    await signInWith('ada', 'wrong')
    await waitFor(() => expect(screen.getByText(/invalid credentials/i)).toBeTruthy())
    const unknownUserDom = first.container.innerHTML
    cleanup()

    // Not auth seeding: this clears the BANNER between two renders of the same
    // signed-out page, so that the second render's message is its own and not
    // the first's. No session is claimed. (AC-5.6 classification: bucket 4.)
    useAuthStore.setState({ error: null, errorCode: null, isLoading: false })
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_credentials', 'no such account anywhere', null),
    )
    const second = renderPage()
    await signInWith('ada', 'wrong')
    await waitFor(() => expect(screen.getByText(/invalid credentials/i)).toBeTruthy())
    const wrongPasswordDom = second.container.innerHTML

    expect(wrongPasswordDom).toBe(unknownUserDom)
  })
})

// ---------------------------------------------------------------------------
// Test 6 — 403 renders distinctly, and ONLY it
// ---------------------------------------------------------------------------
describe('403 email_not_verified is the one distinct branch', () => {
  // The notices differ by their background token: InfoNotice uses the muted
  // prio-normal purple, ErrorNotice the prio-urgent red. Reading the token off
  // the rendered node is what "rendered distinctly" means structurally.
  function noticeBackground(container: HTMLElement): string | undefined {
    const node = Array.from(container.querySelectorAll('div')).find((d) =>
      (d.getAttribute('style') ?? '').includes('border-radius: 8px'),
    )
    return node?.getAttribute('style') ?? undefined
  }

  it('renders the verification copy in the info style', async () => {
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('email_not_verified', 'Email not verified.', null),
    )
    const { container } = renderPage()

    await signInWith('ada', 'hunter2')
    await waitFor(() => expect(screen.getByText(/email not verified/i)).toBeTruthy())

    expect(useAuthStore.getState().errorCode).toBe('email_not_verified')
    expect(noticeBackground(container)).toContain('--prio-normal-bg')
    expect(noticeBackground(container)).not.toContain('--prio-urgent-bg')
  })

  it('renders a 401 in the error style — the other direction', async () => {
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_credentials', 'Invalid credentials', null),
    )
    const { container } = renderPage()

    await signInWith('ada', 'wrong')
    await waitFor(() => expect(screen.getByText(/invalid credentials/i)).toBeTruthy())

    expect(noticeBackground(container)).toContain('--prio-urgent-bg')
    expect(noticeBackground(container)).not.toContain('--prio-normal-bg')
  })

  it('renders a 400 in the error style too — only 403 is special', async () => {
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_request', 'Identifier and password are required.', 'identifier'),
    )
    const { container } = renderPage()

    await signInWith('ada', 'pw')
    await waitFor(() => expect(screen.getByText(/enter your username or email/i)).toBeTruthy())

    expect(noticeBackground(container)).toContain('--prio-urgent-bg')
  })

  it('renders a reserved 429 generically — no special-casing today (§7)', async () => {
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('rate_limited', 'Too many attempts. Try again later.', null),
    )
    const { container } = renderPage()

    await signInWith('ada', 'pw')
    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeTruthy())
    expect(noticeBackground(container)).toContain('--prio-urgent-bg')
  })
})

// ---------------------------------------------------------------------------
// Test 4 — empty-field validation only, no format branching
// ---------------------------------------------------------------------------
describe('validation is empty-only', () => {
  it('blocks an empty identifier without hitting the network', async () => {
    renderPage()
    fireEvent.change(passwordInput(), { target: { value: 'pw' } })
    submit()

    await waitFor(() => expect(screen.getByText(/enter your username or email/i)).toBeTruthy())
    expect(loginUser).not.toHaveBeenCalled()
  })

  it('blocks an empty password without hitting the network', async () => {
    renderPage()
    fireEvent.change(identifierInput(), { target: { value: 'ada' } })
    submit()

    await waitFor(() => expect(screen.getByText(/enter your username or email/i)).toBeTruthy())
    expect(loginUser).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only identifier as empty', async () => {
    renderPage()
    await signInWith('   ', 'pw')

    await waitFor(() => expect(screen.getByText(/enter your username or email/i)).toBeTruthy())
    expect(loginUser).not.toHaveBeenCalled()
  })

  it('accepts a whitespace-only PASSWORD — it is significant, not empty', async () => {
    vi.mocked(loginUser).mockResolvedValue(PAYLOAD)
    renderPage()
    await signInWith('ada', '   ')

    await waitFor(() => expect(loginUser).toHaveBeenCalledWith('ada', '   '))
  })

  it('submits a garbage identifier rather than pre-judging its format', async () => {
    // Ruling 4: "!!!" is not a client-side error. It goes to the server and
    // comes back 401 — a client-side format verdict would be a shape oracle.
    vi.mocked(loginUser).mockRejectedValue(
      new AuthContractError('invalid_credentials', 'Invalid credentials', null),
    )
    renderPage()
    await signInWith('!!!', 'pw')

    await waitFor(() => expect(loginUser).toHaveBeenCalledWith('!!!', 'pw'))
    expect(screen.queryByText(/valid username/i)).toBeNull()
    expect(screen.queryByText(/valid email/i)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test 7 — loading / disabled state
// ---------------------------------------------------------------------------
describe('loading state', () => {
  it('disables the button and shows the spinner in flight, then re-enables', async () => {
    let resolve!: (v: typeof PAYLOAD) => void
    vi.mocked(loginUser).mockReturnValue(new Promise((r) => { resolve = r }))
    renderPage()

    await signInWith('ada', 'pw')

    const button = screen.getByRole('button', { name: /signing in/i })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByText('Signing in...')).toBeTruthy()

    resolve(PAYLOAD)
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it('re-enables the button after a rejected submit', async () => {
    let reject!: (e: unknown) => void
    vi.mocked(loginUser).mockReturnValue(new Promise((_r, rj) => { reject = rj }))
    renderPage()

    await signInWith('ada', 'wrong')
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /signing in/i }) as HTMLButtonElement).disabled).toBe(true),
    )

    reject(new AuthContractError('invalid_credentials', 'Invalid credentials', null))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement).disabled).toBe(false),
    )
  })
})

// ---------------------------------------------------------------------------
// Test 8 — the guardrail, asserted structurally
// ---------------------------------------------------------------------------
describe('form structure', () => {
  it('has exactly one non-password text input, labelled "Username or email"', () => {
    const { container } = renderPage()
    const form = container.querySelector('form')!

    const textInputs = Array.from(form.querySelectorAll('input')).filter(
      (i) => i.type !== 'password',
    )
    expect(textInputs).toHaveLength(1)
    expect(textInputs[0].id).toBe('identifier')
    expect(screen.getByLabelText('Username or email')).toBe(textInputs[0])
    expect(form.querySelectorAll('input[type="password"]')).toHaveLength(1)
  })

  it('has no toggle, radio, checkbox or select that could pick an identifier kind', () => {
    const { container } = renderPage()
    const form = container.querySelector('form')!

    expect(form.querySelectorAll('select')).toHaveLength(0)
    expect(form.querySelectorAll('input[type="radio"]')).toHaveLength(0)
    expect(form.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    // No lingering "Username"-only labelling that would contradict the field.
    expect(screen.queryByLabelText('Username')).toBeNull()
  })

  it('has exactly one submit button', () => {
    const { container } = renderPage()
    const form = container.querySelector('form')!
    expect(form.querySelectorAll('button[type="submit"]')).toHaveLength(1)
  })
})
