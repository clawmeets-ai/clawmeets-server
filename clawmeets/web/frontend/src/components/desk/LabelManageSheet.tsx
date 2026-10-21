import { useEffect, useRef, useState } from 'react'
import { GripVertical, Info, Plus, Tag, Trash2, X } from 'lucide-react'
import type { DeskLabel, LabelKind, PaletteToken } from '../../api/endpoints/deskLabels'
import { useLabels } from '../../hooks/useLabels'
import { usePointerReorder } from '../../hooks/usePointerReorder'
import { labelErrorMessage } from '../../utils/labelErrors'
import {
  cycleColor,
  displayName,
  displayNameFrom,
  labelsOfKind,
  nextColor,
  normalizeSlug,
  resolveLabel,
  unknownAxisReason,
  type RegistryContent,
  type ResolvedRegistry,
} from '../../utils/labelView'

/**
 * Rename, recolour, reorder, merge, delete — the whole registry.
 *
 * ONE SECTION AND ONE ADD CONTROL. There used to be two of each, one per kind,
 * and the split was positional precisely because kind was immutable and
 * consequential. `state` is retired, so there is one kind, one section, and no
 * field on this form that can be mis-set.
 *
 * WHAT THIS SHEET DELIBERATELY DOES NOT OFFER: any affordance to "clean up" a
 * label an owner minted under the old axis. A registry written before the
 * retirement keeps its rows — the server coerces a stored `state` row to a
 * context on read — so Next / Wait For / Some Day arrive here as ordinary
 * contexts, and they stay attached to real to-dos. They are the owner's to
 * delete or keep, through the same Trash affordance as any other row, and
 * nothing on this screen suggests they are stale.
 */

export interface LabelManageSheetProps {
  registry: ResolvedRegistry
  /** The rail's `diagnoseRegistry` verdict. The sheet CANNOT derive this — it
   *  never sees the plate — and without it `orphaned` arrives here as an
   *  ordinary `ready` registry with no rows, which reads as "no labels yet"
   *  and offers to re-add the owner's whole vocabulary over a file the server
   *  could not parse. */
  content: RegistryContent
  /** How many to-dos carry each slug — the delete confirm reads this out
   *  BEFORE the call, and `detached_from` on the response confirms it after. */
  refCounts: Map<string, number>
  /** Slugs on the plate the registry does not know, in first-seen order. */
  unregistered: string[]
  onClose: () => void
  /** Surfaced by the rail's toast — the sheet is a panel, not a page, and a
   *  failure has to be visible even after it closes. */
  flash: (msg: string) => void
}

export default function LabelManageSheet({
  registry,
  content,
  refCounts,
  unregistered,
  onClose,
  flash,
}: LabelManageSheetProps) {
  const { create, rename, recolour, reorder, remove, merge, refetch } = useLabels()
  const [adding, setAdding] = useState<LabelKind | null>(null)
  const [addError, setAddError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [mergeInto, setMergeInto] = useState('')
  const [draftNames, setDraftNames] = useState<Record<string, string>>({})
  const [announce, setAnnounce] = useState('')
  const addInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (adding) addInput.current?.focus()
  }, [adding])

  const contexts = labelsOfKind(registry, 'context')

  const moveTo = (from: string, to: string) => {
    const order = registry.labels.map((l) => l.slug)
    const i = order.indexOf(from)
    const j = order.indexOf(to)
    if (i < 0 || j < 0 || i === j) return
    const [moved] = order.splice(i, 1)
    order.splice(j, 0, moved)
    reorder(order).catch((err) => flash(labelErrorMessage(err)))
  }

  // A SECOND drag surface, hit-testing on `data-label-slug` rather than
  // `data-todo-id`. The attribute split is what prevents elementFromPoint
  // crossing into the rail underneath — which is why the hook is parameterised
  // rather than loosened to a shared class.
  const { dragId, overId, startDrag } = usePointerReorder(moveTo, { attr: 'data-label-slug' })

  /** Keyboard reorder. A pointer drag is unreachable by keyboard, and
   *  reordering the registry is the ONLY way to control group order — so a
   *  keyboard-only owner would otherwise have no route to it at all. Not a
   *  design change: the drag is untouched, this is a second route to the same
   *  operation. */
  const onGripKey = (e: React.KeyboardEvent, slug: string) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const siblings = labelsOfKind(registry, 'context').map((l) => l.slug)
    const i = siblings.indexOf(slug)
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1
    if (j < 0 || j >= siblings.length) return
    moveTo(slug, siblings[j])
    setAnnounce(`${slug} moved to position ${j + 1} of ${siblings.length}`)
  }

  const submitAdd = () => {
    const raw = addInput.current?.value.trim() ?? ''
    const kind = adding!
    const { slug, fault } = normalizeSlug(raw)
    if (fault === 'invalid_slug') {
      setAddError('Give it a name — letters, numbers and hyphens.')
      return
    }
    // REFUSED at input time rather than truncated: the server answers a long
    // slug with labels.slug_too_long and rejects the write, so a client-side
    // .slice() would send a value it will not take.
    if (fault === 'slug_too_long') {
      setAddError(`“${slug}” is too long — 32 characters is the maximum.`)
      return
    }
    // The cross-kind clash branch is gone with the second kind: one namespace,
    // one kind, so a name already in the registry is simply a duplicate and the
    // next line already says so.
    if (registry.index.has(slug)) {
      setAddError(`You already have ${displayName(resolveLabel(slug, registry))}.`)
      return
    }
    create({
      name: displayNameFrom(raw),
      slug,
      kind,
      // The client always sends `color` EXPLICITLY, so the swatch the owner saw
      // is the colour that lands — no round-trip flash where a create renders
      // one colour then repaints to another. The server holds the same rule for
      // the CLI and the seed, which have no palette knowledge.
      color: nextColor(registry.labels),
    })
      .then(() => {
        setAdding(null)
        setAddError('')
      })
      .catch((err) => setAddError(labelErrorMessage(err, { slug })))
  }

  const confirmDelete = () => {
    const slug = pendingDelete!
    const done = () => {
      setPendingDelete(null)
      setMergeInto('')
    }
    if (mergeInto) {
      merge(slug, mergeInto)
        .then((r) => {
          flash(`${slug} merged into ${mergeInto} — ${r.moved} to-do${r.moved === 1 ? '' : 's'} moved.`)
          done()
        })
        .catch((err) => flash(labelErrorMessage(err, { slug })))
      return
    }
    remove(slug)
      .then((r) => {
        flash(
          `${slug} deleted — detached from ${r.detached_from} to-do${
            r.detached_from === 1 ? '' : 's'
          }. None were removed.`,
        )
        done()
      })
      .catch((err) => flash(labelErrorMessage(err, { slug })))
  }

  const row = (l: DeskLabel) => {
    const resolved = resolveLabel(l.slug, registry)
    return (
      <div
        className={
          'mg' +
          (dragId === l.slug ? ' dragging' : '') +
          (overId === l.slug && dragId && dragId !== l.slug ? ' drag-over' : '')
        }
        key={l.slug}
        data-label-slug={l.slug}
      >
        <button
          className="mg-drag"
          title="Drag to reorder — or focus and press ↑ / ↓"
          aria-label={`Reorder ${displayName(resolved)}`}
          onPointerDown={(e) => startDrag(l.slug, e)}
          onKeyDown={(e) => onGripKey(e, l.slug)}
        >
          <GripVertical size={13} />
        </button>
        <button
          className="mg-sw"
          style={{
            background: l.color ? `var(--lb-${l.color}-bg)` : '#fff',
            borderColor: l.color ? `var(--lb-${l.color}-fg)` : 'var(--line-2)',
          }}
          title="Colour"
          aria-label={`Change colour of ${displayName(resolved)}`}
          onClick={() => {
            const next = cycleColor(l.color)
            recolour(l.slug, next).catch((err) =>
              flash(labelErrorMessage(err, { slug: l.slug })),
            )
          }}
        />
        <input
          className="mg-in"
          value={draftNames[l.slug] ?? l.name}
          aria-label={`Rename ${displayName(resolved)}`}
          onChange={(e) => setDraftNames((d) => ({ ...d, [l.slug]: e.target.value }))}
          onBlur={(e) => {
            const name = displayNameFrom(e.target.value)
            setDraftNames((d) => {
              const next = { ...d }
              delete next[l.slug]
              return next
            })
            if (!name || name === l.name) return
            // PATCH carries name/color ONLY — never `kind`. Renaming is by
            // SLUG, so references on every to-do survive it untouched.
            rename(l.slug, name).catch((err) =>
              flash(labelErrorMessage(err, { slug: l.slug })),
            )
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              setDraftNames((d) => {
                const next = { ...d }
                delete next[l.slug]
                return next
              })
            }
          }}
        />
        <span className="mg-n">{refCounts.get(l.slug) ?? 0}</span>
        <button
          className="mg-a dz"
          title="Delete or merge"
          aria-label={`Delete or merge ${displayName(resolved)}`}
          onClick={() => {
            setPendingDelete(l.slug)
            setMergeInto('')
            setAdding(null)
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    )
  }

  const addBlock = (kind: LabelKind) => {
    if (adding !== kind) {
      return (
        <button className="mg-add" onClick={() => { setAdding(kind); setAddError('') }}>
          <Plus size={12} />
          Add a {kind}
        </button>
      )
    }
    return (
      <div className="mg-form">
        <input
          ref={addInput}
          className="mg-fin"
          placeholder="office, garage, deep-work…"
          aria-label={`New ${kind} name`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAdd()
            if (e.key === 'Escape') setAdding(null)
          }}
        />
        <div className="mg-fnote">
          A to-do can carry <b>any number</b> of contexts. They are alternatives — a filter on two
          means "either".
        </div>
        {addError && <div className="mg-ferr">{addError}</div>}
        <div className="btns">
          <button className="pri" onClick={submitAdd}>
            Add {kind}
          </button>
          <button onClick={() => setAdding(null)}>Cancel</button>
        </div>
      </div>
    )
  }

  const warn = () => {
    if (!pendingDelete) return null
    const l = resolveLabel(pendingDelete, registry)
    const n = refCounts.get(pendingDelete) ?? 0
    // One kind, so every other registered row is a legal merge target. The
    // same-kind guard is not weakened, it is satisfied by construction — and
    // the server still refuses a cross-kind merge with `labels.kind_mismatch`,
    // which stays mapped for a registry that predates the retirement.
    const others =
      l.kind === 'unknown'
        ? []
        : labelsOfKind(registry, 'context').filter((o) => o.slug !== l.slug)
    // NOTE WHAT IS NOT HERE: the "This is your last state — grouping by state
    // will switch off" warning. There is no state kind to be the last of, and
    // grouping by ticket state cannot be switched off by deleting a label,
    // because it reads no label at all.
    return (
      <div className="mg-warn" role="alertdialog" aria-label="Confirm">
        Remove <b>{displayName(l)}</b> from {n} to-do{n === 1 ? '' : 's'}? The to-dos themselves
        stay on your plate.
        <select
          value={mergeInto}
          aria-label="Merge target"
          onChange={(e) => setMergeInto(e.target.value)}
        >
          <option value="">— or merge it into another label —</option>
          {others.map((o) => (
            <option key={o.slug} value={o.slug}>
              Merge into {displayName(resolveLabel(o.slug, registry))}
            </option>
          ))}
        </select>
        <div className="btns">
          <button className="pri" onClick={confirmDelete}>
            Confirm
          </button>
          <button onClick={() => setPendingDelete(null)}>Cancel</button>
        </div>
      </div>
    )
  }

  // The sheet IS the registry. With no registry it has nothing to manage, and
  // every control in it would be a lie: the sections would read empty ("you
  // have no contexts"), the add forms would collide with labels that do exist,
  // and the unregistered section would offer to add back the owner's whole
  // vocabulary. One honest panel instead.
  //
  // TWO WAYS TO HAVE NO REGISTRY, and the second one is why `content` is a
  // prop. `unavailable` is "the request failed". `orphaned` is worse: the
  // request SUCCEEDED and returned zero rows, because the file on disk could
  // not be parsed — so `state` is `ready` and the old guard was false. That
  // left every control live over an unreadable file, and the unregistered
  // section listing the owner's entire real vocabulary under "written by an
  // agent" with one-tap re-add. Tapping it appends one row to an empty list
  // and saves, overwriting bytes that may still have been recoverable.
  //
  // Same shutdown, different sentence — the situations are not the same and
  // the reassurance is not the same.
  const orphaned = content === 'orphaned'
  const unavailable = !registry.labels.length && registry.state !== 'ready'
  const shut = orphaned || unavailable

  return (
    <div className="sheet" onMouseDown={onClose}>
      <div className="sheet-c" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Manage labels">
        <div className="sheet-h">
          <Tag size={14} /> Manage labels
          <span style={{ flex: 1 }} />
          <button className="pop-x" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="sheet-b">
          <span aria-live="polite" className="sr-only">
            {announce}
          </span>

          {shut ? (
            orphaned ? (
              <div className="mg-none">
                <b>Your label list came back empty, but your to-dos still carry labels.</b>{' '}
                Nothing has been lost — the labels are still on your to-dos, so nothing here has
                been renamed or deleted. This usually clears on its own.{' '}
                {/* The last clause is load-bearing. It is what stops the owner
                    "helpfully" re-creating labels over a file that may still be
                    recoverable — which is precisely what this panel replaced. */}
                <button onClick={refetch}>Try again</button> — and if it is still empty in a few
                minutes, tell your assistant before adding anything back.
              </div>
            ) : (
              <div className="mg-none">
                <b>{unknownAxisReason(registry.state)}</b> Nothing has been lost — your labels are
                still on your to-dos, we just can't read the list right now, so there is nothing
                safe to rename, recolour or delete here.
              </div>
            )
          ) : (
            <>
              {!registry.labels.length && (
                <div className="mg-none">
                  <b>No labels yet.</b> Add a <b>context</b> to say where a task can be done, or a{' '}
                  <b>state</b> to say what is happening to it. Nothing is built in — these are
                  yours.
                </div>
              )}

              <div className="pop-sec">
                Labels — <span className="sec-card">any number per to-do</span>
              </div>
              {contexts.map(row)}
              {addBlock('context')}

              {!!unregistered.length && (
                <>
                  <div className="pop-sec">
                    Not in your list — written by an agent or a voice edit
                  </div>
                  {unregistered.map((slug) => (
                    <UnregisteredRow
                      key={slug}
                      slug={slug}
                      count={refCounts.get(slug) ?? 0}
                      onAdd={(kind) =>
                        create({ name: slug, slug, kind, color: nextColor(registry.labels) }).catch(
                          (err) => flash(labelErrorMessage(err, { slug })),
                        )
                      }
                    />
                  ))}
                </>
              )}

              {warn()}

              <div className="mg-foot">
                The number is how many to-dos carry the label. Deleting <b>detaches</b> it — it
                never deletes a to-do — and merging repoints those to-dos at another label. Drag to
                reorder (or focus a grip and press ↑ / ↓): that order is the order groups appear in
                and the order chips render in.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * An unregistered slug, and the one verb that resolves it.
 *
 * There used to be a fork — `@` or `!` — because an agent that wrote
 * `waiting-on-bank` had no way to say which axis it meant, so the owner had to.
 * One kind left, so there is nothing to ask: one tap adds it.
 */
function UnregisteredRow({
  slug,
  count,
  onAdd,
}: {
  slug: string
  count: number
  onAdd: (kind: LabelKind) => void
}) {
  return (
    <div className="mg">
      <span className="mg-drag" style={{ opacity: 0 }} aria-hidden="true">
        <GripVertical size={13} />
      </span>
      <span className="mg-sw unreg" title="No colour until you add it" />
      <span className="mg-in mg-ro">@{slug}</span>
      <span className="mg-n">{count}</span>
      <button
        className="mg-a add"
        title="Add it to your label list"
        aria-label={`Add ${slug} to your label list`}
        onClick={() => onAdd('context')}
      >
        @
      </button>
    </div>
  )
}

/** Kept beside the sheet because it is the only consumer: the palette values
 *  live in CSS, and this is the one place a token has to become a swatch. */
export function swatchStyle(color: PaletteToken | null) {
  return color
    ? { background: `var(--lb-${color}-bg)`, borderColor: `var(--lb-${color}-fg)` }
    : undefined
}

/** Re-exported so the sheet's callers do not each import `Info`. */
export const SheetInfoIcon = Info
