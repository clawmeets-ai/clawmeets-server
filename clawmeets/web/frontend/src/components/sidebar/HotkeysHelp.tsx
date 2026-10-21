import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { RAIL_SHORTCUTS } from './railShortcuts'

interface HotkeysHelpProps {
  open: boolean
  onClose: () => void
}

function Row({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-1.5">
      <span className="text-[13.5px] text-ink-1">{label}</span>
      <span className="flex items-center gap-1">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded font-mono text-[11px] font-bold text-ink-2"
            style={{ background: 'var(--bg-pill-muted)', border: '1px solid var(--line-2)' }}
          >
            {k}
          </kbd>
        ))}
      </span>
    </div>
  )
}

// Top-level keyboard shortcuts reference. Opened by the rail's "Keys" button or
// the `?` hotkey. Mirrors three sets of bindings — keep all three in sync:
//   * "Go to"  → Sidebar.tsx via RAIL_SHORTCUTS
//   * "My Desk" card nav → DeskPage.tsx's window keydown handler
//   * "My Desk" `@`      → DeskComposer.tsx's picker toggle
// The desk bindings used to also live in a right-rail legend (DeskShortcuts);
// that rail slot is the SOP library now, so this modal is their only home.
export default function HotkeysHelp({ open, onClose }: HotkeysHelpProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] px-4 bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-white rounded-[14px] overflow-hidden"
        style={{ boxShadow: 'var(--shadow-pop)', border: '1px solid var(--line-2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: 'var(--line-1)' }}
        >
          <span className="text-[13px] font-extrabold text-ink-1">Keyboard shortcuts</span>
          <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--bg-pill-muted)] text-ink-4">
            esc
          </span>
        </div>

        <div className="py-2">
          <div className="px-4 pt-1 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-ink-4">
            General
          </div>
          <Row keys={['⌘', 'K']} label="Search" />
          <Row keys={['?']} label="Keyboard shortcuts" />

          <div className="px-4 pt-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-ink-4">
            Go to
          </div>
          {RAIL_SHORTCUTS.map((s) => (
            <Row key={s.context} keys={['g', s.key]} label={s.label} />
          ))}

          <div className="px-4 pt-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-ink-4">
            My Desk
          </div>
          <Row keys={['J', 'K']} label="Move up / down" />
          <Row keys={['[', ']']} label="Jump section" />
          <Row keys={['Space']} label="Expand / collapse" />
          <Row keys={['R']} label="Send back" />
          <Row keys={['X']} label="Mark done" />
          <Row keys={['O']} label="Open thread" />
          <Row keys={['@']} label="Show / hide agent picker" />
          <Row keys={['Esc']} label="Clear selection" />
        </div>
      </div>
    </div>,
    document.body,
  )
}
