import { describe, expect, it } from 'vitest'
import { CONTACT_FALLBACK_NAME, isContactId, storedSenderName } from './messageSender'

const CONTACT_ID = 'contact:7d1c0e52-5b8e-4e0a-9d43-2f1f6c1b9a10'

describe('isContactId', () => {
  it('matches only the contact prefix', () => {
    expect(isContactId(CONTACT_ID)).toBe(true)
    expect(isContactId('6f1c0e52-5b8e-4e0a-9d43-2f1f6c1b9a10')).toBe(false)
    expect(isContactId('')).toBe(false)
    expect(isContactId(null)).toBe(false)
    expect(isContactId(undefined)).toBe(false)
  })
})

describe('storedSenderName', () => {
  it("shows the contact's stored display name", () => {
    expect(
      storedSenderName({ from_participant_id: CONTACT_ID, from_participant_name: 'Mara Quintero' }),
    ).toBe('Mara Quintero')
  })

  it('never shows a raw contact id, even with no stored name', () => {
    expect(storedSenderName({ from_participant_id: CONTACT_ID, from_participant_name: '' })).toBe(
      CONTACT_FALLBACK_NAME,
    )
  })

  it('keeps the old id fallback for everyone else', () => {
    expect(storedSenderName({ from_participant_id: 'u-1', from_participant_name: '' })).toBe('u-1')
  })
})
