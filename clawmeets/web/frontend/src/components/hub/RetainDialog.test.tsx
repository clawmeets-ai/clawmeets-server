import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ApiError } from '../../api/client'
import { RETAIN_COPY } from '../../utils/agentAccessCopy'
import { HUB_COPY } from '../../utils/hubThread'
import RetainDialog, { retainErrorText } from './RetainDialog'

afterEach(cleanup)

const LABEL = 'scout@acme.dev'
function renderDialog(o: Partial<Parameters<typeof RetainDialog>[0]> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <RetainDialog agentLabel={LABEL} open busy={false} error={null} onConfirm={onConfirm} onCancel={onCancel} {...o} />,
  )
  return { onConfirm, onCancel }
}

describe('the retain dialog', () => {
  it('says the three statements, in order', () => {
    renderDialog()
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual([RETAIN_COPY.allows(LABEL), RETAIN_COPY.outside(LABEL), RETAIN_COPY.fullPowers])
    expect(items[1]).toMatch(/outside content/)
    expect(items[2]).toMatch(/full powers/)
    expect(screen.queryByTestId('retain-identity')).toBeNull()
  })

  it('Esc and Cancel cancel; Retain confirms', () => {
    const { onConfirm, onCancel } = renderDialog()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Retain' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab inside the dialog', () => {
    renderDialog()
    const confirm = screen.getByRole('button', { name: 'Retain' })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('busy: no cancel by Esc, "Retaining…"', () => {
    const { onCancel } = renderDialog({ busy: true })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Retaining…' })).toBeTruthy()
  })

  it('renders the error, and the identity line for Retain again', () => {
    renderDialog({ error: 'nope', identityChanged: true })
    expect(screen.getByRole('alert').textContent).toBe('nope')
    expect(screen.getByTestId('retain-identity').textContent).toBe(RETAIN_COPY.identityChanged(LABEL))
  })

  it('error text: access codes, hub-state codes, then a generic line', () => {
    const e = (code: string) => new ApiError(409, code, { detail: { code, message: '' } })
    expect(retainErrorText(e('own_agent'))).toMatch(/is yours/)
    expect(retainErrorText(e('user_only'))).toMatch(/from your browser/)
    expect(retainErrorText(e('hub_untrusted'))).toBe(HUB_COPY.untrusted)
    expect(retainErrorText(new Error('net'))).toBe(RETAIN_COPY.failed)
  })
})
