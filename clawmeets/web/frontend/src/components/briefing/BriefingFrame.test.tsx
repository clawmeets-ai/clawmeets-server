import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import BriefingFrame, { BRIEF_SANDBOX } from './BriefingFrame'
import {
  BRIEF_MESSAGE_SOURCE,
  FALLBACK_FRAME_PX,
  NO_REPORT_TIMEOUT_MS,
} from './heightBootstrap'

/**
 * THE ISOLATION HOST, tested against what jsdom can actually observe.
 *
 * jsdom does not implement `sandbox` and does not execute iframe scripts, so
 * nothing here proves the boundary DOES anything — that is precisely why
 * `docs/briefing-browser-checklist.md` exists, and reading the string
 * assertion below as proof of isolation would be the expensive mistake. What
 * these tests do prove is that the shipped attribute says what was agreed, and
 * that the parent half of the sizing protocol behaves.
 */

const DOC = '<!doctype html><html><head></head><body>hi</body></html>'

const heightEnvelope = (height: number, slug = 'wine') => ({
  source: BRIEF_MESSAGE_SOURCE,
  v: 1,
  type: 'height',
  slug,
  height,
})

const frameOf = (container: HTMLElement) =>
  container.querySelector('iframe') as HTMLIFrameElement

/** Deliver a message event as if it came from `source`. */
function deliver(data: unknown, source: MessageEventSource | null) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source }))
  })
}

afterEach(cleanup)

describe('BriefingFrame — the boundary attribute', () => {
  it('renders the agreed sandbox flags exactly', () => {
    const { container } = render(
      <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
    )

    expect(frameOf(container).getAttribute('sandbox')).toBe(BRIEF_SANDBOX)
  })

  it('does NOT carry allow-same-origin', () => {
    // Asserted separately from the equality on purpose. If someone adds the
    // flag to "fix" something, the equality test above reads as a string that
    // needs updating; THIS one reads as the boundary being removed, which is
    // what it would be — allow-same-origin is what makes the origin opaque,
    // and the opacity is the whole thing.
    const { container } = render(
      <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
    )

    expect(frameOf(container).getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('carries the document with the bootstrap injected, not the raw bytes', () => {
    const { container } = render(
      <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
    )
    const srcdoc = frameOf(container).getAttribute('srcdoc') ?? ''

    expect(srcdoc).toContain('<body>hi</body>')
    expect(srcdoc).toContain('clawmeets-brief')
  })
})

describe('BriefingFrame — sizing', () => {
  it('starts at the fallback height with no failure notice', () => {
    const { container } = render(
      <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
    )

    expect(frameOf(container).style.height).toBe(`${FALLBACK_FRAME_PX}px`)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('resizes on a valid envelope FROM THE FRAME', () => {
    const { container } = render(
      <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
    )
    const frame = frameOf(container)

    deliver(heightEnvelope(742), frame.contentWindow)

    expect(frame.style.height).toBe('742px')
  })

  it('ignores the same envelope from the page itself', () => {
    // The payload is identical and perfectly valid. Only the sender differs,
    // and contentWindow identity is the one thing a message cannot forge —
    // which is why it is checked BEFORE the payload is even parsed.
    const { container } = render(
      <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
    )
    const frame = frameOf(container)

    deliver(heightEnvelope(742), window)

    expect(frame.style.height).toBe(`${FALLBACK_FRAME_PX}px`)
  })

  it('ignores a malformed envelope from the frame', () => {
    const { container } = render(
      <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
    )
    const frame = frameOf(container)

    deliver({ ...heightEnvelope(742), source: 'clawmeets-briefing' }, frame.contentWindow)
    deliver(heightEnvelope(742, 'cheese'), frame.contentWindow)
    deliver(heightEnvelope(10_000_000), frame.contentWindow)

    expect(frame.style.height).toBe(`${FALLBACK_FRAME_PX}px`)
  })
})

describe('BriefingFrame — the blessed AC-3.3 exception', () => {
  it('shows a visible failure notice once the no-report timer fires', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
      )

      act(() => {
        vi.advanceTimersByTime(NO_REPORT_TIMEOUT_MS)
      })

      // A labelled failure, not a clipped tail: the frame keeps a fixed height
      // (so the browser gives it its own scrollbar) and SAYS so.
      expect(frameOf(container).style.height).toBe(`${FALLBACK_FRAME_PX}px`)
      expect(screen.getByRole('status').textContent).toMatch(/failed to load properly/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a LATE height clears the notice and sizes the frame', () => {
    // A document that was slow past 4s is not broken, and leaving a false
    // accusation on screen is worse than the wait was.
    vi.useFakeTimers()
    try {
      const { container } = render(
        <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
      )
      act(() => {
        vi.advanceTimersByTime(NO_REPORT_TIMEOUT_MS)
      })
      expect(screen.queryByRole('status')).not.toBeNull()

      deliver(heightEnvelope(900), frameOf(container).contentWindow)

      expect(screen.queryByRole('status')).toBeNull()
      expect(frameOf(container).style.height).toBe('900px')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a document that reports in time never sees the timer', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
      )
      deliver(heightEnvelope(300), frameOf(container).contentWindow)

      act(() => {
        vi.advanceTimersByTime(NO_REPORT_TIMEOUT_MS * 3)
      })

      expect(screen.queryByRole('status')).toBeNull()
      expect(frameOf(container).style.height).toBe('300px')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('BriefingFrame — a republish while the briefing is open', () => {
  it('remounts the frame and drops the old measurement', () => {
    // Mutating srcdoc under a live document would leave the height measured
    // from the OLD content attached to the new one. The `slug::generated_at`
    // key is what makes that structurally impossible.
    const { container, rerender } = render(
      <BriefingFrame html={DOC} slug="wine" generatedAt="t1" title="Wine" />,
    )
    const before = frameOf(container)
    deliver(heightEnvelope(742), before.contentWindow)
    expect(before.style.height).toBe('742px')

    rerender(
      <BriefingFrame html={`${DOC}<!-- v2 -->`} slug="wine" generatedAt="t2" title="Wine" />,
    )

    const after = frameOf(container)
    expect(after).not.toBe(before)
    expect(after.style.height).toBe(`${FALLBACK_FRAME_PX}px`)
  })
})
