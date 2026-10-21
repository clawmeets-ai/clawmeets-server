import Editor from 'react-simple-code-editor'
import hljs from 'highlight.js'

interface Props {
  value: string
  onChange: (next: string) => void
  isLoading?: boolean
  minHeight?: number
}

export default function JsonConfigEditor({ value, onChange, isLoading, minHeight = 360 }: Props) {
  return (
    <div
      className="w-full border border-gray-200 rounded-lg bg-gray-50/50 focus-within:ring-2 focus-within:ring-purple-500/20 focus-within:border-purple-400 overflow-auto"
      style={{ minHeight }}
    >
      <Editor
        value={value}
        onValueChange={onChange}
        highlight={(code) => hljs.highlight(code, { language: 'json', ignoreIllegals: true }).value}
        padding={10}
        autoFocus
        textareaClassName="focus:outline-none"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          minHeight,
        }}
        placeholder={isLoading ? 'Loading…' : undefined}
      />
    </div>
  )
}
