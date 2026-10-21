import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileHref, linkOrText } from './lib'

/**
 * `fileHref` exists because a report / brief payload freezes its `sources[].href`
 * at publish time, while every live API call picks `/api` (Vite dev proxy) or ''
 * (production) at runtime in `api/client.ts`. A frozen string can't do that, so
 * the renderer re-derives the prefix. These tests pin both environments AND the
 * paths that must NOT be touched -- over-matching would rewrite SPA routes into
 * dead links, which is the same bug in the other direction.
 */

const FILE_PATH = '/projects/abc-123/chatrooms/user-communication/files/report.md'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('fileHref', () => {
  it('strips a baked-in /api prefix in production', () => {
    vi.stubEnv('DEV', false)
    expect(fileHref('/api' + FILE_PATH)).toBe(FILE_PATH)
  })

  it('leaves a prefix-less file path alone in production', () => {
    vi.stubEnv('DEV', false)
    expect(fileHref(FILE_PATH)).toBe(FILE_PATH)
  })

  it('adds the dev-proxy prefix in dev, whether or not one was baked in', () => {
    vi.stubEnv('DEV', true)
    expect(fileHref(FILE_PATH)).toBe('/api' + FILE_PATH)
    expect(fileHref('/api' + FILE_PATH)).toBe('/api' + FILE_PATH)
  })

  it('covers the user-files upload route too', () => {
    vi.stubEnv('DEV', false)
    const userFile = '/api/projects/abc-123/chatrooms/design/user-files/logo.png'
    expect(fileHref(userFile)).toBe(
      '/projects/abc-123/chatrooms/design/user-files/logo.png',
    )
  })

  it('leaves SPA chatroom routes untouched -- they have no /files/ segment', () => {
    vi.stubEnv('DEV', false)
    const spaRoute = '/projects/abc-123/chatrooms/user-communication'
    expect(fileHref(spaRoute)).toBe(spaRoute)
  })

  it('leaves external and non-file URLs untouched', () => {
    vi.stubEnv('DEV', false)
    expect(fileHref('https://example.com/api/projects/x/chatrooms/y/files/z.md')).toBe(
      'https://example.com/api/projects/x/chatrooms/y/files/z.md',
    )
    expect(fileHref('/agents/abc-123')).toBe('/agents/abc-123')
  })
})

describe('linkOrText', () => {
  it('normalizes the href it renders', () => {
    vi.stubEnv('DEV', false)
    expect(linkOrText('/api' + FILE_PATH, 'the report')).toContain(
      'href="' + FILE_PATH + '"',
    )
  })

  it('still falls back to plain text without an href', () => {
    expect(linkOrText(null, 'no link')).toBe('no link')
  })
})
