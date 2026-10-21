import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import type { HubAgentDetail, HubConfig, HubTarget } from '../../api/endpoints/hub'
import type { ChatMessage } from '../../types'
import {
  FP_ACME, FP_OTHER, NOW_S, delivery, hubAgent, hubAgentDetail, hubConfig, hubProject, hubTarget,
} from '../../test/hubFixtures'
import { makeSession, seedSessions } from '../../test/authFixtures'
import { formatHubDate, hubThreadPath } from '../../utils/hubDisplay'
import HubChatView, { HUB_CHAT_COPY } from './HubChatView'

/**
 * The hub thread view (/hub/:hubAgentId[/:threadId]): the disclosure, remote
 * bodies through untrusted Markdown only, every closed reason, the unlisted
 * states, the offline confirm, the four pinned error details, the budget
 * exemption of start and send, local_agent, history with the hub off, and the
 * two routes.
 */

// This suite's DOM matchers (the project does not load jest-dom).
interface DomMatchers<R = unknown> {
  toHaveTextContent(want: string | RegExp): R
  toBeInTheDocument(): R
  toHaveFocus(): R
  toHaveValue(want: string): R
}
declare module 'vitest' {
  interface Assertion<T = any> extends DomMatchers<T> {}
}
const textOf = (el: unknown) => ((el as Element | null)?.textContent ?? '').replace(/\s+/g, ' ')
expect.extend({
  toHaveTextContent(el: unknown, want: string | RegExp) {
    const t = textOf(el)
    const pass = typeof want === 'string' ? t.includes(want) : want.test(t)
    return { pass, message: () => `expected "${t}" ${pass ? 'not ' : ''}to contain ${String(want)}` }
  },
  toBeInTheDocument(el: unknown) {
    const pass = el instanceof Node && document.body.contains(el)
    return { pass, message: () => `expected element ${pass ? 'not ' : ''}to be in the document` }
  },
  toHaveFocus(el: unknown) {
    const pass = document.activeElement === el
    return { pass, message: () => `expected element ${pass ? 'not ' : ''}to have focus` }
  },
  toHaveValue(el: unknown, want: string) {
    const v = (el as HTMLTextAreaElement).value
    return { pass: v === want, message: () => `expected value "${v}" to be "${want}"` }
  },
})

const api = vi.hoisted(() => ({
  getHubConfig: vi.fn(),
  getHubAgent: vi.fn(),
  getHubAvatar: vi.fn(),
  startHubConversation: vi.fn(),
  sendHubMessage: vi.fn(),
  listHubDeliveries: vi.fn(),
  reportHubAgent: vi.fn(),
  searchHubAgents: vi.fn(),
  getMessages: vi.fn(),
  getProject: vi.fn(),
  getChatroom: vi.fn(),
  setRoomFlow: vi.fn(),
  uploadUserFile: vi.fn(),
  sendDMMessage: vi.fn(),
  markdown: vi.fn(),
}))
vi.mock('../../api/endpoints/hub', async (orig) => {
  const real = await orig<typeof import('../../api/endpoints/hub')>()
  return {
    ...real,
    getHubConfig: (...a: unknown[]) => api.getHubConfig(...a),
    getHubAgent: (...a: unknown[]) => api.getHubAgent(...a),
    getHubAvatar: (...a: unknown[]) => api.getHubAvatar(...a),
    startHubConversation: (...a: unknown[]) => api.startHubConversation(...a),
    sendHubMessage: (...a: unknown[]) => api.sendHubMessage(...a),
    listHubDeliveries: (...a: unknown[]) => api.listHubDeliveries(...a),
    reportHubAgent: (...a: unknown[]) => api.reportHubAgent(...a),
    searchHubAgents: (...a: unknown[]) => api.searchHubAgents(...a),
  }
})
vi.mock('../../api/endpoints', async (orig) => {
  const real = await orig<typeof import('../../api/endpoints')>()
  return {
    ...real,
    getMessages: (...a: unknown[]) => api.getMessages(...a),
    getProject: (...a: unknown[]) => api.getProject(...a),
    getChatroom: (...a: unknown[]) => api.getChatroom(...a),
  }
})
vi.mock('../../api/endpoints/roomFlow', () => ({ setRoomFlow: (...a: unknown[]) => api.setRoomFlow(...a) }))
vi.mock('../../api/endpoints/files', async (orig) => {
  const real = await orig<typeof import('../../api/endpoints/files')>()
  return { ...real, uploadUserFile: (...a: unknown[]) => api.uploadUserFile(...a) }
})
vi.mock('../../api/endpoints/dm', async (orig) => {
  const real = await orig<typeof import('../../api/endpoints/dm')>()
  return { ...real, sendDMMessage: (...a: unknown[]) => api.sendDMMessage(...a) }
})
const ws = vi.hoisted(() => ({ connected: false }))
vi.mock('../../hooks/useWebSocket', async (orig) => {
  const real = await orig<typeof import('../../hooks/useWebSocket')>()
  return { ...real, useWebSocketStatus: () => ws.connected }
})
// The real MarkdownBody, with every call's props recorded.
vi.mock('../shared/MarkdownBody', async (orig) => {
  const real = await orig<typeof import('../shared/MarkdownBody')>()
  const Real = real.default
  return {
    ...real,
    default: (props: Parameters<typeof Real>[0]) => {
      api.markdown(props)
      return <Real {...props} />
    },
  }
})

const ID = hubAgent().hub_agent_id
const PID = 'p-hub-1'

const hubErr = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, code, { detail: { code, message: 'hub says <b>no</b>', ...extra } })

function msg(id: string, from: string, content: string, ts = new Date().toISOString()): ChatMessage {
  return { entry_type: 'message', id, ts, from_participant_id: from, from_participant_name: from, content, expects_response_from: [] }
}

let location = ''
function Probe() {
  location = useLocation().pathname
  return null
}

let qc: QueryClient
function mount(path: string, seed?: (qc: QueryClient) => void) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed?.(qc)
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="hub/:hubAgentId" element={<HubChatView />} />
          <Route path="hub/:hubAgentId/:threadId" element={<HubChatView />} />
          <Route path="dm/:agentName" element={<p>dm view</p>} />
        </Routes>
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function setup({ config = {}, target = hubTarget(), detail = hubAgentDetail(), messages = [] as ChatMessage[] }: {
  config?: Partial<HubConfig>
  target?: HubTarget | null
  detail?: HubAgentDetail | Error
  messages?: ChatMessage[]
} = {}) {
  api.getHubConfig.mockResolvedValue(hubConfig(config))
  api.getProject.mockResolvedValue(hubProject(PID, target))
  if (detail instanceof Error) api.getHubAgent.mockRejectedValue(detail)
  else api.getHubAgent.mockResolvedValue(detail)
  api.getMessages.mockResolvedValue(messages)
  api.getChatroom.mockRejectedValue(new ApiError(404, 'not mocked'))
}

const composer = () => screen.getByRole('textbox', { name: /^Message / })
async function typeAndSend(text: string) {
  fireEvent.change(await waitFor(composer), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}
const banner = () => screen.findByTestId('hub-thread-banner')

const fetchSpy = vi.fn(() => new Promise<Response>(() => {}))

beforeEach(() => {
  seedSessions([makeSession({ id: 'u1' })], 'u1')
  vi.stubGlobal('fetch', fetchSpy)
  api.getHubAvatar.mockRejectedValue(new ApiError(404, 'avatar_not_set'))
  api.listHubDeliveries.mockResolvedValue([])
  api.uploadUserFile.mockResolvedValue(undefined)
  location = ''
  ws.connected = false
})

afterEach(() => {
  cleanup()
  qc?.clear()
  seedSessions([])
  vi.unstubAllGlobals()
  vi.useRealTimers()
  for (const f of Object.values(api)) f.mockReset()
  fetchSpy.mockClear()
})

describe('the "hosted on X" disclosure', () => {
  it('shows before the first message, with sender_label, the fp, the current key only when it differs, and the verified address as text', async () => {
    setup({ detail: hubAgentDetail({ current_fingerprint: '5ac2e019ffff0000' }) })
    mount(hubThreadPath(ID))
    const note = await screen.findByTestId('hub-disclosure')
    expect(note).toHaveTextContent('This agent is hosted on acme.dev, not on this server.')
    expect(note).toHaveTextContent('whose operator can read it, and the hub can read it in transit.')
    expect(within(note).getByTestId('hub-sender-label')).toHaveTextContent('carol @ clawmeets.ai')
    expect(within(note).getByTestId('hub-disclosure-identity')).toHaveTextContent(
      'Server fingerprint 3f9a1c2e (current key 5ac2e019) · address https://acme.dev ✓ verified')
    expect(note).toHaveTextContent('new to you')
    expect(note.querySelector('a')).toBeNull()
  })

  it('no current key when it equals the genesis, and "address not verified" when unverified', async () => {
    setup({ detail: hubAgentDetail({ current_fingerprint: FP_ACME, deployment_url_verified: false, first_contact: false }) })
    mount(hubThreadPath(ID))
    const id = await screen.findByTestId('hub-disclosure-identity')
    expect(id).toHaveTextContent('Server fingerprint 3f9a1c2e · address not verified')
    expect(id).not.toHaveTextContent('current key')
    expect(screen.queryByText('https://acme.dev')).toBeNull()
  })

  it('a look-alike server name gets the "contains unusual characters" chip in the header', async () => {
    setup({ target: hubTarget({ deployment_name: '\u0430cme.dev' }), messages: [msg('m1', 'u1', 'hi')] })
    mount(hubThreadPath(ID, PID))
    const sub = await screen.findByTestId('hub-chat-subtitle')
    expect(sub.querySelector('[data-testid="chip-unusual"]')).not.toBeNull()
  })

  it('collapses to the header subtitle once the thread has messages', async () => {
    setup({ messages: [msg('m1', 'u1', 'hi')] })
    mount(hubThreadPath(ID, PID))
    expect(await screen.findByTestId('hub-chat-subtitle')).toHaveTextContent('Hosted on acme.dev · 3f9a1c2e')
    expect(screen.queryByTestId('hub-disclosure')).toBeNull()
  })
})

describe('remote message bodies', () => {
  it('render only through HubMessageBody with untrusted on, and a hostile body stays inert', async () => {
    const hostile = '<img src=x onerror="alert(1)"> ![pic](https://evil.example/p.png) [go](javascript:alert(1)) ‮evil'
    setup({ messages: [msg('m1', 'u1', 'my **own** text'), msg('r1', 'stand-in', hostile)] })
    mount(hubThreadPath(ID, PID))
    const remote = await screen.findByTestId('hub-message-remote')
    expect(api.markdown).toHaveBeenCalled()
    for (const [props] of api.markdown.mock.calls) {
      expect(props.untrusted).toBe(true)
      expect(props.content).toBe(hostile)
    }
    const list = screen.getByTestId('hub-messages')
    expect(list.querySelector('img')).toBeNull()
    expect(remote.querySelector('a[href^="javascript"]')).toBeNull()
    expect(remote.textContent).not.toContain('‮')
    // My own message is plain text: never Markdown.
    expect(screen.getByTestId('hub-message-mine')).toHaveTextContent('my **own** text')
  })
})

describe('an agent that is no longer listed', () => {
  it('listed: false on an open thread: the approved sentence, and no composer', async () => {
    setup({ detail: hubAgentDetail({ listed: false }) })
    mount(hubThreadPath(ID, PID))
    const b = await banner()
    expect(b).toHaveTextContent('scout@acme.dev is no longer listed on the hub.')
    expect(b).toHaveTextContent("You can't send new messages")
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('hub_target.listed false keeps the thread readable as history', async () => {
    setup({ target: hubTarget({ listed: false }), messages: [msg('r1', 'stand-in', 'old reply')] })
    mount(hubThreadPath(ID, PID))
    expect(await banner()).toHaveTextContent('scout@acme.dev is no longer listed on the hub.')
    expect(screen.getByTestId('hub-message-remote')).toHaveTextContent('old reply')
  })

  it('404 agent_unlisted on a draft: "This agent is no longer listed on the hub." and no composer', async () => {
    setup({ detail: hubErr(404, 'agent_unlisted') })
    mount(hubThreadPath(ID))
    expect(await banner()).toHaveTextContent(HUB_CHAT_COPY.unlistedDraft)
    expect(HUB_CHAT_COPY.unlistedDraft).toBe('This agent is no longer listed on the hub.')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('404 agent_unlisted on an open thread reads the same as listed: false', async () => {
    setup({ detail: hubErr(404, 'agent_unlisted') })
    mount(hubThreadPath(ID, PID))
    expect(await banner()).toHaveTextContent('scout@acme.dev is no longer listed on the hub.')
  })
})

describe('a closed thread, for each closed reason: banner and no composer', () => {
  const cases: [string, string][] = [
    ['agent_unlisted', 'scout@acme.dev is no longer listed on the hub. This conversation is kept as history.'],
    ['key_revoked', "This agent's hub key was revoked by its owner. This conversation is kept as history."],
    ['deployment_suspended', 'The hub has suspended acme.dev. This conversation is kept as history.'],
    ['conversation_closed', 'scout@acme.dev closed this conversation. Start a new one to continue.'],
    ['hub_off_on_server', 'The hub is turned off on this server. This conversation is kept as history.'],
    ['identity_changed', "acme.dev's identity changed. The server now using this name has a different key (was 3f9a1c2e)."],
    ['something_newer', 'This conversation is closed.'],
  ]
  it.each(cases)('closed_reason %s', async (reason, text) => {
    setup({ target: hubTarget({ closed_reason: reason, closed_at: NOW_S - 86400 }) })
    mount(hubThreadPath(ID, PID))
    const b = await banner()
    expect(b).toHaveTextContent(text)
    expect(b).toHaveTextContent("You can't send new messages")
    expect(b).not.toHaveTextContent('may still arrive')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(api.getHubAgent).not.toHaveBeenCalled()
  })

  it('agent_unlisted closed less than 10 minutes ago adds the drain sentence', async () => {
    setup({ target: hubTarget({ closed_reason: 'agent_unlisted', closed_at: Date.now() / 1000 - 120 }) })
    mount(hubThreadPath(ID, PID))
    expect(await banner()).toHaveTextContent('Replies already on their way may still arrive for a few minutes.')
  })

  it('conversation_closed offers "Start a new one", which opens a new draft', async () => {
    setup({ target: hubTarget({ closed_reason: 'conversation_closed', closed_at: NOW_S }) })
    mount(hubThreadPath(ID, PID))
    fireEvent.click(await screen.findByRole('button', { name: 'Start a new one' }))
    await waitFor(() => expect(location).toBe(hubThreadPath(ID)))
  })

  it('a 410 agent_unlisted on send turns into the closed banner', async () => {
    setup()
    api.sendHubMessage.mockRejectedValue(hubErr(410, 'agent_unlisted'))
    mount(hubThreadPath(ID, PID))
    await typeAndSend('hello?')
    expect(await banner()).toHaveTextContent('scout@acme.dev is no longer listed on the hub. This conversation is kept as history.')
  })

  it('a 409 identity_changed on send shows "was {fp}"', async () => {
    setup()
    api.sendHubMessage.mockRejectedValue(hubErr(409, 'identity_changed'))
    mount(hubThreadPath(ID, PID))
    await typeAndSend('hello?')
    expect(await banner()).toHaveTextContent('(was 3f9a1c2e)')
  })
})

describe('the offline confirm', () => {
  it.each([
    ['agent_offline', 'scout@acme.dev is offline. acme.dev will hold your message and the agent answers when it\'s back. Send anyway?'],
    ['deployment_offline', 'acme.dev is offline. Your message waits on this server and is sent when acme.dev reconnects, for up to 72 hours. Send anyway?'],
  ])('%s: the warning, then Send anyway re-sends with the same client_message_id and confirm_offline', async (warning, text) => {
    setup()
    api.sendHubMessage
      .mockRejectedValueOnce(hubErr(409, 'target_offline_confirm_required', { send_warning: warning }))
      .mockResolvedValueOnce({ message_id: 'm9', delivery: delivery({ message_id: 'm9', state: 'waiting_for_target' }) })
    mount(hubThreadPath(ID, PID))
    await typeAndSend('are you there?')
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(text)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(composer()).toHaveValue('are you there?')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send anyway' }))
    await waitFor(() => expect(api.sendHubMessage).toHaveBeenCalledTimes(2))
    const [first, second] = api.sendHubMessage.mock.calls
    expect(first[1].confirm_offline).toBe(false)
    expect(second[1].confirm_offline).toBe(true)
    expect(second[1].client_message_id).toBe(first[1].client_message_id)
    await waitFor(() => expect(composer()).toHaveValue(''))
  })
})

describe('the agent comes from the thread, not the URL', () => {
  it('a URL with another agent\'s id redirects to the thread\'s own agent, and nothing is asked about the URL\'s agent', async () => {
    const other = hubAgent({ name: 'mallory', deployment_fingerprint: FP_OTHER }).hub_agent_id
    setup({ messages: [msg('m1', 'u1', 'hi')] })
    mount(hubThreadPath(other, PID))
    await waitFor(() => expect(location).toBe(hubThreadPath(ID, PID)))
    expect(await screen.findByTestId('hub-chat-title')).toHaveTextContent('scout@acme.dev')
    await waitFor(() => expect(api.getHubAgent).toHaveBeenCalled())
    for (const [id] of api.getHubAgent.mock.calls) expect(id).toBe(ID)
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('scout@acme.dev')
  })

  it('a project that is not a hub thread leaves /hub for its ordinary route', async () => {
    setup({ target: null })
    mount(hubThreadPath(ID, PID))
    await waitFor(() => expect(location).toBe(`/projects/${PID}`))
    expect(screen.queryByTestId('hub-chat-view')).toBeNull()
  })
})

describe('send errors that no banner explains', () => {
  const errorLine = () => screen.findByTestId('hub-composer-error')

  it('an unhandled code (not_owner) shows the fallback line, and the draft is kept', async () => {
    setup()
    api.sendHubMessage.mockRejectedValue(hubErr(403, 'not_owner'))
    mount(hubThreadPath(ID, PID))
    await typeAndSend('hello?')
    expect(await errorLine()).toHaveTextContent("Couldn't send: this server refused the message. Your message is kept.")
    expect(composer()).toHaveValue('hello?')
  })

  it('project_not_found says the conversation no longer exists', async () => {
    setup()
    api.sendHubMessage.mockRejectedValue(hubErr(404, 'project_not_found'))
    mount(hubThreadPath(ID, PID))
    await typeAndSend('hello?')
    expect(await errorLine()).toHaveTextContent('This conversation no longer exists on this server.')
  })

  it('agent_not_found on send reads as no longer listed, and the composer goes', async () => {
    setup()
    api.sendHubMessage.mockRejectedValue(hubErr(404, 'agent_not_found'))
    mount(hubThreadPath(ID, PID))
    await typeAndSend('hello?')
    expect(await banner()).toHaveTextContent('scout@acme.dev is no longer listed on the hub.')
    expect(screen.queryByRole('textbox', { name: /^Message / })).toBeNull()
  })
})

describe('the four pinned error details', () => {
  it('429 retry_after on send: the wait from retry_after, and the draft is kept', async () => {
    setup()
    api.sendHubMessage.mockRejectedValue(hubErr(429, 'rate_limited', { retry_after: 42 }))
    mount(hubThreadPath(ID, PID))
    await typeAndSend('too fast')
    const b = await banner()
    expect(b).toHaveTextContent(/You're sending too fast to scout@acme\.dev\. You can send again in 0:4[12]\./)
    expect(b.dataset.reason).toBe('rate_limited')
    expect(composer()).toHaveValue('too fast')
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('send_warning picks the offline sentence (deployment_offline)', async () => {
    setup()
    api.sendHubMessage.mockRejectedValue(hubErr(409, 'target_offline_confirm_required', { send_warning: 'deployment_offline' }))
    mount(hubThreadPath(ID, PID))
    await typeAndSend('x')
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('acme.dev is offline. Your message waits on this server')
  })

  it("hub down: the hub's last-connected time from config, and from a 503 on send", async () => {
    setup({ config: { deployment_connected: false, hub_link: 'unreachable', last_connected_at: NOW_S - 3600 } })
    mount(hubThreadPath(ID, PID))
    expect(await banner()).toHaveTextContent(
      `Can't reach the hub. Sending to other servers is paused. Last connected ${formatHubDate(NOW_S - 3600)}.`)
    cleanup()

    setup()
    api.sendHubMessage.mockRejectedValue(hubErr(503, 'hub_unreachable', { last_connected_at: NOW_S - 7200 }))
    mount(hubThreadPath(ID, PID))
    await typeAndSend('x')
    expect(await banner()).toHaveTextContent(`Last connected ${formatHubDate(NOW_S - 7200)}.`)
  })

  it("file_not_found: names the missing file's id and drops its chip; payload_too_large marks its file", async () => {
    setup()
    api.sendHubMessage
      .mockRejectedValueOnce(hubErr(404, 'file_not_found', { file_id: 'deck.pdf' }))
      .mockRejectedValueOnce(hubErr(413, 'payload_too_large', { limit: 'file', max: 1000, actual: 2048, file_id: 'notes.txt' }))
    mount(hubThreadPath(ID, PID))
    const input = await screen.findByTestId('hub-file-input')
    fireEvent.change(input, {
      target: { files: [new File(['a'], 'deck.pdf'), new File(['b'], 'notes.txt')] },
    })
    await typeAndSend('see attached')
    expect(await screen.findByTestId('hub-composer-error')).toHaveTextContent(
      'That file is no longer in this conversation: deck.pdf')
    expect(screen.getAllByTestId('hub-file-chip').map((c) => c.textContent)).toEqual(['notes.txt'])
    expect(api.sendHubMessage.mock.calls[0][1].file_ids).toEqual(['deck.pdf', 'notes.txt'])

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByTestId('hub-composer-error')).toHaveTextContent(
      'A file is 2 KB — over the 1000 bytes limit for other servers.'))
    expect(screen.getByTestId('hub-file-chip').dataset.problem).toBe('true')
    expect(composer()).toHaveValue('see attached')
  })
})

describe('start and send skip the search budget', () => {
  const seedDirectory = (q: QueryClient) =>
    q.setQueryData(['hub-directory', '', [], false], {
      pages: [{ agents: [hubAgent()], next_cursor: null, served_from: 'live', cache_age_s: null, cached_at: null }],
      pageParams: [undefined],
    })

  it('a draft opened from the directory starts and sends while search is rate-limited', async () => {
    setup({ detail: hubErr(429, 'rate_limited', { retry_after: 30 }) })
    api.searchHubAgents.mockRejectedValue(hubErr(429, 'rate_limited', { retry_after: 30 }))
    api.startHubConversation.mockResolvedValue({
      ...hubProject('p-new', hubTarget()), surface: 'frontdesk',
      target: {
        agent_online: true, deployment_connected: true, send_warning: null, deployment_name: 'acme.dev',
        deployment_fingerprint: FP_ACME, deployment_url: 'https://acme.dev', deployment_url_verified: true, first_contact: true,
      },
    })
    api.sendHubMessage.mockResolvedValue({ message_id: 'm1', delivery: delivery() })
    mount(hubThreadPath(ID), seedDirectory)
    expect(await screen.findByTestId('hub-disclosure')).toHaveTextContent('hosted on acme.dev')
    await typeAndSend('hello from far away')
    await waitFor(() => expect(api.sendHubMessage).toHaveBeenCalledTimes(1))
    expect(api.startHubConversation).toHaveBeenCalledWith(ID, expect.any(String))
    expect(api.sendHubMessage.mock.calls[0][0]).toBe('p-new')
    await waitFor(() => expect(location).toBe(hubThreadPath(ID, 'p-new')))
  })

  it('an open thread sends while the detail answers 429', async () => {
    setup({ detail: hubErr(429, 'rate_limited', { retry_after: 30 }) })
    api.sendHubMessage.mockResolvedValue({ message_id: 'm1', delivery: delivery() })
    mount(hubThreadPath(ID, PID))
    await typeAndSend('still here')
    await waitFor(() => expect(api.sendHubMessage).toHaveBeenCalledWith(PID, expect.objectContaining({ text: 'still here' })))
    await waitFor(() => expect(composer()).toHaveValue(''))
  })
})

describe('history polling', () => {
  afterEach(() => { vi.useRealTimers() })

  it('polls history every 5 s only while the socket is down; a live socket leaves it to the changelog push', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    ws.connected = true
    setup({ messages: [msg('m1', 'u1', 'one')] })
    const view = mount(hubThreadPath(ID, PID))
    await screen.findByText('one')
    const before = api.getMessages.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    expect(api.getMessages.mock.calls.length).toBe(before)
    view.unmount()

    ws.connected = false
    mount(hubThreadPath(ID, PID))
    await screen.findByText('one')
    const start = api.getMessages.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    expect(api.getMessages.mock.calls.length).toBeGreaterThanOrEqual(start + 2)
  })
})

describe('Reported', () => {
  it('the header menu reads "Reported" as soon as a report succeeds, with no remount', async () => {
    // Its own agent: "Reported" lasts the browser session, so other tests keep "Report".
    const other = 'bbbbbbbbbbbbbbbb~lex'
    setup({ target: hubTarget({ hub_agent_id: other }), detail: hubAgentDetail({ hub_agent_id: other }) })
    api.reportHubAgent.mockResolvedValue(undefined)
    mount(hubThreadPath(other, PID))
    fireEvent.click(await screen.findByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report' }))
    const dialog = await screen.findByTestId('report-dialog')
    const reason = dialog.querySelector('input[type="radio"]') as HTMLInputElement | null
    if (reason) fireEvent.click(reason)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report' }))
    await within(dialog).findByText(/^Reported\./)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menuitem', { name: 'Reported' })).toBeTruthy()
    expect((screen.getByRole('menuitem', { name: 'Reported' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('start refusals that no retry can change', () => {
  it('identity_changed on start: the identity-changed sentence with "was {fp}", no "try again", and no composer', async () => {
    setup()
    api.startHubConversation.mockRejectedValue(hubErr(409, 'identity_changed'))
    mount(hubThreadPath(ID))
    await typeAndSend('hi')
    const b = await banner()
    expect(b).toHaveTextContent("acme.dev's identity changed. The server now using this name has a different key (was 3f9a1c2e).")
    expect(textOf(document.body)).not.toMatch(/try again/i)
    expect(screen.queryByRole('textbox', { name: /^Message / })).toBeNull()
    expect(api.sendHubMessage).not.toHaveBeenCalled()
  })

  it('invalid_agent_id on start: its own sentence, no "try again", and no composer', async () => {
    setup()
    api.startHubConversation.mockRejectedValue(hubErr(400, 'invalid_agent_id'))
    mount(hubThreadPath(ID))
    await typeAndSend('hi')
    expect(await banner()).toHaveTextContent(HUB_CHAT_COPY.invalidAgentId)
    expect(textOf(document.body)).not.toMatch(/try again/i)
    expect(screen.queryByRole('textbox', { name: /^Message / })).toBeNull()
  })
})

describe('other behaviour', () => {
  it('local_agent on start navigates to /dm/{agent_name}', async () => {
    setup()
    api.startHubConversation.mockRejectedValue(hubErr(409, 'local_agent', { use_path: '/dm/scout', agent_name: 'scout' }))
    mount(hubThreadPath(ID))
    await typeAndSend('hi')
    await waitFor(() => expect(location).toBe('/dm/scout'))
    expect(api.sendHubMessage).not.toHaveBeenCalled()
  })

  it('mode off: history and delivery lines still show, the composer reads hub off, and detail is never fetched', async () => {
    setup({ config: { mode: 'off' }, messages: [msg('m1', 'u1', 'sent before'), msg('r1', 'stand-in', 'a reply')] })
    api.listHubDeliveries.mockResolvedValue([delivery({ message_id: 'm1', state: 'delivered' })])
    mount(hubThreadPath(ID, PID))
    expect(await screen.findByText('Delivered')).toBeInTheDocument()
    expect(screen.getByTestId('hub-message-remote')).toHaveTextContent('a reply')
    expect(await banner()).toHaveTextContent('The hub is turned off on this server. This conversation is kept as history.')
    expect(api.getHubAgent).not.toHaveBeenCalled()
    expect(api.listHubDeliveries).toHaveBeenCalledWith(PID)
  })

  it('a delivery line sits under each of my messages, and a failed one offers Copy text', async () => {
    setup({ messages: [msg('m1', 'u1', 'one'), msg('m2', 'u1', 'two')] })
    api.listHubDeliveries.mockResolvedValue([
      delivery({ message_id: 'm1', state: 'waiting_for_target', waiting_reason: 'agent_offline' }),
      delivery({ message_id: 'm2', state: 'failed', failed_reason: 'blocked_by_target' }),
    ])
    mount(hubThreadPath(ID, PID))
    await screen.findByText(/^Waiting: scout is offline — acme.dev holds it/)
    expect(screen.getByText(/Not delivered: the agent's owner isn't accepting messages from you/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Copy text' })).toHaveLength(1)
  })

  it('needs approval: the notice above the composer', async () => {
    setup({ detail: hubAgentDetail({ needs_approval: true }) })
    mount(hubThreadPath(ID))
    expect(await screen.findByTestId('hub-approval-notice')).toHaveTextContent(
      "scout's owner approves new contacts first. Your first message waits until they accept you.")
  })

  it('never calls the generic user-message route', async () => {
    setup()
    api.sendHubMessage.mockResolvedValue({ message_id: 'm1', delivery: delivery() })
    mount(hubThreadPath(ID, PID))
    await typeAndSend('only the hub route')
    await waitFor(() => expect(api.sendHubMessage).toHaveBeenCalled())
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(api.sendDMMessage).not.toHaveBeenCalled()
    for (const [url] of fetchSpy.mock.calls as unknown as [unknown][]) expect(String(url)).not.toContain('user-message')
  })

  it('Report is in the header menu', async () => {
    setup()
    mount(hubThreadPath(ID, PID))
    fireEvent.click(await screen.findByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('scout@acme.dev')
  })
})

describe('the two routes', () => {
  it('/hub/{id} is a draft and /hub/{id}/{project} is the thread, with the id decoded once and kept whole', async () => {
    const odd = '3f9a1c2e5b7d9f00~scout/x y'
    setup({ detail: hubAgentDetail({ hub_agent_id: odd }) })
    mount(hubThreadPath(odd))
    await screen.findByTestId('hub-disclosure')
    expect(api.getHubAgent).toHaveBeenCalledWith(odd)
    expect(api.getProject).not.toHaveBeenCalled()
    cleanup()

    setup()
    mount(hubThreadPath(odd, PID))
    await screen.findByTestId('hub-chat-subtitle')
    expect(api.getProject).toHaveBeenCalledWith(PID)
    expect(api.getMessages).toHaveBeenCalledWith(PID, 'user-communication')
  })
})

describe('stopping outside messages in a hub thread', () => {
  const room = (flow: Record<string, unknown>) => ({
    id: 'r', name: 'user-communication', project_id: PID, participants: [], version: 1, created_at: '',
    participant_info: [], flow,
  })

  it('a 409 room_flow_stopped keeps the draft, says why, and offers Resume to the owner', async () => {
    setup()
    api.getProject.mockResolvedValue(hubProject(PID, hubTarget(), { created_by: 'u1' }))
    api.getChatroom.mockResolvedValue(room({ inbound_flow: 'stopped', stopped_by: 'owner', held_count: 0 }))
    api.sendHubMessage.mockRejectedValue(hubErr(409, 'room_flow_stopped'))
    api.setRoomFlow.mockResolvedValue({ inbound_flow: 'open', stopped_by: null, held_count: 0 })
    mount(hubThreadPath(ID, PID))
    expect((await screen.findByTestId('room-flow-strip')).textContent).toContain('Outside messages are stopped (by you)')
    await typeAndSend('still there?')
    expect(await screen.findByTestId('hub-composer-error')).toHaveTextContent('Outside messages are stopped in this room. Resume them to send.')
    expect(composer()).toHaveValue('still there?')
    fireEvent.click(screen.getByTestId('hub-resume-flow'))
    await waitFor(() => expect(api.setRoomFlow).toHaveBeenCalledWith(PID, 'user-communication', 'open'))
    await waitFor(() => expect(screen.queryByTestId('room-flow-strip')).toBeNull())
    expect(api.sendHubMessage).toHaveBeenCalledTimes(1)
  })

  it('the header control is the thread owner\'s only', async () => {
    setup()
    api.getProject.mockResolvedValue(hubProject(PID, hubTarget(), { created_by: 'u1' }))
    api.getChatroom.mockResolvedValue(room({ inbound_flow: 'open' }))
    mount(hubThreadPath(ID, PID))
    expect((await screen.findByTestId('room-flow-control')).textContent).toBe('Stop outside messages')
    cleanup()
    api.getProject.mockResolvedValue(hubProject(PID, hubTarget(), { created_by: 'someone-else' }))
    mount(hubThreadPath(ID, PID))
    await screen.findByTestId('hub-chat-title')
    await act(async () => {})
    expect(screen.queryByTestId('room-flow-control')).toBeNull()
  })
})

