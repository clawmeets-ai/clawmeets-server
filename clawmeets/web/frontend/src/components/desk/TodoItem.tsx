import { useEffect, useRef, useState } from 'react'
import { Check, Paperclip } from 'lucide-react'
import Avatar from '../common/Avatar'
import LabelChip from './LabelChip'
import TicketChip from './TicketChip'
import TodoRowMenu from './TodoRowMenu'
import { hasTicketChip } from '../../utils/ticketView'
import type { AgentStatus } from '../../types'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import type { RowChip } from '../../utils/labelView'

/** Max chars of the draft shown inline on the plate. Generous because the
 *  preview block is CSS-clamped to two lines — this only bounds the DOM text. */
const DRAFT_PREVIEW_LEN = 160

/** Preview of a saved draft: trim + collapse whitespace, slice to
 *  DRAFT_PREVIEW_LEN, append "…" when truncated. Empty string → caller falls
 *  back to the "Draft saved" label. */
function draftPreview(text?: string | null): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  return clean.length > DRAFT_PREVIEW_LEN
    ? clean.slice(0, DRAFT_PREVIEW_LEN).trimEnd() + '…'
    : clean
}

/**
 * The row title in edit mode.
 *
 * Its own component so the "already settled" flag can live in a ref beside the
 * field, which is what makes Esc DISCARD deterministically. Blur commits — the
 * owner chose saving over binning what they typed — and Esc has to disarm that
 * commit before the field unmounts, because whether removing a focused node
 * fires `focusout` is up to the engine. Relying on that would make Esc save on
 * some browsers and discard on others; the flag makes it discard on all of
 * them. The same flag stops Enter double-committing through the blur that
 * follows it.
 *
 * Focus is taken in an effect, not via `autoFocus`, and only when no other copy
 * of this field already holds it: grouped mode renders the same to-do once per
 * label it carries, so this can mount MORE THAN ONCE for a single rename, and
 * the later copy stealing focus would blur the first — which, with blur
 * committing, would close the edit the owner had just opened.
 */
function TodoTitleInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (text: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const settled = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement && active.classList.contains('todo-rename')) return
    el.focus()
    el.select()
  }, [])

  const commit = (value: string) => {
    if (settled.current) return
    settled.current = true
    onCommit(value)
  }

  return (
    <input
      ref={ref}
      className="todo-text todo-rename"
      defaultValue={initial}
      aria-label="Task title"
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit(e.currentTarget.value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          settled.current = true
          onCancel()
        }
      }}
    />
  )
}

/**
 * The row body: a <button> that loads the item, EXCEPT while the title is being
 * renamed, when it is a plain <div>.
 *
 * Not cosmetic. An <input> inside a <button> is invalid HTML, and the button
 * swallows the events the field needs — the caret will not place on click and
 * a drag-select of the text is read as a press of the button. Dropping to a div
 * for the duration removes both, and read mode is byte-identical to what it was
 * before, so nothing about loading a row changes.
 */
function BodyShell({
  renaming,
  onUse,
  children,
}: {
  renaming: boolean
  onUse: () => void
  children: React.ReactNode
}) {
  if (renaming) return <div className="todo-body">{children}</div>
  return (
    <button
      className="todo-body todo-body--open"
      onClick={onUse}
      title="Load into the message box"
    >
      {children}
    </button>
  )
}

interface DragWire {
  /** Grip pressed — begins a pointer drag for this row. */
  onGripDown: (t: DeskTodo, e: React.PointerEvent) => void
  /** Row body pressed — arms the hold timer. The hook ignores presses that land
   *  on a control of their own (checkbox, ⋮, +N, the rename field, the grip),
   *  so this can be wired to the row root unconditionally. */
  onRowDown: (t: DeskTodo, e: React.PointerEvent) => void
}

interface TodoItemProps {
  t: DeskTodo
  leaving?: boolean
  /** This to-do is the one currently loaded in the desk message box. */
  active?: boolean
  dragging?: boolean
  /** A hold is in progress on this row but has not become a drag yet — paints
   *  the "about to lift" squeeze, and is the only cue a touch user gets that
   *  the gesture was heard before it fires. */
  pressing?: boolean
  over?: boolean
  /** Which margin to light up while a drag hovers this row (up → top, down → bottom). */
  overEdge?: 'top' | 'bottom'
  wire?: DragWire
  /** The round checkbox — FILE IT AWAY, or put it back. It writes `archived`
   *  and nothing else; it never moves the derived ticket state, in either
   *  direction. */
  onArchive: (id: string) => void
  onRemove: (id: string) => void
  /** Row body clicked — load this to-do into the desk message box. Issues no
   *  request of its own: it never sends, completes, or deletes the item. */
  onUse: (t: DeskTodo) => void
  /** Presence of the saved draft's recipient. Resolved by the rail (it
   *  already holds the roster) so every row agrees, the same way `SopItem`
   *  takes its recipient. */
  draftToStatus?: AgentStatus
  /** Resolved labels for this row, already ordered and capped by `chipsFor()`.
   *
   *  Resolved by the RAIL, not per row — one registry read serves every row,
   *  the same way `rowPresence()` already serves the roster. It also has to be
   *  a PROP rather than a hook call here: rename, recolour and reorder change
   *  no to-do document, so a row memoized on to-do identity alone would never
   *  repaint after one. The registry is an input to row rendering, not a
   *  one-time read at mount. */
  chips?: { show: RowChip[]; more: number }
  /** The `+N` expansion is per-item and EPHEMERAL — `TodoRail` useState, never
   *  persisted. */
  expanded?: boolean
  onToggleExpand?: (id: string) => void
  /** Open the row's label popover. Absent ⇒ no label affordance (the
   *  Archived drawer). */
  onEditLabels?: (t: DeskTodo, anchor: HTMLElement) => void
  /** Grouped mode renders the SAME to-do under every label it carries, so the
   *  key has to disambiguate — and the drag hit-test attribute must NOT, or
   *  `elementFromPoint` could resolve an ambiguous id. Passing this swaps
   *  `data-todo-id` for `data-todo-instance`. */
  instanced?: boolean
  /** Title clicked — begin an inline rename. Absent ⇒ the title is plain text
   *  and the whole row body loads into the message box, which is what the
   *  Archived drawer wants: a filed-away task is a record, not a draft. */
  onStartRename?: (id: string) => void
  /** This row's title is being edited in place. RAIL-owned state, like
   *  `expanded` — grouped mode renders one to-do under every label it carries,
   *  and the copies must not disagree about whether it is in edit mode. */
  renaming?: boolean
  /** Commit a new title. Handed the raw field value; the hook trims it and
   *  no-ops on blank or unchanged. */
  onRename?: (id: string, text: string) => void
  /** Leave edit mode writing nothing (Esc). */
  onCancelRename?: () => void
  /** This row is currently rendered in MORE THAN ONE group. Duplication is
   *  free — every copy is one react-query record, so an archive propagates to
   *  all of them in one frame — but it has to be visible, or the same task
   *  twice on one screen reads as a bug. */
  dup?: boolean
  /** A hovered desk card's `projectId` appears in this row's `project_ids`.
   *  Orthogonal to `active` (loaded in the message box) — both can be true,
   *  and they paint on different channels so they stack. */
  linked?: boolean
  /** Pointer entered / left the row. Hands up the to-do id on enter and `null`
   *  on leave. Absent in the Archived drawer, which carries no cross-highlight:
   *  a filed-away task is a record, not live work on the plate. */
  onHover?: (todoId: string | null) => void
}

/**
 * One task on the plate. Quiet until hover; a round checkbox archives it, the
 * body loads the item into the desk message box, the TITLE renames it in place,
 * an invisible strip in the left gutter drags to reorder — as does a ~420ms
 * hold anywhere else on the row — and hover reveals a single `⋮` holding Labels
 * and Delete.
 *
 * EVERYTHING AHEAD OF THE TITLE IS THE BUDGET. On a narrow plate the task
 * wrapped to four or five lines because three pieces of permanent chrome ran
 * before its first character. Only the archive circle still sits in flex flow;
 * the grip left it for the gutter and the two action icons collapsed into one.
 * Re-adding a resting icon to either end is re-spending that budget.
 *
 * No trailing chevron. A right-pointing glyph reads as "this leads somewhere
 * else", and a click no longer goes anywhere — it fills the desk message box,
 * in place, next to the row. Three cues already say the row is clickable and
 * none of them mislead about where it goes: the body button's "Load into the
 * message box" tooltip, the hover card (`cursor: pointer`, raised border and
 * shadow), and the `is-open` accent the row wears while it is the one loaded.
 * The chevron also sat inside `.todo-actions`, so it only ever appeared on the
 * same hover that reveals trash and labels — it was never the thing that told
 * a resting row it could be clicked.
 *
 * Two hit areas, one row: the title claims a plain click for rename, and
 * everything else in the body — meta line, chips strip, whitespace — still
 * loads. That trade is deliberate. The title is the biggest target on the row,
 * so loading loses its most obvious handle; but a task's wording is the one
 * thing the plate could not change at all, and delete-and-recapture was the
 * only route to it, which costs the labels, the saved draft and the plate
 * position.
 *
 * The split only works while "everything else" is real pixels, which is a
 * LAYOUT invariant, not something the markup states. It failed on exactly one
 * shape — the plain to-do with no draft and no attachments —
 * where the meta line rendered empty and the title spanned the row, so every
 * click landed on rename and the item never reached the message box. Two things
 * hold the invariant now: the title box shrink-wraps to its text (CSS), so the
 * rest of the line still loads, and a row whose meta would be blank gets the
 * hit strip below instead. Anything that makes the title full-width again, or
 * drops the strip, brings the bug back.
 *
 * The writes to a to-do from here remain only the ones the user names
 * explicitly: the checkbox, the trash icon, and a rename they typed and
 * confirmed. Clicking the body is still free.
 */
export default function TodoItem({
  t,
  leaving,
  active,
  dragging,
  pressing,
  over,
  overEdge,
  wire,
  onArchive,
  onRemove,
  onUse,
  draftToStatus,
  chips,
  expanded,
  onToggleExpand,
  onEditLabels,
  onStartRename,
  renaming,
  onRename,
  onCancelRename,
  instanced,
  dup,
  linked,
  onHover,
}: TodoItemProps) {
  /** The overflow menu is open on THIS row. Local state, not rail-owned:
   *  rail-owned is the rule for anything two copies of a grouped row must
   *  agree on (`expanded`, `renaming`), and an open menu is the opposite — it
   *  belongs to the copy whose ⋮ was pressed. Its only job in the row is the
   *  `is-menu` class, which pins the hover-revealed cluster painted while the
   *  pointer is inside the popover. */
  const [menuOpen, setMenuOpen] = useState(false)
  const archived = t.archived
  // HOISTED ABOVE THE ARCHIVED EARLY RETURN, and rendered in BOTH branches.
  // The drawer no longer says anything about state, so an archived row whose
  // project is still running has to be visibly Working — this is an INVERSION
  // of the earlier round's design, where a finished row showed nothing.
  //
  // Derived from the row rather than passed as a prop, which is what makes that
  // free: the drawer renders `<TodoItem>` with no `chips` prop at all, so a chip
  // riding the `chips` path could not appear there without also dragging the
  // whole label strip back into a place that deliberately has none.
  //
  // A BOOLEAN, not the element, for the guards below. A JSX element is truthy
  // even when the component renders null, so guarding on `ticket` alone paints
  // an empty `.todo-labels` line on every New row that carries no labels.
  const ticket = hasTicketChip(t) ? <TicketChip t={t} /> : null
  // Real stored bytes.
  //
  // `?? []` even though the field is typed required: this row renders straight
  // off the ['desk-todos'] cache, and a server that predates the attachments
  // field would otherwise take the whole plate down rather than one badge.
  const attachCount = (t.attachments ?? []).length

  // Would the meta line render nothing?
  //
  // A blank meta is the one row shape with NO loadable pixels under the title,
  // and the title owns a plain click for rename — so on a plain self-captured
  // to-do the row had nothing left to click to load it. This flag is what
  // restores them: it renders `todo-hint--load` to state what the click does,
  // and puts `bare` on the row, which is where desk.css grows the body button
  // over the row's own padding so the whole row loads. In read mode the hint is
  // faded, never hidden — `visibility`/`display` would take its pixels with the
  // text, and those pixels ARE the hit target. The one exception is while the
  // title is being renamed, where the body is a div with no hit area to protect
  // and desk.css does hide the strip.
  const metaEmpty = !t.drafted && attachCount === 0

  // ONE BADGE, TWO HOMES. A drafted row addressed to someone already spends a
  // whole wrap line on the recipient, and that line ends well short of the
  // row's right edge — so the count rides it flush-right instead of claiming a
  // slot of its own in the `.todo-meta` wrap. Every other shape has no such
  // line, so the badge stays where it was.
  //
  // Same element and the same `title` in both homes: the existing
  // `getByTitle('N attachments')` assertions are about the CLAIM, not the
  // placement, and must keep passing wherever it lands.
  const attachOnDraftLine = !!(t.drafted && t.draft_recipient_name && attachCount > 0)
  const attachBadge = attachCount > 0 && (
    <span
      className={'todo-attach' + (attachOnDraftLine ? ' todo-attach--inline' : '')}
      title={`${attachCount} attachment${attachCount > 1 ? 's' : ''}`}
    >
      <Paperclip size={10} />
      {attachCount}
    </span>
  )

  if (archived) {
    return (
      <div className={'todo-item archived' + (menuOpen ? ' is-menu' : '')}>
        {/* THE CIRCLE ITSELF DOES NOT CHANGE — it is the thing the owner
            already knows. What changes is what it CLAIMS: the accessible name
            and the tooltip, which are now the only place the action is named at
            all (neither button had a tooltip before this). */}
        <button
          className="todo-check on"
          onClick={() => onArchive(t.id)}
          aria-label="Unarchive"
          title="Unarchive — put it back on your plate"
        >
          <Check size={12} />
        </button>
        <div className="todo-body">
          <div className="todo-text">{t.text}</div>
          {/* The one thing the drawer still says about this row. No `chips`
              prop reaches here, so the label strip stays absent. */}
          {ticket && <div className="todo-labels">{ticket}</div>}
        </div>
        {/* No `onEditLabels` reaches the drawer, so this renders a Delete-only
            menu — the same control the live rows carry, one item shorter. */}
        <div className="todo-actions">
          <TodoRowMenu onRemove={() => onRemove(t.id)} onOpenChange={setMenuOpen} />
        </div>
      </div>
    )
  }

  const cls =
    'todo-item' +
    // The row shape the strip above is for. A class rather than a `:has()` so
    // the CSS that reclaims its height is greppable from here — see
    // `.todo-item.bare` in desk.css, which stops the strip taking a flow line.
    (metaEmpty ? ' bare' : '') +
    (active ? ' is-open' : '') +
    (dragging ? ' dragging' : '') +
    // Never both: the hook clears `pressId` in the same breath as it sets
    // `dragId`, but the guard states the invariant rather than trusting it —
    // the two rules animate `transform` against each other.
    (pressing && !dragging ? ' pressing' : '') +
    (over ? (overEdge === 'bottom' ? ' drag-over-bottom' : ' drag-over-top') : '') +
    (dup ? ' dup' : '') +
    (linked ? ' linked' : '') +
    (menuOpen ? ' is-menu' : '') +
    (leaving ? ' leaving' : '')

  // Grouped rows carry `data-todo-instance` instead of `data-todo-id`, so
  // `usePointerReorder`'s elementFromPoint hit-test cannot see an ambiguous id
  // even if drag is re-enabled somewhere later by accident.
  const idAttr = instanced ? { 'data-todo-instance': t.id } : { 'data-todo-id': t.id }

  return (
    <div
      className={cls}
      {...idAttr}
      /* THE SECOND WAY INTO THE DRAG. The grip is a 16px transparent strip in
         the gutter that touch can never find; holding the row itself is the
         path that makes the plate orderable on a phone. Wired to the ROOT, not
         the body button, so the meta line and the row's own whitespace arm it
         too — `armLongPress` filters out presses that land on a control of
         their own, including the grip whose event bubbles through here. */
      onPointerDown={wire ? (e) => wire.onRowDown(t, e) : undefined}
      /* Only while a press is pending: on touch, a long hold over text raises
         the selection callout / context menu, which would eat the gesture
         mid-way. Guarded so a normal right-click on a resting row still
         works. */
      onContextMenu={pressing ? (e) => e.preventDefault() : undefined}
      onMouseEnter={onHover ? () => onHover(t.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      {dup && <span className="todo-dup" title="Also shown in another group" />}
      {/* NO GLYPH CHILD, AND NOW NO INK AT ALL. The handle was a six-dot
          `<GripVertical>`, then a 3px `::before` rail; it is now a transparent
          full-row-height strip in the panel's left gutter, out of flex flow
          entirely, which is the only version that gives the TITLE the width
          back — deleting the rail alone would have quieted the row and
          reclaimed nothing.
          `cursor: grab` is the last cue left, so a pointer crossing the gutter
          still finds it; touch gets none, which is the deliberate cost.
          Everything the drag depends on is unchanged: same element, same
          class, same `role`/`aria-label`, same `onPointerDown`, so
          `usePointerReorder` and the rail's drag tests see exactly what they
          saw before. */}
      {wire && (
        <span
          className="todo-grip"
          title="Drag to reorder"
          role="button"
          aria-label="Drag to reorder"
          onPointerDown={(e) => wire.onGripDown(t, e)}
        />
      )}

      <button
        className="todo-check"
        onClick={() => onArchive(t.id)}
        aria-label="Archive"
        title="Archive — file it away"
      >
        <Check size={12} />
      </button>

      <BodyShell renaming={!!renaming} onUse={() => onUse(t)}>
        {renaming ? (
          <TodoTitleInput
            initial={t.text}
            onCommit={(v) => onRename?.(t.id, v)}
            onCancel={() => onCancelRename?.()}
          />
        ) : onStartRename ? (
          /* `role="button"` on a div, NOT a <button>: the body around it is
             already a <button> in read mode, and the nesting is the same
             invalid-HTML trap the `+N` chip below documents. Click and the two
             keys are stopped from propagating so opening the editor never also
             loads the row into the message box — the whole point of the split
             hit area. */
          <div
            className="todo-text todo-text--edit"
            role="button"
            tabIndex={0}
            title="Click to rename"
            onClick={(e) => {
              e.stopPropagation()
              onStartRename(t.id)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              onStartRename(t.id)
            }}
          >
            {t.text}
          </div>
        ) : (
          <div className="todo-text">{t.text}</div>
        )}
        {/* Its OWN wrap line, above the meta and never folded into it: desk.css
            already gives the draft row a whole wrap line, and the label row
            has the same claim. */}
        {/* The guard widens for the ticket chip so a row carrying one but no
            labels still renders the line — and a NEW row with no labels still
            renders nothing at all, which is the point of `TicketChip`
            returning null.

            `ticket` is FIRST, and it is NOT a member of `chips.show`: CHIP_CAP
            still counts three LABELS and the `+N` arithmetic below is
            untouched, so the derived chip can never consume one of the row's
            three slots or disappear under the overflow. */}
        {(ticket || !!chips?.show.length) && (
          <div className={'todo-labels' + (expanded ? ' expanded' : '')}>
            {ticket}
            {chips?.show.map((l) => (
              <LabelChip key={l.slug} label={l} pinned={l.pinned} />
            ))}
            {/* `role="button"` on a span, NOT a <button>: the whole row is
                already a <button>, and a button inside a button is invalid
                HTML — the parser is entitled to hoist the inner one out, which
                makes both the `+N` toggle and the row's own click depend on the
                engine. A span with the role, the tab stop and the two keys is
                the same control without the nesting. */}
            {!!chips && chips.more > 0 && onToggleExpand && (
              <span
                className="lb-more"
                role="button"
                tabIndex={0}
                aria-label={`Show ${chips.more} more label${chips.more > 1 ? 's' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleExpand(t.id)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  e.stopPropagation()
                  onToggleExpand(t.id)
                }}
              >
                +{chips.more}
              </span>
            )}
          </div>
        )}
        <div className="todo-meta">
          {/* The blank-meta hit strip. `aria-hidden` because it is a pointer
              affordance and nothing else: it sits inside the body <button>, so
              without it the row's accessible name would grow this sentence,
              while the button's own `title` already says the same thing. */}
          {metaEmpty && (
            <span className="todo-hint todo-hint--load" aria-hidden="true">
              No draft yet — click to start one
            </span>
          )}
          {t.drafted && (
            <span className="todo-draft" title={t.draft_prompt ?? undefined}>
              <span className="todo-draft-msg">
                {draftPreview(t.draft_prompt) || 'Draft saved'}
              </span>
              {t.draft_recipient_name && (
                <span className="todo-draft-to">
                  <Avatar name={t.draft_recipient_name} status={draftToStatus} size="xs" />
                  <span className="todo-draft-who">@{shortAgent(t.draft_recipient_name)}</span>
                  {attachOnDraftLine && attachBadge}
                </span>
              )}
            </span>
          )}
          {!attachOnDraftLine && attachBadge}
        </div>
      </BodyShell>

      {/* TWO ICONS -> ONE. The rail's `onEditLabels(row, anchor)` contract is
          untouched; the anchor it now receives is the ⋮ button, which is where
          the label popover has to line up. */}
      <div className="todo-actions">
        <TodoRowMenu
          onEditLabels={onEditLabels ? (anchor) => onEditLabels(t, anchor) : undefined}
          onRemove={() => onRemove(t.id)}
          onOpenChange={setMenuOpen}
        />
      </div>
    </div>
  )
}

/** Short label for a stored full agent name (strip the "{owner}-" prefix). */
function shortAgent(fullName: string): string {
  const i = fullName.indexOf('-')
  return i >= 0 ? fullName.slice(i + 1) : fullName
}
