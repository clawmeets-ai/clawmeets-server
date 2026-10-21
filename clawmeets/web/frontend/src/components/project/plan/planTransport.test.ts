import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE TAB IS TRANSPORT — the obvious sibling of the server-side
 * `test_the_routes_contain_no_parsing_and_no_heading_logic` and
 * `test_the_cli_contains_no_parsing_and_no_heading_logic`.
 *
 * There is ONE grammar in this system and it lives in `models/plan_markdown.py`.
 * A second one in the client would not merely duplicate it — it would
 * reintroduce the exact bug the server's fence-awareness rule prevents, because
 * this project's own PLAN.md documents the grammar it uses: a client-side
 * scanner reads its `## Goal` code sample as a section and eats its
 * `{@agent: …}` examples.
 *
 * So none of these files may derive a heading, a slug, a depth, a box count or
 * a fence. They consume `PlanSection`, whose every member the server computed.
 *
 * MATCHING PRECISION MATTERS HERE. A bare substring search for "slug" hits the
 * word in a comment that correctly documents this constraint, and a test that
 * fires on its own documentation gets "fixed" by deleting the sentence — which
 * leaves the trap armed for whoever writes the next surface. Every check below
 * therefore runs against source with comments and string literals STRIPPED, so
 * it can only fire on code.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SURFACE = [
  ...readdirSync(HERE)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.') && f !== 'planTestServer.ts')
    .map((f) => join(HERE, f)),
  resolve(HERE, '..', 'ProjectPlanTab.tsx'),
  resolve(HERE, '..', '..', 'desk', 'PlanBand.tsx'),
  resolve(HERE, '..', '..', '..', 'api', 'endpoints', 'projectPlans.ts'),
  resolve(HERE, '..', '..', '..', 'hooks', 'useProjectPlan.ts'),
]

/** Source with every comment and string/template literal removed. What is left
 *  is code, so a match is a real one. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

const SOURCES = SURFACE.map((p) => [p.slice(p.indexOf('/src/') + 1), code(p)] as const)

describe('the plan client contains no grammar of its own', () => {
  it('no module matches a Markdown heading', () => {
    // `/^#{1,6}\s/`, `/^(#+)/`, `startsWith('#')` — any of them is a second
    // parser, and the one in the server skips fenced code blocks while this one
    // would not.
    const hits = SOURCES.filter(([, src]) => /\/[^/\n]*#\{?\d*,?\d*\}?[^/\n]*\//.test(src))
    expect(hits.map(([p]) => p)).toEqual([])
  })

  it('no module derives a slug', () => {
    // Slug de-duplication is `x` / `x-2` and the server owns it. A client that
    // re-derives an id from a heading disagrees the moment two headings match.
    const hits = SOURCES.filter(([, src]) => /\bslugify\b|\.toLowerCase\(\)\s*\.replace\(/.test(src))
    expect(hits.map(([p]) => p)).toEqual([])
  })

  it('no module counts checkboxes', () => {
    // `boxes` is `(done, total)` and DISPLAY ONLY. There is no checkbox state
    // machine, client or server; ticking one is an ordinary section edit.
    const hits = SOURCES.filter(([, src]) => /\[\s*[xX ]\s*\]/.test(src))
    expect(hits.map(([p]) => p)).toEqual([])
  })

  it('no module knows what a fenced code block is', () => {
    const hits = SOURCES.filter(([, src]) => src.includes('```'))
    expect(hits.map(([p]) => p)).toEqual([])
  })

  it('the body is indexed in exactly ONE place, on offsets the SERVER derived', () => {
    // `char_start`/`char_end` are shipped for exactly this. Everything
    // downstream — the raw editor's seed, an accept row's `base`, the collision
    // candidates — goes through `sectionText`, so there is one call site to
    // change if the contract ever moves.
    const callers = SOURCES.filter(([, src]) => /\bbody\.slice\(/.test(src)).map(([p]) => p)
    expect(callers).toEqual(['src/components/project/plan/planTrayLogic.ts'])
    const logic = SOURCES.find(([p]) => p.endsWith('planTrayLogic.ts'))![1]
    expect(logic.match(/\bbody\.slice\(/g)).toHaveLength(1)
  })

  it('nothing constructs a diff — the client renders the one the server made', () => {
    // `display_diff` is generated per request and is never an input: no surface
    // anywhere accepts a diff, and the write path sends replacement TEXT. This
    // is the client-side half of "difflib is imported exactly once".
    const hits = SOURCES.filter(([, src]) =>
      /from\s+''(diff|jsdiff)''|require\(''diff''\)|\bcreatePatch\(|\bdiffWords\(|\bdiffLines\(/.test(
        src,
      ),
    )
    expect(hits.map(([p]) => p)).toEqual([])
  })

  it('nothing writes a note status client-side — constraint C1', () => {
    // A local flag, a component useState holding a status, an optimistic
    // decrement that is not reconciled: all three are the same defect, and the
    // integer being mutated is the one the execution gate reads.
    const hits = SOURCES.filter(([, src]) =>
      /\.status\s*=[^=]|open_notes_for_you\s*[-+]{2}|open_notes_for_you\s*[-+]=/.test(src),
    )
    expect(hits.map(([p]) => p)).toEqual([])
  })

  it('the deviation is never added to the count', () => {
    // The single most likely bug on the card. There is deliberately no
    // expression anywhere that combines a deviation with the integer
    // arithmetically.
    const hits = SOURCES.filter(([, src]) =>
      /(deviation|\bdev\b)[^;\n]{0,40}\?\s*1\s*:\s*0|\+\s*\(\s*(deviation|dev)\b/.test(src),
    )
    expect(hits.map(([p]) => p)).toEqual([])
  })

  it('`superseded` is a label, never a wire kind', () => {
    // `DraftEntry.kind` is five values and `PUT /plan/draft` rejects a sixth.
    const kinds = SOURCES.find(([p]) => p.endsWith('projectPlans.ts'))![1]
    expect(/DraftEntryKind\s*=\s*[^;]*superseded/.test(kinds)).toBe(false)
  })
})

describe('the four PROJECT_PLAN_SYNC registration sites are all present', () => {
  // A grep cannot prove the wire reaches the query cache — that is
  // `useWebSocket.plan.test.tsx`'s job, and it fires a raw frame end to end.
  // This is the cheap companion: it fails loudly if a site is DELETED, naming
  // which one, so the runtime test's red does not have to be diagnosed.
  const root = resolve(HERE, '..', '..', '..')
  const site = (rel: string) => readFileSync(join(root, rel), 'utf8')

  it('site 1 — the enum member', () => {
    expect(site('types/index.ts')).toContain("PROJECT_PLAN_SYNC = 'project_plan_sync'")
  })

  it('site 2 — the onAny() types array, the one that fails SILENTLY', () => {
    const src = site('api/websocket.ts')
    const decl = src.indexOf('const types: ControlMessageType[] = [')
    expect(decl).toBeGreaterThan(-1)
    const array = src.slice(decl)
    // Bound the slice at the array's OWN closing bracket, not at the `[]` of
    // its type annotation.
    expect(array.slice(0, array.indexOf('\n    ]'))).toContain('PROJECT_PLAN_SYNC')
  })

  it('site 3 — the dispatch case', () => {
    expect(site('hooks/useWebSocket.ts')).toContain('case ControlMessageType.PROJECT_PLAN_SYNC')
  })

  it('site 4 — the query the case invalidates', () => {
    expect(site('hooks/useProjectPlan.ts')).toContain("queryKey: ['project-plan', projectId]")
  })
})
