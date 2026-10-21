// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../../..')
const SRC = join(ROOT, 'src')

// Same flags as `npm run lint`: no comment can lift a rule.
const eslint = new ESLint({ cwd: ROOT, allowInlineConfig: false })

async function lint(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) })
  return result.messages.map((m) => m.ruleId ?? m.message)
}

describe('the hub lint fence', () => {
  it('fails dangerouslySetInnerHTML under components/hub/', async () => {
    const code = 'export const X = ({ t }: { t: string }) => <div dangerouslySetInnerHTML={{ __html: t }} />\n'
    expect(await lint(code, 'src/components/hub/Fixture.tsx')).toContain('no-restricted-syntax')
  })

  it('fails dangerouslySetInnerHTML passed as an object property', async () => {
    const code = "import { createElement } from 'react'\nexport const X = (t: string) => createElement('div', { dangerouslySetInnerHTML: { __html: t } })\n"
    expect(await lint(code, 'src/components/hub/Fixture.tsx')).toContain('no-restricted-syntax')
  })

  it('fails a MarkdownBody import under components/hub/', async () => {
    const code = "import MarkdownBody from '../shared/MarkdownBody'\nexport const X = () => <MarkdownBody content=\"\" />\n"
    expect(await lint(code, 'src/components/hub/Fixture.tsx')).toContain('no-restricted-imports')
  })

  it('fails a MarkdownBody import in the Hub channel card', async () => {
    const code = "import MarkdownBody from '../../shared/MarkdownBody'\nexport const X = () => <MarkdownBody content=\"\" />\n"
    expect(await lint(code, 'src/components/settings/agent/HubChannelCard.tsx')).toContain('no-restricted-imports')
  })

  it.each([
    'src/components/sidebar/PublicPanel.tsx',
    'src/components/sidebar/FrontDeskPanel.tsx',
    'src/components/settings/agent/ChannelsSection.tsx',
  ])('covers %s, a non-hub file that draws hub text, and the file passes as written', async (file) => {
    const html = 'export const X = ({ t }: { t: string }) => <div dangerouslySetInnerHTML={{ __html: t }} />\n'
    expect(await lint(html, file)).toContain('no-restricted-syntax')
    const md = "import MarkdownBody from '../shared/MarkdownBody'\nexport const X = () => <MarkdownBody content=\"\" />\n"
    expect(await lint(md, file)).toContain('no-restricted-imports')
    expect(await lint(readFileSync(join(ROOT, file), 'utf8'), file)).toEqual([])
  })

  it('fails a MarkdownBody with no untrusted attribute under components/chatroom/', async () => {
    const bare = "import MarkdownBody from '../shared/MarkdownBody'\nexport const X = () => <MarkdownBody content=\"\" />\n"
    expect(await lint(bare, 'src/components/chatroom/Fixture.tsx')).toContain('no-restricted-syntax')
    const stated = "import MarkdownBody from '../shared/MarkdownBody'\nexport const X = ({ u }: { u: boolean }) => <MarkdownBody content=\"\" untrusted={u} />\n"
    expect(await lint(stated, 'src/components/chatroom/Fixture.tsx')).toEqual([])
    const html = 'export const X = ({ t }: { t: string }) => <div dangerouslySetInnerHTML={{ __html: t }} />\n'
    expect(await lint(html, 'src/components/chatroom/Fixture.tsx')).toContain('no-restricted-syntax')
  })

  const ROOM_SURFACES = [
    'src/components/chatroom/Fixture.tsx',
    'src/components/dm/DMChatView.tsx',
    'src/components/project/ActivityFeed.tsx',
    'src/components/desk/UpdateCard.tsx',
    'src/components/files/FileViewerModal.tsx',
  ]
  const MD = "import MarkdownBody from '../shared/MarkdownBody'\n"

  it.each(ROOM_SURFACES)('rejects untrusted={false} and a misplaced attribute in %s', async (file) => {
    const literalFalse = `${MD}export const X = () => <MarkdownBody content="" untrusted={false} />\n`
    expect(await lint(literalFalse, file)).toContain('no-restricted-syntax')
    const nested = `${MD}const Y = (p: { untrusted?: boolean }) => null\n`
      + 'export const X = () => <MarkdownBody content="" components={{ a: () => <Y untrusted /> }} />\n'
    expect(await lint(nested, file)).toContain('no-restricted-syntax')
    const bare = `${MD}export const X = () => <MarkdownBody content="" />\n`
    expect(await lint(bare, file)).toContain('no-restricted-syntax')
    const stated = `${MD}export const X = ({ u }: { u: boolean }) => <MarkdownBody content="" untrusted={u} />\n`
    expect(await lint(stated, file)).toEqual([])
  })

  it.each(ROOM_SURFACES)('rejects the trust-rule bypass (useUntrustedBodies alone) in %s', async (file) => {
    // The blocker's pattern: the whole-room rule with no per-author rule.
    const bypass = "import { useUntrustedBodies } from '../../hooks/useUntrustedBodies'\n" + MD
      + 'export const X = ({ p }: { p: string }) => {\n'
      + "  const untrusted = useUntrustedBodies(p, 'workroom')\n"
      + '  return <MarkdownBody content="" untrusted={untrusted} />\n}\n'
    expect(await lint(bypass, file)).toContain('no-restricted-syntax')
  })

  it('rejects useUntrustedBodies in any component, but not in the hook that wraps it', async () => {
    const call = "import { useUntrustedBodies } from '../../hooks/useUntrustedBodies'\nexport const X = () => useUntrustedBodies('p', 'r')\n"
    expect(await lint(call, 'src/components/sidebar/Fixture.tsx')).toContain('no-restricted-syntax')
    expect(await lint(call, 'src/components/hub/Fixture.tsx')).toContain('no-restricted-syntax')
    const file = 'src/hooks/useRoomTrust.ts'
    expect(await lint(readFileSync(join(ROOT, file), 'utf8'), file)).toEqual([])
  })

  it.each([
    'src/components/dm/DMChatView.tsx',
    'src/components/project/ActivityFeed.tsx',
    'src/components/desk/UpdateCard.tsx',
    'src/components/files/FileViewerModal.tsx',
    'src/components/files/FilePreview.tsx',
    'src/components/files/HighlightedCode.tsx',
    'src/components/files/FileList.tsx',
    'src/components/files/FileItem.tsx',
    'src/components/chatroom/ChatroomView.tsx',
    'src/components/chatroom/StagedAttachments.tsx',
  ])('the room surface %s passes as written', async (file) => {
    expect(await lint(readFileSync(join(ROOT, file), 'utf8'), file)).toEqual([])
  })

  it('keeps the raw-HTML ban on FilePreview; only HighlightedCode is exempt', async () => {
    const html = 'export const X = ({ t }: { t: string }) => <div dangerouslySetInnerHTML={{ __html: t }} />\n'
    expect(await lint(html, 'src/components/files/FilePreview.tsx')).toContain('no-restricted-syntax')
    expect(await lint(html, 'src/components/files/HighlightedCode.tsx')).not.toContain('no-restricted-syntax')
  })
  it.each([
    'src/components/chatroom/MessageItem.tsx',
    'src/components/chatroom/ForwardModal.tsx',
  ])('the room renderer %s passes as written', async (file) => {
    expect(await lint(readFileSync(join(ROOT, file), 'utf8'), file)).toEqual([])
  })

  it('cannot be lifted by an eslint-disable comment', async () => {
    const code = '/* eslint-disable */\nexport const X = ({ t }: { t: string }) => <div dangerouslySetInnerHTML={{ __html: t }} />\n'
    expect(await lint(code, 'src/components/hub/Fixture.tsx')).toContain('no-restricted-syntax')
  })

  it('passes HubMessageBody as written', async () => {
    const file = 'src/components/hub/HubMessageBody.tsx'
    expect(await lint(readFileSync(join(ROOT, file), 'utf8'), file)).toEqual([])
  })

  it('still fails dangerouslySetInnerHTML inside HubMessageBody', async () => {
    const code = 'export default ({ t }: { t: string }) => <div dangerouslySetInnerHTML={{ __html: t }} />\n'
    expect(await lint(code, 'src/components/hub/HubMessageBody.tsx')).toContain('no-restricted-syntax')
  })

  it('leaves files outside the hub alone', async () => {
    const code = "import MarkdownBody from './MarkdownBody'\nexport const X = () => <MarkdownBody content=\"\" />\n"
    expect(await lint(code, 'src/components/shared/Fixture.tsx')).toEqual([])
  })
})

describe('stated file trust', () => {
  const FILE_SURFACES = [
    'src/components/dm/Fixture.tsx',
    'src/components/chatroom/Fixture.tsx',
    'src/components/desk/UpdateCard.tsx',
    'src/components/files/Fixture.tsx',
    'src/components/sidebar/Fixture.tsx',
    'src/components/hub/Fixture.tsx',
  ]
  const imports = "import FileList from '../files/FileList'\nimport FileItem from '../files/FileItem'\nimport FileViewerModal from '../files/FileViewerModal'\n"
  const bad = {
    // The DM Files sidebar before the fix.
    'a FileList with no isOutsideFile': 'export const X = () => <FileList files={[]} projectId="p" chatroomName="r" />\n',
    'a FileList answering a literal false': 'export const X = () => <FileList files={[]} projectId="p" chatroomName="r" isOutsideFile={() => false} />\n',
    'a FileItem with no outside': 'export const X = ({ f }: { f: never }) => <FileItem file={f} projectId="p" chatroomName="r" />\n',
    'a FileItem with outside={false}': 'export const X = ({ f }: { f: never }) => <FileItem file={f} projectId="p" chatroomName="r" outside={false} />\n',
    'a chatroom FileViewerModal with no untrusted': 'export const X = () => <FileViewerModal projectId="p" chatroomName="r" filename="a.html" onClose={() => {}} />\n',
    'a chatroom FileViewerModal with untrusted={false}': 'export const X = () => <FileViewerModal projectId="p" chatroomName="r" filename="a.html" untrusted={false} onClose={() => {}} />\n',
  }

  for (const [name, code] of Object.entries(bad)) {
    it.each(FILE_SURFACES)(`fails ${name} in %s`, async (file) => {
      expect(await lint(imports + code, file)).toContain('no-restricted-syntax')
    })
  }

  it('passes stated trust, and a staged local file with none', async () => {
    const good = imports + [
      'export const A = ({ o }: { o: (n: string) => boolean }) => <FileList files={[]} projectId="p" chatroomName="r" isOutsideFile={o} />',
      'export const B = ({ f, o }: { f: never; o: boolean }) => <FileItem file={f} projectId="p" chatroomName="r" outside={o} />',
      'export const C = ({ u }: { u: boolean }) => <FileViewerModal projectId="p" chatroomName="r" filename="a" untrusted={u} onClose={() => {}} />',
      'export const D = ({ f }: { f: File }) => <FileViewerModal file={f} filename="a" onClose={() => {}} />',
    ].join('\n') + '\n'
    expect(await lint(good, 'src/components/dm/Fixture.tsx')).toEqual([])
  })
})

// Backstop for scripts/assert-no-hub-leak.py: the strings are built by
// concatenation, as the guard does, so this file never trips the guard.
const HUB_TOKEN_PREFIX = 'cm' + 'hub_'
const HUB_ROUTE = '/' + '_hub' + '/'
const HUB_PKG = 'clawmeets' + '_hub'

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* sourceFiles(p)
    else yield p
  }
}

describe('no hub secrets in the frontend source', () => {
  it('contains no hub token prefix, private route segment or private package name', () => {
    const hits: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const needle of [HUB_TOKEN_PREFIX, HUB_ROUTE, HUB_PKG]) {
        if (text.includes(needle)) hits.push(`${file.slice(ROOT.length + 1)}: ${needle}`)
      }
    }
    expect(hits).toEqual([])
  })
})

// Only MarkdownBody draws a message body. These four import react-markdown for
// text that never comes from a message (see .eslintrc.cjs).
const REACT_MARKDOWN_IMPORTERS = [
  'src/components/files/FilePreview.tsx',
  'src/components/project/plan/PlanBody.tsx',
  'src/components/sample-request/SampleRequestBody.tsx',
  'src/components/shared/MarkdownBody.tsx',
]

describe('the react-markdown fence', () => {
  const md = "import ReactMarkdown from 'react-markdown'\nexport const X = ({ t }: { t: string }) => <ReactMarkdown>{t}</ReactMarkdown>\n"

  it.each([
    'src/components/project/ActivityFeed.tsx',
    'src/components/desk/UpdateCard.tsx',
    'src/components/chatroom/Fixture.tsx',
    'src/hooks/fixture.tsx',
    'src/components/hub/Fixture.tsx',
    'src/components/hub/HubMessageBody.tsx',
  ])('fails a react-markdown import in %s', async (file) => {
    expect(await lint(md, file)).toContain('no-restricted-imports')
  })

  it('fails a MarkdownBody with no untrusted attribute under components/chatroom/', async () => {
    const bare = "import MarkdownBody from '../shared/MarkdownBody'\nexport const X = () => <MarkdownBody content=\"\" />\n"
    expect(await lint(bare, 'src/components/chatroom/Fixture.tsx')).toContain('no-restricted-syntax')
    const stated = "import MarkdownBody from '../shared/MarkdownBody'\nexport const X = ({ u }: { u: boolean }) => <MarkdownBody content=\"\" untrusted={u} />\n"
    expect(await lint(stated, 'src/components/chatroom/Fixture.tsx')).toEqual([])
    const html = 'export const X = ({ t }: { t: string }) => <div dangerouslySetInnerHTML={{ __html: t }} />\n'
    expect(await lint(html, 'src/components/chatroom/Fixture.tsx')).toContain('no-restricted-syntax')
  })

  it.each([
    'src/components/chatroom/MessageItem.tsx',
    'src/components/chatroom/ForwardModal.tsx',
  ])('the room renderer %s passes as written', async (file) => {
    expect(await lint(readFileSync(join(ROOT, file), 'utf8'), file)).toEqual([])
  })

  it('cannot be lifted by an eslint-disable comment', async () => {
    expect(await lint('/* eslint-disable */\n' + md, 'src/components/project/ActivityFeed.tsx')).toContain('no-restricted-imports')
  })

  it.each(REACT_MARKDOWN_IMPORTERS)('lets %s import it', async (file) => {
    expect(await lint(md, file)).not.toContain('no-restricted-imports')
  })

  it('no other source file imports react-markdown', () => {
    const importers: string[] = []
    for (const file of sourceFiles(SRC)) {
      if (/\.test\.tsx?$/.test(file)) continue
      if (/from ['"]react-markdown['"]/.test(readFileSync(file, 'utf8'))) importers.push(file.slice(ROOT.length + 1))
    }
    expect(importers.sort()).toEqual(REACT_MARKDOWN_IMPORTERS)
  })
})
