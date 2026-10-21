import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import type { AgentSampleRequest } from '../../hooks/useAgentSampleRequests'
import PromptEditor, { type PromptEditorHandle } from '../composer/PromptEditor'
import SampleIdeaList, { toPlainPreview } from './SampleIdeaList'

/**
 * The three things that make hover-to-preview safe, and the one that makes it
 * usable on a phone:
 *
 *  1. Hovering a row previews; clicking FILLS. A preview must never commit.
 *  2. A typed draft is never clobbered by a preview. That guarantee comes from
 *     the CSS gate (`.pe-input[data-blank='1'][data-ph-ghost]::before`), not
 *     from a JS check — so the test asserts the DOM state the gate reads,
 *     since jsdom won't compute pseudo-element content for us.
 *  3. On a touch device there is no hover step at all: a tap fills directly and
 *     leaves no dangling ghost behind.
 */

const SAMPLES: AgentSampleRequest[] = [
  {
    category: 'Sample requests',
    title: 'Should I sell my condo — and at what price?',
    request: 'Propose an agent team to value my condo at [Address: 480 Mission Bay Blvd].',
  },
  {
    category: 'Sample requests',
    title: 'Find the best-value Bordeaux I can actually buy',
    request: "Comb **Zachy's**\nfor Bordeaux with good QPR.",
  },
]

// jsdom has no matchMedia. Every test declares its pointer capability, since
// that is exactly the branch under test.
function setHoverCapable(hover: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query === '(hover: hover)' ? hover : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

afterEach(cleanup)

describe('toPlainPreview', () => {
  it('resolves slot defaults, drops bold markers, and flattens newlines', () => {
    expect(toPlainPreview('Value my condo at [Address: 480 Mission Bay Blvd].')).toBe(
      'Value my condo at 480 Mission Bay Blvd.',
    )
    expect(toPlainPreview("Comb **Zachy's**\nfor Bordeaux.")).toBe("Comb Zachy's for Bordeaux.")
  })
})

describe('SampleIdeaList', () => {
  beforeEach(() => setHoverCapable(true))

  it('previews on hover and clears on mouse-out, without ever calling onUse', () => {
    const onUse = vi.fn()
    const onPreview = vi.fn()
    render(<SampleIdeaList samples={SAMPLES} onUse={onUse} onPreview={onPreview} />)

    const row = screen.getByRole('button', { name: /sell my condo/i })
    fireEvent.mouseEnter(row)
    expect(onPreview).toHaveBeenLastCalledWith(
      'Propose an agent team to value my condo at 480 Mission Bay Blvd.',
    )

    fireEvent.mouseLeave(row)
    expect(onPreview).toHaveBeenLastCalledWith(null)
    expect(onUse).not.toHaveBeenCalled()
  })

  it('previews on keyboard focus too, so Tab-navigation matches the mouse', () => {
    const onPreview = vi.fn()
    render(<SampleIdeaList samples={SAMPLES} onUse={() => {}} onPreview={onPreview} />)

    const row = screen.getByRole('button', { name: /Bordeaux/i })
    fireEvent.focus(row)
    expect(onPreview).toHaveBeenLastCalledWith("Comb Zachy's for Bordeaux with good QPR.")
    fireEvent.blur(row)
    expect(onPreview).toHaveBeenLastCalledWith(null)
  })

  it('fills with the placeholder-collapsed body on click and drops the preview', () => {
    const onUse = vi.fn()
    const onPreview = vi.fn()
    render(<SampleIdeaList samples={SAMPLES} onUse={onUse} onPreview={onPreview} />)

    fireEvent.click(screen.getByRole('button', { name: /sell my condo/i }))
    expect(onUse).toHaveBeenCalledWith(
      'Propose an agent team to value my condo at 480 Mission Bay Blvd.',
    )
    expect(onPreview).toHaveBeenLastCalledWith(null)
  })

  it('skips the preview step entirely on a touch device', () => {
    setHoverCapable(false)
    const onUse = vi.fn()
    const onPreview = vi.fn()
    render(<SampleIdeaList samples={SAMPLES} onUse={onUse} onPreview={onPreview} />)

    const row = screen.getByRole('button', { name: /sell my condo/i })
    fireEvent.mouseEnter(row)
    // A tap synthesizes mouseenter on many mobile browsers; without the guard
    // that would strand ghost text with no mouseleave ever coming.
    expect(onPreview).not.toHaveBeenCalled()

    fireEvent.click(row)
    expect(onUse).toHaveBeenCalledTimes(1)
    expect(onPreview).toHaveBeenLastCalledWith(null)
  })

  it('clears a live preview on unmount — navigating away fires no mouseleave', () => {
    const onPreview = vi.fn()
    const { unmount } = render(
      <SampleIdeaList samples={SAMPLES} onUse={() => {}} onPreview={onPreview} />,
    )
    fireEvent.mouseEnter(screen.getByRole('button', { name: /sell my condo/i }))
    onPreview.mockClear()
    unmount()
    expect(onPreview).toHaveBeenCalledWith(null)
  })

  it('announces the fill through a live region (the ghost is pseudo-element content)', () => {
    render(<SampleIdeaList samples={SAMPLES} onUse={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Bordeaux/i }))
    expect(screen.getByRole('status').textContent).toContain('Bordeaux')
  })

  it('renders nothing when there are no samples', () => {
    const { container } = render(<SampleIdeaList samples={[]} onUse={() => {}} />)
    expect(container.firstChild).toBeNull()
  })
})

// Harness: the real composer wired to the real list, exactly as the two zero
// states wire them.
function Wired({ samples }: { samples: AgentSampleRequest[] }) {
  const editor = useRef<PromptEditorHandle>(null)
  return (
    <>
      <PromptEditor ref={editor} placeholder="Message @assistant…" ariaLabel="composer" />
      <SampleIdeaList
        samples={samples}
        onUse={(t) => editor.current?.setPlain(t, false)}
        onPreview={(t) => editor.current?.setGhost(t)}
      />
    </>
  )
}

describe('ghost preview against the real composer', () => {
  beforeEach(() => setHoverCapable(true))

  it('writes data-ph-ghost on hover and removes it on mouse-out', () => {
    render(<Wired samples={SAMPLES} />)
    const box = screen.getByRole('textbox')
    const row = screen.getByRole('button', { name: /sell my condo/i })

    expect(box.getAttribute('data-ph-ghost')).toBeNull()
    fireEvent.mouseEnter(row)
    expect(box.getAttribute('data-ph-ghost')).toBe(
      'Propose an agent team to value my condo at 480 Mission Bay Blvd.',
    )
    fireEvent.mouseLeave(row)
    expect(box.getAttribute('data-ph-ghost')).toBeNull()
  })

  it('cannot show over a typed draft: data-blank flips to 0, which kills the CSS rule', () => {
    render(<Wired samples={SAMPLES} />)
    const box = screen.getByRole('textbox')

    box.textContent = 'a draft I was already writing'
    fireEvent.input(box)
    expect(box.getAttribute('data-blank')).toBe('0')

    fireEvent.mouseEnter(screen.getByRole('button', { name: /sell my condo/i }))
    // The attribute is still written — the guarantee is that the selector
    // `[data-blank='1'][data-ph-ghost]` no longer matches, so nothing paints
    // and, crucially, the draft itself is untouched.
    expect(box.textContent).toBe('a draft I was already writing')
    expect(box.getAttribute('data-blank')).toBe('0')
  })
})
