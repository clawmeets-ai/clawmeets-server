import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHideComments from './rehypeHideComments'

// followup B11. `vitest.config.ts` sets `globals: false`, so testing-library's
// auto-cleanup never registers; asserted suite-wide by `suiteHygiene.test.ts`.
afterEach(cleanup)

/**
 * THE ASSERTION NOBODY HAD WRITTEN.
 *
 * `plan_markdown` states in prose that a comment-only line "provably cannot be
 * found" in the rendered DOM, and `_is_anchorable` refuses to anchor a note to
 * one on exactly that grounds. Nothing checked it. When react-markdown 9 started
 * turning an unhandled raw node into TEXT rather than dropping it, the claim
 * went false and the suite stayed green — the evidence lines simply appeared in
 * the plan editor. These tests are the check that was missing, so the same
 * upgrade cannot land the same way twice.
 *
 * Rendered through the REAL react-markdown with the plan's own plugin stack, not
 * against a hand-built hast tree: the bug lived in the version boundary between
 * remark's output and react-markdown's transform, which a synthetic tree skips.
 */

/** The plan renderer's exact configuration. */
function md(text: string) {
  return render(
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeHideComments]}
    >
      {text}
    </ReactMarkdown>,
  )
}

describe('an HTML comment renders to nothing', () => {
  it('hides the evidence line under a criterion', () => {
    const { container } = md(
      [
        '- [ ] **AC-2.1** — A user with valid credentials receives a session',
        '      that survives a server restart.',
        '      <!-- evidence: tests/test_auth_session.py::test_survives_restart -->',
      ].join('\n'),
    )
    expect(container.textContent).toContain('survives a server restart.')
    expect(container.textContent).not.toContain('evidence')
    expect(container.textContent).not.toContain('<!--')
  })

  it('takes the line break with it, so the criterion ends where its sentence does', () => {
    const { container } = md(
      ['- [ ] **AC-2.1** — A sentence.', '      <!-- evidence: a.test.ts -->'].join('\n'),
    )
    const li = container.querySelector('li')!
    // remark-breaks turns the newline that put the comment on its own line into
    // a <br>. Left behind, that <br> is a blank line under every criterion —
    // which is why `skipHtml` alone is not this fix.
    expect(li.querySelector('br')).toBeNull()
    expect(li.textContent!.trimEnd()).toBe(li.textContent!.replace(/\s+$/, ''))
  })

  it('hides a comment standing on its own as a block', () => {
    const { container } = md('A paragraph.\n\n<!-- a note to the writer -->\n\nAnother.')
    expect(container.textContent).toContain('A paragraph.')
    expect(container.textContent).toContain('Another.')
    expect(container.textContent).not.toContain('a note to the writer')
  })

  it('hides every comment when several stack up', () => {
    const { container } = md(
      ['- [ ] **AC-1.1** — One.', '      <!-- evidence: a -->', '      <!-- evidence: b -->'].join(
        '\n',
      ),
    )
    expect(container.textContent).toContain('One.')
    expect(container.textContent).not.toContain('evidence')
    expect(container.querySelector('li')!.querySelector('br')).toBeNull()
  })
})

describe('what it deliberately does NOT touch', () => {
  it('leaves other raw HTML rendering exactly as it does today', () => {
    // Without `rehype-raw` these are escaped text, and that is the SHIPPING
    // behaviour: a fix that also made them disappear would be a second,
    // unasked-for change riding along with the first.
    const { container } = md('Text with <b>bold</b> raw.')
    expect(container.textContent).toContain('<b>')
    expect(container.textContent).toContain('</b>')
  })

  it('keeps a raw node that is a comment PLUS visible text', () => {
    // Markdown hands this over as one raw block. Dropping the node would take
    // the sentence with it.
    const { container } = md('<!-- a --> and this is visible')
    expect(container.textContent).toContain('and this is visible')
  })

  it('drops a mid-sentence comment without joining the lines around it', () => {
    const { container } = md('before <!-- c --> after\nnext line')
    expect(container.textContent).not.toContain('<!-- c -->')
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
    // The break belongs to the line, not to the comment: it stays.
    expect(container.querySelector('br')).not.toBeNull()
  })

  it('leaves a comment inside a fenced block alone — it is code, not markup', () => {
    const { container } = md('```html\n<!-- shown on purpose -->\n```')
    expect(container.textContent).toContain('<!-- shown on purpose -->')
  })
})
