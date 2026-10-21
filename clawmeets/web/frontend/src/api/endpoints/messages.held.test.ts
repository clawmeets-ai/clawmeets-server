import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendUserMessage } from './messages'
import { sendDMMessage } from './dm'
import { isHeldForReview } from './hub'

/** A 202 HeldForReview is a stored post, not an error: the send resolves to
 *  it once, with no retry, and a 200 still resolves to the ChatMessage. */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const HELD = { held: true, reason: 'flow_stopped', message: 'Held until the owner reopens the room.' }

describe('the held answer', () => {
  it('sendUserMessage resolves to HeldForReview on a 202, in one request', async () => {
    fetchMock.mockResolvedValueOnce(json(202, HELD))
    const r = await sendUserMessage('p1', 'user-communication', { content: 'hi' })
    expect(isHeldForReview(r)).toBe(true)
    expect(r).toEqual(HELD)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sendUserMessage resolves to the ChatMessage on a 200', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: 'm1', content: 'hi' }))
    const r = await sendUserMessage('p1', 'user-communication', { content: 'hi' })
    expect(isHeldForReview(r)).toBe(false)
    expect(r).toMatchObject({ id: 'm1' })
  })

  it('sendDMMessage resolves to HeldForReview on a 202', async () => {
    fetchMock.mockResolvedValueOnce(json(202, { ...HELD, reason: 'inspector_error' }))
    const r = await sendDMMessage('p1', 'user-communication', 'hi')
    expect(isHeldForReview(r) && r.reason).toBe('inspector_error')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
