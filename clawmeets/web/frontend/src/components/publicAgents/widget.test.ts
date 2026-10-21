import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/dom'

// The embeddable widget is plain JavaScript served by the server
// (clawmeets/server/channels/webchat_widget.js); load the real file.
const SRC = readFileSync(
  resolve(__dirname, '../../../../../server/channels/webchat_widget.js'), 'utf8',
)
const BASE = 'https://cm.example'

const profile = (handle: string, over: Record<string, unknown> = {}) => ({
  display_name: handle[0].toUpperCase() + handle.slice(1), handle, description: `${handle} help`,
  online: true, takes_direct_requests: true, starter_questions: [],
  account: { handle: 'olivia', display_name: 'Olivia', url: `${BASE}/users/olivia/agents/` },
  request_taker: null, ...over,
})

let failSend = false
const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
  const url = new URL(input)
  const key = url.searchParams.get('key') || JSON.parse(String(init?.body || '{}')).key
  const handle = String(key).replace('cmw_', '')
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  if (url.pathname.endsWith('/profile')) return ok({ profile: profile(handle), max_chars: 4000 })
  if (url.pathname.endsWith('/session')) {
    return ok({ visitor: 'v_aaaaaaaaaaaaaaaaaaaa', token: 't', profile: profile(handle), max_chars: 4000 })
  }
  if (init?.method === 'POST') {
    return failSend ? new Response('{}', { status: 500 }) : ok({ ok: true })
  }
  return ok({ messages: [] })
})

interface Api {
  open: (k: string) => void
  minimize: (k: string) => void
  close: (k: string) => void
  add: (k: string) => void
  list: () => { key: string; state: string; name: string }[]
  __markdown: (t: string) => DocumentFragment
  __manager: { chats: Record<string, { receive: (m: unknown) => void; stop: () => void }> }
}
const api = () => (window as unknown as { ClawMeetsChat: Api }).ClawMeetsChat

function boot(attrs: Record<string, string>) {
  const s = document.createElement('script')
  s.setAttribute('src', `${BASE}/api/channels/widget.js`)
  s.setAttribute('data-test-open-shadow', '')
  Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v))
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => s })
  ;(0, eval)(SRC)
  delete (document as unknown as { currentScript?: unknown }).currentScript
  return document.querySelector('[data-clawmeets-webchat]')!.shadowRoot!
}

beforeEach(() => {
  failSend = false
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  const m = api()?.__manager
  if (m) Object.values(m.chats).forEach((c) => c.stop())
  delete (window as unknown as { ClawMeetsChat?: unknown }).ClawMeetsChat
  document.querySelectorAll('[data-clawmeets-webchat]').forEach((el) => el.remove())
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('markdown', () => {
  it('renders formatting as nodes and never HTML or unsafe links', () => {
    boot({ 'data-mode': 'dock' })
    const div = document.createElement('div')
    div.appendChild(api().__markdown(
      '**Hi** <img src=x onerror=alert(1)>\n\n- one `code`\n- [ok](https://a.example) [bad](javascript:alert(1))',
    ))
    expect(div.querySelector('strong')!.textContent).toBe('Hi')
    expect(div.querySelector('img')).toBeNull()
    expect(div.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(div.querySelectorAll('li')).toHaveLength(2)
    expect(div.querySelector('code')!.textContent).toBe('code')
    const links = Array.from(div.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(links).toEqual(['https://a.example'])
    expect(div.querySelector('a')!.getAttribute('target')).toBe('_blank')
  })
})

describe('dock', () => {
  it('shows one chat head per key, sharing one dock', async () => {
    const root = boot({ 'data-keys': 'cmw_alpha, cmw_beta' })
    await waitFor(() => expect(root.querySelector('[aria-label="Alpha"]')).toBeTruthy())
    expect(root.querySelector('[aria-label="Beta"]')).toBeTruthy()
    expect(root.querySelector('[aria-label="Start a chat"]')).toBeTruthy()
    expect(document.querySelectorAll('[data-clawmeets-webchat]')).toHaveLength(1)
  })

  it('opens windows side by side up to the limit, minimising the oldest', async () => {
    const root = boot({ 'data-mode': 'dock' })
    ;['cmw_a1', 'cmw_a2', 'cmw_a3'].forEach((k) => api().add(k))
    ;['cmw_a1', 'cmw_a2', 'cmw_a3'].forEach((k) => api().open(k))
    // jsdom is 1024px wide: room for two windows.
    expect(root.querySelectorAll('.wins > .chat')).toHaveLength(2)
    const states = Object.fromEntries(api().list().map((c) => [c.key, c.state]))
    expect(states).toEqual({ cmw_a1: 'min', cmw_a2: 'open', cmw_a3: 'open' })

    api().minimize('cmw_a3')
    api().close('cmw_a2')
    expect(root.querySelectorAll('.wins > .chat')).toHaveLength(0)
    const after = Object.fromEntries(api().list().map((c) => [c.key, c.state]))
    expect(after).toEqual({ cmw_a1: 'min', cmw_a2: 'listed', cmw_a3: 'min' })
  })

  it('counts unread replies on a minimised head', async () => {
    const root = boot({ 'data-key': 'cmw_alpha' })
    await waitFor(() => expect(root.querySelector('[aria-label="Alpha"]')).toBeTruthy())
    api().__manager.chats.cmw_alpha.receive({ seq: 1, text: 'hello', at: 1 })
    expect(root.querySelector('.hw .un')!.textContent).toBe('1')
    api().open('cmw_alpha')
    expect(root.querySelector('.hw .un')).toBeNull()
    expect(root.querySelector('.md')!.textContent).toContain('hello')
  })

  it('keeps the visitor message and says so when a send fails', async () => {
    failSend = true
    const root = boot({ 'data-key': 'cmw_alpha', 'data-open': '' })
    const ta = await waitFor(() => {
      const el = root.querySelector('textarea')
      expect(el).toBeTruthy()
      return el as HTMLTextAreaElement
    })
    fireEvent.input(ta, { target: { value: 'hi **there**' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() => expect(root.textContent).toContain('couldn’t reply just now'))
    expect(root.querySelector('.me')!.textContent).toBe('hi **there**')
  })
})

describe('fullpage', () => {
  it('fills the page with one chat and its intro', async () => {
    const root = boot({ 'data-key': 'cmw_alpha', 'data-mode': 'fullpage' })
    await waitFor(() => expect(root.querySelector('.intro h1')!.textContent).toBe('Alpha'))
    expect(root.querySelector('.full .chat')).toBeTruthy()
    expect(root.querySelector('.heads')).toBeNull()
    expect(root.querySelectorAll('.starters button').length).toBe(3)
    expect(document.title).toBe('Alpha · Olivia')
  })
})
