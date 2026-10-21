import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Read off disk, not `import`: vitest stubs every CSS import to `''` (the
// `css: false` default), `?raw` included, and `import.meta.url` is not a file
// URL under the transform. `process.cwd()` is vitest's root — the guard below
// is what makes a cwd change fail loudly instead of passing vacuously.
const CSS = readFileSync(resolve(process.cwd(), 'src/components/desk/desk.css'), 'utf8')

/**
 * CSS RULES THAT NOTHING ELSE IN THIS HARNESS CAN GUARD.
 *
 * Every one of these was shipped missing or wrong, and every one was found by
 * rendering in a real engine rather than by a test: jsdom does no layout, so
 * every assertion in this suite's other 58 files was structurally incapable of
 * seeing them. Three of them were introduced by the fix for the one before —
 * `.pop`'s percentage max-height has now leaked into a third containing block
 * twice, each time because a wrapper was given `position: relative` for an
 * unrelated reason. That is the pattern this file exists to make expensive.
 *
 * IT DOES NOT TEST LAYOUT and must not be read as if it does. It asserts that
 * specific declarations still EXIST, because each of them looks inert to a
 * reader — a bare `position: relative` on a wrapper that styles nothing, a
 * max-height that duplicates the base rule's intent, a `flex` shorthand that
 * appears to restate the default — while the failure mode when one is deleted
 * is not a red test but a popover 27px above its own button, a 39px
 * scrollport, or a `+N` that silently vanishes at long label names.
 *
 * The colour assertions are different in kind and worth separating: those DO
 * pin the shipped value, because a token name is text and text is something a
 * regex can genuinely read. What they cannot check is the contrast ratio the
 * token yields — that number is in the comment beside each rule, measured in
 * a real engine, and it is the comment that has to be trusted, not this file.
 *
 * A regex over a stylesheet is a weak test. It is the strongest one available
 * here, and the alternative — a jsdom assertion about geometry — would pass
 * for the wrong reason, which is worse than not having it.
 */

describe('desk.css — rules the test harness cannot otherwise see', () => {
  it('found the stylesheet', () => {
    expect(CSS.length).toBeGreaterThan(1000)
  })

  it('gives .todo-ctl-wrap a containing block for the group/filter popovers', () => {
    // Without it `.pop { position: absolute; top: 44 }` resolves against
    // `.todo` and the popover opens over the capture box.
    expect(CSS).toMatch(/\.todo-ctl-wrap\s*\{[^}]*position:\s*relative/)
  })

  // `.pop`'s `max-height: 70%` is correct against `.todo` and fatal against
  // anything shorter. Any short mount site needs its own px override, and this
  // one was found only after the containing block moved under it.
  it('overrides .pop max-height inside the control strip, where 70% is ~26px', () => {
    // `.todo-ctl-wrap` is 37px. Without this the Filter popover renders 47.9px
    // tall over 294px of content — none of six rows visible.
    expect(CSS).toMatch(/\.todo-ctl-wrap\s+\.pop\s*\{[^}]*max-height:\s*\d+px/)
  })

  it('leaves exactly one .pop mount site on the percentage max-height', () => {
    // The count is the point. Every `.pop` anchor that is not the full-height
    // rail needs a px override; if a third mount site appears without one,
    // this is the assertion that should be updated deliberately rather than
    // the defect being rediscovered in an engine for a second time.
    const overrides = CSS.match(/^\.[\w-]+\s+\.pop\s*\{[^}]*max-height:/gm) ?? []
    expect(overrides).toHaveLength(1)
    expect(CSS).toMatch(/\.pop\s*\{[^}]*max-height:\s*70%/)
  })

  it('lets a row label chip shrink so the +N overflow count survives', () => {
    // `.lb` carries `flex: none`. On the row's one-line strip that pins
    // flex-shrink to 0, so two ordinary long names push `.lb-more` out of an
    // `overflow: hidden` box and a five-label row presents as a two-label row.
    // It also means `.lb-t`'s `text-overflow: ellipsis` can never fire.
    expect(CSS).toMatch(/\.todo-labels\s+\.lb:not\(\.lb-more\)\s*\{[^}]*flex:\s*0\s+1\s+auto/)
    // ...and `.lb-more` keeps `flex: none`, so the count is the LAST thing to
    // yield rather than the first. Losing this inverts the whole fix.
    expect(CSS).toMatch(/^\.lb-more\s*\{[^}]*flex:\s*none/m)
  })

  it('renders the two new copy surfaces above AA', () => {
    // Tokens, not ratios — see the file header. `.pop-why` carries
    // `unknownAxisReason()`, the sentence explaining why the row above it is
    // refused; at 9.5px, ink-4 on white is 2.62:1. ink-3 is 4.73:1.
    expect(CSS).toMatch(/\.pop-why\s*\{[^}]*color:\s*var\(--ink-3\)/)
    expect(CSS).not.toMatch(/\.pop-why\s*\{[^}]*color:\s*var\(--ink-4\)/)
    // `.pop-cap.calm` on --bg-pill-muted: ink-3 is 4.10:1, ink-2 is 9.33:1 —
    // the same token `.deg-note` already uses on that background.
    expect(CSS).toMatch(/\.pop-cap\.calm\s*\{[^}]*color:\s*var\(--ink-2\)/)
  })

  /**
   * N1 — THE ONE ASSERTION IN THIS FILE THAT IS NOT A REGEX.
   *
   * The rest of this suite reads declarations as text, which is all a regex can
   * do. This one RESOLVES THE CASCADE: it collects every `::before` rule in the
   * shipped file whose selector is built only from `.md-card*` classes, scores
   * each by (specificity, source order) exactly as an engine would, and asks
   * which rule wins `background` for a concrete class set.
   *
   * That is the thing `UpdateCard.bands.test.tsx`'s
   * `container.querySelector('.md-card--urgent')` structurally cannot do: jsdom
   * attaches no stylesheet and evaluates no cascade, so it confirms the CLASS is
   * on the element and is blind to whether the class draws anything. It passed
   * for the whole of wave 1 while `md-card--urgent` — the deviation's only
   * carrier in the feed, the one §4(b) picked because it survives before the
   * card is opened — lost to `--report`, `--progress` and `--read` on equal
   * specificity and earlier source order, and an off-contract card in Working
   * drew a pulsing green rule.
   *
   * It is also order-independent: raising the rule's specificity, moving it
   * last, or adding a fifth lane are all fine, and only a rule that actually
   * beats the urgent one fails this.
   */
  describe('the off-contract left rule wins the cascade on EVERY lane', () => {
    interface Rule {
      classes: Set<string>
      spec: number
      order: number
      decls: string
    }

    // Every `…::before` rule whose selector is a chain of `.md-card…` classes
    // and nothing else. Anything with a descendant, a combinator or a
    // non-`.md-card` compound is out of scope and is skipped rather than
    // mis-scored.
    const rules: Rule[] = []
    // L1 — WHAT THE RESOLVER COULD NOT SCORE AND DROPPED SILENTLY. Both skips
    // below are correct as skips — a descendant selector, a combinator or an
    // attribute selector genuinely cannot be scored by the arithmetic here —
    // but a skip that says nothing is a hole: add
    // `.md-list .md-card--progress::before { background: var(--av-green) }` and
    // it is (0,2,1), it beats the urgent rule at (0,2,1) on source order, the
    // deviation's carrier goes dead on the Working lane again, and every
    // assertion below still passes because the rule was never collected.
    // Counted here and asserted zero, so the day a `.md-card…::before` is
    // written in a shape this cannot score, the suite says so instead of
    // shrinking.
    const skipped: string[] = []
    // Comments out first, or a selector match swallows the block comment above
    // it and stops looking like a selector — which would drop the very rule
    // this suite is here to watch, and pass vacuously.
    const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, '\n')
    const RULE = /(^|[}\n])\s*([^{}@\n][^{}]*?)\s*\{([^}]*)\}/g
    let m: RegExpExecArray | null
    let order = 0
    while ((m = RULE.exec(SRC))) {
      for (const sel of m[2].split(',')) {
        const t = sel.trim()
        if (!t.includes('::before')) continue
        const inScope = t.includes('md-card')
        if (!t.endsWith('::before')) {
          if (inScope) skipped.push(t)
          continue
        }
        const compound = t.slice(0, -'::before'.length)
        if (!/^(\.[\w-]+)+$/.test(compound)) {
          if (inScope) skipped.push(t)
          continue
        }
        const classes = compound.split('.').filter(Boolean)
        if (!classes.every((c) => c === 'md-card' || c.startsWith('md-card--'))) {
          if (inScope) skipped.push(t)
          continue
        }
        // (0, classes, 1 pseudo-ELEMENT) — packed so a bigger number is a
        // stronger selector, which is the only comparison made below.
        rules.push({ classes: new Set(classes), spec: classes.length * 16 + 1, order: order++, decls: m[3] })
      }
    }

    /** The engine's answer for one declaration on one element: highest
     *  specificity, then last declared. That is the whole cascade ONLY while no
     *  `!important` is in play on these rules — a premise this used to state and
     *  leave unchecked, and that the guard below now asserts. */
    function winner(on: string[], prop: string): Rule | null {
      const have = new Set(on)
      let best: Rule | null = null
      for (const r of rules) {
        if (![...r.classes].every((c) => have.has(c))) continue
        if (!new RegExp(`(^|;)\\s*${prop}\\s*:`).test(r.decls)) continue
        if (!best || r.spec > best.spec || (r.spec === best.spec && r.order > best.order)) best = r
      }
      return best
    }

    it('collected the .md-card left-rule cascade off the real stylesheet', () => {
      // Guards the collector itself: if the regex stops matching, every
      // assertion below would pass vacuously on an empty rule set.
      expect(rules.length).toBeGreaterThanOrEqual(5)
      expect(winner(['md-card'], 'background')?.decls).toContain('--line-strong')
    })

    it('scored every .md-card…::before rule in the file — dropped none of them', () => {
      // The hole L1 closed. `.md-stage-s + .md-stage-s::before` is the file's
      // one out-of-scope `::before` and carries no `md-card`, so it is not
      // counted here; anything that DOES touch `.md-card` and cannot be scored
      // fails this rather than vanishing from the rule set.
      expect(skipped).toEqual([])
    })

    it('no .md-card…::before rule uses !important, which `winner` cannot score', () => {
      // `winner` compares specificity then source order and stops there, which
      // is the whole cascade only while no declaration is `!important` — an
      // assumption the JSDoc above states and nothing enforced. The file's one
      // `!important` is `.todo-info-foot`, nowhere near this.
      expect(CSS).not.toMatch(/\.md-card[^{}]*::before[^{}]*\{[^}]*!important/)
    })

    // The four lanes a card can carry. `--urgent` is additive on top of each.
    for (const lane of ['reply', 'report', 'progress', 'read']) {
      it(`beats .md-card--${lane} on the background`, () => {
        const w = winner(['md-card', `md-card--${lane}`, 'md-card--urgent'], 'background')
        expect(w).not.toBeNull()
        expect(w!.decls).toContain('--prio-urgent-fg')
        expect(w!.classes.has('md-card--urgent')).toBe(true)
      })
    }

    it('kills the progress pulse it inherits, rather than only recolouring it', () => {
      // `--progress` sets `animation` as well as `background`. Overriding one
      // property leaves the other applying: a red rule that still pulses reads
      // as "running", which is the opposite of what a deviation means.
      const w = winner(['md-card', 'md-card--progress', 'md-card--urgent'], 'animation')
      expect(w).not.toBeNull()
      expect(w!.classes.has('md-card--urgent')).toBe(true)
      expect(w!.decls).toMatch(/animation:\s*none/)
    })

    it('leaves a lane rule winning when the card is NOT off-contract', () => {
      // The override must be conditional on the class, not a blanket win —
      // otherwise every Working card would stop pulsing.
      const w = winner(['md-card', 'md-card--progress'], 'background')
      expect(w!.decls).toContain('--av-green')
    })
  })

  // ——————————— the cross-highlight, all three surfaces ———————————
  // `DeskPage.crossHighlight.test.tsx` and
  // `MyDeskRailPanel.crossHighlight.test.tsx` pin the other end of this
  // contract: that the right elements get `.md-card--linked`,
  // `.todo-item.linked` and `.mdr-sub--linked`. Nothing over there can see
  // whether the classes still PAINT — a jsdom assertion about an outline
  // passes against an empty stylesheet.
  //
  // The mark is a leading edge plus a soft aura on each surface, and the rules
  // below pin the two halves that look inert to a reader: the resting
  // transparent halo, and `position: relative` on the sidebar sub-row.

  it('parks a TRANSPARENT halo on both roots at rest, so the lit one can fade in', () => {
    // The single most deletable-looking declaration in the file: an outline
    // nobody can see, on elements that are never linked most of the time. It is
    // what gives `outline-color` a value to transition FROM — declare the halo
    // only on `.linked` and it has no start value, so it snaps to full strength
    // on the first mouse-move frame. That snap is half of what made the dashed
    // predecessor read as cheap, and no jsdom test can see it.
    expect(CSS).toMatch(
      /\.md-card,\s*\.todo-item\s*\{[^}]*outline:\s*1\.5px\s+solid\s+transparent/,
    )
    expect(CSS).toMatch(/\.md-card,\s*\.todo-item\s*\{[^}]*outline-offset:\s*3px/)
  })

  it('does NOT park that halo on the sidebar sub-row, which IS focusable', () => {
    // The halo's precondition is that the element cannot take focus — a resting
    // outline on one that can swallows its focus ring, and the app ships no
    // global `:focus-visible` outside `landing.css` to put one back.
    // `.md-card` and `.todo-item` are plain `<div>`s, so they are safe;
    // `.mdr-sub` is a `<button>`, so it takes the wash instead and must never
    // acquire an outline here. (`DeskPage.crossHighlight.test.tsx` asserts the
    // div-ness of the other two against the real DOM, where it is checkable.)
    expect(CSS).not.toMatch(/\.mdr-sub[^{]*\{[^}]*outline:/)
  })

  it('lights the halo pale and CLEAR of the border box, not at it', () => {
    // What replaced the dash pattern as the thing that keeps `linked` from
    // reading as `selected`: contrast and distance. `--accent-soft` (pale) at
    // 3px out, against `.md-card--selected`'s full `--accent` AT the border
    // box. The two co-occur constantly — the keyboard cursor is itself a
    // highlight source — so they have to stack into one legible object.
    expect(CSS).toMatch(
      /\.md-card--linked,\s*\.todo-item\.linked\s*\{[^}]*outline-color:\s*var\(--accent-soft\)/,
    )
    // And no dashed OUTLINE survived anywhere in the stylesheet. Dashed BORDERS
    // still exist and are fine — `.md-dash-job` and friends — because there the
    // pattern means what it means everywhere else in this codebase:
    // provisional. That is precisely why the link could not keep using it.
    //
    // Comments stripped first: the rule above documents the declaration it
    // replaced by quoting it, and a bare search cannot tell the corpse from the
    // epitaph.
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/outline:[^;]*dashed/)
  })

  it('widens the card spine on WIDTH ALONE, leaving every lane hue intact', () => {
    // The leading edge for a card is the lane spine it already has. Widening it
    // on `width` cannot disturb the lane cascade — including the doubled-class
    // `.md-card.md-card--urgent::before` override above, which has broken
    // silently once before — because that cascade is fought entirely on
    // `background` and `animation`.
    const rule = /\.md-card--linked::before\s*\{([^}]*)\}/.exec(CSS)
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/width:\s*5px/)
    expect(rule![1]).not.toMatch(/background|animation/)
    // …and it can only fade if the base pseudo-element transitions width.
    expect(CSS).toMatch(/\.md-card::before\s*\{[^}]*transition:[^;]*width/)
  })

  it('draws the to-do and sidebar bars from ONE rule, so they cannot drift', () => {
    // "The same mark on both surfaces" is the claim; a grouped selector is what
    // makes it structurally true rather than merely true today. Split them and
    // this fails, which is the intent — the same reason the dashed rule it
    // replaced was written grouped.
    expect(CSS).toMatch(/\.todo-item::after,\s*\.mdr-sub::after\s*\{/)
    expect(CSS).toMatch(
      /\.todo-item\.linked::after,\s*\.mdr-sub--linked::after\s*\{[^}]*opacity:\s*1/,
    )
    // It scales up rather than appearing, and both properties are on the
    // transition list — an `opacity` fade with an untransitioned `transform`
    // would pop to full height under a fading bar.
    const base = /\.todo-item::after,\s*\.mdr-sub::after\s*\{([^}]*)\}/.exec(CSS)
    expect(base![1]).toMatch(/scaleY\(0?\.35\)/)
    expect(base![1]).toMatch(/transition:[^;]*opacity[^;]*transform/)
  })

  it('gives the sidebar sub-row the positioning context its bar hangs off', () => {
    // `position: relative` on `.mdr-sub` styles nothing by itself and reads as
    // deletable. Without it the bar positions against the nearest positioned
    // ancestor — the scrolling panel — and every lit row's bar stacks in one
    // place at the top of the rail.
    expect(CSS).toMatch(/\.mdr-sub\s*\{[^}]*position:\s*relative/)
  })

  it('declares the linked card wash AFTER .md-card, which is what makes it win', () => {
    // `.md-card--linked` and `.md-card` are one class each — IDENTICAL
    // specificity — so `background: #fff` on the base rule beats the wash on
    // every ordering but this one. Nothing about the selector says so; moving
    // the block up the file silently turns the wash off and no other test in
    // this repo renders the card against a real engine to notice.
    const base = CSS.search(/\.md-card\s*\{/)
    const linked = CSS.search(/\.md-card--linked\s*\{[^}]*background/)
    expect(base).toBeGreaterThan(-1)
    expect(linked).toBeGreaterThan(base)
  })

  // ——————————— the to-do row's geometry ———————————
  // Four rules whose numbers are DERIVED from the check circle and stated
  // nowhere but in each other's comments. The circle shrank 19px -> 15px once;
  // the three rules pinned to its centerline had to move with it, and nothing
  // in the file would have failed if one had been missed — the icons would
  // simply have sat a couple of pixels below the circle, on touch only.

  /** Every `<prop>: <n>px` in the first rule whose selector matches. */
  function decl(selector: string, prop: string, from = CSS): number | null {
    const rule = new RegExp(`(^|[}\n])\\s*${selector}\\s*\\{([^}]*)\\}`, 'm').exec(from)
    if (!rule) return null
    const m = new RegExp(`(^|;)\\s*${prop}\\s*:\\s*(-?[\\d.]+)px`).exec(rule[2])
    return m ? Number(m[2]) : null
  }

  // The touch block is its own cascade layer; read it separately or a desktop
  // rule wins the regex. DESKTOP is everything ABOVE it — and that split is
  // load-bearing, not tidiness: `.todo-check::after` is declared in BOTH, so a
  // search over the whole file would silently answer a desktop question with
  // the touch rule and keep passing after the desktop one was deleted.
  const TOUCH_AT = CSS.search(/@media \(hover: none\), \(pointer: coarse\)/)
  const TOUCH = /@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? ''
  const DESKTOP = TOUCH_AT > 0 ? CSS.slice(0, TOUCH_AT) : ''

  it('found the touch block and the desktop half above it', () => {
    // Guards every assertion below from passing vacuously against ''.
    expect(TOUCH).toContain('.todo-act')
    expect(TOUCH.length).toBeGreaterThan(200)
    // The row's own rules all sit above the first touch block. If one ever
    // moves below it, these lookups would go quiet rather than fail.
    for (const sel of ['.todo-check {', '.todo-actions {', '.todo-grip {'])
      expect(DESKTOP).toContain(sel)
  })

  it('centers the action cluster on the check circle, whatever its size', () => {
    // THE DERIVATION, not the literals. The circle centers at
    // (row pad 8 + margin-top 1 + half the circle) under the row's top edge,
    // and `.todo-actions` is `height: 2 x that` so an absolutely-positioned
    // `align-items: center` lands on it. Resizing the circle without moving
    // the cluster is the exact drift that shipped once — and it is invisible
    // on desktop, where the icons only appear on hover.
    const circle = decl('\\.todo-check', 'height', DESKTOP)
    expect(circle).not.toBeNull()
    const centerline = 8 + 1 + circle! / 2
    expect(decl('\\.todo-actions', 'height', DESKTOP)).toBe(2 * centerline)
  })

  it('spans the drag grip over the full row height instead of a centerline box', () => {
    // The grip used to be a 17px box derived from the circle's centerline, and
    // a 40px one on touch. It now carries no ink at all, so there is nothing
    // to align: it is an absolutely-positioned transparent strip in the
    // panel's left gutter, out of flex flow, which is the ONLY version that
    // hands the title the width back — deleting the rail alone quiets the row
    // and reclaims nothing. `top`/`bottom: 0` is what makes the target the
    // whole left edge rather than a sliver, and `position: absolute` is what
    // takes it out of flow. Losing either turns this back into chrome the
    // title pays for.
    expect(DESKTOP).toMatch(/\.todo-grip\s*\{[^}]*position:\s*absolute/)
    expect(DESKTOP).toMatch(/\.todo-grip\s*\{[^}]*top:\s*0/)
    expect(DESKTOP).toMatch(/\.todo-grip\s*\{[^}]*bottom:\s*0/)
    // No height/margin in either viewport — either one back means it is
    // hanging off the padding edge again rather than spanning the row.
    expect(decl('\\.todo-grip', 'height', DESKTOP)).toBeNull()
    expect(decl('\\.todo-grip', 'height', TOUCH)).toBeNull()
    expect(decl('\\.todo-grip', 'margin-top', TOUCH)).toBeNull()
  })

  /** The `inset` shorthand of the first matching rule, as [top, right, bottom,
   *  left] — expanded from the 1- and 4-value forms the file uses. */
  function inset(selector: string, from: string): number[] | null {
    const rule = new RegExp(`(^|[}\n])\\s*${selector}\\s*\\{([^}]*)\\}`, 'm').exec(from)
    if (!rule) return null
    const m = /(^|;)\s*inset\s*:\s*([^;}]+)/.exec(rule[2])
    if (!m) return null
    const v = m[2].trim().split(/\s+/).map((x) => Number(x.replace('px', '')))
    return v.length === 1 ? [v[0], v[0], v[0], v[0]] : v
  }

  it('keeps the archive circle a full tap target after the ink shrank', () => {
    // 15px of ink is below every touch-target guideline there is. The ring is
    // transparent and looks inert, which is exactly why deleting it would not
    // look like a regression — and `position: relative` on the circle is what
    // the ring is positioned against, so losing THAT is the same bug.
    expect(CSS).toMatch(/\.todo-check\s*\{[^}]*position:\s*relative/)
    const ring = inset('\\.todo-check::after', DESKTOP)
    expect(ring).not.toBeNull()
    const circle = decl('\\.todo-check', 'height', DESKTOP)!
    // HEIGHT is what the ring is really buying — it is the axis with nothing
    // competing for the pixels.
    expect(circle + -ring![0] + -ring![2]).toBeGreaterThanOrEqual(30)
    // …and on touch the height reaches the same 40px the icons get.
    const touchRing = inset('\\.todo-check::after', TOUCH)
    expect(circle + -touchRing![0] + -touchRing![2]).toBe(40)
  })

  it('does not let the circle\'s tap ring reach back over the drag grip', () => {
    // THE REASON THE RING IS ASYMMETRIC, stated as arithmetic so a later edit
    // to `inset: -8px` (which looks tidier and is wrong) fails here.
    //
    // SAME GUARANTEE, NEW ARITHMETIC. The grip is now an absolute strip, so
    // everything is measured from the row's own padding box: the strip runs
    // from `left` to `left + width`, and the circle — the first flex child
    // now that the grip has left the flow — starts at the row's `padding-left`
    // with its ring reaching back by the inset. Where they overlap the ring,
    // being later in the DOM, WINS the hit test and quietly eats the drag
    // target. Both viewports land on exactly 6px, from opposite directions:
    // desktop -10 + 16, touch -12 + 18.
    const padLeft = 8
    for (const [name, scope] of [['desktop', DESKTOP], ['touch', TOUCH]] as const) {
      // Touch only overrides what it changes; fall back to the desktop rule.
      const gw = decl('\\.todo-grip', 'width', scope) ?? decl('\\.todo-grip', 'width', DESKTOP)!
      const gl = decl('\\.todo-grip', 'left', scope) ?? decl('\\.todo-grip', 'left', DESKTOP)!
      const ring = inset('\\.todo-check::after', scope)!
      expect(gl + gw, `${name}: the strip runs under the circle's tap ring`).toBeLessThanOrEqual(
        padLeft - -ring[3],
      )
    }
    // …and the row's padding-left is the literal the line above assumes.
    expect(DESKTOP).toMatch(/\.todo-item\s*\{[^}]*padding:\s*8px 8px 9px/)
  })

  it('leaves the drag grip NO ink, and keeps the box that makes it draggable', () => {
    // The rail — a 3px `::before` faded to .2 — is gone on purpose: the ask
    // was to stop advertising drag on every resting row. What must NOT go with
    // it is the hit box, or the row cannot be picked up at all. So: no
    // pseudo-element anywhere, no hover tint that would re-introduce ink, and
    // a strip at least 16px wide in both viewports with `cursor: grab` as the
    // one surviving cue.
    expect(CSS).not.toMatch(/\.todo-grip::before/)
    expect(CSS).not.toMatch(/\.todo-grip:hover/)
    expect(CSS).toMatch(/\.todo-grip\s*\{[^}]*cursor:\s*grab/)
    expect(decl('\\.todo-grip', 'width', DESKTOP)).toBeGreaterThanOrEqual(16)
    expect(decl('\\.todo-grip', 'width', TOUCH)).toBeGreaterThanOrEqual(16)
  })

  it('keeps the bare row\'s hit strip out of flow, and grows the body to replace it', () => {
    // THE TROUGH BETWEEN PLAIN TO-DOS. `.todo-hint--load` is the only thing in
    // a bare row's meta, and as a flow line it cost a ~15px line box plus
    // `.todo-meta`'s 6px margin on a row whose content is one 18px title — so a
    // run of bare items on the plate sat nearly double-spaced. Three rules take
    // that back, and each one alone is a regression:
    //   · absolute meta      — or the 21px comes straight back;
    //   · the body's bleed   — or the row stops loading under the very hint
    //                          that advertises the click (the bug the strip was
    //                          added to fix, back by another route);
    //   · the tight line-box — or the text stands taller than the band it sits
    //                          in and paints over the row below.
    expect(DESKTOP).toMatch(/\.todo-item\.bare \.todo-meta\s*\{[^}]*position:\s*absolute/)
    // The bleed is EXACTLY the row's own padding, negated — that is what makes
    // the whole row loadable at no height cost. Read both halves off the file
    // rather than restating them, so a change to the row's padding fails here.
    const rowPad = /\.todo-item\s*\{[^}]*padding:\s*(\d+)px \d+px (\d+)px/.exec(DESKTOP)!
    const body = /\.todo-item\.bare \.todo-body--open\s*\{([^}]*)\}/.exec(DESKTOP)?.[1] ?? ''
    expect(body).toContain(`padding: ${rowPad[1]}px 0 ${rowPad[2]}px`)
    expect(body).toContain(`margin: -${rowPad[1]}px 0 -${rowPad[2]}px`)
    // …and the hint's line box fits inside the bottom band it now rides.
    expect(decl('\\.todo-item\\.bare \\.todo-hint--load', 'line-height', DESKTOP)).toBeLessThanOrEqual(
      Number(rowPad[2]),
    )
  })

  it('drops the bare row\'s strip while the title is being renamed', () => {
    // THE HALF THE BLEED DOES NOT COVER. `BodyShell` renders a plain <div> —
    // not `.todo-body--open` — while renaming, because an <input> inside a
    // <button> is invalid HTML. The bleed above is scoped to `--open`, so that
    // div keeps its natural 18px height while the rule above still positions
    // the meta absolutely against it: measured in headless chromium, the strip
    // lands 9px INSIDE the rename field and the hint paints across the text
    // being typed. Deleting this rule brings that straight back, and jsdom
    // cannot see it — the row renders, it just renders illegibly.
    expect(DESKTOP).toMatch(
      /\.todo-item\.bare \.todo-body:not\(\.todo-body--open\) \.todo-meta\s*\{[^}]*display:\s*none/,
    )
    // The bleed staying scoped to `--open` is the other half of the same fact:
    // if it ever widens to `.todo-body`, the rename box inherits a containing
    // block it was never measured against and this guard stops meaning anything.
    expect(DESKTOP).toMatch(/\.todo-item\.bare \.todo-body--open\s*\{[^}]*padding:/)
  })

  it('pins the row action cluster visible while its overflow menu is open', () => {
    // `.todo-actions` is revealed by `:hover` alone. Moving the pointer off
    // the row and into the popover it just opened would fade the ⋮ out from
    // under the menu — and on the way out, `pointer-events: none` would make
    // the menu's own items unclickable. The z-index is the second half: the
    // cluster is a stacking context at `z-index: 1`, which the NEXT row's
    // cluster and grip draw level with, so an open menu needs to be lifted
    // clear of them.
    expect(CSS).toMatch(/\.todo-item\.is-menu \.todo-actions\s*\{[^}]*opacity:\s*1/)
    expect(CSS).toMatch(/\.todo-item\.is-menu \.todo-actions\s*\{[^}]*pointer-events:\s*auto/)
    // `decl` only reads px values; z-index is unitless.
    const zIndex = (selector: string, from: string): number | null => {
      const rule = new RegExp(`(^|[}\n])\\s*${selector}\\s*\\{([^}]*)\\}`, 'm').exec(from)
      const m = rule && /(^|;)\s*z-index\s*:\s*(-?\d+)/.exec(rule[2])
      return m ? Number(m[2]) : null
    }
    const lifted = zIndex('\\.todo-item\\.is-menu \\.todo-actions', CSS)
    expect(lifted).not.toBeNull()
    expect(lifted!).toBeGreaterThan(zIndex('\\.todo-actions', DESKTOP)!)
  })

  it('drops the action scrim on touch, where it paints a white slab over the title', () => {
    // `.todo-actions` floats over the row behind a `linear-gradient(…, #fff)`
    // written for hover. Desktop never sees it because the row underneath is
    // white on hover; touch has no hover, the row is the lavender rail colour,
    // and the gradient reads as a white rectangle clipping the task text.
    // Becoming a static flex child is the fix, and BOTH halves matter — the
    // `is-open` scrim is a second gradient on its own rule that survives a
    // reset of the base one.
    expect(TOUCH).toMatch(/\.todo-actions\s*\{[^}]*position:\s*static/)
    expect(TOUCH).toMatch(/\.todo-actions\s*\{[^}]*background:\s*none/)
    expect(TOUCH).toMatch(/\.todo-item\.is-open \.todo-actions\s*\{[^}]*background:\s*none/)
    // The desktop rule must still carry the scrim it is fixing — if this ever
    // goes away the media override above is dead weight pinning nothing.
    expect(CSS).toMatch(/\.todo-actions\s*\{[^}]*linear-gradient\(90deg, transparent, #fff/)
  })

  it('paints the Failed chip in the urgent palette, and pairs it with a glyph', () => {
    // Tokens, not ratios — see the file header. --prio-urgent-fg on
    // --prio-urgent-bg is 7.31:1. The glyph is the second channel: colour
    // alone is a claim a colour-blind reader cannot check, which is the same
    // reason `.tk-working` carries a spinner.
    expect(CSS).toMatch(/\.tk-failed\s*\{[^}]*background:\s*var\(--prio-urgent-bg\)/)
    expect(CSS).toMatch(/\.tk-failed\s*\{[^}]*color:\s*var\(--prio-urgent-fg\)/)
    expect(CSS).toMatch(/\.tk-failed\s*>\s*svg\s*\{/)
    // There is still no `.tk-new`. A blank row is a New row — the fourth state
    // did not change that, and adding one would give the most common row on a
    // fresh plate a chip it never had.
    expect(CSS).not.toMatch(/\.tk-new\s*\{/)
  })

  it("keeps the sticky group header's offset matched to .todo-scroll's padding", () => {
    // `top: -8px` cancels `padding: 8px …`. They are one value in two places;
    // if a future edit moves one, this says so.
    expect(CSS).toMatch(/\.todo-scroll\s*\{[^}]*padding:\s*8px/)
    expect(CSS).toMatch(/\.grp-h\s*\{[^}]*top:\s*-8px/)
  })
})
