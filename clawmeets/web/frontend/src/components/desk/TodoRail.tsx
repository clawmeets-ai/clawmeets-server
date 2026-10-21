import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Archive,
  Check,
  CheckSquare,
  ChevronRight,
  ChevronDown,
  Info,
  Search,
  X,
  Copy,
  Loader2,
} from 'lucide-react'
import { useTodos } from '../../hooks/useTodos'
import { useAgents } from '../../hooks/useAgents'
import { usePointerReorder } from '../../hooks/usePointerReorder'
import { useLabels, useLabelViewReconcile } from '../../hooks/useLabels'
import { useAuthStore } from '../../stores/authStore'
import { useDeskLabelViewStore } from '../../stores/deskLabelViewStore'
import {
  axisKnown,
  chipsFor,
  diagnoseRegistry,
  registryWritable,
  effectiveGroup,
  groupTodos,
  labelCounts,
  unregisteredSlugs,
  type LabelGroup,
} from '../../utils/labelView'
import { groupByTicketState, matchesPlate, stateCounts } from '../../utils/ticketView'
import { matchesTodoSearch, todoQueryTokens } from '../../utils/todoSearch'
import LabelFilter from './LabelFilter'
import LabelManageSheet from './LabelManageSheet'
import LabelInput, {
  CAP_REASON,
  CaptureChips,
  CaptureLabels,
  applyPick,
  captureMenu,
  menuLength,
  stripToken,
} from './LabelInput'
import { labelErrorMessage } from '../../utils/labelErrors'
import { findAgent } from '../../utils/agentDisplay'
import type { AgentCard } from '../../types'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import TodoItem from './TodoItem'

/** Presence of the one agent a row can name — the saved draft's recipient.
 *  Resolved here so the rail's single roster query serves every row, instead
 *  of each row querying for itself. */
function rowPresence(agents: AgentCard[] | undefined, t: DeskTodo) {
  return {
    draftToStatus: findAgent(agents, {
      id: t.draft_recipient_id,
      name: t.draft_recipient_name,
    })?.status,
  }
}

interface TodoRailProps {
  /** Id of the to-do loaded in the desk message box (badged `.is-open`). */
  activeTodoId: string | null
  /** Ids of the to-dos linked to the desk card currently under the pointer.
   *  Resolved by `DeskPage` — it is the only place holding both the cards and
   *  the to-dos — so the rail only ever paints what it is handed. */
  linkedTodoIds: ReadonlySet<string>
  /** A row was entered (id) / left (`null`). Pure pass-through to `DeskPage`. */
  onHoverTodo: (todoId: string | null) => void
  /** A row was clicked — DeskPage loads that to-do into the desk message box. */
  onUseTodo: (t: DeskTodo) => void
  /** Toast a label write/create failure the rail cannot show in place (owned
   *  by DeskPage). */
  flash: (msg: string) => void
}

/**
 * The manager's plate — capture box, open items (drag-reorderable, click to
 * load into the desk message box), groupable and filterable by label AND by
 * the derived ticket state, and a collapsible ARCHIVED drawer. Owns
 * `useTodos`, whose verbs write through to the server; the list refreshes on
 * `DESK_TODO_SYNC` so agent-published items appear live.
 *
 * THE TWO AXES ARE INDEPENDENT and the rail never crosses them: `archived`
 * decides which of the two lists a row is in, `state` decides its chip and its
 * group, and neither one moves the other. An archived row whose project is
 * still running sits in the drawer reading Working, which is a legitimate row
 * and not a contradiction to smooth over.
 *
 * ONE BOX, TWO JOBS, and `text` is the single state behind both: what is typed
 * narrows the plate as you go, AND is the task the `+` captures. Search-first
 * is not a compromise here — it is the dedupe you want anyway, since the rows
 * that survive while you type "chase the Provi PO" are exactly the ones that
 * might already say it. Enter and `+` do the same thing; `+` is disabled while
 * the box holds no text, so the one state in which it does nothing says so.
 *
 * THE SEARCH IS A THIRD NARROWING TERM alongside the label and state filters,
 * and is treated as one everywhere `filtering` is read — the "N of M" header,
 * the clear `×`, the "new items hidden by this filter" strip and the archived
 * drawer's own count all take it into account. A row must never leave the
 * plate without a visible cause. It is the only one of the three NOT persisted
 * (component state, not `deskLabelViewStore`): a saved filter you can see a
 * control for is a feature, a saved search that silently narrows tomorrow's
 * plate is a bug.
 *
 * Dispatch lives entirely in the message box. The rail resolves no recipients
 * and sends nothing — a row click is a pass-through to DeskPage, the same
 * shape `SopRail` uses for `onUseSop`. Beyond the checkbox, the trash icon and
 * a label write, it mutates no to-do.
 */
export default function TodoRail({
  activeTodoId,
  linkedTodoIds,
  onHoverTodo,
  onUseTodo,
  flash,
}: TodoRailProps) {
  const { todos, add, adding, addingText, archive, remove, rename, reorder, setLabels } =
    useTodos()
  const { data: agents } = useAgents()
  const { user } = useAuthStore()
  // Both the search query AND the capture draft — see the header note.
  const [text, setText] = useState('')
  // Read by a capture's refusal, which lands after the render that sent it.
  const textRef = useRef(text)
  textRef.current = text
  const [showArchived, setShowArchived] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showSheet, setShowSheet] = useState(false)
  // `+N` expansion is per-item and EPHEMERAL — never persisted, and cleared on
  // every drag (see `onDragStart` below).
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Which row's title is open for inline rename. RAIL-owned for the same reason
  // `expanded` is: grouped mode renders one to-do under EVERY label it carries,
  // and two copies of a row must not disagree about whether it is being edited.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  // The complete-map escape hatch, session-scoped: which empty groups to show.
  const [showEmpties, setShowEmpties] = useState(false)
  const { dragId, overId, pressId, startDrag, armLongPress } = usePointerReorder(reorder, {
    // Collapse every `+N` when a drag begins, by either entry point. Expanding
    // a row changes its height, and the hit-test runs on every pointermove, so
    // a row that grows mid-drag moves the drop target out from under the
    // finger.
    onDragStart: () => setExpanded((s) => (s.size ? new Set() : s)),
  })

  const { registry, isError, refetch, create } = useLabels()
  // Labels staged on the capture draft, and the autocomplete's cursor.
  const [capLabels, setCapLabels] = useState<string[]>([])
  const [acIndex, setAcIndex] = useState(0)
  // The row popover: which row, and the last write failure to show in it.
  const [labelPop, setLabelPop] = useState<{ id: string; top: number } | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const [popError, setPopError] = useState<string | null>(null)
  const hydrateView = useDeskLabelViewStore((s) => s.hydrate)
  const storedGroup = useDeskLabelViewStore((s) => s.group)
  const filter = useDeskLabelViewStore((s) => s.filter)
  const states = useDeskLabelViewStore((s) => s.states)
  const matchAll = useDeskLabelViewStore((s) => s.matchAll)
  const collapsed = useDeskLabelViewStore((s) => s.collapsed)
  const clearFilter = useDeskLabelViewStore((s) => s.clearFilter)
  const toggleCollapsed = useDeskLabelViewStore((s) => s.toggleCollapsed)

  useEffect(() => {
    hydrateView(user?.id ?? null)
  }, [hydrateView, user?.id])

  const open = todos.filter((t) => !t.archived)
  const archivedList = todos.filter((t) => t.archived)
  const empty = todos.length === 0

  // The typed query, tokenized. Memoized on `text` so the identity is stable
  // enough to sit in an effect's dependency list.
  const tokens = useMemo(() => todoQueryTokens(text), [text])
  const searching = tokens.length > 0

  // IS ANYTHING NARROWING THE PLATE? Read at every site below, as ONE derived
  // const rather than N copies of `filter.length`, because each of those is a
  // separate way for the clear affordance and the "N of M" header to vanish
  // while a state filter — or now a search — is quietly still hiding rows.
  const filtering = filter.length > 0 || states.length > 0 || searching

  const { notice, dismissNotice } = useLabelViewReconcile(registry, open)

  // An agent publishing to the plate while a filter is on: `useWebSocket`
  // invalidates ['desk-todos'], the row arrives, and the filter hides it.
  // Without this strip the item lands INVISIBLY, which is a regression against
  // today's behaviour where it prepends and appears live.
  const [hiddenByFilter, setHiddenByFilter] = useState(0)
  const seenIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    const ids = new Set(open.map((t) => t.id))
    const previous = seenIds.current
    seenIds.current = ids
    // The first pass is the initial load, not an arrival.
    if (!previous || !filteringRef.current) return
    const arrived = open.filter((t) => !previous.has(t.id))
    // The SAME predicate the plate renders with, search included — an arrival
    // that the search term hides is just as invisible as one a label filter
    // hides, and the strip is the only thing that says so.
    const hidden = arrived.filter(
      (t) =>
        !matchesPlate(t, viewRef.current, registryRef.current) ||
        !matchesTodoSearch(t, tokensRef.current),
    )
    if (hidden.length) setHiddenByFilter((n) => n + hidden.length)
  }, [open])
  // Clearing or changing ANY narrowing term answers the strip, so it resets.
  useEffect(() => setHiddenByFilter(0), [filter, states, matchAll, tokens])

  const view = useMemo(
    () => ({ group: storedGroup, filter, states, matchAll }),
    [storedGroup, filter, states, matchAll],
  )
  // Read by the arrival effect, which must not re-run when the view or the
  // registry moves — only when the PLATE does.
  const viewRef = useRef(view)
  viewRef.current = view
  const registryRef = useRef(registry)
  registryRef.current = registry
  const filteringRef = useRef(filtering)
  filteringRef.current = filtering
  const tokensRef = useRef(tokens)
  tokensRef.current = tokens
  // The stored axis is SUPPRESSED off-ready, not overwritten, so the owner's
  // choice comes back by itself when the registry does.
  const group = effectiveGroup(view, registry.state)

  // `matchesPlate`, never `matches`: the state term runs FIRST, before the
  // label filter's empty-filter early return and outside its registry branch,
  // which is what makes filtering by state keep working when the registry does
  // not load.
  //
  // The search is ANDed on rather than folded into `matchesPlate`: that
  // predicate is the persisted view (labels × state) and is shared with the
  // store's own reasoning, while the search is this component's ephemeral
  // third term. Keeping it outside is what lets the two be cleared
  // independently.
  const shown = useMemo(
    () => open.filter((t) => matchesPlate(t, view, registry) && matchesTodoSearch(t, tokens)),
    [open, view, registry, tokens],
  )
  // From `open`, never from `shown`: these are what the FILTER POPOVER reads,
  // and a count that shrank as you filtered would make the popover unusable.
  // DISTINCT, never the sum of per-group counts.
  const counts = useMemo(() => labelCounts(open), [open])
  // From the same `open` list as the label counts, so the popover's two columns
  // agree and neither shrinks as the other is filtered.
  const tkCounts = useMemo(() => stateCounts(open), [open])
  const unregistered = useMemo(() => unregisteredSlugs(open, registry), [open, registry])
  // G1: THE TICKET BRANCH SITS BEFORE `groupTodos`, whose first line is
  // `if (!axisKnown(reg.state)) return []`. Behind it, ticket grouping would
  // return no groups at exactly the moment it is the only axis still working.
  // (G2 is `effectiveGroup` exempting `'ticket'` from the off-ready
  // suppression; G3 is the deleted "your last state was deleted" reconcile
  // branch. All three have to hold or this is not a replacement.)
  const groups = useMemo(
    () =>
      group === 'ticket'
        ? groupByTicketState(shown)
        : group === 'context'
          ? groupTodos(shown, 'context', registry)
          : null,
    [group, shown, registry],
  )
  // The drawer runs the SAME predicate as the open plate — both axes — so the
  // filter means one thing on one screen.
  const archivedShown = useMemo(
    () =>
      archivedList.filter((t) => matchesPlate(t, view, registry) && matchesTodoSearch(t, tokens)),
    [archivedList, view, registry, tokens],
  )
  const content = diagnoseRegistry(registry, open)
  // Every surface that can reach `POST /me/desk/labels` asks this first: an
  // unreadable registry materializes as zero rows server-side, so a create
  // saves ONE row over the owner's whole list.
  const writable = registryWritable(registry.state, content)

  // Which margin of the hovered row to highlight: a target sitting *above* the
  // picked-up item means we're dragging up (light its top edge); below means
  // dragging down (bottom edge). Derived from the ordered `open` list.
  const dragIndex = dragId ? open.findIndex((t) => t.id === dragId) : -1
  const edgeFor = (id: string): 'top' | 'bottom' => {
    const overIndex = open.findIndex((t) => t.id === id)
    return overIndex < dragIndex ? 'top' : 'bottom'
  }

  /** Empty the box. Clears the staged chips with it — they belong to the draft
   *  that was in the box, and leaving them behind would arm the `+` to capture
   *  a to-do with no text. */
  const clearBox = () => {
    setText('')
    setCapLabels([])
    setAcIndex(0)
  }

  /** Everything currently hiding rows, off at once. Wired to the plate
   *  header's `×` and to the hidden-arrivals strip's "Show", both of which
   *  promise the whole plate back — a `clearFilter()` that left the search
   *  term standing would not deliver it. */
  const clearAll = () => {
    clearFilter()
    clearBox()
  }

  /** Capture what is in the box. Requires TEXT, not merely staged chips: a
   *  to-do with labels and no words is a row that renders as blank, and
   *  `useTodos.add` already drops it silently — so the `+` refuses it up front
   *  instead of looking like it worked. */
  const canCapture = text.trim().length > 0

  /** The box clears at once so the next task can be typed, and the "Adding…"
   *  line stands in for the row until the server answers. On a refusal the
   *  words and chips come back — unless the owner has already typed something
   *  else, which is never overwritten. */
  const submit = () => {
    if (!canCapture) return
    const sentText = text
    const sentLabels = capLabels
    add(text, {
      labels: capLabels,
      onError: (err) => {
        flash(labelErrorMessage(err))
        if (textRef.current) return
        setText(sentText)
        setCapLabels(sentLabels)
      },
    })
    clearBox()
  }

  const menu = captureMenu(text, capLabels, registry, writable)

  /** Accept a label onto the capture draft. THE TOKEN NEVER REACHES THE TEXT —
   *  but only on an EXPLICIT accept, which is the confirm rule: everything the
   *  owner did not pick stays literal, so "ask @assistant about the Provi PO"
   *  keeps its word and invents no label. */
  const acceptCapture = (slug: string) => {
    setCapLabels((v) => applyPick(v, slug))
    setText((t) => stripToken(t))
    setAcIndex(0)
  }

  const onCaptureKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !text && capLabels.length) {
      e.preventDefault()
      setCapLabels((v) => v.slice(0, -1))
      return
    }
    if (!menu) {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
      return
    }
    const n = menuLength(menu)
    if (e.key === 'ArrowDown' && n) {
      e.preventDefault()
      setAcIndex((i) => (i + 1) % n)
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault()
      setAcIndex((i) => (i + n - 1) % n)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setText((t) => stripToken(t))
    } else if ((e.key === 'Enter' || e.key === 'Tab') && n) {
      e.preventDefault()
      if (acIndex < menu.hits.length) acceptCapture(menu.hits[acIndex].slug)
      else
        create({
          name: menu.token.query,
          kind: 'context',
          color: undefined,
        })
          .then((l) => acceptCapture(l.slug))
          .catch((err) => flash(labelErrorMessage(err, { slug: menu.token.query })))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    }
  }

  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const wire = {
    onGripDown: (t: DeskTodo, e: React.PointerEvent) => startDrag(t.id, e),
    onRowDown: (t: DeskTodo, e: React.PointerEvent) => armLongPress(t.id, e),
  }

  /** One row, wired the same way in the flat list and inside every group.
   *
   *  `wire` is passed ONLY when ungrouped. Grouped mode passes none, so
   *  `TodoItem`'s existing `{wire && …}` guard renders NO GRIP and no
   *  `onPointerDown` — both affordances are ABSENT, not present-and-broken,
   *  which is what keeps "order is locked while grouped" true now that drag
   *  has a second, far more discoverable way in. */
  const renderRow = (t: DeskTodo, opts: { grouped?: boolean; dup?: boolean } = {}) => {
    const over = !opts.grouped && overId === t.id && !!dragId && dragId !== t.id
    return (
      <TodoItem
        key={t.id}
        t={t}
        active={activeTodoId === t.id}
        // Grouped mode renders the SAME to-do under every label it carries;
        // membership is by to-do id, so all copies light together. That is
        // correct, and already how the `dup` tick behaves.
        linked={linkedTodoIds.has(t.id)}
        onHover={onHoverTodo}
        dragging={!opts.grouped && dragId === t.id}
        pressing={!opts.grouped && pressId === t.id}
        over={over}
        overEdge={over ? edgeFor(t.id) : undefined}
        wire={opts.grouped ? undefined : wire}
        instanced={opts.grouped}
        dup={opts.dup}
        chips={chipsFor(t, view, registry, expanded.has(t.id))}
        expanded={expanded.has(t.id)}
        onToggleExpand={toggleExpand}
        onArchive={archive}
        onRemove={remove}
        onUse={onUseTodo}
        renaming={renamingId === t.id}
        onStartRename={setRenamingId}
        onCancelRename={() => setRenamingId(null)}
        onRename={(id, value) => {
          setRenamingId(null)
          rename(id, value)
        }}
        onEditLabels={(row, anchor) => {
          setPopError(null)
          const rail = railRef.current?.getBoundingClientRect()
          setLabelPop({
            id: row.id,
            top: anchor.getBoundingClientRect().bottom - (rail?.top ?? 0) + 6,
          })
        }}
        {...rowPresence(agents, t)}
      />
    )
  }

  /** A group and its rows. Empty groups do not each render a header — they
   *  collapse to one "N empty groups · Show" line, ~24px instead of N × ~60px
   *  in a rail one screen tall. */
  const renderGroup = (g: LabelGroup) => {
    const folded = collapsed[g.key] ?? g.collapsedByDefault
    return (
      <div className={'grp' + (g.tone ? ' ' + g.tone : '')} key={g.key}>
        <button
          className="grp-h"
          aria-expanded={!folded}
          onClick={() => toggleCollapsed(g.key, folded)}
        >
          {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span className="grp-n">{g.name}</span>
          <span className="grp-c">{g.items.length}</span>
          <span className="grp-line" />
        </button>
        {g.tone === 'unreg' && !folded && (
          <div className="grp-unreg">
            Not in your label list
            <button onClick={() => setShowSheet(true)}>Add it</button>
          </div>
        )}
        {!folded &&
          (g.items.length ? (
            g.items.map((t) =>
              renderRow(t, { grouped: true, dup: (dupCount.get(t.id) ?? 0) > 1 }),
            )
          ) : (
            <div className="grp-empty">Nothing here right now.</div>
          ))}
      </div>
    )
  }

  // How many groups each row is rendered in, so a duplicated row can say so.
  // SKIPPED for ticket grouping: one to-do has one state, so it lands in
  // exactly one group by construction and there is nothing to count.
  const dupCount = new Map<string, number>()
  if (group === 'context') {
    for (const t of shown) {
      dupCount.set(
        t.id,
        (t.labels ?? []).filter((sl) => {
          const i = registry.index.get(sl)
          return i !== undefined && registry.labels[i].kind === 'context'
        }).length,
      )
    }
  }

  // THE FOUR STATE GROUPS ARE NEVER FOLDED AWAY FOR BEING EMPTY and never
  // counted toward the "N empty groups · Show" affordance. The four together
  // are a map of the plate, and a map works only if all of it is on screen — a
  // missing "Done" header reads as a missing feature rather than as an
  // empty group. The cost is one ~24px header per empty group, and Failed
  // made it four; that is the deliberate price of Failed being findable on a
  // plate where it is rare.
  const visibleGroups =
    group === 'ticket'
      ? (groups ?? [])
      : (groups ?? []).filter(
          (g) => g.items.length || (!filtering && g.tone === '' && showEmpties),
        )
  // Under a filter, empty groups are pure noise; so is an empty unregistered
  // group, which only exists because something on the plate carries the slug.
  const emptyCount =
    filtering || group === 'ticket'
      ? 0
      : (groups ?? []).filter((g) => !g.items.length && g.tone === '').length

  const popTarget = labelPop ? todos.find((t) => t.id === labelPop.id) : undefined

  return (
    <div className="todo" ref={railRef}>
      <div className="todo-add">
        <div className="todo-add-row">
          <div className="todo-add-box">
            {/* A magnifier, not the old `+`: the leading icon names what the
                box does as you type, and the `+` — which acts on what you
                typed — now has its own button beside it. */}
            <Search size={15} />
            <input
              className="todo-add-in"
              value={text}
              placeholder="Search or add a task…"
              onChange={(e) => {
                setText(e.target.value)
                setAcIndex(0)
              }}
              onKeyDown={onCaptureKey}
            />
            {text && (
              <button className="todo-add-info" onClick={clearBox} title="Clear">
                <X size={13} />
              </button>
            )}
            <button
              className="todo-add-info"
              aria-label="How agents publish to-dos to your plate"
              title="How agents publish to-dos"
              onClick={() => setShowInfo(true)}
            >
              <Info size={15} />
            </button>
          </div>
          <button
            className="todo-add-new"
            onClick={submit}
            disabled={!canCapture}
            aria-label="Add task"
            title={canCapture ? 'Add this task' : 'Type a task to add it'}
          >
            <Plus size={15} />
          </button>
        </div>
        <CaptureChips
          value={capLabels}
          registry={registry}
          onRemove={(slug) => setCapLabels((v) => v.filter((s) => s !== slug))}
        />
        {adding && (
          <div className="todo-adding" role="status" aria-live="polite">
            <Loader2 size={12} className="animate-spin" />
            <span>Adding “{addingText}”…</span>
          </div>
        )}
        {menu?.atCap && <div className="cap-cap">{CAP_REASON}</div>}
        {menu && (
          <CaptureLabels
            menu={menu}
            index={acIndex}
            registry={registry}
            onAccept={acceptCapture}
            onCreate={(name, kind) =>
              create({ name, kind })
                .then((l) => acceptCapture(l.slug))
                .catch((err) => flash(labelErrorMessage(err, { slug: name })))
            }
          />
        )}
      </div>

      <LabelFilter
        registry={registry}
        counts={counts}
        tkCounts={tkCounts}
        unregistered={unregistered}
        onManage={() => setShowSheet(true)}
        onRetry={refetch}
      />

      <div className="todo-scroll">
        {/* THE BANNER BINDS TO isError, never to `!data`. Bound to "no
            registry" it flashes on every cold start, and a scary banner during
            normal operation trains the owner to ignore the one that matters.
            Not red either: a lost label list is a cosmetic failure and the
            copy's whole job is to say so, because the alternative reading —
            "my plate is broken" — is the one that costs ten minutes of panic. */}
        {isError && (
          <div className="deg-note">
            <Info size={13} />
            <span>
              <b>Your label list didn't load.</b> Chips show the words on each to-do but not your
              colours, and grouping is off until it does. Nothing on your plate has changed.
              <button onClick={refetch}>Try again</button>
            </span>
          </div>
        )}

        {/* An entirely unparseable registry answers with ZERO ROWS, never the
            seed — so on the wire it looks exactly like an emptied one. The one
            thing that tells them apart is the plate: emptying a registry
            detaches every label on the way out, so labels still on the plate
            with an empty list mean the list did not come back. A distinct code
            path, because the repair is distinct. */}
        {axisKnown(registry.state) && content === 'orphaned' && (
          <div className="deg-note">
            <Info size={13} />
            <span>
              {/* Lead with what SURVIVED. "Nothing has been lost" and "add them
                  back" cannot both be true in one breath, and the owner resolves
                  the contradiction by acting — which, before this, meant the one
                  button in the rail that could destroy the registry. The only
                  action offered now is the one that can actually fix it. */}
              <b>Your to-dos still carry their labels, but your label list came back empty.</b>{' '}
              Nothing has been lost — the labels are still on your to-dos, and nothing on your
              plate has changed. This usually clears on its own.
              <button onClick={refetch}>Try again</button>
            </span>
          </div>
        )}

        {notice && (
          <div className="hid-note quiet">
            <Info size={13} />
            {notice}
            <button onClick={dismissNotice}>Dismiss</button>
          </div>
        )}

        {hiddenByFilter > 0 && (
          <div className="hid-note">
            <Info size={13} />
            {hiddenByFilter} new item{hiddenByFilter > 1 ? 's' : ''} hidden by this filter
            <button onClick={clearAll}>Show</button>
          </div>
        )}

        {empty && (
          <div className="todo-empty">
            <span className="todo-empty-ic">
              <CheckSquare size={22} />
            </span>
            <div className="todo-empty-t">Nothing on your plate</div>
            <div className="todo-empty-s">Capture a task above — then open it to hand off.</div>
          </div>
        )}

        {/* THE TWO COUNTERS, and they behave differently on purpose. This one
            reads the filter; DeskSideRail's tab badge is the true open total
            and is NOT touched — it is a queue-depth glance rendered while the
            owner may be on the SOP tab where the filter control is not even
            visible, so a filtered number there is unexplainable. And it is the
            count of DISTINCT open items, never the sum of the group counts. */}
        {open.length > 0 && (
          <div className="todo-plate-h">
            {group === 'ticket'
              ? 'Grouped by state'
              : group
                ? `Grouped by ${group}`
                : 'To do'}
            <span className="todo-plate-c">
              {filtering ? (
                <>
                  <b>{shown.length}</b> of {open.length}
                </>
              ) : (
                <b>{open.length}</b>
              )}
            </span>
            {filtering && (
              <button className="ctl-clear" onClick={clearAll} aria-label="Clear filter">
                <X size={11} />
              </button>
            )}
          </div>
        )}

        {!group && !shown.length && open.length > 0 && (
          <div className="todo-empty">
            {/* Under a search this is the CREATE prompt, and deliberately so:
                "nothing on your plate says this yet" is the exact moment the
                answer is to capture it, and the box already holds the words. */}
            <div className="todo-empty-t">
              {searching ? <>No task matches “{text.trim()}”</> : 'Nothing matches'}
            </div>
            <div className="todo-empty-s">
              {searching
                ? 'Press Enter to capture it as a new task.'
                : registry.state === 'provisional'
                  ? 'Showing last-known labels — this filter may be out of date.'
                  : 'No open task carries this combination.'}
            </div>
          </div>
        )}

        {/* Grouping is a PURE PROJECTION and never writes, which is the whole
            answer to "does ungrouping restore my hand order?" — nothing was
            modified, so there is nothing to restore. */}
        {group && (
          <div className="grp-note">
            <Info size={12} />
            <span>
              <b>Order is locked while grouped.</b> Rows keep their plate order. Ungroup — or
              filter to one label — to drag again.
            </span>
          </div>
        )}

        {group
          ? visibleGroups.map(renderGroup)
          : shown.map((t) => renderRow(t))}

        {group && emptyCount > 0 && !showEmpties && (
          <button className="grp-empties" onClick={() => setShowEmpties(true)}>
            {emptyCount} empty group{emptyCount > 1 ? 's' : ''} · Show
          </button>
        )}
        {group && showEmpties && !filtering && (
          <button className="grp-empties" onClick={() => setShowEmpties(false)}>
            Hide empty groups
          </button>
        )}

        {/* THE ARCHIVED DRAWER. Not "Completed" any more, and the rename is
            not cosmetic: the word cannot sit above rows carrying a Done
            CHIP that means something else entirely. Three claims come off at
            once — the heading, the green check (a green check above an
            Archived-but-Working row is a claim the row contradicts), and the
            strikethrough in the CSS (strikethrough means FINISHED; these rows
            are merely FILED, and the dim already says so).

            It also honours the filter now. Unfiltered was harmless while the
            drawer was uniformly "done"; with two axes it would quietly
            contradict the control directly above it. */}
        {archivedList.length > 0 && (
          <div className="todo-arch-drawer">
            <button className="todo-arch-tog" onClick={() => setShowArchived((s) => !s)}>
              <Archive size={12} />
              Archived<span className="todo-arch-c">{archivedList.length}</span>
              {filtering && (
                <span className="todo-arch-sub">
                  showing {archivedShown.length} of {archivedList.length}
                </span>
              )}
              <span className="todo-arch-line" />
              {showArchived ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
            {showArchived &&
              archivedShown.map((t) => (
                <TodoItem
                  key={t.id}
                  t={t}
                  onArchive={archive}
                  onRemove={remove}
                  onUse={onUseTodo}
                  {...rowPresence(agents, t)}
                />
              ))}
          </div>
        )}
      </div>

      {/* The row popover. Rendered INLINE rather than as a nested component:
          a component defined inside TodoRail would be a new type on every
          render, so React would remount it and the inline-create field would
          lose what the owner had typed on every keystroke elsewhere. */}
      {labelPop && popTarget && (
        <>
          <div className="pop-scrim" onMouseDown={() => setLabelPop(null)} />
          <div
            className="pop"
            style={{ left: 8, top: labelPop.top }}
            role="dialog"
            aria-label="Labels"
          >
            <div className="pop-h">
              Labels<span className="sp" />
              <button className="pop-x" onClick={() => setLabelPop(null)} aria-label="Close">
                <X size={13} />
              </button>
            </div>
            <LabelInput
              value={popTarget.labels ?? []}
              registry={registry}
              error={popError}
              onChange={(slugs) => {
                setPopError(null)
                // The server's 400 is the correctness boundary the input-time
                // guard cannot be: the cap is reachable by race, and a full
                // REPLACE means the rejection takes the whole write with it —
                // so the optimistic patch rolls back to the server's state
                // rather than leaving chips on screen that were never saved.
                // No context object: `ctx.slug` is a LABEL slug, and
                // `popTarget.id` is a to-do UUID. Latent today only because the
                // codes reachable from a to-do PATCH happen not to read it —
                // the day one does, the owner reads "You already have
                // 7f3a-…-9c1 in your list."
                setLabels(popTarget.id, slugs, (err) => setPopError(labelErrorMessage(err)))
              }}
              onCreate={(name, kind) => create({ name, kind })}
              onManage={() => {
                setLabelPop(null)
                setShowSheet(true)
              }}
              onRetry={refetch}
              writable={writable}
            />
          </div>
        </>
      )}

      {showSheet && (
        <LabelManageSheet
          registry={registry}
          content={content}
          refCounts={counts}
          unregistered={unregistered}
          onClose={() => setShowSheet(false)}
          flash={flash}
        />
      )}

      {showInfo && <TodoPublishInfo onClose={() => setShowInfo(false)} />}
    </div>
  )
}

/** Plain-English request a new user can hand to any to-do-capable agent. */
const SAMPLE_REQUEST =
  'Check my emails today and publish the ones that need action by end of day to my To-Do under My Desk.'

/**
 * Informational modal: explains that you don't add to-dos by hand — you ask an
 * agent, in plain language, and it drops each item on your plate with a
 * ready-to-refine prompt attached. Shows one copy-ready sample request. Reuses
 * the shared `md-ov` overlay chrome (backdrop + card + ✕); closes on ✕,
 * backdrop mousedown, or Escape — same pattern as BriefingOverlay.
 */
function TodoPublishInfo({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = () => {
    if (!navigator.clipboard) return
    navigator.clipboard
      .writeText(SAMPLE_REQUEST)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }

  return (
    <div className="md-ov" onMouseDown={onClose}>
      <div className="md-ov-card todo-info-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="md-ov-top">
          <div className="md-ov-eyebrow">How your plate fills up</div>
          <button className="md-ov-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <h2 className="md-ov-title todo-info-title">Let an agent fill your plate</h2>

        <div className="todo-info-body">
          <p>
            You don't add to-dos by hand. You ask an agent — in plain language — and it reads the
            source (your inbox, a doc, a dashboard), decides what actually needs your attention, and
            drops each item on your plate with a ready-to-refine prompt attached.
          </p>

          <div className="todo-info-lbl">Try asking an agent</div>
          <div className="todo-info-cmd">
            <span>{SAMPLE_REQUEST}</span>
            <button className="todo-info-copy" onClick={copy} aria-label="Copy request">
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <p className="todo-info-foot">
            Works the same for your calendar, PRs, receipts — anything an agent watches. Items an
            agent publishes land here badged with its name; click one to open it and refine the
            prompt before you hand it back.
          </p>
        </div>
      </div>
    </div>
  )
}
