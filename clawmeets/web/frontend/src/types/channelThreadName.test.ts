import { describe, expect, it } from 'vitest'
import { FRONT_DESK_NAME_RE, parseFrontDeskName } from './index'

// A channel thread (an outside contact's conversation, server/channels) is
// named `ch-{connection8}-{hex8}`: opaque, no `-fd-`, nothing the contact
// chose. The Front Desk requester pattern must never read a username out of it.
describe('channel thread names', () => {
  const names = ['ch-0123abcd-89efcdab', 'ch-a59f4671-56cc7e28']

  it('never match the Front Desk requester pattern', () => {
    for (const name of names) {
      expect(FRONT_DESK_NAME_RE.test(name)).toBe(false)
      expect(parseFrontDeskName(name)).toBeNull()
    }
  })
})
