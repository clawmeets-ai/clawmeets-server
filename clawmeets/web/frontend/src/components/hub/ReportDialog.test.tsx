import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import { wasReportedThisSession } from '../../hooks/useHub'
import ReportDialog, { REPORT_NOTE_MAX } from './ReportDialog'

/** Report: the body sent, 202, 429 and 503 (the note is kept), and the
 *  session-scoped "Reported" memory. */

const reportHubAgent = vi.hoisted(() => vi.fn())
vi.mock('../../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../../api/endpoints/hub')>()
  return { ...real, reportHubAgent: (...a: unknown[]) => reportHubAgent(...a) }
})

const hubErr = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, code, { detail: { code, message: '', ...extra } })

function renderDialog(id = 'abc~scout') {
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <ReportDialog hubAgentId={id} display="scout@acme.dev" onClose={onClose} />
    </QueryClientProvider>,
  )
  return { onClose }
}

const note = () => screen.getByRole('textbox') as HTMLTextAreaElement
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Report' }))

afterEach(() => {
  cleanup()
  reportHubAgent.mockReset()
})

describe('ReportDialog', () => {
  it('shows the title, the four reasons, the 500-character note and what the report carries', () => {
    renderDialog()
    expect(screen.getByRole('dialog').textContent).toContain('Report scout@acme.dev')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Pretends to be someone else', 'Spam', 'Harmful content', 'Other',
    ])
    expect(note().maxLength).toBe(REPORT_NOTE_MAX)
    expect(screen.getByText(/It does not include your conversation\./)).toBeTruthy()
    expect(document.activeElement?.tagName).toBe('SELECT')
  })

  it('sends {reason, note}; 202 says "Reported. Thanks" and the agent reads reported for the session', async () => {
    reportHubAgent.mockResolvedValue(undefined)
    renderDialog('id-202')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'spam' } })
    fireEvent.change(note(), { target: { value: '  sends ads  ' } })
    submit()
    await screen.findByText("Reported. Thanks — the hub's operator will review it.")
    expect(reportHubAgent).toHaveBeenCalledWith('id-202', { reason: 'spam', note: 'sends ads' })
    expect(wasReportedThisSession('id-202')).toBe(true)
  })

  it('an empty note is left out of the body', async () => {
    reportHubAgent.mockResolvedValue(undefined)
    renderDialog('id-nonote')
    submit()
    await waitFor(() => expect(reportHubAgent).toHaveBeenCalledWith('id-nonote', { reason: 'impersonation', note: undefined }))
  })

  it('429: "Try again in N min", the dialog stays open and the note is kept', async () => {
    reportHubAgent.mockRejectedValue(hubErr(429, 'rate_limited', { retry_after: 125 }))
    renderDialog('id-429')
    fireEvent.change(note(), { target: { value: 'my note' } })
    submit()
    expect((await screen.findByTestId('report-error')).textContent).toBe("You've sent a lot of reports. Try again in 3 min.")
    expect(note().value).toBe('my note')
    expect(wasReportedThisSession('id-429')).toBe(false)
  })

  it('503 hub_unreachable: the sentence, and the note is kept', async () => {
    reportHubAgent.mockRejectedValue(hubErr(503, 'hub_unreachable'))
    renderDialog('id-503')
    fireEvent.change(note(), { target: { value: 'keep me' } })
    submit()
    expect((await screen.findByTestId('report-error')).textContent).toBe(
      "Couldn't send the report because the hub is unreachable. Try again later.",
    )
    expect(note().value).toBe('keep me')
  })

  it('Cancel and Escape close without sending', () => {
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(reportHubAgent).not.toHaveBeenCalled()
  })
})
