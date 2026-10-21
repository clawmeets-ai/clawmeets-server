import { afterEach, describe, expect, it, vi } from 'vitest'
import hljs from 'highlight.js'
import { cleanup, render } from '@testing-library/react'
import MarkdownBody from './MarkdownBody'

function html(content: string, untrusted?: boolean) {
  return render(<MarkdownBody content={content} untrusted={untrusted} />).container
}

describe('MarkdownBody untrusted', () => {
  afterEach(cleanup)

  it('never loads an image; it becomes a text link to its address', () => {
    const c = html('![cat](https://evil.example/pixel.png)', true)
    expect(c.querySelector('img')).toBeNull()
    const a = c.querySelector('a')!
    expect(a.textContent).toBe('[image: cat]')
    expect(a.getAttribute('href')).toBe('https://evil.example/pixel.png')
  })

  it('renders a javascript: link as text, not an anchor', () => {
    const c = html('[click](javascript:alert(1))', true)
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toContain('click')
  })

  it('renders a data: link as text', () => {
    const c = html('[x](data:text/html;base64,PHNjcmlwdD4=)', true)
    expect(c.querySelector('a')).toBeNull()
  })

  it('shows the punycode host beside a link', () => {
    const c = html('[bank](https://bаnk.example/login)', true) // Cyrillic а
    expect(c.textContent).toContain('(xn--')
    expect(c.querySelector('a')!.getAttribute('href')).toMatch(/^https:\/\/xn--/)
  })

  it('shows a mailto address\'s domain, in punycode, beside the link', () => {
    const c = html('[support@apple.com](mailto:x@xn--pple-43d.com) and [b](mailto:y@\u0430pple.com)', true)
    expect(c.textContent).toContain('support@apple.com (xn--pple-43d.com)')
    expect(c.textContent).toMatch(/b \(xn--[^)]+\.com\)/)
    const plain = html('[write](mailto:a@acme.dev)', true)
    expect(plain.textContent).toBe('write (acme.dev)')
  })

  it('sets target and rel on every link', () => {
    const c = html('[a](https://a.example) and <https://b.example> and [m](mailto:x@y.example)', true)
    const anchors = Array.from(c.querySelectorAll('a'))
    expect(anchors).toHaveLength(3)
    for (const a of anchors) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow')
      expect(a.getAttribute('target')).toBe('_blank')
    }
  })

  it('strips invisible tag characters and bidi controls', () => {
    const c = html('hi\u{E0041}\u{E0042}‮there​', true)
    expect(c.textContent).toBe('hithere')
  })

  it('leaves raw HTML inert', () => {
    const c = html('<img src=x onerror=alert(1)><script>alert(1)</script>', true)
    expect(c.querySelector('img')).toBeNull()
    expect(c.querySelector('script')).toBeNull()
  })

  it('renders code as plain text: no highlighter, no highlightAuto, no markup from the code', () => {
    const auto = vi.spyOn(hljs, 'highlightAuto')
    const hl = vi.spyOn(hljs, 'highlight')
    const big = 'let x = "<span class=\\"evil\\">"; '.repeat(800) // ~30 KB, a made-up language
    const c = html('```zz\n' + big + '\n```\n\n```js\nconst a = 1 <b>2</b>\n```', true)
    expect(auto).not.toHaveBeenCalled()
    expect(hl).not.toHaveBeenCalled()
    const codes = Array.from(c.querySelectorAll('code'))
    expect(codes).toHaveLength(2)
    for (const code of codes) expect(code.children).toHaveLength(0) // text only, no hljs spans
    expect(codes[1].textContent!.trimEnd()).toBe('const a = 1 <b>2</b>')
    expect(c.querySelector('b')).toBeNull()
    auto.mockRestore()
    hl.mockRestore()
  })

  it('keeps highlighting for trusted messages', () => {
    const c = html('```js\nconst a = 1\n```')
    expect(c.querySelector('code span')).not.toBeNull()
  })

  it('keeps the default output unchanged', () => {
    const md = '![cat](https://a.example/c.png) [x](https://a.example)​'
    const c = html(md)
    expect(c.querySelector('img')!.getAttribute('src')).toBe('https://a.example/c.png')
    const a = c.querySelector('a')!
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(c.textContent).toContain('​')
    expect(c.innerHTML).toBe(html(md, false).innerHTML)
  })
})
