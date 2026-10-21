import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Filter, Layers, Tag, X, Info } from 'lucide-react'
import type { TicketState } from '../../api/endpoints/deskTodos'
import { useDeskLabelViewStore } from '../../stores/deskLabelViewStore'
import {
  axisKnown,
  displayName,
  labelsOfKind,
  resolveLabel,
  unknownAxisReason,
  type GroupAxis,
  type ResolvedRegistry,
} from '../../utils/labelView'
import { TICKET_STATES, ticketLabel } from '../../utils/ticketView'
import LabelChip from './LabelChip'

/**
 * The rail's control strip: the group menu, the filter popover, and the
 * active-filter bar.
 *
 * Reads and writes `deskLabelViewStore` directly rather than lifting the state
 * into `TodoRail` — the rail derives FROM the view, and threading six setters
 * back down would make the rail the owner of a thing it only reads.
 */

export interface LabelFilterProps {
  registry: ResolvedRegistry
  /** DISTINCT open items per slug, computed once by the rail. */
  counts: Map<string, number>
  /** Unarchived items per ticket state, computed once by the rail from the same
   *  `open` list as `counts`. All three keys are present, zeros included — a
   *  blank count beside a context row that has one reads as broken. */
  tkCounts: Map<TicketState, number>
  /** Every unregistered slug currently on the plate, in first-seen order.
   *  Filterable: hiding them would make a chip the owner can SEE
   *  un-actionable. */
  unregistered: string[]
  onManage: () => void
  onRetry: () => void
}

type Pop = null | 'group' | 'filter'

export default function LabelFilter({
  registry,
  counts,
  tkCounts,
  unregistered,
  onManage,
  onRetry,
}: LabelFilterProps) {
  const [pop, setPop] = useState<Pop>(null)
  const wrap = useRef<HTMLDivElement>(null)

  const group = useDeskLabelViewStore((s) => s.group)
  const filter = useDeskLabelViewStore((s) => s.filter)
  const states = useDeskLabelViewStore((s) => s.states)
  const matchAll = useDeskLabelViewStore((s) => s.matchAll)
  const setGroup = useDeskLabelViewStore((s) => s.setGroup)
  const toggleFilter = useDeskLabelViewStore((s) => s.toggleFilter)
  const toggleState = useDeskLabelViewStore((s) => s.toggleState)
  const clearFilter = useDeskLabelViewStore((s) => s.clearFilter)
  const setMatchAll = useDeskLabelViewStore((s) => s.setMatchAll)

  useEffect(() => {
    if (!pop) return
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setPop(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [pop])

  const known = axisKnown(registry.state)
  // `cold` and `unavailable` disable the same controls; they do NOT get the
  // same sentence. Read once, used at all three copy sites below.
  const why = unknownAxisReason(registry.state)
  const loading = registry.state === 'cold'
  const contexts = labelsOfKind(registry, 'context')
  // THE FOURTH "is a filter on" SITE. It drives the Filter badge, the button's
  // `on` class, the Clear button and whether the active-filter bar renders at
  // all — so reading `filter.length` alone here makes every one of them vanish
  // when only a state filter is set.
  const n = filter.length + states.length
  // COPY ONLY. `group === 'ticket'` is a PERSISTED value in localStorage
  // (`deskLabelViewStore`), so the comparison keeps the old slug forever —
  // renaming it would silently drop every existing owner's saved grouping.
  const groupLabel = group === 'context' ? 'Context' : group === 'ticket' ? 'State' : 'Group'

  return (
    <div ref={wrap} className="todo-ctl-wrap">
      <div className={'todo-ctl' + (n ? ' filtered' : '')}>
        <button
          className={'ctl-btn' + (group ? ' on' : '')}
          aria-haspopup="true"
          aria-expanded={pop === 'group'}
          onClick={() => setPop((p) => (p === 'group' ? null : 'group'))}
        >
          <Layers size={12} />
          {groupLabel}
          <ChevronDown size={11} />
        </button>
        <button
          className={'ctl-btn' + (n ? ' on' : '')}
          aria-haspopup="true"
          aria-expanded={pop === 'filter'}
          onClick={() => setPop((p) => (p === 'filter' ? null : 'filter'))}
        >
          <Filter size={12} />
          Filter
          {!!n && <span className="ctl-n">{n}</span>}
          <ChevronDown size={11} />
        </button>
        <span className="ctl-sp" />
        {!!n && (
          <button className="ctl-clear" onClick={clearFilter}>
            <X size={11} />
            Clear
          </button>
        )}
      </div>

      {/* The active-filter bar states the predicate exactly where it is true.
          Off-ready there are no axes to partition by, so it is ONE flat OR
          run — and the widening is explained only when there is one (two or
          more slugs), never as a blanket warning. */}
      {(!!states.length || (!!filter.length && !known)) && (
        <>
          <div className="todo-fbar">
            {/* The state chips run FIRST and render identically whether or not
                the registry loaded: they are not slugs and need no resolving. */}
            {states.map((st, i) => (
              <span key={st} style={{ display: 'contents' }}>
                {i > 0 && <span className="fbar-op">OR</span>}
                <span className={'tk tk-' + st + ' has-x'}>
                  {ticketLabel(st)}
                  <button
                    className="lb-x"
                    onClick={() => toggleState(st)}
                    aria-label={`Remove ${ticketLabel(st)} from the filter`}
                  >
                    <X size={9} />
                  </button>
                </span>
              </span>
            ))}
            {!!states.length && !!filter.length && <span className="fbar-op">AND</span>}
            {!known &&
              filter.map((slug, i) => (
                <span key={slug} style={{ display: 'contents' }}>
                  {i > 0 && <span className="fbar-op">OR</span>}
                  <LabelChip
                    label={resolveLabel(slug, registry)}
                    onRemove={() => toggleFilter(slug)}
                  />
                </span>
              ))}
            {known && !!filter.length && (
              <FilterBar
                registry={registry}
                filter={filter}
                matchAll={matchAll}
                onRemove={toggleFilter}
                bare
              />
            )}
          </div>
          {!known && filter.length > 1 && (
            <div className="fbar-why">
              Your labels can't be resolved until the list loads, so this is showing anything that
              matches.
            </div>
          )}
        </>
      )}
      {!states.length && !!filter.length && known && (
        <FilterBar registry={registry} filter={filter} matchAll={matchAll} onRemove={toggleFilter} />
      )}

      {pop === 'group' && (
        <div className="pop" style={{ left: 8, top: 44 }} role="dialog" aria-label="Group by">
          <div className="pop-h">
            Group by<span className="sp" />
            <button className="pop-x" onClick={() => setPop(null)} aria-label="Close">
              <X size={13} />
            </button>
          </div>
          <button
            className={'pop-row' + (group === null ? ' on' : '')}
            onClick={() => {
              setGroup(null)
              setPop(null)
            }}
          >
            <span className="bx rd" />
            None — hand order
            <span className="ct">{counts.size ? '' : ''}</span>
          </button>
          <AxisRow
            kind="context"
            label="Context"
            active={group === 'context'}
            groups={contexts.length + unregistered.length}
            known={known}
            reason={
              !known
                ? loading
                  ? `${why} Contexts will be groupable in a moment.`
                  : `${why} We can't tell contexts from states without it. Filtering still works.`
                : 'No contexts yet — add one in Manage labels.'
            }
            onPick={() => {
              setGroup('context')
              setPop(null)
            }}
          />
          {/* ALWAYS ENABLED, and never disabled with a reason, because there
              is no condition under which it cannot work: it partitions on a
              field that arrives with every to-do and reads the registry not at
              all. Four groups, always — Working, Failed, New, Done. There is
              no "Unprocessed · no state" pile: NEW IS THE INBOX. */}
          <AxisRow
            kind="ticket"
            label="State"
            active={group === 'ticket'}
            groups={TICKET_STATES.length}
            known
            reason=""
            onPick={() => {
              setGroup('ticket')
              setPop(null)
            }}
          />
          <div className="pop-div" />
          <button
            className="pop-foot"
            onClick={() => {
              setPop(null)
              onManage()
            }}
          >
            <Tag size={12} />
            Manage labels…
          </button>
        </div>
      )}

      {pop === 'filter' && (
        <div className="pop" style={{ left: 8, top: 44 }} role="dialog" aria-label="Filter">
          <div className="pop-h">
            Filter<span className="sp" />
            {!!n && (
              <button className="pop-x" onClick={clearFilter} title="Clear" aria-label="Clear filter">
                <X size={13} />
              </button>
            )}
            <button className="pop-x" onClick={() => setPop(null)} aria-label="Close">
              <X size={13} />
            </button>
          </div>

          {/* OUTSIDE the `!known` branch, so it renders in BOTH — which is
              what "still works if the label registry fails to load" means in
              practice. No ALL/AND toggle: a to-do has exactly one state, so an
              AND across two would be unsatisfiable and the control could only
              produce an empty plate. */}
          <div className="pop-sec">State — any of</div>
          {TICKET_STATES.map((st) => (
            <FilterRow
              key={st}
              name={ticketLabel(st)}
              on={states.includes(st)}
              count={tkCounts.get(st) ?? 0}
              onClick={() => toggleState(st)}
            />
          ))}

          {!known ? (
            <>
              {/* There is no list to offer. What must still work is REMOVING
                  what is already on — a filter the owner can see in the bar but
                  cannot reach in the popover is the trap this branch exists to
                  avoid. Removal is a slug-set edit and needs no registry. */}
              <div className="pop-row off">
                <span className="bx rd" />
                Your labels<span className="ct">—</span>
              </div>
              <div className="pop-why">
                {why} There is nothing to choose from yet.{' '}
                {n
                  ? 'What you already filtered on still works — you can turn it off here.'
                  : loading
                    ? ''
                    : 'Filtering will come back on its own.'}
              </div>
              {filter.map((slug) => (
                <button key={slug} className="pop-row on" onClick={() => toggleFilter(slug)}>
                  <span className="bx" />
                  <span className="unreg-nm">{slug}</span>
                  <span className="ct">{counts.get(slug) ?? 0}</span>
                </button>
              ))}
              <div className="pop-div" />
              <button className="pop-foot" onClick={onRetry}>
                <Info size={12} />
                Try again
              </button>
            </>
          ) : (
            <>
              <div className="pop-sec">Context — any of</div>
              {contexts.map((l) => (
                <FilterRow
                  key={l.slug}
                  name={displayName(resolveLabel(l.slug, registry))}
                  on={filter.includes(l.slug)}
                  count={counts.get(l.slug) ?? 0}
                  onClick={() => toggleFilter(l.slug)}
                />
              ))}
              {/* Unregistered slugs sit in their own run at the FOOT of the
                  context section, INSIDE it, because they participate in the
                  same OR. */}
              {!!unregistered.length && <div className="pop-sub">not in your list</div>}
              {unregistered.map((slug) => (
                <button
                  key={slug}
                  className={'pop-row unregrow' + (filter.includes(slug) ? ' on' : '')}
                  onClick={() => toggleFilter(slug)}
                >
                  <span className="bx" />
                  <span className="unreg-nm">@{slug}</span>
                  <span className="ct">{counts.get(slug) ?? 0}</span>
                </button>
              ))}
              <button
                className={'pop-tog' + (matchAll ? ' on' : '')}
                aria-pressed={matchAll}
                onClick={() => setMatchAll(!matchAll)}
              >
                <span className="sw">
                  <i />
                </span>
                Match ALL contexts
                <span className="hint">{matchAll ? 'AND' : 'OR'}</span>
              </button>
              <div className="pop-div" />
              <button
                className="pop-foot"
                onClick={() => {
                  setPop(null)
                  onManage()
                }}
              >
                <Tag size={12} />
                Manage labels…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function FilterRow({
  name,
  on,
  count,
  onClick,
}: {
  name: string
  on: boolean
  count: number
  onClick: () => void
}) {
  return (
    <button className={'pop-row' + (on ? ' on' : '')} aria-pressed={on} onClick={onClick}>
      <span className="bx" />
      {name}
      <span className="ct">{count}</span>
    </button>
  )
}

/**
 * An axis you cannot group by is DISABLED WITH ITS REASON, not hidden.
 *
 * Hiding it makes the rail look like it never had the feature, and it
 * collapses two conditions needing very different reactions into one identical
 * absence — "you have not made any contexts yet" (repairable, and the manage
 * sheet is one click away) versus "your label list did not load" (nothing to
 * repair, wait).
 *
 * The TICKET row never reaches the disabled arm and cannot: it passes
 * `known` unconditionally and a fixed group count of three, because it reads a
 * field that arrives with every to-do. That is the same fact `effectiveGroup`
 * encodes by exempting `'ticket'` from the off-ready suppression, said once
 * more at the surface the owner presses.
 */
function AxisRow({
  kind,
  label,
  active,
  groups,
  known,
  reason,
  onPick,
}: {
  kind: GroupAxis
  label: string
  active: boolean
  groups: number
  known: boolean
  reason: string
  onPick: () => void
}) {
  const enabled = known && groups > 0
  if (enabled) {
    return (
      <button className={'pop-row' + (active ? ' on' : '')} data-axis={kind} onClick={onPick}>
        <span className="bx rd" />
        {label}
        <span className="ct">{groups} groups</span>
      </button>
    )
  }
  return (
    <>
      <button className="pop-row off" data-axis={kind} disabled>
        <span className="bx rd" />
        {label}
        <span className="ct">—</span>
      </button>
      <div className="pop-why">{reason}</div>
    </>
  )
}

/** The label half of the predicate, spelled out: one flat run joined by OR, or
 *  by AND under "Match ALL". One kind left means one run — the state half now
 *  lives on its own axis and renders above this, joined to it by AND.
 *
 *  `bare` drops the wrapping `.todo-fbar`, for the case where the caller is
 *  already inside one because it rendered the state chips first. */
function FilterBar({
  registry,
  filter,
  matchAll,
  onRemove,
  bare,
}: {
  registry: ResolvedRegistry
  filter: string[]
  matchAll: boolean
  onRemove: (slug: string) => void
  bare?: boolean
}) {
  const op = matchAll ? 'AND' : 'OR'
  const run = filter.map((slug, i) => (
    <span key={slug} style={{ display: 'contents' }}>
      {i > 0 && <span className="fbar-op">{op}</span>}
      <LabelChip label={resolveLabel(slug, registry)} onRemove={() => onRemove(slug)} />
    </span>
  ))
  return bare ? <>{run}</> : <div className="todo-fbar">{run}</div>
}
