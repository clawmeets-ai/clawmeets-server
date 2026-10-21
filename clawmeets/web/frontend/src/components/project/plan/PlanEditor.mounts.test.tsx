import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * ONE COMPONENT, TWO MOUNTS — §5, asserted STRUCTURALLY.
 *
 * The behavioural half of this is already covered and covered better elsewhere:
 * `ProjectPlanTab.test.tsx`'s 26 assertions drive the full mount end-to-end
 * through a fake server, and `PlanBand.test.tsx`'s C1 parity assertion drives a
 * resolve through the compact one and checks both integers move together. What
 * neither can see is the thing §5 actually promises — that the two mounts are
 * the SAME COMPONENT rather than two implementations kept in step by review,
 * and that `density` never reaches a decision that is not layout.
 *
 * A render test cannot fail on that. A second write path added for the compact
 * mount would render, pass, and be exactly the defect the design forbids: a
 * client-side path around a guard the server enforces. So this file reads the
 * source.
 */

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

// Comments carry the words this file greps for — `density`, route names — so
// they have to go, or every assertion below passes on prose.
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

const EDITOR = 'src/components/project/plan/PlanEditor.tsx'
const TAB = 'src/components/project/ProjectPlanTab.tsx'
const BAND = 'src/components/desk/PlanBand.tsx'
const CARD = 'src/components/desk/UpdateCard.tsx'
const ACCEPTANCE = 'src/components/project/plan/PlanAcceptance.tsx'
const COMMENT_LIST = 'src/components/project/plan/PlanCommentList.tsx'
const TRAY = 'src/components/project/plan/PlanTray.tsx'
const CSS = 'src/components/project/plan/plan.css'

describe('§5 — one editor, two mounts', () => {
  it('there is exactly ONE PlanEditor, and it is exported from one file', () => {
    expect(code(EDITOR)).toMatch(/export function PlanEditor\b/)
    // No desk variant, no fork, no copy.
    for (const f of [TAB, BAND, CARD]) {
      expect(code(f)).not.toMatch(/function\s+\w*PlanEditor\w*\s*\(/)
    }
  })

  it('both mounts import that one component', () => {
    expect(code(TAB)).toMatch(/import\s*\{\s*PlanEditor\s*\}\s*from\s*'\.\/plan\/PlanEditor'/)
    // The band also imports the editor's `PlanSendState` type, so the named
    // list is no longer the single word it was — the claim is that it imports
    // `PlanEditor` from that module, not that it imports nothing else.
    expect(code(BAND)).toMatch(
      /import\s*\{[^}]*\bPlanEditor\b[^}]*\}\s*from\s*'\.\.\/project\/plan\/PlanEditor'/,
    )
  })

  it('and they differ by `density` — the tab full, the band compact', () => {
    expect(code(TAB)).toMatch(/<PlanEditor[^>]*density="full"/)
    expect(code(BAND)).toMatch(/<PlanEditor[^>]*density="compact"/)
  })

  /**
   * THE LOAD-BEARING ONE. `density` is allowed to pick a layout and nothing
   * else; the moment it reaches a handler or a route, the two mounts have
   * forked and the desk has grown a second write path.
   */
  it('`density` is read ONLY where layout is chosen, never inside a handler', () => {
    const body = code(EDITOR)
    const reads = body.match(/density\s*===\s*'(full|compact)'/g) ?? []
    expect(reads.length).toBeGreaterThan(0)
    // Every read is a className / JSX-branch decision. If `density` ever
    // appears inside a `useCallback`, an `await`, or a route call, this is the
    // assertion that should be argued with rather than deleted.
    for (const m of body.matchAll(/density\s*===\s*'(?:full|compact)'/g)) {
      const around = body.slice(Math.max(0, m.index! - 260), m.index! + 60)
      expect(around).not.toMatch(/useCallback\($/)
      expect(around).not.toMatch(/\bawait\s+\w/)
    }
    // `showHistory` is the one derived flag, and it gates a READ (the versions
    // query + the History pane), never a write.
    expect(body).toMatch(/const showHistory = density === 'full'/)
  })

  it('ONE WRITE FUNNEL: `POST …/plan/review` is called from the editor and nowhere else', () => {
    expect(code(EDITOR)).toMatch(/\bsubmitPlanReview\(/)
    // `PlanAcceptance` joins this list so the new component cannot grow a second
    // write funnel of its own.
    for (const f of [TAB, BAND, CARD, ACCEPTANCE]) {
      expect(code(f)).not.toMatch(/\bsubmitPlanReview\(/)
    }
  })

  /**
   * REWRITTEN A SECOND TIME, AND IT ENDS UP ASSERTING THE STRONGEST FORM OF THE
   * THING IT ORIGINALLY ASSERTED THE OPPOSITE OF.
   *
   * Round one required the resolve route on BOTH mounts. Round two (M2, change
   * 9) took it off the editor — every control on a note stages, and a note is
   * closed by a staged `Dismiss` or answered by a staged `Ask` — and left the
   * band holding it for its DEVIATION callout, on the reading that a callout is
   * not a note-row control.
   *
   * THAT EXCEPTION IS GONE, AND THE REASON IT WAS WRONG IS THAT A DEVIATION IS
   * A NOTE. Change 9's rule is about notes, not about note ROWS, so the callout
   * was inside it all along; the band's two buttons were simply the last place
   * anything about a note reached a route before `Send review`. The deviation
   * is now decided on its own note in the editor the band mounts below the
   * callout, staged like everything else.
   *
   * So the claim is now the unconditional one: NOTHING on any of these mounts
   * reaches the status route. Zero call sites, not one — and a resolve creeping
   * back into ANY of them fails here rather than needing an argument about
   * which file is allowed to hold the exception.
   */
  it('NO STATUS PATH ON ANY MOUNT — nothing about a note reaches a route', () => {
    // Not the call, not the import, in any file on either mount. The BAND is in
    // this list now; it used to be the one file required to be absent from it.
    for (const f of [EDITOR, TAB, BAND, CARD, ACCEPTANCE]) {
      expect(code(f)).not.toMatch(/\bresolvePlanNote\b/)
    }
    // The declared endpoint SURVIVES with no caller, deliberately — see the
    // note on its export in `projectPlans.ts`. This pins that the deletion was
    // of the call site rather than of the client's knowledge of the route, so
    // "no component calls it" stays a checkable claim rather than becoming
    // vacuously true the day someone re-adds the function.
    expect(code('src/api/endpoints/projectPlans.ts')).toMatch(
      /export async function resolvePlanNote\b/,
    )
    // Nothing anywhere does arithmetic on the integer the execution gate reads.
    for (const f of [EDITOR, TAB, BAND, CARD]) {
      expect(code(f)).not.toMatch(/open_notes_for_you\s*[-+]/)
      expect(code(f)).not.toMatch(/[-+]\s*open_notes_for_you/)
      expect(code(f)).not.toMatch(/setOpenNotes|decrement/i)
    }
  })

  it('THE DESK ADDS NO ROUTE. Every plan path it can reach is a declared endpoint', () => {
    const endpoints = code('src/api/endpoints/projectPlans.ts')
    for (const fn of [
      'submitPlanReview',
      'resolvePlanNote',
      'putPlanDraft',
      'deletePlanDraft',
      'postPlanNote',
    ]) {
      expect(endpoints).toMatch(new RegExp(`export (async )?function ${fn}\\b`))
    }
    // No hand-rolled fetch/post to a plan URL anywhere on either mount — and
    // `PlanAcceptance` is in the list, so the control that moved onto the desk
    // cannot bring a URL of its own with it.
    for (const f of [EDITOR, TAB, BAND, CARD, ACCEPTANCE]) {
      expect(code(f)).not.toMatch(/['"`]\/projects\/[^'"`]*\/plan/)
    }
  })

  /**
   * THERE IS NO ACCEPTANCE ROUTE LEFT TO CALL IN EITHER DIRECTION, and this
   * asserts the absence rather than trusting it. `POST …/plan/approve` went
   * first: accepting a plan is applying its go-note, which rides
   * `submitPlanReview` like every other note decision. `POST …/plan/revoke`
   * followed it, because an accepted plan is not un-decided — it is
   * renegotiated by applying the next note, which re-signs the acceptance.
   *
   * A client function for either would be a second door onto one act — and,
   * worse, one that 404s. Asserted as a grep because that is the only
   * instrument that can see a function nothing renders yet.
   */
  it('NO APPROVE ROUTE AND NO REVOKE ROUTE ANYWHERE IN THE CLIENT', () => {
    const endpoints = code('src/api/endpoints/projectPlans.ts')
    expect(endpoints).not.toMatch(/export (async )?function approvePlan\b/)
    expect(endpoints).not.toMatch(/\/plan\/approve/)
    expect(endpoints).not.toMatch(/export (async )?function revokePlan\b/)
    expect(endpoints).not.toMatch(/\/plan\/revoke/)
  })

  /**
   * THE ACCEPTANCE STRIP POSTS NOTHING AT ALL, which is the property that
   * replaced "one revoke call site". It used to pin the Approve control's one
   * call site, then the undo's; neither half exists now, so what is left to
   * protect is that the strip stayed a readout. A `useMutation`, a `post(`, or
   * a `queryClient` reaching into it would all be the same regression — a
   * control growing back on a surface whose whole claim is that it has none.
   */
  it('THE ACCEPTANCE STRIP IS A READOUT — no call site, on any mount', () => {
    for (const f of [ACCEPTANCE, EDITOR, TAB, BAND, CARD]) {
      expect(code(f)).not.toMatch(/\brevokePlan\(/)
      expect(code(f)).not.toMatch(/\bapprovePlan\(/)
    }
    expect(code(ACCEPTANCE)).not.toMatch(/\buseQueryClient\b/)
    expect(code(ACCEPTANCE)).not.toMatch(/\bpost\s*[<(]/)
  })

  /**
   * THE COMMENT LIST HAS EXACTLY ONE IMPLEMENTATION, and it is reached through
   * the editor — which is the whole reason the alarm it grew out of was MOVED
   * rather than copied into the tab. The tab had no off-contract signal at all;
   * the fix could have been a second callout there, and this file exists to
   * fail on precisely that shape. A grep is the right instrument again: two
   * lists would render, pass every render test, and drift apart on the next
   * change to the copy.
   */
  it('ONE COMMENT LIST, in the editor, and neither mount keeps a copy', () => {
    expect(code(COMMENT_LIST)).toMatch(/export function PlanCommentList\b/)
    // The editor is the one thing that mounts it.
    expect(code(EDITOR)).toMatch(/<PlanCommentList\b/)
    for (const f of [TAB, BAND, CARD]) {
      expect(code(f)).not.toMatch(/<PlanCommentList\b/)
      // Not a second one under another name, either: the callout the band used
      // to own is gone rather than renamed, and nothing re-spells its markup.
      expect(code(f)).not.toMatch(/function\s+\w*Deviation\w*\s*\(/)
      expect(code(f)).not.toMatch(/data-testid="plan-(deviation|comment-list)"/)
    }
  })

  /**
   * AND THE STAGED BATCH IS DRAWN ONCE, in that list, which is the half of this
   * change that could most easily regress into two surfaces. The tray used to
   * draw every row as an item AND the comment those rows decide was a card in
   * the pane; the rows moved onto their comments and the tray became a send
   * bar. Leaving a "collapsed" item list behind in the tray would restore
   * exactly the duplication the move removed, so the absence is asserted rather
   * than trusted — and `onRemove` going with it is what `noUnusedLocals` cannot
   * check, because a prop threaded to nowhere still type-checks at the caller.
   */
  it('THE TRAY NO LONGER DRAWS ITEMS — one row, one place', () => {
    const tray = code(TRAY)
    expect(tray).not.toMatch(/data-row-id=/)
    expect(tray).not.toMatch(/<ul\b/)
    expect(tray).not.toMatch(/\bonRemove\b/)
    // And the editor stopped passing it, at every call site rather than only in
    // the component's own interface.
    expect(code(EDITOR)).not.toMatch(/\bonRemove\b/)
    // The list is where a row is drawn and undone now.
    expect(code(COMMENT_LIST)).toMatch(/data-row-id=/)
    expect(code(COMMENT_LIST)).toMatch(/\bonUnstage\b/)
  })

  /**
   * THE PROJECTED EDIT-COMMENT NEVER BECOMES A NOTE. `commentList` draws a
   * staged text edit as the comment it is, and that projection is display-only:
   * two call sites key on a REAL note id and would break on a synthetic one —
   * the submit's `note_ids`, where the server has no note to fan out to, and
   * `openNotesOn`, which paints the section rail's dot and speaks its count.
   * The containment is enforced inside `commentList` (see
   * `planTrayLogic.test.ts`); what is asserted HERE is that the editor never
   * re-routes `items` into either of them.
   */
  it('`items` FEEDS THE LIST AND NOTHING ELSE', () => {
    const body = code(EDITOR)
    expect(body).toMatch(/const items = useMemo\(\(\) => commentList\(/)
    // The submit still names the PENDING notes, never the list's items.
    expect(body).toMatch(/note_ids: pending\.map\(/)
    expect(body).not.toMatch(/note_ids: items/)
    // And the rail's dot still counts notes.
    expect(body).toMatch(/openNotesOn\(notes,/)
    expect(body).not.toMatch(/openNotesOn\(items/)
  })

  /**
   * AND IT IS SEEDED FROM THE NOTES, NOT FROM A PROP. `initialSection` was the
   * band telling the editor which clause to open on; only one caller ever
   * passed it, and it passed the deviation's own section — so the Plan tab
   * always opened on the whole document and the note needing a decision was
   * several scrolls down. The editor answers that question itself now, which
   * means there is one owner for it rather than two ways to answer it.
   */
  it('the pane is seeded from the DEVIATION, and `initialSection` is gone', () => {
    const body = code(EDITOR)
    expect(body).toMatch(/\bopenDeviations\(/)
    expect(body).toMatch(/setPane\(deviation\.section\)/)
    // The prop is gone from the interface and from every call site.
    for (const f of [EDITOR, TAB, BAND, CARD]) {
      expect(code(f)).not.toMatch(/\binitialSection\b/)
    }
    // `openSignal` KEEPS its job — it re-seeds on each unfold — so its removal
    // would be a behaviour loss rather than a simplification.
    expect(body).toMatch(/\bopenSignal\b/)
  })

  /** §6 / wave 1's two structural invariants, re-checked after the extraction. */
  describe("wave 1's invariants survived the move", () => {
    it('the gating conjunction is still written at exactly ONE display site', () => {
      // `isGated` is the named predicate; `UpdateCard` is its one display site
      // for the meter. Nobody re-spells the conjunction inline.
      for (const f of [EDITOR, TAB, BAND, CARD]) {
        expect(code(f)).not.toMatch(/phase\s*===\s*'executing'\s*&&[^\n]*open_notes_for_you\s*>/)
      }
      expect(code(CARD)).toMatch(/const gated = isGated\(/)
      expect(code(CARD)).toMatch(/isProgress && !gated/)
    })

    it('the editor mounts ONLY while the PLAN band is expanded', () => {
      // The request-cost invariant the whole design rests on, at the strength
      // it actually holds: a folded band costs no `GET …/plan` and an expanded
      // one costs at most one, so the desk's cost is one request per card whose
      // band is OPEN — not one per desk. Each card is its own project and its
      // own query key, so twelve open `spec-ing` cards are twelve requests.
      expect(code(BAND)).toMatch(/\{expanded && \(\s*<PlanEditor/)
      expect(code(CARD)).toMatch(/expanded=\{!!opened\.plan\}/)
    })

    it('the open signal is a COUNTER, incremented on the unfold', () => {
      const card = code(CARD)
      expect(card).toMatch(/useState\(0\)/)
      expect(card).toMatch(/setPlanOpenSignal\(\(n\) => n \+ 1\)/)
      // Not a boolean anywhere.
      expect(card).not.toMatch(/setPlanOpenSignal\((true|false)\)/)
    })

    it('`spec-ing` is compared, never renamed and never written back', () => {
      for (const f of [EDITOR, TAB, BAND, CARD]) {
        const body = code(f)
        // No assignment of a renamed token onto the wire.
        expect(body).not.toMatch(/phase:\s*['"](PLAN|EXECUTE|REPORT)['"]/)
      }
      // The rename still lives at its one site.
      expect(code('src/components/desk/PhaseRail.tsx')).toMatch(/id: 'spec-ing', label: 'PLAN'/)
    })
  })

  /**
   * THE FULL MOUNT DOCKS ITS TRAY, AND THIS IS THE ONE LAYOUT FACT WORTH
   * GREPPING FOR — because it is the one whose breakage looks like a missing
   * FEATURE rather than a broken style.
   *
   * The reported symptom was that the Plan tab had no way to send a review: the
   * tray rendered its header, its rows and its textarea, and `Send review` was
   * nowhere. It was in the DOM the whole time. The root carried `h-full`, so as
   * a flex item of `.plan-tab` — which also holds the tab header — it asked for
   * the header's height ON TOP of the space available, and the column overflowed
   * its own parent every time.
   *
   * Nothing absorbed the overflow, and that is the part a render test cannot
   * see: negative free space goes by SCALED shrink factor, `shrink x
   * flex-base-size`, and the document pane is `flex-1` — basis `0%`, scaled
   * factor `0`. The child that exists to give up height gave up none, the
   * squeeze landed on the auto-basis siblings, and the tray's last row spilled
   * into the `overflow-hidden` that `ProjectView` wraps this tab in.
   *
   * jsdom does no layout, so neither half of that is assertable by rendering:
   * every class here would compute to the same zero box. The source is the only
   * instrument that can fail on it, which is this file's whole premise.
   */
  describe('the tray stays on screen at `density="full"`', () => {
    it('the full root FLEXES with its parent — never `h-full`', () => {
      const body = code(EDITOR)
      const full = body.match(/density === 'full'\s*\?\s*'([^']*)'/)
      expect(full).not.toBeNull()
      const cls = full![1]
      expect(cls).toContain('plan-editor')
      expect(cls).toContain('flex-1')
      // Without this the pane cannot shrink under its content and the inner
      // `overflow-y-auto` never becomes the thing that scrolls.
      expect(cls).toContain('min-h-0')
      // THE REGRESSION ITSELF. `h-full` is what made the column taller than the
      // box that clips it.
      expect(cls).not.toContain('h-full')
    })

    it('and the tray cannot be the child that gives way', () => {
      const tray = code(TRAY)
      expect(tray).toMatch(/className="plan-tray shrink-0\b/)
      // It is allowed to be unshrinkable only because it CANNOT GROW WITH THE
      // BATCH — an unbounded tray with `shrink-0` would crowd out the document
      // pane instead, which is the same bug wearing the other coat. It used to
      // earn that with `max-h-56 overflow-y-auto` on its item list; the list is
      // gone, so what is left has to be fixed-height by construction.
      //
      // THE `h-14` IT USED TO ASSERT WAS THE BATCH-COMMENT TEXTAREA, and the
      // textarea is gone — so the tray is now fixed-height with NOTHING in it
      // that has a size of its own, which is strictly stronger than what this
      // used to pin. Asserted as the absence of the two things that could grow:
      // a list, and a textarea.
      expect(tray).not.toMatch(/<ul\b/)
      expect(tray).not.toMatch(/<textarea\b/)
    })

    /**
     * THE INVARIANT THE TRAY FIX SILENTLY DEPENDED ON, AND THE SECOND BREAK OF
     * IT IS WHY THIS EXISTS.
     *
     * Sizing the column right (above) fixes nothing on its own: the failure it
     * describes needs only ONE unbounded child above the pane row to come
     * straight back, because the pane row is `flex: 1 1 0%` — base size 0, so
     * its SCALED shrink factor is `1 x 0 = 0` and the one item that exists to
     * give up height gives up none. `PlanDeviation` was added after that fix,
     * printed a multi-thousand-character deviation comment under
     * `min-height: auto` (whose block-axis minimum IS the content height), and
     * `Send review` left the screen exactly as it had the first time. That
     * alarm is `PlanCommentList` now and holds strictly more rows, so the same
     * three properties are asserted on `.plan-cl`.
     *
     * So the rule is asserted rather than assumed: EVERY CHILD ABOVE THE PANE
     * ROW IS BOUNDED AND NOT FLEXIBLE. Then the pane row is the only item that
     * can absorb anything and free space can never go negative.
     *
     * IT READS SOURCE BECAUSE JSDOM HAS NO LAYOUT ENGINE. `getBoundingClientRect`
     * is all zeroes there, so "the tray is on screen" is not assertable in this
     * runner at any price — and a test that mounts the tree and checks the tray
     * EXISTS is the test that already passed while the bug shipped, twice.
     */
    it('NOTHING ABOVE THE PANE ROW CAN GROW — the invariant, at every site', () => {
      const css = src(CSS)
      const editor = code(EDITOR)

      // 1. The comment list (the alarm, generalised). `flex: none` alone is not enough — an unshrinkable child
      //    that is 780px tall is the bug. It must also be CAPPED, and something
      //    inside it must scroll so capping it hides nothing.
      const list = css.match(/\.plan-cl \{([^}]*)\}/)
      expect(list).not.toBeNull()
      expect(list![1]).toMatch(/flex:\s*none/)
      expect(list![1]).toMatch(/max-height:\s*\d/)
      // THE BOX ITSELF CLIPS AND DOES NOT SCROLL, which is what changed when
      // the send bar moved inside it — see the test below this one for why the
      // difference is the whole of `Send review` staying on screen.
      expect(list![1]).toMatch(/overflow:\s*hidden/)
      // Against the DECLARATIONS, not the prose: the comment inside this rule
      // names `overflow-y: auto` in order to forbid it, and a negative match
      // over the raw block would read that warning as the thing it warns about.
      expect(list![1].replace(/\/\*[\s\S]*?\*\//g, ' ')).not.toMatch(/overflow-y:\s*auto/)
      // The scroller moved one level in, onto the rows.
      const rows = css.match(/\.plan-cl-rows \{([^}]*)\}/)
      expect(rows).not.toBeNull()
      expect(rows![1]).toMatch(/overflow-y:\s*auto/)
      // And a row's summary is one line whatever the comment says, so the cap
      // is a bound on the COUNT of rows rather than a hope about their height.
      // This matters MORE now than it did as the alarm: the list holds every
      // open comment, not only the deviations, so the count it must survive is
      // the whole of `PLAN_LIMITS.openNotes`.
      expect(css).toMatch(/\.plan-cl-t \{[^}]*-webkit-line-clamp|\.plan-cl-t \{[^}]*white-space:\s*nowrap/)

      // 2. The acceptance strip.
      const approve = css.match(/\.plan-approve \{([^}]*)\}/)
      expect(approve).not.toBeNull()
      expect(approve![1]).toMatch(/flex:\s*none/)

      // 3. Every outcome banner, with no exception for the next one added —
      //    the class is the marker and each occurrence is checked.
      const banners = editor.match(/plan-outcome[^"']*/g) ?? []
      expect(banners.length).toBeGreaterThan(0)
      for (const b of banners) expect(b).toContain('shrink-0')

      // 4. The tray, which is now INSIDE the comment list rather than a sibling
      //    at the bottom of this column — so it is bounded by (1) as well as by
      //    its own `shrink-0`, asserted above.
      // 5. And the pane row is the one thing that IS flexible, which is what
      //    makes the other four a complete list rather than four coincidences.
      expect(editor).toMatch(/'flex-1 flex min-h-0'/)
    })

    /**
     * SEND IS INSIDE THE COMMENT LIST BUT OUTSIDE ITS SCROLLER, AND THAT IS THE
     * WHOLE OF WHY MOVING IT THERE IS SAFE.
     *
     * `.plan-cl` was built to stop an unbounded box above the pane row pushing
     * `Send review` off the bottom of the screen. Putting Send back inside that
     * box asks the same question from the other side: a box that scrolls AS A
     * WHOLE scrolls its own footer away with its rows, and the reader who has
     * staged six decisions scrolls down to send them and finds nothing to press.
     * Nothing about that failure is visible to a render test — the button is in
     * the DOM either way, which is precisely how it shipped twice before.
     *
     * The structure that prevents it is three rules and one piece of markup:
     * `.plan-cl` clips, `.plan-cl-rows` is the only `overflow-y: auto` and
     * carries `min-height: 0` so it can actually shrink, and the footer is
     * rendered as a SIBLING of the rows rather than inside them. The first two
     * are asserted above; this asserts the third, on the source, because jsdom
     * has no layout engine to ask where the button ended up.
     */
    it('SEND SITS OUTSIDE `.plan-cl-rows` — it cannot scroll away with the rows', () => {
      const listSrc = code(COMMENT_LIST)
      // The rows scroller opens and closes before the footer opens. Anything
      // between those two points is inside the thing that scrolls.
      const rowsAt = listSrc.indexOf('className="plan-cl-rows"')
      const footAt = listSrc.indexOf('className="plan-cl-foot"')
      const slotAt = listSrc.indexOf('{footer}')
      expect(rowsAt).toBeGreaterThan(-1)
      expect(footAt).toBeGreaterThan(rowsAt)
      expect(slotAt).toBeGreaterThan(footAt)
      // And the editor puts the send bar in that slot rather than back at the
      // bottom of its own column, where it was and where it must not return.
      const editorSrc = code(EDITOR)
      expect(editorSrc).toMatch(/footer=\{\s*<PlanTray/)
      expect(editorSrc.match(/<PlanTray\b/g) ?? []).toHaveLength(1)
    })

    it('THE COMPACT MOUNT KEEPS NEITHER, because the desk band is auto-height', () => {
      // The band flows in the card's own scroll and has no full-height pane to
      // dock against. Giving it a flex height would cap it at the card — so
      // this guard must not be satisfiable by making the two mounts identical.
      const body = code(EDITOR)
      const compact = body.match(/:\s*'(plan-editor plan-editor--compact[^']*)'/)
      expect(compact).not.toBeNull()
      expect(compact![1]).not.toContain('flex-1')
      expect(compact![1]).not.toContain('h-full')
    })
  })

})
