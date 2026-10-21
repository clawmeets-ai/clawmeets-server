import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import colors from 'tailwindcss/colors'

/**
 * THE ANCHORED NOTE'S BACKGROUND, MEASURED RATHER THAN EYEBALLED.
 *
 * `desk.css.test.ts` says of its own colour assertions that "what they cannot
 * check is the contrast ratio the token yields — that number is in the comment
 * beside each rule … and it is the comment that has to be trusted". That is
 * true of a ratio against a RENDERED surface, which needs a layout engine.
 * It is not true here, and this file is the difference.
 *
 * A WCAG contrast ratio is a pure function of two sRGB triples. The only thing
 * jsdom cannot do is resolve the cascade — so this file does not ask it to. It
 * reads the token NAME out of the stylesheet, resolves that name out of
 * `tokens.css`, reads the warning's Tailwind CLASS NAMES out of
 * `PlanNoteRow.tsx`, resolves those out of Tailwind's own palette, and then
 * does arithmetic that needs no browser at all. Every input is the shipped
 * value; nothing is restated by hand, so nothing can drift from what renders.
 *
 * WHAT "BOTH THEMES" MEANS IN THIS CODEBASE, stated because it is not what a
 * reader expects. There is no dark stylesheet. `tailwind.config.js` sets no
 * `darkMode`, so Tailwind 3's default `media` strategy applies and `dark:`
 * follows the OS `prefers-color-scheme`; `tokens.css` defines every surface
 * token once, in `:root`, and NOTHING in `src/` carries a
 * `prefers-color-scheme` block or a `.dark` selector. So a theme switch flips
 * the seventeen `dark:` TEXT utilities in the tree and moves no surface at all.
 * Both themes therefore share one background — and this file asserts that
 * rather than assuming it, so the day a dark surface theme arrives, the rule
 * this suite guards gets revisited instead of silently inverting.
 */

const root = process.cwd()
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const PLAN_CSS = read('src/components/project/plan/plan.css')
const TOKENS = read('src/styles/design/tokens.css')
const NOTE_ROW = read('src/components/project/plan/PlanNoteRow.tsx')

/* -- the shipped values, resolved from where they actually live ------------ */

/** `--name` out of `tokens.css`'s `:root`. Throws rather than returning a
 *  default: a silently-missing token would make every ratio below a fiction. */
function token(name: string): string {
  const m = TOKENS.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`))
  if (!m) throw new Error(`tokens.css defines no --${name}`)
  return m[1]
}

/** The `background` of a rule, as authored — `var(--x)`, `transparent`, a hex. */
function background(selector: string): string {
  const m = PLAN_CSS.match(
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`),
  )
  if (!m) throw new Error(`plan.css has no rule for ${selector}`)
  const bg = m[1].match(/(?:^|[\s;])background\s*:\s*([^;]+);/)
  if (!bg) throw new Error(`${selector} declares no background`)
  return bg[1].trim()
}

/** The Tailwind text colour a `PlanNoteRow` element carries, per theme. The
 *  regex is anchored on a string unique to that element, so a class moving to
 *  a different div fails here rather than measuring the wrong thing. */
function warningClasses(anchor: string): { light: string; dark: string } {
  const at = NOTE_ROW.indexOf(anchor)
  if (at < 0) throw new Error(`PlanNoteRow.tsx no longer contains ${anchor}`)
  const window_ = NOTE_ROW.slice(Math.max(0, at - 400), at)
  const light = [...window_.matchAll(/(?<![\w:-])text-(amber-\d{3})/g)].pop()
  const dark = [...window_.matchAll(/dark:text-(amber-\d{3})/g)].pop()
  if (!light || !dark) throw new Error(`no amber pair found for ${anchor}`)
  return { light: light[1], dark: dark[1] }
}

/** `amber-800` -> `#92400e`, out of Tailwind's own palette rather than a hex
 *  copied into this file. The classes compile against this exact object. */
function tw(cls: string): string {
  const [family, step] = cls.split('-')
  const scale = (colors as unknown as Record<string, Record<string, string>>)[family]
  const hex = scale?.[step]
  if (!hex) throw new Error(`Tailwind has no colour ${cls}`)
  return hex
}

/* -- WCAG 2.x relative luminance and contrast ------------------------------ */

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/* -- the surfaces under test ----------------------------------------------- */

/** What an anchored note used to be painted on, and what it is measured
 *  against. `background: transparent` meant "the document", and the document
 *  is `--bg-canvas` on the Plan tab and `#fff` on the desk card — the same
 *  colour by two names. */
const PAGE = token('bg-canvas')
const ANCHORED_BG = background('.plan-anchored .plan-note')
const TOKEN_NAME = ANCHORED_BG.match(/^var\(\s*--([\w-]+)\s*\)$/)?.[1] ?? ''

describe('AC-4.1 — the anchored note gets a real background, built from a token', () => {
  it('is a var(), not transparent and not a hex', () => {
    expect(ANCHORED_BG).not.toBe('transparent')
    expect(ANCHORED_BG).not.toMatch(/#[0-9a-fA-F]/)
    expect(TOKEN_NAME).not.toBe('')
  })

  it('resolves out of tokens.css', () => {
    expect(token(TOKEN_NAME)).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  it('NEEDS NO SECOND RULE — nothing in the tree redefines a surface per theme', () => {
    // The whole basis for "it resolves correctly in dark mode with no second
    // rule". The moment either of these stops holding, the single declaration
    // in plan.css stops being sufficient and this test is the notice.
    const cssFiles: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.css')) cssFiles.push(p)
      }
    }
    walk(resolve(root, 'src'))
    expect(cssFiles.length).toBeGreaterThan(3)
    for (const f of cssFiles) {
      const css = readFileSync(f, 'utf8')
      // The AT-RULE, not the words: two files legitimately NAME this feature in
      // a comment explaining why they do not use it, and a bare substring match
      // fails on its own documentation.
      expect(css).not.toMatch(/@media[^{]*prefers-color-scheme/)
      expect(css).not.toMatch(new RegExp(`\\.dark[\\s,{][^}]*--${TOKEN_NAME}\\s*:`))
    }
    // And the token itself is declared exactly once.
    const declared = [...TOKENS.matchAll(new RegExp(`--${TOKEN_NAME}\\s*:`, 'g'))]
    expect(declared).toHaveLength(1)
  })
})

describe('AC-4.2 — visibly distinct from the document behind it, in BOTH themes', () => {
  /** A large adjacent surface, not a UI boundary: the 2px `--line-2` bar is
   *  what carries the WCAG 1.4.11 edge (AC-4.4), so the fill's job is only to
   *  read as a different surface. 1.10:1 is the floor that separates a tint a
   *  reader can see from one they cannot — `--bg-card-hover` (1.05:1) fails it
   *  and was rejected for exactly that reason. */
  const FLOOR = 1.1

  it('light', () => {
    expect(contrast(token(TOKEN_NAME), PAGE)).toBeGreaterThanOrEqual(FLOOR)
  })

  it('dark — the same number, and that is the assertion', () => {
    // No surface token moves with the theme (proved above), so the dark-mode
    // background IS the light-mode background. Asserted rather than skipped:
    // a suite that quietly tested one theme twice would look like this too.
    expect(contrast(token(TOKEN_NAME), PAGE)).toBeGreaterThanOrEqual(FLOOR)
  })

  it('stays SUBORDINATE — lighter than the card the list below the document uses', () => {
    // AC-4.4. `.plan-note`'s base class is `bg-sidebar`, Tailwind's mirror of
    // `--bg-sidebar`. An anchored note that reached that weight would stop
    // being subordinate to the line above it.
    expect(luminance(token(TOKEN_NAME))).toBeGreaterThan(luminance(token('bg-sidebar')))
  })
})

describe('AC-4.3 — the warning is no quieter than it was, in both themes', () => {
  const WARN = warningClasses('This section changed since')
  const WAITING = warningClasses('waiting to send')

  /** What the warning measured BEFORE this milestone: the shipped
   *  amber-700/400 pair against the bare page. Derived, not restated — if
   *  Tailwind's palette moves, the bar moves with it. */
  const WAS = { light: contrast(tw('amber-700'), PAGE), dark: contrast(tw('amber-400'), PAGE) }

  it('records the baseline it has to beat', () => {
    expect(WAS.light).toBeCloseTo(5.02, 1)
    expect(WAS.dark).toBeCloseTo(1.67, 1)
  })

  it('light — against the new background, no lower than against the page today', () => {
    expect(contrast(tw(WARN.light), token(TOKEN_NAME))).toBeGreaterThanOrEqual(WAS.light)
  })

  it('dark — against the new background, no lower than against the page today', () => {
    expect(contrast(tw(WARN.dark), token(TOKEN_NAME))).toBeGreaterThanOrEqual(WAS.dark)
  })

  it('and no lower in the LIST below the document either, where the same row renders', () => {
    // The fix is on the warning, so it travels with the note. The card down
    // there is `bg-sidebar`, which had been costing this warning contrast
    // nobody had measured; it comes out ahead there too.
    const card = token('bg-sidebar')
    expect(contrast(tw(WARN.light), card)).toBeGreaterThanOrEqual(contrast(tw('amber-700'), card))
    expect(contrast(tw(WARN.dark), card)).toBeGreaterThanOrEqual(contrast(tw('amber-400'), card))
  })

  it('is the MOST SALIENT amber in the note — louder than "waiting to send"', () => {
    const bg = token(TOKEN_NAME)
    expect(contrast(tw(WARN.light), bg)).toBeGreaterThan(contrast(tw(WAITING.light), bg))
    expect(contrast(tw(WARN.dark), bg)).toBeGreaterThan(contrast(tw(WAITING.dark), bg))
  })
})

describe('AC-4.4 — the left accent bar survives', () => {
  it('the anchored rule still draws it, and still from a token', () => {
    expect(PLAN_CSS).toMatch(
      /\.plan-anchored \.plan-note\s*\{[^}]*border-left:\s*2px solid var\(--line-2\)/,
    )
  })

  it('and a focused anchored note still marks itself on that bar, not on the fill', () => {
    // Why the "selected"-named token is safe here: focus is a border colour,
    // the surface is a fill, and the two never collide.
    expect(PLAN_CSS).toMatch(
      /\.plan-anchored \.plan-note--focused\s*\{[^}]*border-left-color:\s*var\(--accent\)/,
    )
  })
})
