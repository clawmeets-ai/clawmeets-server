import { Loader, TriangleAlert } from 'lucide-react'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import { hasTicketChip, ticketLabel } from '../../utils/ticketView'

/**
 * The derived ticket state, rendered OUTSIDE the label-chip path.
 *
 * A SIBLING OF `LabelChip`, deliberately not a variant of it. Sharing that
 * component is what would leak the sigil and the palette back in, and the
 * separation buys a guarantee stronger than a convention: this file imports
 * neither `labelView` nor `LabelChip`, so a ticket chip CANNOT be produced by
 * `chipsFor()`, counted by `labelCounts()`, grouped by `groupTodos()`, or fall
 * under `+N` — it never enters any of those functions' inputs, and there is no
 * line anyone could add here that would change that without an import.
 *
 * No sigil (a sigil is a claim about the label axis). No palette token — colour
 * is how the owner recognises labels THEY minted, and this is not one. No
 * `slug`, no `pinned`, no registry lookup, and no prop but the row itself: it
 * derives from `t.state`, which is what lets the Archived drawer render it
 * without also restoring the label strip.
 *
 * IT RETURNS NULL FOR `new`. A blank row is a New row — there is no third
 * visual, and the most common row on a fresh plate looks exactly as it did
 * before this feature. The decision itself lives in ONE place,
 * `ticketView.hasTicketChip`, which this reads rather than restates: the strip
 * guard in `TodoItem` needs the same answer as a boolean, and a JSX element is
 * truthy even when the component renders null.
 */
export default function TicketChip({ t }: { t: DeskTodo }) {
  if (!hasTicketChip(t)) return null

  const word = ticketLabel(t.state)
  // "linked", never "running" or "active": `association_count` is the STORED
  // count, so a dangling id is inside it — and "3 linked" stays true with one
  // there, where "3 running" would not.
  const n = t.association_count
  const title = n > 0 ? `${word} · ${n} linked` : word

  return (
    <span className={'tk tk-' + t.state} title={title} aria-label={title}>
      {t.state === 'working' && <Loader size={9} aria-hidden="true" />}
      {/* Failed carries a glyph for the same reason Working does: on an
          archived row the chip is the only thing saying what happened, and
          "Failed" in the urgent palette is a colour claim a colour-blind
          reader cannot check. Not a second channel for `completed` — nothing
          goes wrong there, so there is nothing to flag. */}
      {t.state === 'failed' && <TriangleAlert size={9} aria-hidden="true" />}
      {word}
    </span>
  )
}
