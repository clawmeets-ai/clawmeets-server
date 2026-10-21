import { ChevronDown, ChevronRight } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import type { BandId, BandTone } from './deskBands'

export interface CardBandProps {
  id: BandId
  expanded: boolean
  onToggle: () => void
  /** `'warn'` is set from `!!plan.deviation` and from NOTHING else. Red is
   *  reserved for a real deviation: an absence — no plan, front-desk, no report
   *  — is muted grey, and a merely-waiting card is accent. Nothing missing is
   *  ever drawn red. */
  tone?: BandTone
  /** 'Report' | 'Plan · the contract' | 'Response' */
  label: string
  /** `.md-cs-def` — the one-line definition, EXPANDED state only. */
  definition?: string
  /** Right-hand status pills. */
  pill?: ReactNode
  /** Mono right-aligned trailer: `rev N`, or the report's kind. */
  rev?: ReactNode
  /** The one FOLDED line: the quote, the receipt, the contract's state. */
  foldMeta: string
  /** 'Answer' | 'Review deviation' | 'Open contract' | 'Read' */
  foldCta: string
  children?: ReactNode
}

/**
 * One collapsible band on a desk card — the shell only. Two states, one
 * component, so the folded row and the expanded body cannot drift apart in
 * their tone or their label.
 *
 * FOLDING IS NEVER DESTRUCTIVE and every band is reachable by click. The folded
 * row renders entirely from what the card already has in hand (`PlanSummary`,
 * the quote, the report stamp) — it issues no request. That is not an
 * optimisation, it is the request-cost mitigation the design is built on: see
 * the note at the PLAN band's call site in `UpdateCard`.
 *
 * N4 — IT IS A DISCLOSURE, AND IT SAYS SO. Both states carry `aria-expanded`
 * and `aria-controls`, following `LabelFilter.tsx`'s in-repo pattern rather
 * than inventing one. Without them a folded band is announced as a plain
 * button: a screen-reader user is told "Plan · the contract, 2 changes waiting
 * on you, Review, button" with nothing saying there is a collapsed region
 * behind it, and nothing that changes when they open it.
 *
 * `aria-controls` names the panel in BOTH states even though the panel is not
 * in the DOM while folded: the editor and the report body must stay UNMOUNTED
 * while folded (a mounted compact `PlanEditor` is a `GET …/plan` per card), so
 * there is no always-rendered panel to point at. The dangling reference is the
 * accepted cost; a rendered-but-hidden panel would cost a request per card on
 * every desk load.
 */
export function CardBand({
  id,
  expanded,
  onToggle,
  tone = 'plain',
  label,
  definition,
  pill,
  rev,
  foldMeta,
  foldCta,
  children,
}: CardBandProps) {
  // M1 — GENERATED PER INSTANCE, never derived from `id`. The band ids are
  // compile-time constants ('report' | 'plan' | 'response') and `DeskPage`
  // renders one `UpdateCard` per feed item, so a derived id repeats on every
  // card: two projects in `spec-ing` both open their PLAN band and the DOM
  // holds two `id="band-panel-plan"`. A screen-reader user on the second card
  // follows `aria-controls`, `getElementById` returns the first match, and they
  // are read the FIRST project's contract with no signal that they moved.
  //
  // `useId` is safe across the fold because `CardBand` ITSELF NEVER UNMOUNTS —
  // only its children do — so the value is stable through the toggle and is the
  // same in both branches below. Declared above the early return so the hook
  // stays unconditional.
  const panelId = useId()

  if (!expanded) {
    return (
      <button
        type="button"
        className={'md-fold' + (tone === 'plain' ? '' : ' md-fold--' + tone)}
        onClick={onToggle}
        aria-expanded={false}
        aria-controls={panelId}
        data-testid={`band-fold-${id}`}
      >
        <span className="md-fold-t">{label}</span>
        <span className="md-fold-m">{foldMeta}</span>
        <span className="md-fold-line" />
        <span className="md-fold-cta">
          {foldCta}
          <ChevronRight size={11} />
        </span>
      </button>
    )
  }

  return (
    <div
      className={'md-cs md-cs--focus' + (tone === 'plain' ? '' : ' ' + tone)}
      data-testid={`band-${id}`}
    >
      <div className="md-cs-h">
        <span className="md-cs-t">{label}</span>
        {pill}
        <span className="md-cs-line" />
        {rev}
        <button
          type="button"
          className="md-cs-more"
          onClick={onToggle}
          aria-expanded
          aria-controls={panelId}
          aria-label={`Collapse ${label}`}
        >
          <ChevronDown size={11} />
        </button>
      </div>
      {/* The panel is the DISCLOSED region and excludes the header that
          controls it — `aria-controls` pointing at a box containing its own
          toggle would make the control a descendant of what it controls. */}
      <div id={panelId}>
        {definition && <div className="md-cs-def">{definition}</div>}
        {children}
      </div>
    </div>
  )
}
