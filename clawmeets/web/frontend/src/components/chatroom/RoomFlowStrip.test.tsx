import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ApiError } from '../../api/client'
import { NOW_S, roomFlow } from '../../test/hubFixtures'
import { formatHubTime } from '../../utils/hubDisplay'
import { FLOW_COPY } from '../../utils/agentAccessCopy'
import RoomFlowStrip from './RoomFlowStrip'
import { flowErrorText } from './RoomFlowControl'

afterEach(cleanup)
const text = () => screen.getByTestId('room-flow-strip-text').textContent

describe('the stopped strip', () => {
  it('by you, by the monitor, N held, and N = 0', () => {
    render(<RoomFlowStrip flow={roomFlow({ inbound_flow: 'stopped', stopped_by: 'owner', held_count: 4 })} viewerIsOwner />)
    expect(text()).toBe('Outside messages are stopped (by you) · 4 held')
    cleanup()
    render(<RoomFlowStrip flow={roomFlow({ inbound_flow: 'stopped', stopped_by: 'inspector', held_count: 0 })} viewerIsOwner />)
    expect(text()).toBe('Outside messages are stopped (by the monitor)')
  })

  it('the time and the reason, as text', () => {
    render(
      <RoomFlowStrip
        flow={roomFlow({ inbound_flow: 'stopped', stopped_by: 'inspector', stopped_at: NOW_S, reason: '<b>spam burst</b>' })}
        viewerIsOwner
      />,
    )
    expect(screen.getByTestId('room-flow-strip').textContent).toContain(`since ${formatHubTime(NOW_S)}`)
    expect(screen.getByTestId('room-flow-reason').textContent).toBe('— <b>spam burst</b>')
    expect(screen.getByTestId('room-flow-strip').querySelector('b')).toBeNull()
  })

  it('nothing while open or unknown', () => {
    const { container } = render(<RoomFlowStrip flow={roomFlow()} viewerIsOwner />)
    expect(container.textContent).toBe('')
    cleanup()
    const r = render(<RoomFlowStrip flow={undefined} viewerIsOwner />)
    expect(r.container.textContent).toBe('')
  })

  it('the control\'s error line: 503 unavailable, user_only, anything else', () => {
    expect(flowErrorText(new ApiError(503, 'x'))).toBe(FLOW_COPY.unavailable)
    expect(flowErrorText(new ApiError(403, 'x', { detail: { code: 'user_only', message: '' } }))).toMatch(/from your browser/)
    expect(flowErrorText(new ApiError(404, 'x'))).toBe(FLOW_COPY.failed)
  })
})
