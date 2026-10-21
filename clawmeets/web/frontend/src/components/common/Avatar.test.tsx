import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import Avatar from './Avatar'
import { AgentStatus } from '../../types'

/**
 * The presence dot is absolutely positioned against Avatar's outer element, so
 * that element MUST carry the fixed box size. When it didn't, its height stayed
 * `auto`, and every consumer that drops the avatar into a `flex` row (chat
 * messages, the activity feed) stretched it to the row's full height under the
 * default `align-items: stretch` -- parking the `bottom`-anchored dot at the
 * bottom of the whole message instead of on the tile.
 */
afterEach(cleanup)

describe('Avatar', () => {
  it('anchors the presence dot to a fixed-size box, not a stretchable one', () => {
    const { container } = render(
      <Avatar name="cpa" status={AgentStatus.ONLINE} size="md" />,
    )

    const wrapper = container.firstElementChild as HTMLElement
    const dot = container.querySelector('span[class*="rounded-full"]')

    expect(dot).not.toBeNull()
    expect(dot?.parentElement).toBe(wrapper)
    expect(wrapper.className).toContain('relative')
    // The box size, and nothing that lets a flex parent resize it.
    expect(wrapper.className).toContain('w-8')
    expect(wrapper.className).toContain('h-8')
    expect(wrapper.className).toContain('shrink-0')
  })

  it('sizes the box on the wrapper for every size, so no consumer can stretch it', () => {
    const boxes: Array<['xs' | 'sm' | 'md' | 'lg', string, string]> = [
      ['xs', 'w-5', 'h-5'],
      ['sm', 'w-6', 'h-6'],
      ['md', 'w-8', 'h-8'],
      ['lg', 'w-10', 'h-10'],
    ]

    for (const [size, w, h] of boxes) {
      const { container } = render(<Avatar name="cpa" size={size} />)
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.className).toContain(w)
      expect(wrapper.className).toContain(h)
      cleanup()
    }
  })
})
