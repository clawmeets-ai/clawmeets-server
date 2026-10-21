import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import hljs from 'highlight.js'
import ExpandToggle from './ExpandToggle'
import { stripInvisible } from '../../utils/hubDisplay'

/**
 * Compact markdown components shared by chat messages and the desk cards.
 * Keeps headings small, links safe, and code highlighted.
 */
export const chatMarkdownComponents = {
  a: ({ children, ...props }: any) => (
    <a {...props} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
      {children}
    </a>
  ),
  // Bound image height so an async-loading image can't resize its row after
  // mount — that post-load reflow shifts scrollTop and jumps the viewport
  // inside the virtualized list.
  img: ({ ...props }: any) => (
    // eslint-disable-next-line jsx-a11y/alt-text
    <img {...props} loading="lazy" className="max-h-80 max-w-full rounded" />
  ),
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '')
    if (match) {
      let highlighted: string
      try {
        highlighted = hljs.highlight(String(children).replace(/\n$/, ''), { language: match[1] }).value
      } catch {
        highlighted = hljs.highlightAuto(String(children).replace(/\n$/, '')).value
      }
      return (
        <code
          className={className}
          dangerouslySetInnerHTML={{ __html: highlighted }}
          {...props}
        />
      )
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}

const UNTRUSTED_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/** The parsed URL when it is http, https or mailto; otherwise null. */
function safeUntrustedUrl(href: unknown): URL | null {
  if (typeof href !== 'string' || href === '') return null
  try {
    const url = new URL(href)
    return UNTRUSTED_SCHEMES.has(url.protocol) ? url : null
  } catch {
    return null
  }
}

/** The punycode host to show beside a link: the URL's host, or for mailto
 *  the domain of each address (a mailto URL has no host of its own). */
function shownHost(url: URL): string {
  if (url.protocol !== 'mailto:') return url.host
  try {
    return decodeURIComponent(url.pathname)
      .split(',')
      .map((addr) => {
        const at = addr.lastIndexOf('@')
        return at < 0 ? '' : new URL('http://' + addr.slice(at + 1).trim()).hostname
      })
      .filter(Boolean)
      .join(', ')
  } catch {
    return ''
  }
}

/** A link from untrusted text: an anchor only for http, https and mailto,
 *  with its punycode host (or a mailto address's domain) shown beside it.
 *  Anything else is plain text. */
function UntrustedLink({ href, children }: { href: unknown; children: ReactNode }) {
  const url = safeUntrustedUrl(href)
  if (!url) return <span>{children}</span>
  const host = shownHost(url)
  return (
    <>
      <a
        href={url.href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-blue-600 hover:underline"
      >
        {children}
      </a>
      {host && <span className="text-gray-500 text-xs"> ({host})</span>}
    </>
  )
}

/**
 * Components for markdown from outside this server (a remote hub agent's
 * message). Links are fenced by UntrustedLink and an image is never loaded:
 * it becomes a text link to its address. Code is plain text: no highlighter,
 * so no innerHTML, and no highlightAuto a sender could make run for seconds.
 */
const untrustedMarkdownComponents = {
  ...chatMarkdownComponents,
  a: ({ href, children }: any) => <UntrustedLink href={href}>{children}</UntrustedLink>,
  img: ({ src, alt }: any) => (
    <UntrustedLink href={src}>{`[image${alt ? ': ' + alt : ''}]`}</UntrustedLink>
  ),
  code: ({ className, children }: any) => <code className={className}>{children}</code>,
}

interface MarkdownBodyProps {
  content: string
  /**
   * When true, clamp to `collapsedHeightPx` (while `collapsed`) with a gradient
   * fade + a "Show more"/"Show less" toggle. When false, always full height.
   */
  clampable?: boolean
  /** Controlled collapsed state (only meaningful with `clampable`). */
  collapsed?: boolean
  /** Fired by the "Show more"/"Show less" button. */
  onToggle?: () => void
  collapsedHeightPx?: number
  /** Extra classes on the inner prose wrapper. */
  className?: string
  /**
   * Markdown from outside this server: invisible characters are stripped,
   * images never load, and only http, https and mailto links become anchors.
   * Default false leaves today's output unchanged.
   */
  untrusted?: boolean
}

/**
 * Rich-markdown renderer used by chatroom messages and My Desk cards. The full
 * markdown is always rendered; when `clampable` + `collapsed` it is clipped to
 * `collapsedHeightPx` with a fade so truncation never cuts mid-word/token.
 */
export default function MarkdownBody({
  content,
  clampable = false,
  collapsed = false,
  onToggle,
  collapsedHeightPx = 240,
  className,
  untrusted = false,
}: MarkdownBodyProps) {
  const [isOverflowing, setIsOverflowing] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // scrollHeight reports the intrinsic content height independently of any
  // max-height / overflow clamp, so we can measure once per content change
  // regardless of collapse state.
  useLayoutEffect(() => {
    if (!clampable) return
    const el = wrapperRef.current
    if (!el) return
    setIsOverflowing(el.scrollHeight > collapsedHeightPx + 1)
  }, [content, clampable, collapsedHeightPx])

  const body = (
    <div
      className={
        'prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-headings:text-gray-900 prose-p:text-gray-800 prose-strong:text-gray-900 prose-li:text-gray-800 break-words' +
        (className ? ' ' + className : '')
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={untrusted ? untrustedMarkdownComponents : chatMarkdownComponents}
      >
        {untrusted ? stripInvisible(content) : content}
      </ReactMarkdown>
    </div>
  )

  if (!clampable) return body

  const shouldClip = collapsed

  return (
    <div className="text-gray-800">
      <div
        ref={wrapperRef}
        className="relative"
        style={shouldClip ? { maxHeight: collapsedHeightPx, overflow: 'hidden' } : undefined}
      >
        {body}
        {shouldClip && isOverflowing && (
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-0 right-0 h-20"
            style={{
              // The fade must land on whatever surface the body is sitting on,
              // or it draws a wash of the wrong colour over the clipped text.
              // `--md-fade-to` lets that host name its own background; the
              // default is white because every other caller (chat messages)
              // renders on `bg-white`. The desk's `.md-card-quote` sets it to
              // the same token it paints itself with — see desk.css.
              background:
                'linear-gradient(to bottom, transparent, var(--md-fade-to, #fff) 85%)',
            }}
          />
        )}
      </div>
      {isOverflowing && onToggle && (
        <ExpandToggle expanded={!collapsed} onToggle={onToggle} />
      )}
    </div>
  )
}
