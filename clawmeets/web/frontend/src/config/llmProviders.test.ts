// Provider-catalog parity gate. Adding a provider id to ONE place in the
// frontend must fail here until every place agrees — before this file existed,
// a half-added id produced zero failing tests anywhere in the frontend.
//
// Every assertion is a RUNTIME value or a SOURCE-TEXT check, deliberately.
// `tsconfig.json` excludes `src/**/*.test.ts(x)` and vitest transforms with
// esbuild (transpile-only), so nothing typechecks this file: a type-level
// assertion such as `const _x: Record<LlmProviderId, true> = {…}` would never
// fail anything, and would itself be an eighth enumeration site. The union
// likewise does not exist at runtime, which is why it is read as text.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLI_PROVIDERS,
  LLM_PROVIDERS,
  getLlmProvider,
  providerRequiresKey,
} from './llmProviders'

// `src/`. Vitest sets the CWD to the project root (where vitest.config.ts
// lives); `import.meta.url` is NOT usable here because the jsdom environment
// serves modules over an http: URL, not file:. Guarded so a future config change
// fails loudly instead of silently skipping the source-text assertions.
const SRC = join(process.cwd(), 'src')
if (!existsSync(join(SRC, 'config/llmProviders.ts'))) {
  throw new Error(`expected the frontend src/ at ${SRC} — is vitest running from the project root?`)
}

function readSrc(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf-8')
}

/** Every `.ts`/`.tsx` path under `src/`, relative to it. */
function srcFiles(dir = ''): string[] {
  return readdirSync(join(SRC, dir)).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry}` : entry
    if (statSync(join(SRC, rel)).isDirectory()) return srcFiles(rel)
    return /\.tsx?$/.test(entry) ? [rel] : []
  })
}

const isTestFile = (rel: string): boolean => /\.test\.tsx?$/.test(rel)

/** Source with `//` and block comments removed, so prose about a file is not
 *  mistaken for a reference to it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * Pull the `| 'x'` members out of an `export type <Name> = …` block, which runs
 * to the first blank line. Matches on quoted-literal tokens rather than on line
 * shape, so reformatting the union (e.g. prettier collapsing it onto one line)
 * does not silently change what this asserts.
 */
function unionMembers(source: string, typeName: string): string[] {
  const block = new RegExp(`export type ${typeName} =([\\s\\S]*?)\\n\\s*\\n`).exec(source)
  if (!block) throw new Error(`no \`export type ${typeName} =\` block found`)
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const CATALOG_IDS = LLM_PROVIDERS.map((p) => p.id)
const FIXTURE_IDS: string[] = JSON.parse(readSrc('config/providerIds.fixture.json'))

/**
 * A hand-rolled provider union looks like `| 'claude'`. Derived from the catalog
 * so a provider added later is covered without editing this regex — which would
 * make the regex itself an enumeration site.
 */
const PIPE_PROVIDER_LITERAL = new RegExp(`\\|\\s*'(${CATALOG_IDS.join('|')})'`)
const ANY_PROVIDER_LITERAL = new RegExp(`'(${CATALOG_IDS.join('|')})'`)

describe('LLM provider catalog', () => {
  it('union members and catalog entries correspond 1:1', () => {
    const union = unionMembers(readSrc('config/llmProviders.ts'), 'LlmProviderId')

    // Set-equality alone is not enough: a copy-pasted entry whose id was never
    // edited passes a naive set compare, so both sides are checked for dupes
    // first. `soft` so a drill sees every one of these fail independently — a
    // hard assert would mask the ones behind it.
    expect.soft(new Set(union).size, 'duplicate union member').toBe(union.length)
    expect.soft(new Set(CATALOG_IDS).size, 'duplicate catalog entry').toBe(CATALOG_IDS.length)
    expect.soft([...union].sort()).toEqual([...CATALOG_IDS].sort())
  })

  it('sorted catalog ids equal providerIds.fixture.json', () => {
    // The fixture is the anchor the backend drift gate greps the Python provider
    // lists against, so a change to the id set is a deliberate two-file edit and
    // can never be a silent one.
    // The left side is always sorted, so this also pins the fixture's own order.
    expect([...CATALOG_IDS].sort()).toEqual(FIXTURE_IDS)
  })

  it('antigravity is a CLI-tier, keyless entry with the pinned placeholder', () => {
    const entry = getLlmProvider('antigravity')
    expect(entry).toBeDefined()
    // `soft` from here on: mis-tiering the provider should show up as EVERY
    // consequence it has, not just the first one alphabetically down the file.
    expect.soft(entry?.label).toBe('Antigravity')
    expect.soft(entry?.kind).toBe('cli')
    // Pinned contract: the bare slug, no `provider/` prefix (unlike opencode).
    // Exact equality, so it pins the prefix-freedom too.
    expect.soft(entry?.modelPlaceholder).toBe('e.g. gemini-3.1-pro-high')
    // CLI tier ⇒ no API-key field and no base-URL field, both of which the
    // dialog derives from `kind` alone. See ModelConfigDialog.catalogDriven.
    expect.soft(providerRequiresKey('antigravity')).toBe(false)
    expect.soft(CLI_PROVIDERS.map((p) => p.id)).toContain('antigravity')
  })

  it('lists every CLI-tier entry before every API-tier one', () => {
    // The picker renders in catalog ORDER, so order is user-visible and the id
    // set alone does not pin it. Nothing else guards this: a new entry dropped
    // into the middle of the `-api` block would interleave the two tiers in the
    // dropdown, and every other assertion here would stay green.
    // An all-CLI catalog puts indexOf('api') at -1, so this fails loudly rather
    // than passing vacuously.
    const kinds = LLM_PROVIDERS.map((p) => p.kind)
    expect(kinds.lastIndexOf('cli')).toBeLessThan(kinds.indexOf('api'))
  })

  it('types/index.ts and api/endpoints/agents.ts defer to LlmProviderId', () => {
    for (const rel of ['types/index.ts', 'api/endpoints/agents.ts']) {
      const source = readSrc(rel)
      expect.soft(source, `${rel} should type llm_provider by the catalog union`).toContain(
        'llm_provider?: LlmProviderId',
      )
      // No re-introduced hand-rolled union anywhere in the file.
      expect.soft(
        PIPE_PROVIDER_LITERAL.test(source),
        `${rel} carries a hand-rolled provider union: ${PIPE_PROVIDER_LITERAL.exec(source)?.[0]}`,
      ).toBe(false)
    }
  })

  it('CreateAgentPage enumerates no providers', () => {
    const source = readSrc('components/agent/CreateAgentPage.tsx')
    expect.soft(/type\s+LlmProvider\s*=/.test(source), 'local provider union').toBe(false)
    expect.soft(
      ANY_PROVIDER_LITERAL.test(source),
      `CreateAgentPage hardcodes a provider id: ${ANY_PROVIDER_LITERAL.exec(source)?.[0]}`,
    ).toBe(false)
    expect.soft(source).toContain("from '../../config/llmProviders'")
  })

  it('providerIds.fixture.json is imported by no runtime module', () => {
    // The fixture is a test expectation, not a source. This test reads it with
    // `readFileSync`, so nothing under src/ should import it at all — and no
    // non-test file should reach it by any means (a bare `readFileSync` of it
    // would make it a second source of truth just as surely as an import).
    const importers = srcFiles().filter((rel) =>
      /(import|require)[^\n]*providerIds\.fixture/.test(stripComments(readSrc(rel))),
    )
    expect.soft(importers).toEqual([])

    const readers = srcFiles().filter(
      (rel) => !isTestFile(rel) && stripComments(readSrc(rel)).includes('providerIds.fixture'),
    )
    expect.soft(readers).toEqual([])
  })
})
