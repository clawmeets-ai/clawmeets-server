import { useId, useMemo, useState } from 'react'
import { Plus, Tag, X } from 'lucide-react'
import {
  MAX_LABELS_PER_TODO,
  type DeskLabel,
  type LabelKind,
} from '../../api/endpoints/deskLabels'
import {
  axisKnown,
  displayName,
  displayNameFrom,
  labelsOfKind,
  normalizeSlug,
  ORPHANED_WRITE_REFUSAL,
  resolveLabel,
  unknownAxisReason,
  type ResolvedRegistry,
} from '../../utils/labelView'
import LabelChip from './LabelChip'

/**
 * ONE MODULE for every surface that edits a to-do's labels — the capture box,
 * the row popover and the take-over editor. Not three: `@Office` typed in the
 * capture box and `@Office` picked in the take-over have to mean the same
 * thing, and two implementations of "what does this token mean" is exactly how
 * they stop meaning it.
 *
 * ── THE CAP, AND WHY IT IS GUARDED TWICE ─────────────────────────────────
 *
 * At 8 labels the add affordances go unavailable with the reason inline, and
 * the typed token STAYS AS LITERAL TEXT — it is not silently dropped, so the
 * owner keeps what they wrote and can delete a chip and retry without
 * retyping. The blocked ROWS are `aria-disabled` rather than `disabled`: a
 * disabled button leaves the tab order, so a keyboard user would meet an
 * absence where every other refusal in this rail gives a reason. The reason
 * renders ABOVE them and each blocked row is `aria-describedby` it.
 *
 * Not round-trip only: the browser is the one caller that always holds the
 * current list, so it can count without asking anyone. Refusing only on the
 * round trip means the owner types a 9th chip, watches it appear, and watches
 * it vanish ~200ms later — and because the browser sends a full REPLACE, the
 * 400 rejects the whole write, so the chips added before the 9th disappear
 * too. A bad failure produced entirely by choosing the wrong guard.
 *
 * Not input-time only either: the cap is reachable by RACE (the assistant or
 * another tab adds labels between this tab's last refetch and its PATCH), and
 * then `labels.cap_exceeded` comes back carrying the would-be RESULT size —
 * "got 10" on an 8-label item plus two, not "got 2". Client-side refusal is
 * UX; the server's 400 is the correctness boundary, and the client must not
 * act as if only one of them exists.
 *
 * COUNTED ON THE RESULT, not the input. That distinction used to earn a
 * behaviour — a state pick at the cap was a REPLACEMENT, so the set did not
 * grow and the pick stayed allowed. With at-most-one-state retired there is no
 * replacing pick left, so result and input now agree on every path. The shape
 * is kept because it is the correct one to count, not because a case still
 * needs it.
 */

export const CAP_REASON = `${MAX_LABELS_PER_TODO} labels is the maximum for one to-do.`

/**
 * Apply one pick to a label set. Pure, and the single definition of what a pick
 * MEANS — the cap check and the write both read it, so they cannot disagree
 * about the result.
 *
 * A PLAIN TOGGLE NOW. The at-most-one-state replacement is gone with the axis,
 * and it is worth noting what left with it: this branch was the ONLY
 * enforcement of "one state per to-do" anywhere in the product — no server
 * constraint, no schema, just these three lines. Nothing enforces it any more
 * because there is nothing left to enforce; a context has never been exclusive.
 */
export function applyPick(value: string[], slug: string): string[] {
  if (value.includes(slug)) return value.filter((s) => s !== slug)
  return [...value, slug]
}

/** Would this pick exceed the cap? Reads the RESULT, never the input. */
export function pickExceedsCap(value: string[], slug: string): boolean {
  return applyPick(value, slug).length > MAX_LABELS_PER_TODO
}

export interface LabelInputProps {
  /** Slugs currently on the draft or the item. */
  value: string[]
  registry: ResolvedRegistry
  onChange: (slugs: string[]) => void
  /** Inline create. Resolves with the created row so the caller can attach it
   *  in the same gesture; rejects with an ApiError the caller renders. */
  onCreate: (name: string, kind: LabelKind) => Promise<DeskLabel>
  /** A failure from the last write — usually the cap 400 that beat the
   *  input-time guard by a race. */
  error?: string | null
  onManage?: () => void
  onRetry?: () => void
  /** May a NEW label be created from here? False under an orphaned registry,
   *  where a create overwrites the list the server could not read. Defaults to
   *  true so nothing silently loses the ability to create by omission. */
  writable?: boolean
}

/**
 * The picker: the row popover's body and the take-over's editor.
 *
 * Under a lost registry it keeps the half that needs no registry — REMOVING a
 * slug this row already carries is a write to the to-do — and drops the half
 * that does. Without that branch the popover offers to "add to your list"
 * every label the owner already owns, and each tap 409s.
 */
export default function LabelInput({
  value,
  registry,
  onChange,
  onCreate,
  error,
  onManage,
  onRetry,
  writable = true,
}: LabelInputProps) {
  const [draft, setDraft] = useState('')
  const [localError, setLocalError] = useState('')
  const known = axisKnown(registry.state)
  const atCap = value.length >= MAX_LABELS_PER_TODO

  const contexts = labelsOfKind(registry, 'context')
  const carriedUnregistered = value.filter((s) => !registry.index.has(s))

  const capId = useId()

  const pick = (slug: string) => {
    // The blocked rows are `aria-disabled`, not `disabled`, so a click still
    // ARRIVES here — this early return is what actually refuses it. The reason
    // is not restated: `.pop-cap` is already on screen above these rows and
    // every blocked row is `aria-describedby` it, so saying it twice would put
    // the same sentence in two places on one popover.
    if (!value.includes(slug) && pickExceedsCap(value, slug)) return
    setLocalError('')
    onChange(applyPick(value, slug))
  }

  const submitCreate = () => {
    const raw = draft.trim()
    if (!raw) return
    const { slug, fault } = normalizeSlug(raw)
    if (fault === 'invalid_slug') {
      setLocalError('Use letters, numbers and hyphens.')
      return
    }
    // REFUSED at input time rather than truncated — the server 400s a slug
    // over 32 chars, so a client-side .slice() would send a value it rejects.
    if (fault === 'slug_too_long') {
      setLocalError(`“${slug}” is too long — 32 characters is the maximum.`)
      return
    }
    // Refused for the same reason the manage sheet's add forms are gone: an
    // unreadable registry materializes as zero rows, so a create writes ONE
    // row over the owner's whole list. The typed text stays put.
    if (!writable) {
      setLocalError(ORPHANED_WRITE_REFUSAL)
      return
    }
    if (atCap) return
    // The cross-kind clash check is gone with the second kind: one namespace,
    // one kind, so a name the registry already has is simply that label and
    // attaching it is the right answer.
    if (registry.index.has(slug)) {
      pick(slug)
      setDraft('')
      return
    }
    onCreate(displayNameFrom(raw), 'context')
      .then((l) => {
        onChange(applyPick(value, l.slug))
        setDraft('')
        setLocalError('')
      })
      .catch(() => {
        /* the caller surfaces it through `error` */
      })
  }

  if (!known) {
    return (
      <>
        <div className="pop-row off">
          <span className="bx rd" />
          Your labels<span className="ct">—</span>
        </div>
        <div className="pop-why">
          {unknownAxisReason(registry.state)} We can't show what this could carry yet. These are
          the labels it has now — you can still take one off.
        </div>
        {value.length ? (
          value.map((slug) => (
            <div className="pop-row unregrow on" key={slug}>
              <span className="bx" />
              <span className="unreg-nm">{slug}</span>
              <button
                className="mini-x"
                aria-label={`Remove ${slug} from this to-do`}
                onClick={() => onChange(value.filter((s) => s !== slug))}
              >
                <X size={10} />
              </button>
            </div>
          ))
        ) : (
          <div className="pop-why">None.</div>
        )}
        {onRetry && (
          <>
            <div className="pop-div" />
            <button className="pop-foot" onClick={onRetry}>
              <Tag size={12} />
              Try again
            </button>
          </>
        )}
      </>
    )
  }

  return (
    <>
      {/* ABOVE the rows it explains, not below them. With a large registry in a
          max-height scroller a note at the foot is below the fold while the
          owner is pressing dead rows at the head — and `aria-describedby` can
          only point at something that exists before it is needed. */}
      {atCap && (
        <div className="pop-cap" id={capId}>
          {CAP_REASON} Take one off to add another.
        </div>
      )}
      <div className="pop-sec">Context — pick any</div>
      {contexts.map((l) => {
        const on = value.includes(l.slug)
        const blocked = !on && atCap
        return (
          <button
            key={l.slug}
            className={'pop-row' + (on ? ' on' : '')}
            aria-pressed={on}
            // `aria-disabled`, NOT `disabled`: a disabled button leaves the tab
            // order, so a keyboard or screen-reader user at the cap meets an
            // absence where every other refusal in this rail gives a reason.
            // The row stays focusable, announces itself as unavailable, and
            // carries the reason with it; `pick` is what actually refuses.
            aria-disabled={blocked}
            aria-describedby={blocked ? capId : undefined}
            onClick={() => pick(l.slug)}
          >
            <span className="bx" />
            {displayName(resolveLabel(l.slug, registry))}
          </button>
        )
      })}
      {/* Any unregistered slug this row carries is listed too — otherwise the
          only way to SEE it is the chip and the only way to remove it is to
          guess. */}
      {carriedUnregistered.map((slug) => (
        <div className="pop-row unregrow on" key={slug}>
          <span className="bx" />
          <span className="unreg-nm">@{slug}</span>
          {/* Not offered while the registry is unwritable: the sheet it routes
              to is shut in that state, so the button would be a promise the
              next screen breaks. */}
          {onManage && writable && (
            <button className="mini-add" onClick={onManage}>
              Add to list
            </button>
          )}
          <button
            className="mini-x"
            aria-label={`Remove @${slug} from this to-do`}
            onClick={() => onChange(value.filter((s) => s !== slug))}
          >
            <X size={10} />
          </button>
        </div>
      ))}

      {(error || localError) && <div className="pop-err">{error || localError}</div>}

      <div className="pop-div" />
      {!writable && <div className="pop-cap calm">{ORPHANED_WRITE_REFUSAL}</div>}
      <input
        className="pop-mini"
        value={draft}
        disabled={atCap || !writable}
        placeholder={
          atCap
            ? CAP_REASON
            : !writable
              ? "Can't add a label right now"
              : 'New label…  ↵ to create'
        }
        aria-label="Create a label"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submitCreate()
          }
        }}
      />
      {onManage && (
        <button className="pop-foot" onClick={onManage}>
          <Tag size={12} />
          Manage labels…
        </button>
      )}
    </>
  )
}

/* ───────────────────────────── capture box ──────────────────────────────── */

export interface CaptureToken {
  query: string
}

/** The live `@…` token at the caret, or null. ONE SIGIL: `!` retired with the
 *  state axis, so a typed `!` is now ordinary text and stays in the to-do —
 *  which is the right outcome rather than a regression, since there is no
 *  longer an axis for it to name. */
export function captureToken(text: string): CaptureToken | null {
  const m = /@([\w-]*)$/.exec(text)
  return m ? { query: m[1] } : null
}

export interface CaptureMenu {
  token: CaptureToken
  hits: DeskLabel[]
  canCreate: boolean
  atCap: boolean
  /** Why this token cannot become a label, when that is the reason there is
   *  nothing to offer. SAYING SO is the point: a menu that just vanishes at
   *  the 33rd character leaves the owner to discover the refusal from a 400 on
   *  submit, which is the outcome refusing at input time exists to avoid. */
  fault: 'slug_too_long' | null
  /** Set when creating is refused because the REGISTRY cannot be written, not
   *  because of anything about the token. Rendered as its own note — without
   *  it this refusal is a menu that simply does not appear, which is the
   *  silent-vanish failure the `fault` field above exists to avoid. */
  refusal: string | null
}

/**
 * What the capture autocomplete should offer, given the live text.
 *
 * THE CONFIRM RULE, and it is the only thing standing between `@` and a junk
 * label: only a token that MATCHES AN EXISTING LABEL or is EXPLICITLY ACCEPTED
 * from this menu (Tab / Enter / click) is ever stripped from the text.
 * Everything else stays literal. Blind-stripping any `@word` loses a word from
 * "ask @assistant about the Provi PO" and invents a label from it — and since
 * `@` no longer disambiguates against agents, the confirm step is the only
 * thing left that does.
 */
export function captureMenu(
  text: string,
  value: string[],
  reg: ResolvedRegistry,
  writable = true,
): CaptureMenu | null {
  const token = captureToken(text)
  if (!token || !axisKnown(reg.state)) return null
  const pool = labelsOfKind(reg, 'context')
  const q = token.query.toLowerCase()
  const hits = pool.filter((l) => l.name.toLowerCase().startsWith(q))
  const atCap = value.length >= MAX_LABELS_PER_TODO
  const norm = normalizeSlug(token.query)
  const fault = norm.fault === 'slug_too_long' ? ('slug_too_long' as const) : null
  const wouldCreate =
    !atCap &&
    token.query.length >= 2 &&
    norm.fault === null &&
    !pool.some((l) => l.name.toLowerCase() === q)
  // Say it rather than withhold it: under an orphaned registry `hits` is empty
  // too, so a bare `canCreate: false` would make the whole menu vanish and the
  // owner would meet the refusal as a 400 on submit.
  const refusal = wouldCreate && !writable ? ORPHANED_WRITE_REFUSAL : null
  const canCreate = wouldCreate && writable
  if (!hits.length && !canCreate && !atCap && !fault && !refusal) return null
  return { token, hits, canCreate, atCap, fault, refusal }
}

/** Strip the accepted token from the capture text. Called ONLY on an explicit
 *  accept — never speculatively. */
export function stripToken(text: string): string {
  return text.replace(/@[\w-]*$/, '')
}

export interface CaptureLabelsProps {
  menu: CaptureMenu
  index: number
  registry: ResolvedRegistry
  onAccept: (slug: string) => void
  onCreate: (name: string, kind: LabelKind) => void
}

/** The autocomplete list under the capture box. */
export function CaptureLabels({
  menu,
  index,
  registry,
  onAccept,
  onCreate,
}: CaptureLabelsProps) {
  const { token, hits, canCreate, atCap } = menu
  const menu_fault = (m: CaptureMenu) =>
    m.fault === 'slug_too_long' ? (
      <div className="ac-note">
        That name is too long — <b>32 characters</b> is the maximum for a label.
      </div>
    ) : null
  return (
    <div className="ac" role="listbox" aria-label="Contexts">
      <div className="ac-sec">Contexts — pick any</div>
      {hits.map((l, i) => (
        <button
          key={l.slug}
          className={'ac-row' + (i === index ? ' cur' : '')}
          role="option"
          aria-selected={i === index}
          onClick={() => onAccept(l.slug)}
        >
          <LabelChip label={resolveLabel(l.slug, registry)} />
          <span className="k">{i === index ? '↵' : ''}</span>
        </button>
      ))}
      {canCreate && (
        <button
          className={'ac-row ac-new' + (index === hits.length ? ' cur' : '')}
          onClick={() => onCreate(token.query, 'context')}
        >
          <Plus size={12} /> Create context{' '}
          <b style={{ marginLeft: 2 }}>@{token.query}</b>
          <span className="k">{index === hits.length ? '↵' : ''}</span>
        </button>
      )}
      {atCap && <div className="ac-note">{CAP_REASON}</div>}
      {menu.refusal && <div className="ac-note">{menu.refusal}</div>}
      {menu_fault(menu)}
    </div>
  )
}

/** How many rows the menu offers, for arrow-key wrapping. */
export function menuLength(menu: CaptureMenu): number {
  return menu.hits.length + (menu.canCreate ? 1 : 0)
}

/** The pending chips under the capture box — a GHOST LINE, not tokens in
 *  place: the input is ~220px inside a ~260px rail, and in-place tokens at
 *  that width make the caret behaviour fiddly. */
export function CaptureChips({
  value,
  registry,
  onRemove,
}: {
  value: string[]
  registry: ResolvedRegistry
  onRemove: (slug: string) => void
}) {
  const chips = useMemo(
    () => value.map((s) => resolveLabel(s, registry)),
    [value, registry],
  )
  if (!chips.length) return null
  return (
    <div className="cap-chips">
      {chips.map((l) => (
        <LabelChip key={l.slug} label={l} onRemove={() => onRemove(l.slug)} />
      ))}
    </div>
  )
}
