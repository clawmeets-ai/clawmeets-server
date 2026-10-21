// Who sent a chat message, for senders that are not on the viewer's agent roster.
//
// A person outside ClawMeets (reached over a channel such as Telegram or email)
// posts into a Front Desk thread as `from_participant_id = "contact:<id>"`. That
// id is neither a user nor an agent, so a roster lookup misses and code that
// decides "not an agent, so it's me" gets it wrong. Mirrors the server's
// `is_contact_id` (clawmeets/sync/changelog.py); this is the ONLY place the web
// app knows the prefix — never test for it by hand.

const CONTACT_ID_PREFIX = 'contact:'

/** Shown when a contact's message somehow carries no stored name. */
export const CONTACT_FALLBACK_NAME = 'Outside contact'

export function isContactId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(CONTACT_ID_PREFIX)
}

/**
 * Name to show for a sender that is not an agent on the viewer's roster: the
 * name stored on the message, else a readable label — never a raw contact id.
 */
export function storedSenderName(msg: {
  from_participant_id: string
  from_participant_name?: string | null
}): string {
  if (msg.from_participant_name) return msg.from_participant_name
  return isContactId(msg.from_participant_id) ? CONTACT_FALLBACK_NAME : msg.from_participant_id
}
