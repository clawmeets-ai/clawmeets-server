import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { useMessageDeepLink } from './useMessageDeepLink'

/**
 * `?msg=` is read and stripped identically on BOTH deep-link shapes the
 * contract emits (§4.2) — the DM route and the project-room route. They are
 * different routes with different params, so "it works in the one I tested" is
 * not evidence for the other.
 */

let clear: () => void

function Probe() {
  const { targetMessageId, clearTarget } = useMessageDeepLink()
  clear = clearTarget
  const { pathname, search } = useLocation()
  return (
    <>
      <span data-testid="target">{targetMessageId ?? 'none'}</span>
      <span data-testid="url">{pathname + search}</span>
    </>
  )
}

function at(path: string, route: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  )
}

const target = () => screen.getByTestId('target').textContent
const url = () => screen.getByTestId('url').textContent

describe('useMessageDeepLink', () => {
  afterEach(cleanup)

  it('reads and strips ?msg= on the project-room route', () => {
    at('/projects/p1/chatrooms/shared-context?msg=m1', 'projects/:projectId/chatrooms/:chatroomName')
    expect(target()).toBe('m1')
    act(() => clear())
    expect(target()).toBe('none')
    expect(url()).toBe('/projects/p1/chatrooms/shared-context')
  })

  it('reads and strips ?msg= on the DM route', () => {
    at('/dm/chengtao-assistant/e9451c3f?msg=b31d0e55', 'dm/:agentName/:threadId')
    expect(target()).toBe('b31d0e55')
    act(() => clear())
    expect(target()).toBe('none')
    expect(url()).toBe('/dm/chengtao-assistant/e9451c3f')
  })

  it('leaves other params alone when stripping — ?draft= must survive', () => {
    at('/dm/a/t1?draft=hello&msg=m9', 'dm/:agentName/:threadId')
    expect(target()).toBe('m9')
    act(() => clear())
    expect(url()).toBe('/dm/a/t1?draft=hello')
  })

  it('reports no target when the param is absent', () => {
    at('/projects/p1/chatrooms/shared-context', 'projects/:projectId/chatrooms/:chatroomName')
    expect(target()).toBe('none')
  })
})
