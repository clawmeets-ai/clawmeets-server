import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { OutboxItem } from '../../api/endpoints/channels'
import DeliveryStatusLine from './DeliveryStatusLine'

/** The provider's own words for a refused reply, after the line, as text. */

afterEach(cleanup)

function failed(detail: string | null): OutboxItem {
  return { message_id: 'm1', part_index: 0, state: 'failed', reason: 'sender_not_authorized', attempts: 1, detail }
}

describe('DeliveryStatusLine', () => {
  it("shows the provider's words after a not-delivered line", () => {
    render(<DeliveryStatusLine rows={[failed('The from address does not match a verified Sender Identity.')]} channel="email" connectionEnabled />)
    expect(screen.getByTestId('delivery-line').textContent).toBe(
      'Not delivered — SendGrid said: "The from address does not match a verified Sender Identity."',
    )
  })

  it('renders the words as text, never markup', () => {
    render(<DeliveryStatusLine rows={[failed('<img src=x onerror=alert(1)>')]} channel="whatsapp" connectionEnabled />)
    expect(screen.getByTestId('delivery-provider-said').textContent).toBe(' — Meta said: "<img src=x onerror=alert(1)>"')
    expect(document.querySelector('img')).toBeNull()
  })

  it('says nothing more when the provider said nothing', () => {
    render(<DeliveryStatusLine rows={[failed(null)]} channel="telegram" connectionEnabled />)
    expect(screen.getByTestId('delivery-line').textContent).toBe('Not delivered')
    expect(screen.queryByTestId('delivery-provider-said')).toBeNull()
  })
})
