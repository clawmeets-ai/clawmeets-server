import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { bridgeDelivery } from '../../test/hubFixtures'
import BridgeDeliveryLine from './BridgeDeliveryLine'

afterEach(cleanup)
const ID = bridgeDelivery().hub_agent_id
const names = new Map([[ID, 'scout@acme.dev']])
const line = (state: string, reason: string | null = null) => {
  cleanup()
  render(<BridgeDeliveryLine standInIds={[ID]} deliveries={[bridgeDelivery({ state, reason })]} names={names} />)
  return screen.getByTestId('bridge-delivery-line').textContent
}

describe('the delivery line under a message to a retained agent', () => {
  it('every state', () => {
    expect(line('queued')).toBe('Queued for scout@acme.dev')
    expect(line('relayed')).toBe("Sent to scout@acme.dev's server")
    expect(line('delivered')).toBe('Delivered to scout@acme.dev')
    expect(line('answered')).toBe('scout@acme.dev replied')
    expect(line('failed')).toBe('Not relayed to scout@acme.dev: it could not be relayed')
    expect(line('cancelled')).toBe('Not sent to scout@acme.dev')
    expect(line('who_knows')).toBe('scout@acme.dev: status unknown')
  })

  it('every reason, and an unknown one', () => {
    expect(line('failed', 'held')).toBe('Not relayed to scout@acme.dev: held for review')
    expect(line('failed', 'blocked')).toBe('Not relayed to scout@acme.dev: blocked by the monitor')
    expect(line('cancelled', 'flow_stopped')).toBe('Not sent to scout@acme.dev: outside messages are stopped here')
    expect(line('failed', 'toString')).toBe('Not relayed to scout@acme.dev: it could not be relayed')
  })

  it('a stand-in with no row yet reads Queued; none addressed renders nothing', () => {
    render(<BridgeDeliveryLine standInIds={[ID]} deliveries={[]} names={names} />)
    expect(screen.getByTestId('bridge-delivery-line').textContent).toBe('Queued for scout@acme.dev')
    cleanup()
    const { container } = render(<BridgeDeliveryLine standInIds={[]} deliveries={[]} names={names} />)
    expect(container.textContent).toBe('')
  })
})
