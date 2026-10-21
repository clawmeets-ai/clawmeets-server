import { useEffect, useRef, useState } from 'react'

/**
 * THE IN-PLACE EDITOR FOR ONE BLOCK — a textarea seeded with that block's raw
 * Markdown, auto-sized to its content, focused with the caret at the end.
 *
 * A TEXTAREA, NOT `contentEditable`. The reference prototype uses
 * `contentEditable` and it costs it three things a plain field gets for free:
 * the platform undo stack (a `contentEditable` span has none once React owns
 * its content), paste fidelity (pasted rich text lands as HTML nodes, which is
 * how markup nobody typed ends up in a plan document), and the announcement —
 * a screen reader reads a `contentEditable` span as a generic region, while a
 * textarea is announced as the multi-line field it is.
 *
 * IT SHOWS RAW MARKDOWN, INCLUDING THE MARKER. A list item opens as
 * `- [ ] ship it` and a heading as `## Goal`, because the marker is part of
 * what a block edit may legitimately change — that is how a box gets ticked by
 * hand and how a heading gets renamed. Hiding it would mean reconstructing it
 * on commit, which is a second grammar in the client.
 *
 * `plan-raw-edit` rides along on purpose: it is the class `PlanBody`'s
 * selection guard reads, so selecting text that is being WRITTEN never offers
 * to comment on it as though the document said it.
 */
export function PlanBlockEdit({
  src,
  multiline,
  label,
  onCommit,
  onCancel,
}: {
  /** The block's Markdown as the document reads it now — the seed, and the
   *  value a commit is compared against upstream. */
  src: string
  /** Does a bare Enter mean a newline here? True for a block whose source
   *  already spans lines: a wrapped paragraph, a multi-line quote, a list item
   *  with a continuation. */
  multiline: boolean
  label: string
  /** Called on Enter and on blur, with whatever is in the field — including
   *  text identical to `src`, which a blur on an untouched block produces every
   *  time. Dropping that no-op is the caller's job and it does it, because the
   *  same guard has to cover the section editor's blur too (AC-6.6). */
  onCommit: (next: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(src)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  // ESCAPE MUST BEAT BLUR. Cancelling moves focus, which fires `onBlur`, which
  // commits — so without this flag "Escape" and "commit" both run and the
  // cancel is the one that loses. A ref rather than state: the blur handler
  // reads it in the same tick, before any re-render could deliver it.
  const cancelled = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Grow to the content rather than scrolling inside a fixed box: the block is
  // rendered inline in the document, so a scrollbar here would hide the very
  // text being edited behind the line below it.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const commit = () => {
    if (cancelled.current) return
    onCommit(text)
  }

  return (
    <div className="plan-block-edit">
      <textarea
        ref={ref}
        // `plan-raw-edit` is the selection guard's class — see the header.
        className="plan-raw-edit plan-block-ta"
        aria-label={`Markdown for this ${label}`}
        value={text}
        rows={1}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancelled.current = true
            onCancel()
            return
          }
          // Cmd/Ctrl+Enter always commits, so the keyboard has one gesture that
          // works on every block. A bare Enter commits only where it cannot
          // mean a newline the user wanted.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !multiline)) {
            e.preventDefault()
            commit()
          }
        }}
      />
      <span className="plan-block-hint">
        {multiline ? 'Cmd/Ctrl+Enter' : 'Enter'} stages it · Escape cancels
      </span>
    </div>
  )
}
