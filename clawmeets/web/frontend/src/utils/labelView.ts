import {
  PALETTE,
  type DeskLabel,
  type LabelKind,
  type PaletteToken,
  MAX_SLUG_LEN,
} from '../api/endpoints/deskLabels'
import type { DeskTodo, TicketState } from '../api/endpoints/deskTodos'

/**
 * THE PROJECTION LAYER. Every function here is pure and total: same inputs,
 * same output, never throws, never reads a store, never touches the network.
 *
 * Ported from the mock's `matches()` / `chipsFor()` / `nextColor()` /
 * `reconcile()`, which were already written this way. Pure is not tidiness —
 * it is what turns the mock's behaviour checks into unit tests that run in
 * milliseconds instead of DOM tests that need a rendered rail.
 */

/** How much the client currently knows about the registry. Derived in exactly
 *  one place (`hooks/useLabels.ts:deriveRegistryState`) and read here. */
export type RegistryState = 'ready' | 'provisional' | 'cold' | 'unavailable'

/** `ready` and `provisional` both mean "we hold a list"; the difference is
 *  whether it is fresh, and the ONLY thing that turns on is whether a
 *  destructive reconcile may run. */
export function axisKnown(state: RegistryState): boolean {
  return state === 'ready' || state === 'provisional'
}

/**
 * WHY THE AXIS IS UNKNOWN, in the owner's words.
 *
 * `axisKnown` is false for `cold` AND `unavailable`, and every surface that
 * disables a control reads that one boolean — so without this, five surfaces
 * tell the owner "your label list didn't load" while the very first query of
 * the session is still in flight and nothing has failed. That is not a cosmetic
 * slip: it is a loading state reported as a bug, and it is not rare — Safari
 * private mode throws out of `readCache`, so every reload there goes `cold`
 * and never `provisional`.
 *
 * Same disabled controls in both states. Different sentence, because `cold`
 * means "not yet" and `unavailable` means "not going to".
 */
export function unknownAxisReason(state: RegistryState): string {
  return state === 'cold'
    ? 'Still loading your labels…'
    : "Your label list didn't load."
}

export interface ResolvedLabel {
  slug: string
  name: string
  kind: LabelKind | 'unknown'
  color: PaletteToken | null
  /** FALSE means "the registry is held and this slug is genuinely not in it" —
   *  the dashed, colourless, "+ add it" treatment. Off-ready it is TRUE, which
   *  is the whole chip fix: we do not KNOW it isn't registered, so we must not
   *  say it isn't. Say it and the "not in your list" treatment lands on the
   *  owner's entire vocabulary at once, each chip offering an "Add it" that
   *  POSTs and earns `labels.duplicate`. */
  registered: boolean
}

export interface ResolvedRegistry {
  labels: DeskLabel[]
  state: RegistryState
  /** slug → array position. Position IS the order (contexts, then states, in
   *  the order the owner dragged them), and it drives both chip order within a
   *  row and group order down the rail. */
  index: Map<string, number>
}

/** The axis the rail groups by. NOT `LabelKind`: `'ticket'` is not a label
 *  kind, it reads the server-derived `state` field and consults the registry
 *  not at all. Keeping it out of `LabelKind` is what stops it being handed to
 *  `labelsOfKind` / `groupTodos` by a caller that assumes the two are the same
 *  vocabulary. `'state'` is gone with the axis. */
export type GroupAxis = 'context' | 'ticket'

/** The durable view state, as the pure layer sees it. */
export interface LabelView {
  group: null | GroupAxis
  filter: string[]
  matchAll: boolean
  /** The ticket states the plate is narrowed to. ITS OWN ARRAY, never slugs in
   *  `filter`, and that separation is load-bearing rather than tidy: a slug in
   *  `filter` gets resolved against the registry by the pin set, by the
   *  liveness check in `reconcileView` and by `labelCounts` — so a state slug
   *  there would render as a dashed unknown chip, be reported as deleted, and
   *  count zero, in all three. Empty means "every state". */
  states: TicketState[]
}

export interface MergeHint {
  from: string
  into: string
}

/** Build the shape every function below takes. Cheap; memoize at the hook. */
export function toRegistry(labels: DeskLabel[], state: RegistryState): ResolvedRegistry {
  const index = new Map<string, number>()
  labels.forEach((l, i) => index.set(l.slug, i))
  return { labels, state, index }
}

export const EMPTY_REGISTRY: ResolvedRegistry = toRegistry([], 'cold')

/**
 * THE one client-side rule the whole feature hangs on. ALWAYS returns
 * something — six surfaces ask this what a slug is, and `undefined` at any of
 * them is a crash or a silent drop.
 *
 *   registry held + found   → the real row
 *   registry held + missing → `{ kind: 'context', registered: false }`  (R2)
 *   registry NOT held       → `{ kind: 'unknown',  registered: TRUE  }`  (R19)
 *
 * The third row is the one that is easy to get wrong, and §9.1 of the
 * feasibility read is the argument: the absence of a palette colour is the
 * "not curated yet" signal precisely BECAUSE every other chip has one. Under a
 * total failure no chip has one, so the signal has to be WITHDRAWN, not
 * applied to all. `kind: 'unknown'` is the same refusal about the axis: no
 * sigil, because a sigil is a claim we cannot read.
 */
export function resolveLabel(slug: string, reg: ResolvedRegistry): ResolvedLabel {
  if (axisKnown(reg.state)) {
    const i = reg.index.get(slug)
    if (i !== undefined) {
      const l = reg.labels[i]
      return {
        slug: l.slug,
        name: l.name,
        kind: l.kind,
        color: l.color,
        registered: true,
      }
    }
    return { slug, name: slug, kind: 'context', color: null, registered: false }
  }
  return { slug, name: slug, kind: 'unknown', color: null, registered: true }
}

/** The sigil is presentational, rendered everywhere, stored nowhere — and an
 *  `unknown` label gets none, because it is a claim about the axis.
 *
 *  ONE KIND LEFT, so one sigil. The `!` retired with the state axis: it existed
 *  to name the second key you could press, and there is no second key. */
export function sigil(l: ResolvedLabel): string {
  return l.kind === 'unknown' ? '' : '@'
}

export function displayName(l: ResolvedLabel): string {
  return sigil(l) + l.name
}

export function labelsOfKind(reg: ResolvedRegistry, kind: LabelKind): DeskLabel[] {
  if (!axisKnown(reg.state)) return []
  return reg.labels.filter((l) => l.kind === kind)
}

/**
 * Does this to-do pass the active LABEL filter? A flat OR over the chosen
 * slugs, or a strict AND under `matchAll`.
 *
 * It used to be "OR within a kind, AND across kinds". With one kind left the
 * cross-kind refinement is gone, which is the correct collapse rather than a
 * simplification: state narrowing now comes from `view.states` and
 * `ticketView.matchesPlate`, which consult no registry at all.
 *
 * OFF-READY IT DEGRADES TO A FLAT OR, and it must never fall through to
 * "everything passes": a filter that silently stops filtering while the chip
 * still reads "Filter 2" has the owner reading 35 items under a filter set to
 * show 6, and concluding items appeared.
 *
 * A filter is a slug-set test against `todo.labels` and needs no registry at
 * all; only `matchAll`'s strict AND is a claim worth withholding off-ready,
 * because we cannot see which of the chosen slugs are real. So it survives,
 * degraded to as close to its real meaning as the data allows — never
 * suspended (which shows all 35), never cleared (which destroys something set
 * on purpose).
 */
export function matches(
  todo: DeskTodo,
  view: LabelView,
  reg: ResolvedRegistry,
): boolean {
  if (!view.filter.length) return true
  const own = todo.labels ?? []
  if (!axisKnown(reg.state)) return view.filter.some((s) => own.includes(s))

  return view.matchAll
    ? view.filter.every((s) => own.includes(s))
    : view.filter.some((s) => own.includes(s))
}

/** Render cap for chips on a row. DELIBERATELY NOT the storage cap of 8 —
 *  §7.2: nothing derives one from the other, so the backend limit never ends
 *  up making a UI decision. */
export const CHIP_CAP = 3

/** A chip as the row renders it. `pinned` travels WITH the chip rather than
 *  being recomputed per row from the filter: the ordering already knows which
 *  ones pinned, and re-deriving it in the component is how the ring and the
 *  order drift apart. */
export interface RowChip extends ResolvedLabel {
  pinned: boolean
}

export interface RowChips {
  show: RowChip[]
  more: number
}

/**
 * Which chips render on a row, in order, capped at `CHIP_CAP`.
 *
 * Filtered-on labels PIN to the front — a filter must never hide the reason a
 * row is on screen — then registered contexts in REGISTRY ARRAY ORDER, then
 * unregistered contexts last so the row's colour rhythm holds.
 *
 * THE TICKET CHIP IS NOT IN HERE and cannot be: it has no slug, it is never a
 * member of `todo.labels`, and `TicketChip.tsx` imports neither this module
 * nor `LabelChip`. That is what makes "the derived chip never consumes one of
 * the row's three slots and never falls under `+N`" a compile-time fact. Over the cap: show `CHIP_CAP - 1` and report the rest, so the row
 * reads "2 chips + N" rather than "3 chips" and a lie.
 *
 * Off-ready there is no kind to sort by and no registry index to sort within,
 * so the row keeps its STORED order with pinned still first. Without that
 * branch the kind filters below match neither value and every chip silently
 * VANISHES from the row.
 */
export function chipsFor(
  todo: DeskTodo,
  view: LabelView,
  reg: ResolvedRegistry,
  expanded = false,
): RowChips {
  const active = new Set(view.filter)
  const own: RowChip[] = (todo.labels ?? []).map((s) => ({
    ...resolveLabel(s, reg),
    pinned: active.has(s),
  }))
  const pinned = own.filter((l) => l.pinned)
  const rest = own.filter((l) => !l.pinned)

  const ordered = !axisKnown(reg.state)
    ? [...pinned, ...rest]
    : [
        ...pinned,
        ...rest
          .filter((l) => l.kind === 'context' && l.registered)
          .sort((a, b) => registryIndex(a, reg) - registryIndex(b, reg)),
        ...rest.filter((l) => l.kind === 'context' && !l.registered),
      ]

  if (expanded || ordered.length <= CHIP_CAP) return { show: ordered, more: 0 }
  return {
    show: ordered.slice(0, CHIP_CAP - 1),
    more: ordered.length - (CHIP_CAP - 1),
  }
}

function registryIndex(l: ResolvedLabel, reg: ResolvedRegistry): number {
  return reg.index.get(l.slug) ?? 999
}

export interface LabelGroup {
  /** The label's slug, or the `__resid` sentinel for the residual group. */
  key: string
  /** Header text, sigil included. */
  name: string
  label: ResolvedLabel | null
  items: DeskTodo[]
  /** Drives the header's styling: `resid` is quiet (the context residual),
   *  `unreg` carries the dashed language, `ticket` marks a derived group so a
   *  reader (and a test) can tell one from a label group in the markup.
   *
   *  `inbox` is gone with the state axis — it styled the "Unprocessed · no
   *  state" pile, which nagged. New is the inbox now, and New is an ordinary
   *  group with nothing to nag about. */
  tone: '' | 'unreg' | 'resid' | 'ticket'
  /** Unregistered groups open collapsed — they are a repair queue, not part of
   *  the owner's curated map, and at eight groups the vertical budget is the
   *  binding constraint. The store's explicit overrides win over this. */
  collapsedByDefault: boolean
}

/**
 * Group the filtered open list. A to-do appears under EVERY label it carries
 * on the chosen axis; duplication is free, because all copies are one
 * react-query record, so an archive propagates to every rendering in one frame.
 *
 * Group order is registry array position. Unregistered slugs form their own
 * groups sorted LAST (and collapsed by default). Items carrying no label fall
 * to the trailing residual, which goes LAST and stays quiet — no context is
 * benign.
 *
 * THE LABEL AXIS ONLY. Grouping by ticket state is `ticketView`'s
 * `groupByTicketState`, which takes no registry argument at all — and that is
 * the type-level reason it cannot vanish when the registry does, where this
 * one correctly returns nothing.
 *
 * PURE PROJECTION. Never writes, never calls reorder. That is the whole answer
 * to "does ungrouping restore my hand order?" — nothing was modified, so there
 * is nothing to restore.
 */
export function groupTodos(
  shown: DeskTodo[],
  axis: LabelKind,
  reg: ResolvedRegistry,
): LabelGroup[] {
  if (!axisKnown(reg.state)) return []

  const registered = reg.labels.filter((l) => l.kind === axis)
  const unregistered = unregisteredSlugs(shown, reg)

  const groups: LabelGroup[] = []
  const residual = shown.filter(
    (t) => !(t.labels ?? []).some((s) => resolveLabel(s, reg).kind === axis),
  )

  for (const l of registered) {
    const resolved = resolveLabel(l.slug, reg)
    groups.push({
      key: l.slug,
      name: displayName(resolved),
      label: resolved,
      items: shown.filter((t) => (t.labels ?? []).includes(l.slug)),
      tone: '',
      collapsedByDefault: false,
    })
  }

  for (const slug of unregistered) {
    const resolved = resolveLabel(slug, reg)
    groups.push({
      key: slug,
      name: displayName(resolved),
      label: resolved,
      items: shown.filter((t) => (t.labels ?? []).includes(slug)),
      tone: 'unreg',
      collapsedByDefault: true,
    })
  }

  if (residual.length) {
    groups.push({
      key: RESIDUAL_KEY,
      name: 'No context',
      label: null,
      items: residual,
      tone: 'resid',
      collapsedByDefault: false,
    })
  }

  return groups
}

export const RESIDUAL_KEY = '__resid'

/** Group keys for the three ticket groups are namespaced so they can never
 *  collide with a label slug — `normalizeSlug` rejects `:`, so no registry row
 *  can ever produce one of these. Defined here rather than in `ticketView`
 *  because `reconcileView`'s collapsed-key survivor list has to recognise one,
 *  and that reader must not import the module that imports it. */
export const TICKET_GROUP_PREFIX = '__tk:'

/** Every slug on the plate the held registry does not know, in first-seen
 *  plate order. Off-ready the answer is NONE, not all: we cannot know that any
 *  slug is unregistered, and without this line every "not in your list"
 *  surface offers to add back the owner's own labels, each tap a 409. */
export function unregisteredSlugs(
  todos: DeskTodo[],
  reg: ResolvedRegistry,
): string[] {
  if (!axisKnown(reg.state)) return []
  const out: string[] = []
  for (const t of todos) {
    for (const s of t.labels ?? []) {
      if (!reg.index.has(s) && !out.includes(s)) out.push(s)
    }
  }
  return out
}

/**
 * How many DISTINCT open items carry each slug.
 *
 * Distinct, never the sum of per-group counts: under duplication those count
 * row INSTANCES and their sum exceeds the plate. "@office 8 + !Next 6" over a
 * 35-item plate is not 14 to-dos.
 */
export function labelCounts(open: DeskTodo[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of open) {
    // A duplicated slug on one row still counts once for that row.
    for (const s of new Set(t.labels ?? [])) {
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Default colour for a NEW label: the LEAST-USED palette token, ties broken by
 * PALETTE array order (first minimum wins, strict `<`).
 *
 * NOT `PALETTE[count % 8]`, which is wrong in the ORDINARY case rather than
 * the exotic one — delete one label, create another, and it lands back on a
 * token in use while three sit free. Verbatim port of the mock's `nextColor()`
 * and a mirror of `default_color()` in the model; the browser always sends
 * `color` explicitly, so the two copies can never visibly disagree.
 */
export function nextColor(labels: DeskLabel[]): PaletteToken {
  const used = new Map<PaletteToken, number>(PALETTE.map((c) => [c, 0]))
  for (const l of labels) {
    if (l.color && used.has(l.color)) used.set(l.color, used.get(l.color)! + 1)
  }
  return PALETTE.reduce((a, b) => (used.get(b)! < used.get(a)! ? b : a))
}

/** Cycle a swatch through the palette from wherever it currently sits. */
export function cycleColor(current: PaletteToken | null): PaletteToken {
  const i = current ? PALETTE.indexOf(current) : -1
  return PALETTE[(i + 1) % PALETTE.length]
}

/* ─────────────────────────── slug normalization ─────────────────────────── */

export type SlugFault = 'invalid_slug' | 'slug_too_long'

export interface SlugResult {
  slug: string
  fault: SlugFault | null
}

const NON_SLUG_RUN = /[^a-z0-9-]+/g
const DASH_RUN = /-{2,}/g
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/

/**
 * The contract's normalization, mirroring `normalize_label()` in
 * `clawmeets/models/desk_todo.py` step for step: NFKC + strip, drop ONE
 * leading `@`, lowercase, collapse every run of non-`[a-z0-9-]` to a single
 * `-`, collapse `-` runs and trim them, then validate.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *  - It does NOT drop illegal characters. Contract §8's "drop" prose
 *    contradicts the contract's own worked example (`"Someday/Maybe"` →
 *    `someday-maybe`, not `somedaymaybe`); the shipped server REPLACES, and so
 *    does the mock, character for character. This is the correct one.
 *  - It does NOT truncate at 32 like the mock's `.slice(0, 32)`. The server
 *    answers a long slug with `labels.slug_too_long` and refuses the write, so
 *    truncating client-side would send a value the server rejects. Refuse here
 *    instead and let the caller say so at input time.
 */
export function normalizeSlug(raw: string): SlugResult {
  if (typeof raw !== 'string') return { slug: '', fault: 'invalid_slug' }
  let text = raw.normalize('NFKC').trim()
  if (text.startsWith('@')) text = text.slice(1)
  text = text.toLowerCase().replace(NON_SLUG_RUN, '-')
  text = text.replace(DASH_RUN, '-').replace(/^-+|-+$/g, '')
  if (!text || !VALID_SLUG.test(text)) return { slug: text, fault: 'invalid_slug' }
  if (text.length > MAX_SLUG_LEN) return { slug: text, fault: 'slug_too_long' }
  return { slug: text, fault: null }
}

/** A display name with its leading sigils stripped — `@` / `!` are chrome the
 *  renderer prepends from `kind`, never data. Mirrors `_display_name()`. */
export function displayNameFrom(raw: string): string {
  return raw.trim().replace(/^[@!]+/, '').trim()
}

/* `clashWith` is DELETED, not kept-and-unused. It answered exactly one
 * question — "is this name already taken by the OTHER kind?" — so with one kind
 * left it could only ever return null, and a function that always returns null
 * is a branch at three call sites that no test can reach. A name already in the
 * registry is now simply a duplicate, which `registry.index.has` already says
 * and `labels.duplicate` already names. */

/* ───────────────────────── registry content diagnosis ───────────────────── */

/**
 * What a HELD registry actually says — three outcomes that must not collapse
 * into one code path, because the server produces them for three different
 * reasons and only one of them is healthy.
 *
 *  - `populated`   — rows present. Slugs on the plate the registry doesn't
 *                    know surface as dashed chips + the manage sheet's "not in
 *                    your list" section. This is also where a PARTIALLY corrupt
 *                    registry lands: the server answers 200 with whatever
 *                    parsed, and the rows it dropped read as unregistered.
 *  - `empty`       — zero rows and nothing on the plate carries a label. A
 *                    legitimate 200 (`{"labels": []}`) from an owner who
 *                    deleted their vocabulary, or has not built one. NOT a
 *                    failure, and it must never render as one.
 *  - `orphaned`    — zero rows but the plate DOES carry labels. This is the
 *                    corrupt-looks-missing trap: an entirely unparseable
 *                    registry answers with zero rows rather than the seed, so
 *                    it is indistinguishable on the wire from a deliberately
 *                    emptied one — EXCEPT by this: an owner who deleted every
 *                    label would have had them detached from every to-do on
 *                    the way out. Labels on the plate with an empty list means
 *                    the list did not come back, not that it was emptied.
 */
export type RegistryContent = 'populated' | 'empty' | 'orphaned'

export function diagnoseRegistry(
  reg: ResolvedRegistry,
  open: DeskTodo[],
): RegistryContent {
  if (reg.labels.length) return 'populated'
  return open.some((t) => (t.labels ?? []).length) ? 'orphaned' : 'empty'
}

/**
 * MAY THE CLIENT WRITE TO THE REGISTRY AT ALL?
 *
 * `orphaned` is not merely a display problem, and this is the part that is easy
 * to miss: the server materializes an unparseable registry as ZERO ROWS, and
 * `create_label` then appends to that empty list and `_save`s it. The write
 * succeeds, the file is overwritten, and a twelve-label registry becomes one —
 * through whichever control the owner happened to press. The original bytes,
 * which may well have been recoverable by hand, are gone.
 *
 * So every surface that can reach `POST /me/desk/labels` — the manage sheet,
 * the row popover's create field, the capture autocomplete's "Create context"
 * row — asks this first. Refusing to add is a small cost paid during a state
 * that usually clears by itself; the alternative is silent, permanent, and
 * indistinguishable from the repair the owner thought they were performing.
 *
 * The `axisKnown` half is not new behaviour, only stated in one place: with no
 * readable list there is nothing to create against either.
 */
export function registryWritable(
  state: RegistryState,
  content: RegistryContent,
): boolean {
  return axisKnown(state) && content !== 'orphaned'
}

/** Said wherever a create is refused for that reason. One string, because the
 *  three surfaces are one refusal and must not drift into three explanations. */
export const ORPHANED_WRITE_REFUSAL =
  "Your label list came back empty, so we can't add to it right now — a new label " +
  'could overwrite the list we cannot read. Try again in a moment.'

/* ──────────────────────────────── reconcile ─────────────────────────────── */

export interface ReconcileResult {
  next: LabelView & { collapsed: Record<string, boolean> }
  notice: string | null
  /** True when anything actually moved — the caller only writes on a change,
   *  so a steady-state refetch does not churn `localStorage`. */
  changed: boolean
}

export interface ReconcileInput extends LabelView {
  collapsed: Record<string, boolean>
}

/**
 * §1.1's reconcile, as a pure function so it can be tested without a store or
 * a network.
 *
 * CALLERS MUST ONLY CALL THIS WITH A FRESH REGISTRY (query `isSuccess`). A
 * cached registry cannot tell "this label was deleted" from "my copy is a day
 * old", and acting on the difference is destructive in exactly one direction:
 * one transient 500 would permanently clear a filter the owner set on purpose
 * and pop a notice claiming a label was deleted when it wasn't. A filter that
 * shows nothing while the network is down is strictly the better failure.
 *
 * `plateSlugs` is what keeps this from eating the owner's UNREGISTERED
 * filters. A slug absent from the registry is not thereby dead — an agent can
 * write one at any time and the mock lets the owner filter on it. It is dead
 * only when the registry does not have it AND no open to-do carries it.
 * (The plan's three-argument signature predates that distinction; without this
 * argument every unregistered filter chip is cleared on the next refetch.)
 *
 * Delete and merge are NOT the same case, and the asymmetry is the design:
 * merge follows the target because the owner's intent survived it — same set,
 * different name. Delete is the opposite: the set is gone, so silently showing
 * all 35 where they last saw 6 reads as "my to-dos multiplied". Hence the
 * notice — a filter must never stop being active without saying so.
 *
 * Cross-kind merges are refused by the server, so the merge row is
 * kind-preserving by construction and there is no defence here against
 * re-targeting a state group onto a context. That branch would be unreachable,
 * and an unreachable branch is a claim nobody can test.
 */
export function reconcileView(
  view: ReconcileInput,
  labels: DeskLabel[],
  plateSlugs: Set<string>,
  merges: MergeHint[] = [],
): ReconcileResult {
  const live = new Set(labels.map((l) => l.slug))
  const target = new Map(merges.map((m) => [m.from, m.into]))

  const merged: string[] = []
  const dropped: string[] = []
  const filter: string[] = []
  for (const slug of view.filter) {
    const into = target.get(slug)
    if (into) {
      if (!filter.includes(into)) filter.push(into)
      merged.push(slug)
      continue
    }
    // Alive if the registry lists it, or if the plate still carries it (an
    // agent-written slug the owner has legitimately filtered on).
    if (live.has(slug) || plateSlugs.has(slug)) {
      if (!filter.includes(slug)) filter.push(slug)
      continue
    }
    dropped.push(slug)
  }

  // A dead key in `collapsed` is inert — filter it and say nothing. A TICKET
  // group key is kept unconditionally: it names no label, so neither the
  // registry nor the plate can vouch for it, and without this line an owner's
  // folded Done group silently unfolds on every registry refetch.
  const collapsed: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(view.collapsed)) {
    if (
      key === RESIDUAL_KEY ||
      key.startsWith(TICKET_GROUP_PREFIX) ||
      live.has(key) ||
      plateSlugs.has(key)
    ) {
      collapsed[key] = value
    }
  }

  // NOTE WHAT IS NOT HERE, because its absence is the behaviour: there is no
  // `group === 'state'` branch popping "Your last state was deleted — grouping
  // switched off." After the retirement no registry returns a state row, so
  // that condition would be ALWAYS TRUE — it would switch grouping off for
  // every owner who had it on, under a sentence that is false. It is deleted
  // rather than adapted; ticket grouping has no registry row to lose, so there
  // is nothing here for it to reconcile.
  let group = view.group
  if (
    group === 'context' &&
    !labels.some((l) => l.kind === 'context') &&
    ![...plateSlugs].length
  ) {
    // No contexts and nothing on the plate to form an unregistered group:
    // there is no label axis left to project onto. Silent: nothing was nagging
    // the owner about it. `'ticket'` is deliberately not reachable here — it
    // projects onto a derived field that is always there.
    group = null
  }

  const notice = noticeFor(merged, dropped, filter.length, target, toRegistry(labels, 'ready'))

  const changed =
    group !== view.group ||
    filter.length !== view.filter.length ||
    filter.some((s, i) => s !== view.filter[i]) ||
    Object.keys(collapsed).length !== Object.keys(view.collapsed).length

  return {
    // `states` rides through UNTOUCHED and that is not an oversight. There is
    // nothing here to reconcile it against — a ticket state has no registry row
    // to be deleted or merged — but the caller writes this whole object back to
    // storage, so dropping the key here would silently unpersist the owner's
    // state filter on the next registry refetch.
    next: { group, filter, matchAll: view.matchAll, states: view.states, collapsed },
    notice,
    changed: changed || merges.length > 0,
  }
}

/**
 * A NOTICE NAMES A LABEL THE WAY THE RAIL NAMES IT.
 *
 * These fire unprompted, on someone else's action in another tab, which is
 * exactly when recognition matters most — and the filter bar six inches below
 * renders the same label as `@office`. A notice saying `office` is the same
 * label in a second spelling.
 *
 * A DELETED label is quoted instead: it has no row left to read a name or a
 * kind from, and printing `@office` there would assert an axis we just lost.
 * The merge TARGET is alive by construction, so it resolves.
 */
function noticeName(slug: string, reg: ResolvedRegistry): string {
  const l = resolveLabel(slug, reg)
  return l.registered ? displayName(l) : `“${slug}”`
}

/**
 * A refetch can carry BOTH a merge and a delete — two tabs, two owners' hands,
 * one poll. An early return on the merge branch would announce one and swallow
 * the other, and the swallowed one is a filter chip that vanished with no
 * explanation, which is the single thing §1.1's notice exists to prevent.
 * So: both sentences, in the order they read best.
 */
function noticeFor(
  merged: string[],
  dropped: string[],
  remaining: number,
  target: Map<string, string>,
  reg: ResolvedRegistry,
): string | null {
  const nm = (slug: string) => noticeName(slug, reg)
  const parts: string[] = []

  if (merged.length) {
    const intos = [...new Set(merged.map((f) => target.get(f)!))]
    if (intos.length === 1) {
      parts.push(
        merged.length === 1
          ? `${nm(merged[0])} was merged into ${nm(intos[0])} — your filter followed it.`
          : `${merged.map(nm).join(', ')} were merged into ${nm(intos[0])} — your filter followed them.`,
      )
    } else {
      // Two merges into two different targets in one poll. Vanishingly rare,
      // and still nameable — the alternative is a count, which tells the owner
      // nothing they can act on.
      parts.push(
        merged.map((f) => `${nm(f)} was merged into ${nm(target.get(f)!)}`).join('; ') +
          ' — your filter followed them.',
      )
    }
  }

  if (dropped.length) {
    const names = dropped.map(nm).join(', ')
    const subject = dropped.length === 1 ? `Label ${names} was` : `Labels ${names} were`
    parts.push(
      remaining === 0
        ? `${subject} deleted — filter cleared.`
        : `${subject} deleted — removed from your filter.`,
    )
  }

  return parts.length ? parts.join(' ') : null
}

/**
 * The group axis the rail should actually render.
 *
 * Under `unavailable` the stored value is SUPPRESSED, not overwritten: the
 * mock's `reconcile()` assigns `S.group = null`, but its `S` is ephemeral
 * session state and ours is persisted. Deriving instead of writing means the
 * owner's axis comes back by itself when the registry does.
 *
 * `'ticket'` IS EXEMPT from that suppression, and the exemption is the whole
 * reason ticket grouping is worth having: it partitions on a field that
 * arrives with the to-do, so it works exactly as well with a dead registry as
 * with a live one. Suppressed alongside `'context'`, the one axis that still
 * functions would vanish precisely when it is the only one left.
 */
export function effectiveGroup(view: LabelView, state: RegistryState): null | GroupAxis {
  if (view.group === 'ticket') return 'ticket'
  return axisKnown(state) ? view.group : null
}
