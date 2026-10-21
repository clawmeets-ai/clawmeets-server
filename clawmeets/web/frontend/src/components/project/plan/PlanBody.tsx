import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { Check, MessageSquare } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { PlanNote, PlanSection } from '../../../api/endpoints/projectPlans'
import { chatMarkdownComponents } from '../../shared/MarkdownBody'
import rehypeHideComments from '../../shared/rehypeHideComments'
import { PlanBlockEdit } from './PlanBlockEdit'
import {
  blockSource,
  containsBlock,
  editableRange,
  splitOwnChildren,
  taskChecked,
  toggleCheckbox,
  type BlockNode,
  type BlockRange,
} from './planBlocks'
import {
  blockCarries,
  capQuote,
  flattenOwn,
  MIN_QUOTE_CHARS,
  normalizeText,
  stripMarkers,
} from './planAnchor'

/** Width of the composer popover, for the clamp that keeps it on screen. */
const POP_WIDTH = 340

/** What the comment bubble hands the editor. `section` is bound by the block's
 *  own context — never re-derived by scanning text. */
export interface QuoteTarget {
  quote: string
  section: string
  /** WHICH BLOCK, so the target can find its way back into the document.
   *
   *  remark's `node.position.start.offset` within `textOf(section)` — the same
   *  number the note-claim map has always keyed a block on, and the same one
   *  the block hangs as `data-plan-block`. It is not a new identity and it is
   *  not stored anywhere: it is derived from the parse of the text on screen,
   *  so it cannot disagree with the pixels the popover was placed against.
   *
   *  It rides here because the composer no longer reprints the quote. The
   *  question "which block is this about" moved out of the popover and onto the
   *  document, and `section` + `block` is what lets the document answer it —
   *  `quote` alone could not, because a phrase occurring twice in a section
   *  would light both blocks. */
  block: number
  at: { top: number; left: number }
}

/** The word used for a block in a label a screen reader reads out. */
const TAG_WORD: Record<string, string> = {
  p: 'paragraph',
  li: 'list item',
  blockquote: 'quote',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  pre: 'code block',
  table: 'table',
}

/**
 * WHAT A TAB STOP IS CALLED, AND WHY A CONTAINER MUST NOT BORROW A LINE'S NAME.
 *
 * `Edit this list item` is a promise about scope, and on a container it is a
 * false one: pressing Enter there opens the bullet AND everything indented
 * under it, and committing rewrites all of it. A screen-reader user who cannot
 * see the indentation has only this string to go on, so the container says so.
 *
 * ONLY `li` AND `blockquote` EVER REACH THE SECOND BRANCH, and that is a fact
 * about the grammar rather than a coincidence worth relying on silently: a
 * heading and a paragraph cannot hold a block child in Markdown, and `pre` and
 * `table` have no `editableRange` at all. That is what keeps M2's one ARIA wrinkle
 * intact — `aria-label` is prohibited on role `paragraph`, so an editable `<p>`
 * carries `role="group"`, and a `<p>` is never a container, so no container
 * needs that workaround. `listitem` and `blockquote` both take a name from the
 * author, so a container keeps its native role and is named directly.
 */
function blockScopeWord(tag: string, whole: boolean): string {
  const word = TAG_WORD[tag] ?? 'line'
  return whole ? `${word} and everything nested inside it` : word
}

/**
 * THE PLAN DOCUMENT, WITH ITS NOTES IN IT — AND EDITABLE WHERE IT STANDS.
 *
 * This replaces the bare `<MarkdownBody content={index.body} />` the editor
 * used to render, on BOTH mounts — the Plan tab and the desk card's PLAN band
 * are the same component with a different `density`, so a change here reaches
 * both and cannot reach one of them only.
 *
 * IT PARSES NO MARKDOWN AND SCANS NOTHING. Every offset in this file was
 * derived by something else, and there are now two sources rather than one: the
 * server's `char_start`/`char_end` cut the body into sections (the same numbers
 * `sectionText` has always used, and the same fence-aware grammar that makes a
 * plan document quoting its own grammar safe), and remark's `node.position`
 * identifies a block INSIDE one — its `start.offset` has always been the block
 * identity in the note-claim map, and `end.offset` beside it is what makes a
 * block editable. Neither is computed here. The invariant is that the client
 * never re-derives SECTION structure by scanning the body, and it holds: a
 * block range is relative to one section's text and a splice never leaves it.
 *
 * THE TEXT IT RENDERS IS A PREFIX OF THE TEXT A SPLICE SEEDS FROM, which is why
 * `textOf` is a function rather than the raw `body`. While the tray holds text
 * for a section the document shows THAT text, so a second block edit in the
 * section composes with the first instead of silently dropping it — and the
 * offsets remark reports can never disagree with the pixels they were derived
 * from.
 *
 * A PREFIX and not the identical string, because a section nested inside
 * another is in the flat `sections` list AND inside its parent's extent; the
 * parent is drawn truncated at it so the overlap is drawn once. A block range
 * inside a prefix is the same range inside the whole string, so the splice is
 * unaffected and seeds from the full section text — see `sectionOwnText`.
 *
 * ONE ReactMarkdown PER SECTION rather than one for the document. That is what
 * makes "at the end of its OWN section" structural instead of arithmetic: the
 * end of a section is the end of its own subtree, so a note whose quote has
 * gone cannot drift to the bottom of the document — which is the complaint this
 * feature exists to answer. It is also what makes a block range meaningful,
 * because remark's offsets are relative to the string it was handed. The cost
 * is real and worth naming: a link reference definition in one section is not
 * visible to a link in another, because they are now two parses. The plan
 * grammar puts a definition inside the section that uses it in every document
 * we have, and the alternative — one parse plus a computed section end per
 * block — reintroduces exactly the arithmetic this avoids.
 */
export function PlanBody({
  textOf,
  sections,
  preamble,
  notes,
  readOnly,
  onQuote,
  commenting,
  onBlockEdit,
  renderNote,
  anchorOf,
  children,
}: {
  /** A section's Markdown AS RENDERED — amended when the tray holds text for
   *  it, pristine otherwise. Supplied by `PlanEditor` so a block's offsets and
   *  the pixels on screen are derived from one string. */
  textOf: (s: PlanSection) => string
  /** The sections to render: every one on the whole-document pane, exactly one
   *  on a section pane. The two panes are the same code path. */
  sections: PlanSection[]
  /** Anything before the first section — the document's `# ` title, which the
   *  server does not send as a section. Rendered plainly: it carries no notes
   *  and is not editable, because it belongs to no section and therefore to no
   *  tray row. */
  preamble: string
  /** Every note carrying a quote whose section is on screen — REPLIES
   *  INCLUDED. They used to be excluded because they nested under their parent
   *  inside `renderNote`; the threading deletion ended that, and a reply is now
   *  an ordinary root placed on its own `section` and `quote` like any other.
   *  A reply that inherited its parent's quote therefore lands in `mine` beside
   *  the parent under the same block, which is the point — and it costs no
   *  second paint, because the block is painted once however many notes it
   *  carries. */
  notes: PlanNote[]
  readOnly: boolean
  onQuote: (t: QuoteTarget | null) => void
  /** THE TARGET THE COMPOSER IS CURRENTLY OPEN ON, handed straight back down.
   *
   *  The block it names lights up while the composer stands, which is where the
   *  question the popover used to answer by reprinting the quote now gets
   *  answered. It is the editor's own `quoted` state, so there is no second
   *  copy to keep in step and no teardown to write: every path that dismisses
   *  the composer already clears that one value — cancel, Escape, a press
   *  anywhere in this document body, and a successful file — and the highlight
   *  goes out with it. */
  commenting?: QuoteTarget | null
  /** Commit a block's raw Markdown. `range` is remark's own offset pair for
   *  that block within `textOf(section)`. Never called with unchanged text. */
  onBlockEdit: (section: string, range: BlockRange, next: string) => void
  renderNote: (n: PlanNote, anchored: boolean) => ReactNode
  /** THE ID TO HANG ON A SECTION'S ROOT AS `data-note-id`, or `undefined`.
   *
   *  Supplied for a section whose text the TRAY is holding, so a staged edit —
   *  which the comment list draws as the comment it is — has the same landing
   *  target every real note has. A note is scrolled to by `[data-note-id]`; a
   *  staged edit is drawn AS the section's own text and owns no element of its
   *  own, so without this the list would need a second click contract for one
   *  row type. `PlanEditor`'s scroll effect is UNCHANGED and still queries one
   *  attribute.
   *
   *  A SECTION WITH BOTH STAGED TEXT AND AN OPEN NOTE HANGS THE ATTRIBUTE
   *  TWICE, and that is correct rather than a collision: the effect compares
   *  attribute VALUES and takes the match, and the two ids can never be equal —
   *  one is a client-generated row id, the other a server note id. */
  anchorOf?: (s: PlanSection) => string | undefined
  /** The composer popover, positioned against this host. */
  children?: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  /**
   * WHICH BLOCK OWNS WHICH NOTE — first match in document order.
   *
   * A note whose quote occurs in two blocks anchors to the first, and this map
   * is how the second block knows not to claim it again. It is rebuilt whenever
   * the document or the notes move, and claiming is idempotent: a block that
   * already owns a note re-claims it on every re-render and no other block can
   * take it. That makes the map a memo cache rather than state, which is why it
   * can be written during render.
   *
   * IT KEYS ON THE TEXT AS RENDERED, not on `body`. A staged block edit changes
   * what the blocks say, so a note that anchored to the old wording has to be
   * re-offered to every block rather than keeping a claim nothing matches.
   *
   * AND ON WHICH BLOCKS ARE ON SCREEN, which is what `editEpoch` is for and the
   * one thing block-scoped notes added here. Opening a CONTAINER's editor
   * replaces its whole subtree with a textarea, so the inner block that owns a
   * note about an inner bullet stops rendering — and a cache keyed only on the
   * text would hold that dead claim, leaving the note drawn NOWHERE AT ALL: not
   * even loose, because `LooseNotes` correctly reads it as claimed. Bumping the
   * epoch on every open and every close rebuilds the map, so the container
   * picks the note up on the way in and the inner block picks it back up on the
   * way out.
   *
   * IT IS A COUNTER AND NOT A SECOND COPY OF ANYTHING. No block identity is
   * stored, nothing here knows which block moved, and the map it invalidates is
   * still derived from the document as it reads now.
   */
  const texts = sections.map((s) => textOf(s))
  // Joined on a separator no document can contain, so two sections cannot
  // merge into one key by ending and beginning with the same words.
  const rendered = texts.join('\u0000')
  const sig = notes.map((n) => `${n.id}:${n.status}:${n.quote}`).join('|')
  const [editEpoch, setEditEpoch] = useState(0)
  const claims = useMemo(() => new Map<string, number>(), [rendered, sig, editEpoch])

  /** A BLOCK'S EDITOR OPENED OR CLOSED, so re-render from here.
   *
   *  `editing` is local state on the block, so without this `PlanBody` does not
   *  re-render when a field opens: the claim map is never rebuilt and the loose
   *  bucket beside the blocks never recomputes. Re-rendering does NOT remount —
   *  `PLAN_COMPONENTS` is a module constant, so a block keeps the textarea it
   *  just opened along with everything typed into it. */
  const onEditToggle = useCallback(() => setEditEpoch((n) => n + 1), [])

  const claim = useCallback(
    (noteId: string, blockOffset: number) => {
      const owner = claims.get(noteId)
      if (owner === undefined) {
        claims.set(noteId, blockOffset)
        return true
      }
      return owner === blockOffset
    },
    [claims],
  )

  /**
   * COMMENTING ON A WHOLE BLOCK — THE ONE CAPTURE GESTURE THERE IS.
   *
   * There used to be two. A drag-select anywhere in the document also minted a
   * `QuoteTarget`, out of the selected phrase, and it collided with the other
   * feature on this surface: a drag ends in a click, that click lands on an
   * editable paragraph, and opening the editor there would turn the phrase the
   * user had just selected to comment on into a textarea. The block's click
   * handler patched around it by bailing out whenever `window.getSelection()`
   * was non-empty — one mouse gesture arbitrating between two features by
   * inspecting global selection state, which only gets worse once the block
   * editor is a real inline field, because inside a text field a drag-select
   * unambiguously means "select text to edit".
   *
   * Deleting the selection path retires the arbitration rather than maintaining
   * it: SELECTION MEANS EDIT, ICON MEANS COMMENT, with nothing to disambiguate.
   *
   * The geometry lives here rather than in the block because `hostRef` is the
   * popover's containing block and only this component has it.
   */
  const quoteBlock = useCallback(
    (el: HTMLElement, quote: string, section: string, block: number) => {
      const host = hostRef.current
      if (!host) return
      const r = el.getBoundingClientRect()
      const h = host.getBoundingClientRect()
      onQuote({
        quote: capQuote(quote),
        section,
        // The block's own offset, uncapped and unnormalised — it identifies the
        // block rather than describing it, so nothing that happens to the quote
        // on its way to the wire may touch it.
        block,
        at: {
          top: r.bottom - h.top + host.scrollTop + 8,
          left: Math.max(8, Math.min(r.left - h.left, h.width - POP_WIDTH)),
        },
      })
    },
    [onQuote],
  )

  return (
    <div
      className="plan-body"
      ref={hostRef}
      // A press anywhere in the document dismisses an open composer. It fires
      // BEFORE the bubble's own click, so a bubble press clears the previous
      // target and then sets its own rather than closing what it just opened.
      onMouseDown={() => onQuote(null)}
      data-testid="plan-body"
    >
      {preamble.trim() && (
        <div className="plan-preamble">
          <PlanMarkdown text={preamble} components={chatMarkdownComponents} />
        </div>
      )}
      {sections.map((s, i) => (
        <PlanSectionView
          key={s.id}
          section={s}
          text={texts[i]}
          notes={notes.filter((n) => n.section === s.id)}
          claims={claims}
          claim={claim}
          readOnly={readOnly}
          onBlockEdit={onBlockEdit}
          onBlockQuote={quoteBlock}
          // NARROWED TO THIS SECTION HERE, so a block compares one number
          // rather than re-checking which section it is in. Two sections can
          // hold blocks at the same offset — offsets are relative to the
          // section's own text — so the section match has to happen somewhere,
          // and the section view is the one place that already knows.
          commentingBlock={commenting && commenting.section === s.id ? commenting.block : null}
          onEditToggle={onEditToggle}
          renderNote={renderNote}
          anchor={anchorOf?.(s)}
        />
      ))}
      {children}
    </div>
  )
}

/** The prose renderer, with the shared chat components as its base so links,
 *  images and code highlighting behave the way they do everywhere else. */
function PlanMarkdown({
  text,
  components,
}: {
  text: string
  components: Record<string, unknown>
}) {
  return (
    <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-headings:text-gray-900 prose-p:text-gray-800 prose-strong:text-gray-900 prose-li:text-gray-800 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // `<!-- evidence: … -->` is written FOR the agents and folded out of
        // every other reading surface — the spec digest and `plan show --clean`
        // both drop it. Without this the reader sees it verbatim, because
        // react-markdown 9 turned an unhandled raw node into text where 8 threw
        // it away. See the module for why this is not `skipHtml`.
        rehypePlugins={[rehypeHideComments]}
        components={components as never}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** The block tags that can carry a note and host the notes they carry.
 *
 *  A subset of these is additionally EDITABLE — `editableRange` owns that
 *  question, and its only refusals are the tags absent from `EDITABLE_TAGS` and
 *  the positionless node. A container is editable AS ITS WHOLE SUBTREE, which
 *  is why the tags nest here and why the click rule below has to pick a winner.
 *
 *  `td`/`th` ARE GONE AND `pre`/`table` ARRIVED, and both follow from the note
 *  being a block rather than a phrase. A per-cell comment was only ever
 *  coherent because a mark could sit inside one cell; painting a cell and
 *  hanging a note row under it is neither, so a comment about a table is a
 *  comment on the table. And a quote taken from inside a fenced code block used
 *  to anchor NOWHERE — `pre` was not here, so no block was ever offered the
 *  chance to claim it, and the note went to the loose bucket labelled as
 *  unfindable. Both are commentable now and neither is editable: the section's
 *  `Edit raw Markdown` button remains the honest tool for their source. */
const BLOCK_TAGS = [
  'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table',
] as const

/** The two blocks whose bubble CANNOT be a child of the block itself.
 *
 *  `.plan-b-tools` is a `<span>`, and the browser refuses it in both places:
 *  inside `<table>` it is hoisted out of the table entirely (the HTML parser's
 *  foster-parenting rule), and inside `<pre>` it lands in the code text, where
 *  it is both selectable and copied. Those two render inside a wrapper `<div>`
 *  that carries the bubble beside the block instead of inside it. Nothing else
 *  differs: they are not editable, so they have no click handler, no tab stop
 *  and no textarea to place. */
const FIGURE_TAGS = new Set<string>(['pre', 'table'])

interface BlockCtx {
  notes: PlanNote[]
  /** This section's Markdown, as rendered. A block's range indexes into it. */
  text: string
  claim: (noteId: string, blockOffset: number) => boolean
  readOnly: boolean
  /** Section already bound — a block never learns which section it is in. */
  onEdit: (range: BlockRange, next: string) => void
  onComment: (el: HTMLElement, quote: string, block: number) => void
  /** The offset of the block the composer is open on IN THIS SECTION, or
   *  `null` — the composer is closed, or it is open somewhere else. */
  commentingBlock: number | null
  /** A block's editor opened or closed. See `PlanBody`'s `onEditToggle`. */
  onEditToggle: () => void
  renderNote: (n: PlanNote, anchored: boolean) => ReactNode
}

/**
 * The section's notes and write paths reach the block components through
 * CONTEXT, and the reason is not style.
 *
 * `components` is read by react-markdown as a map of component TYPES. Building
 * that map per render — the obvious way to close a block over its section's
 * notes — gives every block a new type on every render, so React unmounts and
 * remounts the whole document subtree each time. The notes render inside those
 * blocks, so a half-typed rejection reason in a note two lines down would be
 * destroyed by a keystroke in the tray. THAT NOW ALSO COVERS EDITING: a block's
 * open textarea is local state on the block component, so a remount would
 * discard a half-typed line every time anything above it re-rendered. The map
 * below is a module constant and the varying part rides context, which
 * re-renders without remounting.
 */
const BlockContext = createContext<BlockCtx | null>(null)

/**
 * The document's own checkbox, made real.
 *
 * remark-gfm renders a task item's box as a DISABLED `<input>` — correct for a
 * viewer and a lie on a surface where the line beside it is editable. This
 * swaps that one element for a button and leaves every other child alone.
 *
 * IT RUNS BEFORE `splitOwnChildren`, on the array that is then partitioned and
 * flattened. The disabled input contributes no text leaf and neither does the
 * button (its only child is an icon), so the block's own text is the same
 * either way — which is what makes the swap safe rather than merely convenient.
 * An `<input>` is not block-level, so the tick stays in the block's OWN run and
 * is painted with the words beside it.
 */
function withRealCheckbox(children: ReactNode, checked: boolean, onToggle: () => void): ReactNode {
  const kids = Array.isArray(children) ? children : [children]
  let swapped = false
  return kids.map((child) => {
    if (swapped || !isValidElement(child) || child.type !== 'input') return child
    swapped = true
    return (
      <button
        key="plan-tick"
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={checked ? 'Untick this box' : 'Tick this box'}
        className={'plan-tick' + (checked ? ' on' : '')}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        {checked && <Check size={11} />}
      </button>
    )
  })
}

/** One block tag, wired to mark what is quoted in it, to host the notes that
 *  quote it, and — where the grammar allows it — to be edited in place. */
function makeBlock(Tag: (typeof BLOCK_TAGS)[number]) {
  function PlanBlock({
    node,
    children,
    className,
    ...rest
  }: {
    node?: BlockNode
    children?: ReactNode
    /** remark-gfm's own — `task-list-item` on a checkbox item. Pulled out of
     *  `rest` so this block's classes JOIN it rather than replacing it. */
    className?: string
  }) {
    const ctx = useContext(BlockContext)
    const [editing, setEditing] = useState(false)
    const elRef = useRef<HTMLParagraphElement | null>(null)
    // Cancelling an editor must put focus back where the keyboard user left it.
    // Set only by the paths that CANCEL — a commit closes the field too, and
    // stealing focus back after a successful edit fights the reading order.
    const refocus = useRef(false)
    const El = Tag as 'p'
    useEffect(() => {
      if (editing || !refocus.current) return
      refocus.current = false
      elRef.current?.focus()
    }, [editing])
    if (!ctx) {
      return (
        <El className={className} {...(rest as Record<string, unknown>)}>
          {children}
        </El>
      )
    }

    const offset = node?.position?.start?.offset ?? -1
    const range = ctx.readOnly ? null : editableRange(node, Tag)
    const src = range ? blockSource(ctx.text, range) : ''
    const checked = range ? taskChecked(src) : null
    // Editable AND holding another block: this tab stop opens a subtree, and
    // every string a user or a screen reader reads off it has to say so.
    const whole = !!range && !!node && containsBlock(node)
    const scope = blockScopeWord(Tag, whole)

    /** Open or close the field, and tell `PlanBody` so the claim map rebuilds:
     *  which blocks are on screen just changed. */
    const setEditingAndClaims = (next: boolean) => {
      setEditing(next)
      ctx.onEditToggle()
    }

    const commit = (next: string) => {
      setEditingAndClaims(false)
      // AC-6.6, one level down. A blur on a block nobody touched must produce
      // no row: a phantom edit is a revision and a changelog entry for text
      // that did not move.
      if (range && next !== src) ctx.onEdit(range, next)
    }

    const kids =
      checked === null
        ? children
        : withRealCheckbox(children, checked, () => {
            const next = toggleCheckbox(src)
            if (range && next !== null) ctx.onEdit(range, next)
          })

    /**
     * OWN TEXT, NOT SUBTREE TEXT — the one substitution this whole change is.
     *
     * `splitOwnChildren` stops at the first block-level child, so an outer list
     * item's text is its own bullet rather than its bullet plus everything
     * indented under it. Both the capture and the claim read it, which is what
     * makes the innermost block the only one that can claim a note about its
     * own words. Reading the subtree instead would hand a note about an inner
     * bullet to the outer item — a parent renders first and claims are
     * first-match in document order — and then paint the entire outer subtree
     * with it.
     *
     * A FIGURE IS NOT SPLIT. `pre` and `table` hold no `PlanBlock` inside them
     * (their children are `code`, `thead`, `tr`, `td` — none of which is a
     * block component), so there is nothing to partition and nothing that could
     * claim ahead of them. They read their whole subtree and render it
     * untouched.
     */
    const figure = FIGURE_TAGS.has(Tag)
    const split = figure ? null : splitOwnChildren(kids)
    const ownText = flattenOwn(split ? split.own : kids)

    // The claim map is UNTOUCHED: first-match-in-document-order still
    // arbitrates, it just can no longer be won by an ancestor. `claim` is
    // called only after the quote matches, so a block that does not carry a
    // note never takes it out of another block's reach.
    //
    // WHILE THE TEXTAREA IS OPEN THE SUBTREE IS NOT ON SCREEN, so the block
    // claims by its whole subtree's text for as long as it is editing. Opening
    // a container swallows its nested blocks, and those blocks are the ones
    // that own the notes about them — without this the container would decline
    // them (its own run says nothing about an inner bullet) and they would be
    // drawn nowhere at all. It is safe precisely because the descendants are
    // not rendering: nothing can contest a claim it is not making. `editEpoch`
    // is what lets the claim change hands in both directions.
    const claimText = editing && range ? flattenOwn(kids) : ownText
    const mine = ctx.notes.filter(
      (n) => !!n.quote && blockCarries(claimText, n.quote) && ctx.claim(n.id, offset),
    )
    // The notes are claimed BEFORE the editing branch below, and that ordering
    // is the point: a block whose textarea is open still owns its notes, so
    // starting to edit a line does not drop the notes about it into the loose
    // bucket at the end of the section.
    const anchored = mine.map((n) => (
      <div key={n.id} className="plan-anchored" data-testid={`plan-anchored-${n.id}`}>
        {ctx.renderNote(n, true)}
      </div>
    ))

    // A CLOSED NOTE STOPS PAINTING and the block reads clean again, while still
    // rendering underneath it: the argument is over, the record is not deleted.
    // `open` is the wire's one unfinished status; the other four are outcomes.
    // Belt and braces today — `PlanEditor` filters the whole surface to `open`
    // before a note reaches this component — and the cheaper half of the pair
    // to keep, because it is what makes THIS component correct on its own.
    const painted = mine.some((n) => n.status === 'open')

    /**
     * THE COMPOSER IS OPEN ON THIS BLOCK — a standing highlight for as long as
     * it stands, and the reason the popover no longer reprints the quote.
     *
     * A SIBLING OF `painted`, NEVER A REPLACEMENT FOR IT. The two say different
     * things — "a note is on me" and "you are writing one about me now" — and a
     * block can be both at once, so they are separate classes on separate
     * elements: the note paint tints the block's own run, this outlines the
     * block. Neither can erase the other because neither is in a position to;
     * that is the whole reason for not overloading one class with a second
     * state.
     *
     * `offset >= 0` because a block remark gave no position reports `-1`, and
     * `commentingBlock` is `null` rather than `-1` when nothing is open — but a
     * bubble press on such a block would file `-1` as its identity and light
     * every other positionless block in the section with it. The guard costs a
     * comparison and closes that.
     */
    const commenting = offset >= 0 && ctx.commentingBlock === offset

    // THE ONE CAPTURE AFFORDANCE. Suppressed below `MIN_QUOTE_CHARS` so a block
    // with no words of its own — a blockquote, whose children are all
    // paragraphs, or a loose list item — never offers a quote that could not
    // anchor. The paragraph inside it is the innermost block and carries the
    // bubble instead.
    const bubble = !ctx.readOnly && ownText.length >= MIN_QUOTE_CHARS && (
      <span className="plan-b-tools">
        {/* Only the COMMENT bubble is left. The pencil is gone: the block
            itself opens the editor, by click or by Enter, and duplicating that
            in a hover-only button was the affordance a keyboard user could
            reach and a mouse user did not need. */}
        <button
          type="button"
          className="plan-b-tool"
          title={`Write a note on this ${TAG_WORD[Tag] ?? 'line'}`}
          aria-label={`Write a note on this ${TAG_WORD[Tag] ?? 'line'}`}
          data-testid={`plan-block-comment-${offset}`}
          onClick={(e) => {
            e.stopPropagation()
            if (elRef.current) ctx.onComment(elRef.current, ownText, offset)
          }}
        >
          <MessageSquare size={12} />
        </button>
      </span>
    )

    if (figure) {
      // No editing, so no tab stop, no `onClick` and no textarea to place — the
      // wrapper exists purely to give the bubble somewhere legal to stand.
      return (
        <>
          <div className="plan-b-fig">
            <El
              {...(rest as Record<string, unknown>)}
              ref={elRef}
              data-plan-block={offset}
              data-plan-commenting={commenting || undefined}
              className={[
                className,
                'plan-b',
                painted ? 'plan-noted' : '',
                commenting ? 'plan-b--commenting' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {kids}
            </El>
            {bubble}
          </div>
          {anchored}
        </>
      )
    }

    if (editing && range) {
      return (
        <>
          <PlanBlockEdit
            src={src}
            multiline={src.includes('\n')}
            label={scope}
            onCommit={commit}
            onCancel={() => {
              refocus.current = true
              setEditingAndClaims(false)
            }}
          />
          {anchored}
        </>
      )
    }

    return (
      <>
        <El
          {...(rest as Record<string, unknown>)}
          ref={elRef}
          data-plan-block={offset}
          // THE HIGHLIGHT, AS AN ATTRIBUTE AS WELL AS A CLASS. A class is what
          // paints it; this is what a test — and anything else asking the
          // document which block is being commented on — can read without
          // matching on styling. `undefined` renders no attribute at all, so a
          // block nobody is commenting on carries nothing.
          data-plan-commenting={commenting || undefined}
          className={[
            className,
            'plan-b',
            range ? 'plan-b--live' : '',
            // A SIBLING OF `plan-b--noted`, not a replacement: a block carrying
            // an open note that is ALSO being commented on gets both, and reads
            // as both.
            commenting ? 'plan-b--commenting' : '',
            // The block itself only says "a note is on me" so the hover tint
            // can stand down; the paint is the span below. Tinting the element
            // would tint everything nested inside it, which is the regression
            // own-text flattening exists to prevent.
            painted ? 'plan-b--noted' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          {...(range
            ? {
                // THE KEYBOARD PATH, AND IT ARRIVES IN THE SAME COMMIT THE
                // PENCIL LEAVES IN. The pencil was the only keyboard route into
                // a block edit, so the editable block itself becomes the tab
                // stop and carries the pencil's own name, byte for byte — no
                // keyboard user loses a label they knew.
                tabIndex: 0,
                'aria-label': `Edit this ${scope}`,
                // THE ONE ARIA WRINKLE, NAMED RATHER THAN GLOSSED. `aria-label`
                // is permitted on `li`, `h1`…`h6` and `blockquote`, and
                // PROHIBITED on `p` (role `paragraph`). So an editable paragraph
                // — and only a paragraph — also carries `role="group"`, which
                // permits naming and is a benign container role that leaves the
                // marks, links and tick button inside it untouched. The trade is
                // real: the paragraph stops announcing as a paragraph. A
                // nameless tab stop is the worse failure.
                ...(Tag === 'p' ? { role: 'group' } : {}),
              }
            : {})}
          onKeyDown={
            range
              ? (e: ReactKeyboardEvent) => {
                  if (e.key !== 'Enter') return
                  // THE KEYBOARD MIRROR OF THE CLICK RULE. Enter on a nested
                  // link, on the tick button, or on the comment bubble is that
                  // control's Enter, not this block's — so only a keypress
                  // landing on the block ITSELF opens the editor.
                  if (e.target !== e.currentTarget) return
                  e.preventDefault()
                  e.stopPropagation()
                  setEditingAndClaims(true)
                }
              : undefined
          }
          onClick={
            range
              ? (e) => {
                  // THE INNERMOST EDITABLE BLOCK UNDER THE POINTER WINS, and
                  // this one line is the whole of that rule. Since change 2 a
                  // container is editable, so a click on a nested item is also
                  // a click on every editable ancestor of it, and the event
                  // would open all of them on its way up. Stopping here leaves
                  // the deepest block that saw the click as the only one that
                  // decides: a click on a nested child opens only that child,
                  // while a click on a parent's OWN line (an outline item's
                  // text, a blockquote's bar) never reaches a child at all and
                  // opens the whole subtree.
                  //
                  // UNCONDITIONAL, AND BEFORE THE GUARDS, WHICH IS THE POINT.
                  // Every guard below decides "not this gesture" — and it has
                  // to decide that for the block the pointer was actually in,
                  // once. Returning early without stopping would hand the same
                  // click to every ancestor to re-judge on its own state, so
                  // the rule would hold only for as long as all of them
                  // happened to agree. They do today (both guards read
                  // `e.target` and the selection, neither of which moves as the
                  // event rises); depending on that is how AC-3.6 breaks later
                  // for a reason nobody can see in the diff.
                  //
                  // A REFUSED BLOCK STOPS NOTHING, deliberately, because it
                  // never gets a handler at all. A table cell has no `range`,
                  // so its click rises to the nearest EDITABLE ancestor: a
                  // table nested in a list item is edited through that item's
                  // subtree, which is the only inline route to it and does not
                  // splice the cell. A top-level cell has no editable ancestor
                  // and so still opens nothing — AC-3.3, unchanged.
                  e.stopPropagation()
                  // THE SELECTION GUARD IS GONE, and its absence is the point
                  // of this change rather than an oversight in it. It read
                  // `window.getSelection()` to decide whether a click meant
                  // "edit this" or "quote this", because a drag-select used to
                  // be the other capture gesture and a drag ends in a click.
                  // There is one capture gesture now and it is a button, so a
                  // selection on prose can only ever mean the reader is
                  // selecting text — which is what the editor is for.
                  //
                  // A link is a link, and the bubble stops its own click.
                  if ((e.target as HTMLElement).closest('a, button')) return
                  setEditingAndClaims(true)
                }
              : undefined
          }
        >
          {/* THE PAINT, AND IT IS THE BLOCK'S OWN RUN — never a character range
              and never the whole subtree. One span, with no click handler on
              it: a click on painted text is a click on the block, which means
              EDIT. That is the gesture conflict retired, in a line that is
              absent rather than present. */}
          {painted ? <span className="plan-noted">{split!.own}</span> : split!.own}
          {split!.nested}
          {bubble}
        </El>
        {anchored}
      </>
    )
  }
  PlanBlock.displayName = `PlanBlock(${Tag})`
  return PlanBlock
}

/** Built ONCE. See `BlockContext` above for why this must not be per-render. */
const PLAN_COMPONENTS: Record<string, unknown> = {
  ...chatMarkdownComponents,
  ...Object.fromEntries(BLOCK_TAGS.map((t) => [t, makeBlock(t)])),
}

function PlanSectionView({
  section,
  text,
  notes,
  claims,
  claim,
  readOnly,
  onBlockEdit,
  onBlockQuote,
  commentingBlock,
  onEditToggle,
  renderNote,
  anchor,
}: {
  section: PlanSection
  text: string
  notes: PlanNote[]
  claims: Map<string, number>
  claim: (noteId: string, blockOffset: number) => boolean
  readOnly: boolean
  onBlockEdit: (section: string, range: BlockRange, next: string) => void
  onBlockQuote: (el: HTMLElement, quote: string, section: string, block: number) => void
  /** See `BlockCtx.commentingBlock` — already narrowed to this section. */
  commentingBlock: number | null
  onEditToggle: () => void
  renderNote: (n: PlanNote, anchored: boolean) => ReactNode
  /** See `PlanBody`'s `anchorOf`. Spread onto the existing root as
   *  `data-note-id` — no new element, no new CSS, and `undefined` renders no
   *  attribute at all. */
  anchor?: string
}) {
  // NOT MEMOISED, ON PURPOSE. It was, and the memo could never hit: `notes`
  // arrives as `notes.filter(...)` — a fresh array every render — and
  // `renderNote` is an inline arrow in `PlanEditor`, so two of the four deps
  // changed identity every time and the cache was pure overhead. Memoising it
  // for real would mean memoising the filtered arrays upstream AND wrapping
  // `renderNote`, which is a change to `PlanEditor`'s render, not to this line.
  // Nothing above depends on it either: the remount-avoidance the `BlockContext`
  // note describes rests on `PLAN_COMPONENTS` being a module constant, which it
  // still is. A fresh context value re-renders the consumers; it does not
  // remount them.
  const ctx: BlockCtx = {
    notes,
    text,
    claim,
    readOnly,
    onEdit: (range, next) => onBlockEdit(section.id, range, next),
    onComment: (el, quote, block) => onBlockQuote(el, quote, section.id, block),
    commentingBlock,
    onEditToggle,
    renderNote,
  }
  return (
    <section
      className="plan-sec"
      data-plan-section={section.id}
      data-note-id={anchor}
      data-testid={`plan-sec-${section.id}`}
    >
      <BlockContext.Provider value={ctx}>
        <PlanMarkdown text={text} components={PLAN_COMPONENTS} />
        {/* THE NOTES WHOSE QUOTE IS GONE, at the end of THIS section and not at
            the bottom of the document. Rendered by a child so the filter runs
            AFTER the blocks above have claimed what they could: React renders
            siblings in order, so this subtree is reached once the markdown
            subtree beside it is complete. A note is never dropped for failing
            to match — it lands here, labelled. */}
        <LooseNotes notes={notes} text={text} claims={claims} renderNote={renderNote} />
      </BlockContext.Provider>
    </section>
  )
}

/**
 * WHY A NOTE IS LOOSE — and the three answers are not the same answer.
 *
 * **THE THIRD ONE IS "IT NEVER NAMED A LINE", and it is now the common case.**
 * This function used to be reachable only by a note that HAD a quote — the
 * partition upstream refused an un-quoted note entry to the document at all —
 * so both sentences below could safely assume one and neither said anything
 * about its absence. With the middle rung of the placement ladder open (see
 * `PlanEditor`'s `bodyRoots`), a note that names a section and no line arrives
 * here on purpose, and it is the shape most CLI-filed notes have.
 *
 * Both existing sentences are WRONG for it, not merely unhelpful: "the line
 * this quotes is no longer in this section" reports a deletion that did not
 * happen, about a line that was never named, and it is the one this note would
 * have got — `still` is false when `quote` is empty. The app would be inventing
 * a loss to explain a placement. So an empty quote is answered first and on its
 * own terms: nothing is missing, the note is simply about the section rather
 * than about a line in it, and that is where it is sitting.
 *
 * Failing to anchor is not evidence that the line is gone. A quote can still
 * fail to land on any block — one spanning two paragraphs is the plain case,
 * because no single block's own text contains both halves, and a quote taken
 * off a container with no own text (a blockquote, a loose list item) is
 * another. What is not acceptable is telling the user "the line this quotes is
 * no longer in this section" while the line is on screen a few centimetres
 * above — the app asserting something the user can see is false.
 *
 * ONE OF THESE CASES CLOSED WITH BLOCK COMMENTING. A quote taken from inside a
 * fenced code block used to anchor nowhere, because `pre` was not in
 * `BLOCK_TAGS` and no block was ever offered the chance to claim it; it lands
 * on its fence now. The sentence below is unchanged, because the distinction it
 * draws was never about which tags were in that list.
 *
 * So the section's own source decides which sentence is printed, and it is the
 * source AS RENDERED: with a block edit staged, "gone" has to mean gone from
 * the text on screen, not from a pristine copy the user is no longer looking
 * at. If the quoted text is still in this section, we say only what is true: we
 * could not find it. If it is genuinely gone, the original sentence is still
 * the right one and it is kept — the two cases are distinguishable here, so
 * they are not collapsed into one hedge that under-reports a real deletion.
 */
function looseReason(text: string, quote: string): string {
  if (!quote) return 'On this section as a whole, not on one line.'
  const hay = normalizeText(text)
  const still = hay.includes(normalizeText(quote)) || hay.includes(stripMarkers(quote))
  return still
    ? "Couldn't find this line in the section."
    : 'The line this quotes is no longer in this section.'
}

function LooseNotes({
  notes,
  text,
  claims,
  renderNote,
}: {
  notes: PlanNote[]
  /** This section's Markdown, the one thing that can tell "gone" from
   *  "unanchorable". */
  text: string
  claims: Map<string, number>
  renderNote: (n: PlanNote, anchored: boolean) => ReactNode
}) {
  const loose = notes.filter((n) => !claims.has(n.id))
  if (loose.length === 0) return null
  return (
    <div className="plan-sec-loose" data-testid="plan-loose-notes">
      {loose.map((n) => (
        <div key={n.id} className="plan-loose-wrap">
          <p className="plan-loose-why" data-testid={`plan-unanchored-${n.id}`}>
            {looseReason(text, n.quote)}
          </p>
          {renderNote(n, false)}
        </div>
      ))}
    </div>
  )
}
