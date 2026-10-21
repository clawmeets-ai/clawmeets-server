import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '../../api/client'
import type { FsEntry, FsTier } from '../../api/endpoints/agentFs'
import HomeFolderBrowser from './HomeFolderBrowser'
import { ACCESS_ERROR_COPY } from '../../utils/agentAccessCopy'

/**
 * The navigator over an in-memory home folder. The runner owns every rule;
 * what must hold here is that the view mirrors the runner's answers — a
 * read-only entry gets a lock and no write controls, every change shows in
 * the tree without a reload, an offline runner says "offline" rather than
 * an empty folder, and a change with no answer says "result unknown" and
 * re-reads the folder instead of saying "failed".
 */

type Node = { type: 'file'; bytes: Uint8Array; tier: FsTier; writable: boolean; readable?: boolean } | { type: 'dir'; tier: FsTier; writable: boolean }

const enc = new TextEncoder()
let tree: Map<string, Node>
let offline: string | null
let nextWrite: 'ok' | 'unknown'
const writes: Array<{ path: string; bytes: Uint8Array }> = []

function fsError(status: number, code: string, message: string, resultUnknown = false): ApiError {
  return new ApiError(status, message, { error: { code, message, result_unknown: resultUnknown }, detail: message })
}

function entryOf(path: string, n: Node): FsEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    type: n.type,
    size: n.type === 'file' ? n.bytes.length : 0,
    mtime: 0,
    tier: n.tier,
    writable: n.writable,
    readable: n.type === 'file' ? n.readable !== false : true,
  }
}

function parentOf(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

async function blobBytes(content: Blob | ArrayBuffer): Promise<Uint8Array> {
  const buf = content instanceof Blob
    ? await new Promise<ArrayBuffer>((resolve) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result as ArrayBuffer)
        r.readAsArrayBuffer(content)
      })
    : content
  return new Uint8Array(buf)
}

vi.mock('../../api/endpoints/agentFs', async (importActual) => {
  const actual = await importActual<typeof import('../../api/endpoints/agentFs')>()
  const guard = () => {
    if (offline) throw fsError(offline === 'remote_agent' ? 404 : 503, offline, offline === 'agent_offline' ? 'agent is offline' : 'runner too old')
  }
  return {
    ...actual,
    listAgentFolder: vi.fn(async (_id: string, path: string) => {
      guard()
      const dir = path === '' ? { type: 'dir', tier: 'open', writable: true } as Node : tree.get(path)
      if (!dir || dir.type !== 'dir') throw fsError(404, 'not_found', 'no such folder')
      const entries = [...tree.entries()]
        .filter(([p]) => parentOf(p) === path)
        .map(([p, n]) => entryOf(p, n))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { path, tier: dir.tier, writable: dir.writable, truncated: false, entries }
    }),
    readAgentFile: vi.fn(async (_id: string, path: string) => {
      guard()
      const n = tree.get(path)
      if (!n || n.type !== 'file') throw fsError(404, 'not_found', 'no such file')
      let text: string | null = null
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(n.bytes)
      } catch {
        text = null
      }
      return {
        path, tier: n.tier, writable: n.writable, size: n.bytes.length, mtime: 0,
        is_text: text !== null, text, content_b64: text === null ? 'AA==' : null,
      }
    }),
    downloadAgentFile: vi.fn(async (_id: string, path: string) => {
      const n = tree.get(path)
      if (!n || n.type !== 'file') throw fsError(404, 'not_found', 'no such file')
      return new Blob([n.bytes])
    }),
    writeAgentFile: vi.fn(async (_id: string, path: string, content: Blob | ArrayBuffer) => {
      guard()
      const bytes = await blobBytes(content)
      writes.push({ path, bytes })
      const existing = tree.get(path)
      if (existing && !existing.writable) throw fsError(403, 'read_only', 'read-only')
      tree.set(path, { type: 'file', bytes, tier: 'open', writable: true })
      if (nextWrite === 'unknown') throw fsError(504, 'result_unknown', 'no answer in time', true)
      return entryOf(path, tree.get(path)!)
    }),
    makeAgentFolder: vi.fn(async (_id: string, path: string) => {
      guard()
      tree.set(path, { type: 'dir', tier: 'open', writable: true })
      return entryOf(path, tree.get(path)!)
    }),
    deleteAgentEntry: vi.fn(async (_id: string, path: string) => {
      guard()
      for (const p of [...tree.keys()]) if (p === path || p.startsWith(`${path}/`)) tree.delete(p)
    }),
  }
})

const api = await import('../../api/endpoints/agentFs')

beforeEach(() => {
  offline = null
  nextWrite = 'ok'
  writes.length = 0
  tree = new Map<string, Node>([
    ['memory', { type: 'dir', tier: 'open', writable: true }],
    ['memory/README.md', { type: 'file', bytes: enc.encode('# Memory notes\n\nhello'), tier: 'open', writable: true }],
    ['memory/notes.txt', { type: 'file', bytes: enc.encode('first draft'), tier: 'open', writable: true }],
    ['memory/blob.bin', { type: 'file', bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x81]), tier: 'open', writable: true }],
    ['system-skill-hub', { type: 'dir', tier: 'system', writable: false }],
    ['AGENTS.md', { type: 'file', bytes: enc.encode('roster'), tier: 'system', writable: false }],
    ['personal-skill-hub', { type: 'dir', tier: 'personal_skills', writable: true }],
  ])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderBrowser() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <HomeFolderBrowser agentId="a1" agentLabel="wine" />
    </QueryClientProvider>,
  )
}

const treeEl = () => screen.getByRole('tree')
const header = () => screen.getByRole('heading', { level: 3 }).parentElement as HTMLElement

async function openInTree(name: string) {
  fireEvent.click(await within(treeEl()).findByText(name))
}

describe('HomeFolderBrowser', () => {
  it('lists the home folder, locks read-only entries, and shows a folder README', async () => {
    renderBrowser()
    const system = await within(treeEl()).findByText('system-skill-hub')
    expect(within(system.closest('button')!).getByTestId('lock-overlay')).toBeTruthy()
    expect(within(within(treeEl()).getByText('memory').closest('button')!).queryByTestId('lock-overlay')).toBeNull()

    await openInTree('memory')
    expect(await screen.findByText('Memory notes')).toBeTruthy()
    // Expanded in the tree.
    expect(await within(treeEl()).findByText('notes.txt')).toBeTruthy()
    const h = header()
    expect(within(h).getByText('Add file')).toBeTruthy()
    expect(within(h).getByText('Add folder')).toBeTruthy()
    expect(within(h).getByText('Delete')).toBeTruthy()
  })

  it('shows a name that is not one path component locked and never opens it', async () => {
    // Even if a runner listed it writable: joined, 'memory\\' would name the folder 'memory'.
    tree.set('memory\\', { type: 'file', bytes: enc.encode('junk'), tier: 'open', writable: true })
    renderBrowser()
    const alias = await within(treeEl()).findByText('memory\\')
    expect(alias.closest('button')).toBeNull()
    expect(within(alias.closest('li')!).getByTestId('lock-overlay')).toBeTruthy()
    fireEvent.click(alias)
    expect(api.readAgentFile).not.toHaveBeenCalled()
    expect(api.listAgentFolder).not.toHaveBeenCalledWith('a1', 'memory\\')
  })

  it('says so when a folder has no README', async () => {
    renderBrowser()
    await openInTree('personal-skill-hub')
    expect(await screen.findByText('This folder has no README.md.')).toBeTruthy()
  })

  it('offers no write controls on a read-only folder or file', async () => {
    renderBrowser()
    await openInTree('system-skill-hub')
    await screen.findByText(/System-managed/)
    expect(within(header()).queryByText('Add file')).toBeNull()
    expect(within(header()).queryByText('Add folder')).toBeNull()
    expect(within(header()).queryByText('Delete')).toBeNull()

    await openInTree('AGENTS.md')
    expect(await screen.findByText('roster')).toBeTruthy()
    expect(within(header()).getByText('Download')).toBeTruthy()
    expect(within(header()).queryByText('Edit')).toBeNull()
    expect(within(header()).queryByText('Delete')).toBeNull()
    expect(within(header()).getByTestId('lock-overlay')).toBeTruthy()
  })

  it('edits and saves a text file, and shows what a later read returns', async () => {
    renderBrowser()
    await openInTree('memory')
    await openInTree('notes.txt')
    expect(await screen.findByText('first draft')).toBeTruthy()
    fireEvent.click(within(header()).getByText('Edit'))
    fireEvent.change(screen.getByLabelText('Edit notes.txt'), { target: { value: 'second draft' } })
    fireEvent.click(within(header()).getByText('Save'))
    // The editor closes once the write lands, and the view re-reads the file.
    await waitFor(() => expect(screen.queryByLabelText('Edit notes.txt')).toBeNull())
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toBe('second draft'))
    expect(new TextDecoder().decode((tree.get('memory/notes.txt') as { bytes: Uint8Array }).bytes)).toBe('second draft')
  })

  it('creates a file and a folder, and the tree shows both without a reload', async () => {
    renderBrowser()
    await openInTree('memory')
    await screen.findByText('Memory notes')
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('todo.md').mockReturnValueOnce('archive')
    fireEvent.click(within(header()).getByText('Add file'))
    fireEvent.click(screen.getByRole('menuitem', { name: /New file/ }))
    expect(await within(treeEl()).findByText('todo.md')).toBeTruthy()
    // The new file is opened.
    await waitFor(() => expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('/memory/todo.md'))

    await openInTree('memory') // collapse
    await openInTree('memory') // re-open, folder view
    await screen.findByText('Memory notes')
    fireEvent.click(within(header()).getByText('Add folder'))
    expect(await within(treeEl()).findByText('archive')).toBeTruthy()
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(tree.get('memory/archive')?.type).toBe('dir')
  })

  it('uploads several files into personal-skill-hub byte for byte', async () => {
    renderBrowser()
    await openInTree('personal-skill-hub')
    await screen.findByText('This folder has no README.md.')
    const skill = new File(['---\nname: wine\n---\nbody'], 'SKILL.md')
    const bin = new File([new Uint8Array([0, 1, 2, 250, 255])], 'logo.png')
    fireEvent.change(screen.getByTestId('fs-upload-input'), { target: { files: [skill, bin] } })
    expect(await within(treeEl()).findByText('SKILL.md')).toBeTruthy()
    expect(await within(treeEl()).findByText('logo.png')).toBeTruthy()
    expect(writes.map((w) => w.path)).toEqual(['personal-skill-hub/SKILL.md', 'personal-skill-hub/logo.png'])
    expect([...writes[1].bytes]).toEqual([0, 1, 2, 250, 255])
  })

  it('asks before deleting, and the tree drops the entry', async () => {
    renderBrowser()
    await openInTree('memory')
    await openInTree('notes.txt')
    await screen.findByText('first draft')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    fireEvent.click(within(header()).getByText('Delete'))
    expect(api.deleteAgentEntry).not.toHaveBeenCalled()
    fireEvent.click(within(header()).getByText('Delete'))
    await waitFor(() => expect(within(treeEl()).queryByText('notes.txt')).toBeNull())
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(tree.has('memory/notes.txt')).toBe(false)
    // Back on the folder that held it.
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('/memory')
  })

  it('says a binary file cannot be shown and still downloads it intact', async () => {
    const created: Blob[] = []
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b)
      return 'blob:x'
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderBrowser()
    await openInTree('memory')
    await openInTree('blob.bin')
    expect(await screen.findByText(/isn't text/)).toBeTruthy()
    expect(within(header()).queryByText('Edit')).toBeNull()
    fireEvent.click(within(header()).getByText('Download'))
    await waitFor(() => expect(created).toHaveLength(1))
    expect([...(await blobBytes(created[0]))]).toEqual([0xff, 0xfe, 0x00, 0x81])
  })

  describe('renders a file by its extension', () => {
    let created: Blob[]
    beforeEach(() => {
      created = []
      URL.createObjectURL = vi.fn((b: Blob) => {
        created.push(b)
        return `blob:${created.length}`
      }) as typeof URL.createObjectURL
      URL.revokeObjectURL = vi.fn()
    })

    const pane = () => header().parentElement as HTMLElement

    it('pretty-prints and highlights JSON', async () => {
      tree.set('memory/data.json', { type: 'file', bytes: enc.encode('{"a":1}'), tier: 'open', writable: true })
      renderBrowser()
      await openInTree('memory')
      await openInTree('data.json')
      await waitFor(() => expect(pane().querySelector('code.language-json')?.textContent).toBe('{\n  "a": 1\n}'))
      expect(within(header()).queryByText('Raw')).toBeNull()
    })

    it('renders markdown, and Raw shows the source', async () => {
      tree.set('memory/plan.md', { type: 'file', bytes: enc.encode('# Plan title\n\n**bold**'), tier: 'open', writable: true })
      renderBrowser()
      await openInTree('memory')
      await openInTree('plan.md')
      expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Plan title')
      fireEvent.click(within(header()).getByText('Raw'))
      expect(pane().querySelector('pre')?.textContent).toBe('# Plan title\n\n**bold**')
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
      fireEvent.click(within(header()).getByText('Rendered'))
      expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy()
    })

    it('shows a PNG as an image from a blob typed image/png', async () => {
      tree.set('memory/logo.png', { type: 'file', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), tier: 'open', writable: true })
      renderBrowser()
      await openInTree('memory')
      await openInTree('logo.png')
      await waitFor(() => expect(pane().querySelector('img')?.getAttribute('src')).toBe('blob:1'))
      expect(created[0].type).toBe('image/png')
      expect([...(await blobBytes(created[0]))]).toEqual([0x89, 0x50, 0x4e, 0x47])
      // Bytes, not text: the text read is never made for an image.
      expect(api.readAgentFile).not.toHaveBeenCalledWith('a1', 'memory/logo.png')
    })

    it('renders HTML in a frame sandboxed to scripts only, and edits its source', async () => {
      tree.set('memory/page.html', { type: 'file', bytes: enc.encode('<h1>hi</h1>'), tier: 'open', writable: true })
      renderBrowser()
      await openInTree('memory')
      await openInTree('page.html')
      await waitFor(() => expect(pane().querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts'))
      expect(created[0].type).toBe('text/html')
      expect(api.readAgentFile).not.toHaveBeenCalledWith('a1', 'memory/page.html')
      fireEvent.click(within(header()).getByText('Edit'))
      expect(((await screen.findByLabelText('Edit page.html')) as HTMLTextAreaElement).value).toBe('<h1>hi</h1>')
    })

    it('shows the size instead of an image over the download cap', async () => {
      tree.set('memory/huge.jpg', { type: 'file', bytes: new Uint8Array(9 * 1024 * 1024), tier: 'open', writable: true })
      renderBrowser()
      await openInTree('memory')
      await openInTree('huge.jpg')
      expect(await screen.findByText(/too large to preview \(9\.0 MB\)/)).toBeTruthy()
      expect(api.downloadAgentFile).not.toHaveBeenCalled()
    })
  })

  it('reports an offline runner instead of an empty folder', async () => {
    offline = 'agent_offline'
    renderBrowser()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/@wine is offline/)).toBeTruthy()
    expect(screen.queryByText('Empty folder')).toBeNull()
  })

  it('reports a runner too old to browse', async () => {
    offline = 'runner_too_old'
    renderBrowser()
    expect(await screen.findByText(/runner is too old/)).toBeTruthy()
  })

  it('a stand-in of another server\'s agent (404 remote_agent): says so, offers no retry', async () => {
    offline = 'remote_agent'
    renderBrowser()
    expect(await screen.findByText(ACCESS_ERROR_COPY.remote_agent as string)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(vi.mocked(api.listAgentFolder).mock.calls.length).toBe(1)
  })

  it('reports a change with no answer as result unknown and re-reads the folder', async () => {
    renderBrowser()
    await openInTree('memory')
    await screen.findByText('Memory notes')
    nextWrite = 'unknown'
    vi.spyOn(window, 'prompt').mockReturnValueOnce('maybe.txt')
    const listsBefore = vi.mocked(api.listAgentFolder).mock.calls.length
    fireEvent.click(within(header()).getByText('Add file'))
    fireEvent.click(screen.getByRole('menuitem', { name: /New file/ }))
    expect(await screen.findByText(/may or may not have happened/)).toBeTruthy()
    expect(screen.queryByText(/failed/i)).toBeNull()
    // The folder was re-read, and shows the file the runner did write.
    await waitFor(() => expect(vi.mocked(api.listAgentFolder).mock.calls.length).toBeGreaterThan(listsBefore))
    expect(await within(treeEl()).findByText('maybe.txt')).toBeTruthy()
  })
})
