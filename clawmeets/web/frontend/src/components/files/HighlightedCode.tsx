import hljs from 'highlight.js'

/**
 * The trusted Markdown file preview's code blocks, highlighted by highlight.js.
 * Its own file because it is the one raw-HTML render in components/files/:
 * hljs output is escaped HTML, and only this file is exempt from the
 * raw-HTML lint ban (.eslintrc.cjs). An untrusted file never reaches it
 * (FilePreview sends untrusted Markdown to MarkdownBody).
 */

/**
 * Custom components for ReactMarkdown with syntax highlighting
 */
export const highlightedCodeComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '')
    if (match) {
      const language = match[1]
      let highlighted: string
      try {
        highlighted = hljs.highlight(String(children).replace(/\n$/, ''), { language }).value
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
