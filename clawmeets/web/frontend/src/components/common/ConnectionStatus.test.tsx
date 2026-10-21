import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import ConnectionStatus, { SERVER_RETRYING_TEXT, SOCKET_RECONNECTING_TEXT } from './ConnectionStatus'
import { get } from '../../api/client'
import { wsManager } from '../../api/websocket'

/**
 * The banner says "reconnecting to the server" for exactly as long as a request
 * is waiting out a restart, and falls back to the socket message otherwise.
 */
const gatewayPage = () => new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
const ok = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

let connected = true
let release!: () => void

beforeEach(() => {
  connected = true
  vi.spyOn(wsManager, 'isConnected').mockImplementation(() => connected)
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(() => Promise.resolve(gatewayPage()))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => (release = () => resolve(ok()))))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ConnectionStatus', () => {
  it('shows nothing when the socket is up and no request is retrying', () => {
    const { container } = render(<ConnectionStatus />)
    expect(container.textContent).toBe('')
  })

  it('says the server is reconnecting while a request waits, then clears', async () => {
    render(<ConnectionStatus />)
    const pending = get('/projects')
    expect(await screen.findByText(SERVER_RETRYING_TEXT)).toBeTruthy()
    await act(async () => {
      release()
      await pending
    })
    expect(screen.queryByText(SERVER_RETRYING_TEXT)).toBeNull()
  })

  it('falls back to the socket message when only the socket is down', () => {
    connected = false
    render(<ConnectionStatus />)
    expect(screen.getByText(SOCKET_RECONNECTING_TEXT)).toBeTruthy()
  })
})
