import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from 'highlight.js'
import MarkdownBody from '../shared/MarkdownBody'
import { highlightedCodeComponents } from './HighlightedCode'

/**
 * Extension → renderer for one file, shared by the project file viewer and
 * the agent home-folder pane. Callers fetch; this module only draws.
 */

/**
 * Map file extensions to highlight.js language identifiers
 */
function getLanguageForExtension(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase()
  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    xml: 'xml',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    vue: 'xml',
    svelte: 'xml',
  }
  return ext ? languageMap[ext] ?? null : null
}

/**
 * Check if file is a markdown file
 */
function isMarkdownFile(filename: string): boolean {
  return /\.md$/i.test(filename)
}

/**
 * Check if file is JSON/NDJSON
 */
function isJsonFile(filename: string): boolean {
  return /\.(json|ndjson)$/i.test(filename)
}

/**
 * Check if file is an image
 */
function isImageFile(filename: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(filename)
}

/**
 * Check if file is a PDF
 */
function isPdfFile(filename: string): boolean {
  return /\.pdf$/i.test(filename)
}

export function isHtmlFile(filename: string): boolean {
  return /\.(html|htm)$/i.test(filename)
}

function isAudioFile(filename: string): boolean {
  return /\.(mp3|wav|m4a|ogg|opus|aac|flac)$/i.test(filename)
}

function isVideoFile(filename: string): boolean {
  return /\.(mp4|webm|mov|m4v)$/i.test(filename)
}

/**
 * Check if file is a code file that should be syntax highlighted
 */
function isCodeFile(filename: string): boolean {
  return getLanguageForExtension(filename) !== null
}

/**
 * Format JSON content with pretty printing
 */
function formatJson(content: string): string {
  // Handle NDJSON: multiple JSON objects on separate lines
  const lines = content.trim().split('\n')
  if (lines.length > 1) {
    // Try to parse each line as JSON and format
    try {
      const formatted = lines
        .filter(line => line.trim())
        .map(line => JSON.stringify(JSON.parse(line), null, 2))
        .join('\n\n')
      return formatted
    } catch {
      // If any line fails, return original
      return content
    }
  }
  // Single JSON object
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

/**
 * Render content based on file type
 */
export function TextFilePreview({ filename, content, untrusted = false }: {
  filename: string
  content: string
  /** From another server (a Hub thread): Markdown renders untrusted (no image
   *  loads) and code is not highlighted, as in MarkdownBody's untrusted mode. */
  untrusted?: boolean
}) {
  const codeRef = useRef<HTMLElement>(null)

  useEffect(() => {
    // Apply syntax highlighting after render. highlightElement rewrites
    // innerHTML (the lint rule can't see it), but it is safe: it re-reads the
    // element's textContent and emits only escaped text in hljs spans.
    if (!untrusted && codeRef.current && (isCodeFile(filename) || isJsonFile(filename))) {
      hljs.highlightElement(codeRef.current)
    }
  }, [filename, content, untrusted])

  if (untrusted && isMarkdownFile(filename)) {
    return <MarkdownBody content={content} untrusted />
  }

  // Markdown rendering
  if (isMarkdownFile(filename)) {
    return (
      <div className="prose prose-gray max-w-none prose-headings:text-gray-900 prose-p:text-gray-800 prose-strong:text-gray-900 prose-li:text-gray-800 prose-td:text-gray-800 prose-th:text-gray-900">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={highlightedCodeComponents}>
        {content}
      </ReactMarkdown>
      </div>
    )
  }

  // JSON/NDJSON rendering with syntax highlighting
  if (isJsonFile(filename)) {
    const formatted = formatJson(content)
    return (
      <pre className="text-sm overflow-x-auto">
        <code ref={codeRef} className="language-json">
          {formatted}
        </code>
      </pre>
    )
  }

  // Code files with syntax highlighting
  if (isCodeFile(filename)) {
    const language = getLanguageForExtension(filename)
    return (
      <pre className="text-sm overflow-x-auto">
        <code ref={codeRef} className={language ? `language-${language}` : ''}>
          {content}
        </code>
      </pre>
    )
  }

  // Default: plain text
  return (
    <pre className="text-sm whitespace-pre-wrap break-words font-mono">
      {content}
    </pre>
  )
}

/**
 * Render binary file content (images, PDFs)
 */
export function BlobFilePreview({ filename, blobUrl, untrusted = false }: {
  filename: string
  blobUrl: string
  /** From another server (a Hub thread): HTML is not rendered, since its
   *  scripts and images would reach the network from the reader's browser. */
  untrusted?: boolean
}) {
  if (isImageFile(filename)) {
    return (
      <div className="flex items-center justify-center h-full">
        <img
          src={blobUrl}
          alt={filename}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    )
  }

  if (isPdfFile(filename)) {
    return (
      <iframe
        src={blobUrl}
        className="w-full h-full border-0"
        title={filename}
      />
    )
  }

  if (isHtmlFile(filename) && untrusted) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-gray-500 text-center">
          <p>This page came from another server, so it isn't opened here.</p>
          <a href={blobUrl} download={filename} className="text-blue-600 hover:underline mt-2 inline-block">
            Download file
          </a>
        </div>
      </div>
    )
  }

  if (isHtmlFile(filename)) {
    // sandbox without allow-same-origin forces an opaque origin, so the
    // rendered HTML cannot reach the parent's localStorage / cookies / DOM.
    return (
      <iframe
        src={blobUrl}
        className="w-full h-full border-0"
        title={filename}
        sandbox="allow-scripts"
      />
    )
  }

  if (isAudioFile(filename)) {
    return (
      <div className="flex items-center justify-center h-full">
        <audio src={blobUrl} controls className="w-full max-w-xl">
          Your browser does not support the audio element.
        </audio>
      </div>
    )
  }

  if (isVideoFile(filename)) {
    return (
      <div className="flex items-center justify-center h-full">
        <video src={blobUrl} controls className="max-w-full max-h-full">
          Your browser does not support the video element.
        </video>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center p-8">
      <div className="text-gray-500 text-center">
        <p>Binary file preview not available</p>
        <a href={blobUrl} download={filename} className="text-blue-600 hover:underline mt-2 inline-block">
          Download file
        </a>
      </div>
    </div>
  )
}

/** True for text files whose rendered form differs from their source, so the
 *  caller should offer a Rendered / Raw toggle. */
export function hasRenderedView(filename: string): boolean {
  return /\.(md|html|htm|svg)$/i.test(filename)
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
}

/** MIME type for the blob-rendered extensions. A blob served as
 *  `application/octet-stream` must be re-typed with this before it becomes an
 *  object URL, or the browser won't show an SVG, open a PDF or render HTML. */
export function mimeForFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}
