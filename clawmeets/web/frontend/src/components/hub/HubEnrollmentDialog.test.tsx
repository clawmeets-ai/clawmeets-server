import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import type { HubEnrollment } from '../../api/endpoints/hub'
import { hubEnrollment } from '../../test/hubFixtures'
import HubEnrollmentDialog, { ENROLL_COPY } from './HubEnrollmentDialog'

/**
 * The enrollment dialog: terms -> code -> done, the skip for a verified owner,
 * the Close-only refusals, and one sentence per error code. The API is mocked
 * at the hub endpoint module.
 */

const api = vi.hoisted(() => ({
  getHubEnrollment: vi.fn(),
  startHubEnrollment: vi.fn(),
  confirmHubEnrollment: vi.fn(),
}))
vi.mock('../../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../../api/endpoints/hub')>()
  return {
    ...real,
    getHubEnrollment: (...a: unknown[]) => api.getHubEnrollment(...a),
    startHubEnrollment: (...a: unknown[]) => api.startHubEnrollment(...a),
    confirmHubEnrollment: (...a: unknown[]) => api.confirmHubEnrollment(...a),
  }
})

const hubErr = (status: number, code: string) => new ApiError(status, code, { detail: { code, message: 'raw' } })

function renderDialog(en: Partial<HubEnrollment> = {}) {
  api.getHubEnrollment.mockResolvedValue(hubEnrollment(en))
  const onDone = vi.fn()
  const onClose = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <HubEnrollmentDialog onDone={onDone} onClose={onClose} />
    </QueryClientProvider>,
  )
  return { onDone, onClose }
}

async function acceptTerms() {
  fireEvent.click(await screen.findByRole('checkbox', { name: ENROLL_COPY.termsLabel }))
  fireEvent.click(screen.getByRole('button', { name: ENROLL_COPY.sendCode }))
}

async function enterCode(code: string) {
  fireEvent.change(await screen.findByLabelText(ENROLL_COPY.codeLabel), { target: { value: code } })
  fireEvent.click(screen.getByRole('button', { name: ENROLL_COPY.confirm }))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('HubEnrollmentDialog', () => {
  it('happy path: terms, then the code, then onDone', async () => {
    const { onDone } = renderDialog({ server: 'none', becomes_contact: true })
    api.startHubEnrollment.mockResolvedValue(hubEnrollment({ server: 'pending', owner: 'code_sent', code_expires_at: 1 }))
    api.confirmHubEnrollment.mockResolvedValue(hubEnrollment({ server: 'active', owner: 'verified' }))

    expect(await screen.findByTestId('enroll-contact')).toBeTruthy()
    const link = screen.getByRole('link', { name: ENROLL_COPY.terms })
    expect(link.getAttribute('href')).toBe('https://hub.clawmeets.ai/terms')
    expect(screen.getByText(/version 2026-10/)).toBeTruthy()
    // Send stays off until the terms are accepted.
    expect((screen.getByRole('button', { name: ENROLL_COPY.sendCode }) as HTMLButtonElement).disabled).toBe(true)

    await acceptTerms()
    await waitFor(() => expect(api.startHubEnrollment).toHaveBeenCalledWith('2026-10'))
    expect(await screen.findByText('We sent a code to c***@example.com.')).toBeTruthy()

    await enterCode(' 123456 ')
    await waitFor(() => expect(api.confirmHubEnrollment).toHaveBeenCalledWith('123456'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('no contact line when the server is already on the hub', async () => {
    renderDialog({ server: 'active', becomes_contact: false })
    await screen.findByRole('checkbox')
    expect(screen.queryByTestId('enroll-contact')).toBeNull()
  })

  it('an owner already verified skips the dialog entirely', async () => {
    const { onDone } = renderDialog({ server: 'active', owner: 'verified' })
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.startHubEnrollment).not.toHaveBeenCalled()
  })

  it('a code already sent opens on the code step; resend posts the enrollment again', async () => {
    renderDialog({ server: 'pending', owner: 'code_sent' })
    api.startHubEnrollment.mockResolvedValue(hubEnrollment({ server: 'pending', owner: 'code_sent' }))
    fireEvent.click(await screen.findByRole('button', { name: ENROLL_COPY.resend }))
    await waitFor(() => expect(api.startHubEnrollment).toHaveBeenCalledWith('2026-10'))
    expect(await screen.findByText(ENROLL_COPY.resent)).toBeTruthy()
  })

  it.each([
    ['operator_only', "Only this server's operator can connect it to the hub."],
    ['off', 'The hub is turned off on this server.'],
  ] as const)('server %s: the reason and only a Close button', async (server, text) => {
    const { onClose } = renderDialog({ server })
    expect((await screen.findByTestId('enroll-blocked')).textContent).toBe(text)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([ENROLL_COPY.close])
    fireEvent.click(screen.getByRole('button', { name: ENROLL_COPY.close }))
    expect(onClose).toHaveBeenCalled()
  })

  it('enroll_busy on send: one plain sentence, never the raw message', async () => {
    renderDialog()
    api.startHubEnrollment.mockRejectedValue(hubErr(409, 'enroll_busy'))
    await acceptTerms()
    expect((await screen.findByRole('alert')).textContent)
      .toBe('Someone else on this server is finishing the hub setup. Try again in a minute.')
    expect(screen.queryByText('raw')).toBeNull()
  })

  it('enroll_code_invalid on confirm: stays on the code step with the sentence', async () => {
    const { onDone } = renderDialog({ owner: 'code_sent' })
    api.confirmHubEnrollment.mockRejectedValue(hubErr(400, 'enroll_code_invalid'))
    await enterCode('000000')
    expect((await screen.findByRole('alert')).textContent).toBe("That code isn't right.")
    expect(screen.getByLabelText(ENROLL_COPY.codeLabel)).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  it.each([
    ['enroll_code_expired', 'That code expired. Send a new one.'],
    ['owner_banned', "This email address can't list agents on the hub."],
    ['hub_untrusted', "The ClawMeets Hub isn't available yet."],
    ['enroll_email_unverified', 'Verify your ClawMeets email address first.'],
  ])('%s reads as one sentence', async (code, text) => {
    renderDialog({ owner: 'code_sent' })
    api.confirmHubEnrollment.mockRejectedValue(hubErr(400, code))
    await enterCode('111111')
    expect((await screen.findByRole('alert')).textContent).toBe(text)
  })
})
