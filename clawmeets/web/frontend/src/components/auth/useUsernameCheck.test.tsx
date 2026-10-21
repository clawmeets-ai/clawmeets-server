import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'
import { useUsernameCheck } from './useUsernameCheck'
import { checkUsername } from '../../api/endpoints/auth'

vi.mock('../../api/endpoints/auth', () => ({ checkUsername: vi.fn() }))

const mockCheck = vi.mocked(checkUsername)
// followup B11. `vitest.config.ts` sets `globals: false`, so testing-library's
// auto-cleanup never registers: a render left standing here stays MOUNTED, and
// mounted means still subscribed to every store it reads and still holding
// every timer its effects started. The next file's fixture then re-renders it
// and re-fires those effects, in a file that has no idea this component exists.
// Audited suite-wide in M5; asserted by `src/test/suiteHygiene.test.ts`.
afterEach(cleanup)

describe('useUsernameCheck', () => {
  beforeEach(() => {
    mockCheck.mockReset()
  })

  it('is idle for empty input and never calls the API', async () => {
    const { result } = renderHook(() => useUsernameCheck())
    expect(result.current.status).toBe('idle')
    expect(mockCheck).not.toHaveBeenCalled()
  })

  it('rejects hyphens and short names locally without hitting the API', async () => {
    const { result } = renderHook(() => useUsernameCheck())

    act(() => result.current.setValue('ada-lovelace'))
    await waitFor(() => expect(result.current.status).toBe('bad'))
    expect(result.current.msg).toMatch(/underscores/i)

    act(() => result.current.setValue('abc'))
    await waitFor(() => expect(result.current.msg).toMatch(/at least 5/i))

    expect(mockCheck).not.toHaveBeenCalled()
  })

  it('reports available for a free, valid slug', async () => {
    mockCheck.mockResolvedValue({ available: true, reason: null })
    const { result } = renderHook(() => useUsernameCheck())

    act(() => result.current.setValue('gracehopper'))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.clean).toBe('gracehopper')
    expect(mockCheck).toHaveBeenCalledWith('gracehopper')
  })

  it('surfaces the server reason when a slug is taken', async () => {
    mockCheck.mockResolvedValue({ available: false, reason: '@gracehopper is taken.' })
    const { result } = renderHook(() => useUsernameCheck())

    act(() => result.current.setValue('gracehopper'))
    await waitFor(() => expect(result.current.status).toBe('bad'))
    expect(result.current.msg).toMatch(/taken/i)
  })

  it('normalizes to lowercase (clean) for the API + link preview', async () => {
    mockCheck.mockResolvedValue({ available: true, reason: null })
    const { result } = renderHook(() => useUsernameCheck())

    act(() => result.current.setValue('GraceHopper'))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(mockCheck).toHaveBeenCalledWith('gracehopper')
  })
})
