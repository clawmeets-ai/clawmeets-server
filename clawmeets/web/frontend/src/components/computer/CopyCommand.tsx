import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

/**
 * One shell command, shown WHOLE, with a copy button.
 *
 * Never truncated and never scrolled-out-of-view, because of the one case this
 * exists for: the computer is awake but not answering, so every button on the
 * page is dead and the keyboard is the only path left. A command the user can
 * half-see is no help at that moment.
 *
 * Same pattern the offline note in chat already uses for `clawmeets start`, so
 * a user who has met one has met both.
 */
export default function CopyCommand({
  command,
  label,
}: {
  command: string
  /** What this command is for, above the command itself. Optional. */
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard blocked (insecure context / permission denied). The command
      // is selectable text either way, so leave the button idle rather than
      // claiming a copy that did not happen.
    }
  }

  return (
    <div>
      {label && (
        <div className="text-[11.5px] font-semibold mb-1" style={{ color: 'var(--ink-3)' }}>
          {label}
        </div>
      )}
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-lg"
        style={{ background: 'var(--bg-rail)', border: '1px solid var(--line-2)' }}
      >
        <span className="font-mono text-[12px] select-none" style={{ color: 'var(--ink-4)' }}>
          $
        </span>
        {/* `break-all` rather than a horizontal scroller: a wrapped command is
            still readable and still copyable, a clipped one is neither. */}
        <code
          className="flex-1 font-mono text-[12px] break-all"
          style={{ color: 'var(--ink-1)' }}
        >
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : `Copy ${command}`}
          title={`Copy "${command}"`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold shrink-0"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--line-2)',
            color: copied ? 'var(--accent-deep)' : 'var(--ink-2)',
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
