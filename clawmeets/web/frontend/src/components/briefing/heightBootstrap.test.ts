import { describe, expect, it } from 'vitest'
import { injectHeightBootstrap } from './heightBootstrap'

/**
 * THE INSERTION POINT, which is a pure string function and therefore the one
 * part of the sizing path a jsdom suite can observe completely.
 *
 * jsdom does not execute iframe scripts, so nothing here proves the bootstrap
 * RUNS. What it proves is that it lands where the contract says, in every
 * document shape the contract enumerates — and that is the failure worth
 * catching automatically, because a bootstrap inserted in the wrong place
 * produces a briefing that renders perfectly and then never sizes, with no
 * error anywhere to explain it.
 */

const BOOTSTRAP = /<script>\(function\(\)\{/

/** Where the injected script starts, or -1. */
const at = (html: string) => html.search(BOOTSTRAP)

const scriptCount = (html: string) => html.match(/<script>\(function\(\)\{/g)?.length ?? 0

describe('injectHeightBootstrap — where the script lands', () => {
  it('goes immediately after <head>, and adds exactly one script', () => {
    const source = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>'
    const out = injectHeightBootstrap(source, 'wine')

    expect(out.indexOf('<head>') + '<head>'.length).toBe(at(out))
    expect(scriptCount(out)).toBe(1)
  })

  it('handles an attributed <head lang="en">', () => {
    const source = '<!doctype html><html><head lang="en"><title>x</title></head><body>y</body></html>'
    const out = injectHeightBootstrap(source, 'wine')

    expect(out.indexOf('<head lang="en">') + '<head lang="en">'.length).toBe(at(out))
  })

  it('leaves the author bytes otherwise untouched', () => {
    // The document is stored and served byte-verbatim; the shell inserts and
    // nothing else. Anything that rewrote, normalized or re-serialized the
    // author's markup here would break that contract client-side, where the
    // server's byte-for-byte guarantee cannot see it.
    const source = '<!doctype html><html><head></head><body>\r\n  é &amp; <b>x</b>\r\n</body></html>'
    const out = injectHeightBootstrap(source, 'wine')
    const script = out.slice(at(out), out.lastIndexOf('</script>') + '</script>'.length)

    expect(out.replace(script, '')).toBe(source)
  })

  it('falls back to just after <html> when there is no <head>', () => {
    const source = '<!doctype html><html><body>hi</body></html>'
    const out = injectHeightBootstrap(source, 'wine')

    expect(out.indexOf('<html>') + '<html>'.length).toBe(at(out))
  })

  it('falls back to just after the doctype when there is no <html>', () => {
    const source = '<!doctype html><body>hi</body>'
    const out = injectHeightBootstrap(source, 'wine')

    expect(out.indexOf('<!doctype html>') + '<!doctype html>'.length).toBe(at(out))
  })

  it('falls back to index 0 when there is neither', () => {
    expect(at(injectHeightBootstrap('<body>hi</body>', 'wine'))).toBe(0)
  })

  it('NEVER inserts ahead of the doctype', () => {
    // Ahead of <!doctype html> is quirks mode, which is a styling imposition
    // by another name — the exact thing this project removes.
    for (const source of [
      '<!doctype html><html><head></head><body>a</body></html>',
      '<!doctype html><html><body>a</body></html>',
      '<!doctype html><body>a</body>',
    ]) {
      const out = injectHeightBootstrap(source, 'wine')
      expect(out.startsWith('<!doctype html>')).toBe(true)
      expect(at(out)).toBeGreaterThan(0)
    }
  })

  it('C1 — a document with <header> and no <head> takes the <html> branch', () => {
    // The contract's written pattern, `<head[^>]*>`, ALSO matches the literal
    // string `<header>`: `<head`, then `[^>]*` eats `er`, then `>`. A
    // hand-written briefing with a <header> and no <head> would take the head
    // branch and bury the bootstrap INSIDE the header element, silently.
    //
    // Re-introducing `[^>]*` passes every other test in this file. Only this
    // one turns red, which is the entire reason it is here.
    const source = '<!doctype html><html><body><header>Title</header><p>a</p></body></html>'
    const out = injectHeightBootstrap(source, 'wine')

    expect(out.indexOf('<html>') + '<html>'.length).toBe(at(out))
    expect(at(out)).toBeLessThan(out.indexOf('<header>'))
  })

  it('an unterminated <script> in the author body does not move the insertion point', () => {
    // Head-first is what buys this: nothing of the author's precedes the
    // insertion point, so an unterminated script can no longer swallow the
    // bootstrap. It still breaks the author's own document — which shows up
    // as the labelled fallback, not as a wrong size.
    const source = '<!doctype html><html><head></head><body><script>var a = 1;</body></html>'
    const out = injectHeightBootstrap(source, 'wine')

    expect(out.indexOf('<head>') + '<head>'.length).toBe(at(out))
    expect(at(out)).toBeLessThan(out.indexOf('var a = 1;'))
  })

  it('carries the slug, and a slug can never close the script element early', () => {
    const out = injectHeightBootstrap('<head></head>', 'wine-briefing')
    expect(out).toContain('"wine-briefing"')

    // Server-side validation keeps real slugs to [a-z0-9_-], but this function
    // is also handed the local sample slug and must not depend on a rule
    // enforced in another process.
    const hostile = injectHeightBootstrap('<head></head>', '</script><script>alert(1)')
    expect(hostile).not.toContain('</script><script>alert(1)')
    expect(scriptCount(hostile)).toBe(1)
  })
})
