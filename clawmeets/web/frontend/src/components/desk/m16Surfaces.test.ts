import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE TWO M16 FIXES, PINNED.
 *
 * Both were found by rendering in a real engine and both were shipped without a
 * test, because the harness cannot see either one: jsdom attaches no stylesheet
 * and does no layout, so a mounting assertion would confirm the class is on the
 * element and stay blind to whether the class draws anything, and would confirm
 * the padding class is in the string and stay blind to what the badge does to
 * the clearance it buys.
 *
 * So these read the SOURCE, in the register `desk.css.test.ts` already
 * established. A regex over a stylesheet is a weak test; it is the strongest
 * one available here, and the alternative — a jsdom assertion about geometry —
 * would pass for the wrong reason.
 */

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

const CSS = src('src/components/desk/desk.css')
const MARKDOWN_BODY = src('src/components/shared/MarkdownBody.tsx')
const STAGED = src('src/components/chatroom/StagedAttachments.tsx')

/** Regex-quote a CSS selector so `.md-card-quote` matches that class and not
 *  `Xmd-card-quote`.
 *
 *  IT USED TO BE A NO-OP. The class was written `[.*+?^${}()|[\\]\\\\]`, and a
 *  character class closes at its first unescaped `]` — so the class was
 *  `[.*+?^${}()|[\\]` and the `\\\\]` after it was read as "then a backslash,
 *  then a `]`". No CSS selector is ever a metacharacter followed by `\\]`, so
 *  nothing matched, nothing was escaped, and the raw selector went into the
 *  `RegExp` with its `.` live as a wildcard. It passed only because `.` also
 *  matches the literal dot it was meant to quote. The `]` is escaped now. */
function quoteRe(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The declarations of one rule, by exact selector. */
function rule(css: string, selector: string): string {
  const m = css.match(
    new RegExp(`(^|[}\\n])\\s*${quoteRe(selector)}\\s*\\{([^}]*)\\}`, 'm'),
  )
  return m ? m[2] : ''
}

describe('the selector quoter actually quotes', () => {
  it('escapes every metacharacter it names — the old class escaped none', () => {
    // Written as a fact about the OUTPUT rather than about the regex, so it
    // fails for the old no-op whatever spelling replaces it.
    expect(quoteRe('.md-card-quote')).toBe('\\.md-card-quote')
    expect(quoteRe('a[b]c')).toBe('a\\[b\\]c')
    expect(quoteRe('x+y*z?')).toBe('x\\+y\\*z\\?')
  })

  it('and the quoted selector stops matching what a live `.` would have', () => {
    // The case the no-op got wrong in substance and not just in form: an
    // unescaped `.` is a wildcard, so `.md-card-quote` matched `Xmd-card-quote`
    // too. Under the old helper this rule was found; it must not be now.
    const decoy = '.plan-x{color:red}\nXmd-card-quote{background:#fff}\n'
    expect(rule(decoy, '.md-card-quote')).toBe('')
    expect(rule(decoy + '.md-card-quote{background:var(--ok)}\n', '.md-card-quote')).toContain(
      'var(--ok)',
    )
  })
})

describe('M16 item 1 — the RESPONSE body agrees with the band it sits in', () => {
  const decls = rule(CSS, '.md-card-quote')

  it('found the rule', () => {
    expect(decls).toContain('background')
  })

  it('draws on a TOKEN, never on a literal colour', () => {
    // The defect: `background: #fff` inside a band painting a `--bg-rail`
    // gradient cut a white box out of a lavender surround. A literal here is
    // the bug returning, whatever its value.
    expect(decls).toMatch(/background:\s*var\(--[\w-]+\)/)
    expect(decls).not.toMatch(/background:\s*(#[0-9a-fA-F]{3,8}|white|rgb)/)
  })

  it('hands its collapse fade THE SAME token it paints itself with', () => {
    // THE SURFACE AND ITS FADE ARE ONE DECISION. Fixing the background alone
    // leaves `MarkdownBody`'s overlay fading to white over the clipped text —
    // the same seam, smaller, and visible only while collapsed. The two must
    // name the same token; which token it is may change.
    const bg = decls.match(/(?:^|;)\s*background:\s*var\((--[\w-]+)\)/)
    const fade = decls.match(/(?:^|;)\s*--md-fade-to:\s*var\((--[\w-]+)\)/)
    expect(bg).not.toBeNull()
    expect(fade).not.toBeNull()
    expect(fade![1]).toBe(bg![1])
  })

  it('and the overlay actually READS that variable', () => {
    // The other half. If `MarkdownBody` goes back to a hardcoded white the
    // custom property above becomes decoration and the seam returns.
    expect(MARKDOWN_BODY).toMatch(/var\(--md-fade-to,\s*#fff\)/)
    expect(MARKDOWN_BODY).not.toMatch(/linear-gradient\([^)]*rgb\(255,\s*255,\s*255\)/)
  })
})

describe('M16 item 2 — the attachment chip clears the composer input', () => {
  /** Tailwind spacing step -> px. */
  const px = (step: string) => Number(step) * 4

  it('the tray carries top padding of its own', () => {
    // `pb-2` on the editor wrap above is not the same thing: it is the wrap's
    // bottom, and the chip row used to butt straight against the input.
    expect(STAGED).toMatch(/className="[^"]*\bpt-2\b[^"]*"/)
  })

  it('the clearance SURVIVES the badge that overhangs it', () => {
    // This is the assertion worth having. The remove badge sits at `-top-1.5`
    // and pokes above the chip, so the padding is not the clearance: the
    // clearance is the padding MINUS the overhang. At `pt-0` the badge measured
    // 3px from the input; the fix took it to 11px.
    const pad = STAGED.match(/className="[^"]*\bpt-(\d+(?:\.\d+)?)\b[^"]*"/)
    expect(pad).not.toBeNull()
    const overhang = STAGED.match(/-top-(\d+(?:\.\d+)?)/)
    expect(overhang).not.toBeNull()
    const clearance = px(pad![1]) + 8 /* the editor wrap's own pb-2 */ - px(overhang![1])
    expect(clearance).toBeGreaterThanOrEqual(10)
  })

  it('stays absent entirely when nothing is staged, so the padding leaves no empty gap', () => {
    // The early return is what makes the padding safe to add unconditionally.
    expect(STAGED).toMatch(/if \(files\.length === 0\) return null/)
  })
})
