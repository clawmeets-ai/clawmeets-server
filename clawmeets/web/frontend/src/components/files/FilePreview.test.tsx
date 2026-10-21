import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { BlobFilePreview, TextFilePreview, hasRenderedView, mimeForFilename } from './FilePreview'

/**
 * Which renderer each extension gets. Both the project file viewer and the
 * agent home-folder pane draw through this module, so a file looks the same
 * wherever it is opened.
 */

afterEach(cleanup)

describe('TextFilePreview', () => {
  it('renders markdown as formatted text', () => {
    const { container } = render(<TextFilePreview filename="notes.md" content={'# Title\n\n**bold**'} />)
    expect(container.querySelector('h1')?.textContent).toBe('Title')
    expect(container.querySelector('strong')?.textContent).toBe('bold')
  })

  it('pretty-prints and highlights JSON and NDJSON', () => {
    const { container } = render(<TextFilePreview filename="data.json" content={'{"a":1}'} />)
    const code = container.querySelector('code.language-json')!
    expect(code.textContent).toBe('{\n  "a": 1\n}')
    expect(code.classList.contains('hljs')).toBe(true)
    cleanup()
    const nd = render(<TextFilePreview filename="log.ndjson" content={'{"a":1}\n{"b":2}'} />)
    expect(nd.container.querySelector('code')?.textContent).toBe('{\n  "a": 1\n}\n\n{\n  "b": 2\n}')
  })

  it('highlights code by extension and leaves other text plain', () => {
    const { container } = render(<TextFilePreview filename="run.py" content="print(1)" />)
    expect(container.querySelector('code.language-python')).toBeTruthy()
    cleanup()
    const plain = render(<TextFilePreview filename="notes.txt" content="hello" />)
    expect(plain.container.querySelector('code')).toBeNull()
    expect(plain.container.querySelector('pre')?.textContent).toBe('hello')
  })
})

describe('BlobFilePreview', () => {
  it('shows images, PDFs, sandboxed HTML and media with their own element', () => {
    const at = (filename: string) => render(<BlobFilePreview filename={filename} blobUrl="blob:x" />).container
    expect(at('a.png').querySelector('img')?.getAttribute('src')).toBe('blob:x')
    expect(at('a.svg').querySelector('img')).toBeTruthy()
    expect(at('a.pdf').querySelector('iframe')?.hasAttribute('sandbox')).toBe(false)
    expect(at('a.html').querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(at('a.mp3').querySelector('audio')).toBeTruthy()
    expect(at('a.mp4').querySelector('video')).toBeTruthy()
  })

  it('offers a download for a binary it cannot draw', () => {
    const { getByText } = render(<BlobFilePreview filename="a.zip" blobUrl="blob:x" />)
    expect(getByText('Download file').getAttribute('download')).toBe('a.zip')
  })
})

describe('hasRenderedView', () => {
  it('is true only where the rendered view hides the source', () => {
    for (const f of ['a.md', 'a.HTML', 'a.htm', 'a.svg']) expect(hasRenderedView(f)).toBe(true)
    for (const f of ['a.json', 'a.py', 'a.png', 'a.txt']) expect(hasRenderedView(f)).toBe(false)
  })
})

describe('mimeForFilename', () => {
  it('types the blob-rendered extensions and falls back to octet-stream', () => {
    expect(mimeForFilename('a.PNG')).toBe('image/png')
    expect(mimeForFilename('a.jpeg')).toBe('image/jpeg')
    expect(mimeForFilename('a.svg')).toBe('image/svg+xml')
    expect(mimeForFilename('a.pdf')).toBe('application/pdf')
    expect(mimeForFilename('dir/a.html')).toBe('text/html')
    expect(mimeForFilename('a.mp4')).toBe('video/mp4')
    expect(mimeForFilename('a.bin')).toBe('application/octet-stream')
    expect(mimeForFilename('Makefile')).toBe('application/octet-stream')
  })
})
