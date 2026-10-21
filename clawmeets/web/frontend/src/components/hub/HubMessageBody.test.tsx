import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const renders: { content: string; untrusted?: boolean }[] = []
vi.mock('../shared/MarkdownBody', () => ({
  default: function MarkdownBodyProbe(p: { content: string; untrusted?: boolean }) {
    renders.push(p)
    return <p>{p.content}</p>
  },
}))

import HubMessageBody from './HubMessageBody'

describe('HubMessageBody', () => {
  afterEach(() => { cleanup(); renders.length = 0 })

  it('is memoised: a re-render with the same text does not render the Markdown again', () => {
    const { rerender } = render(<HubMessageBody text="hello" />)
    rerender(<HubMessageBody text="hello" />)
    rerender(<HubMessageBody text="hello" />)
    expect(renders).toEqual([{ content: 'hello', untrusted: true }])
    rerender(<HubMessageBody text="changed" />)
    expect(renders.map((r) => r.content)).toEqual(['hello', 'changed'])
    expect(renders.every((r) => r.untrusted === true)).toBe(true)
  })
})
