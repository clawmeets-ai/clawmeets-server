// The one destination for every "Get early access" CTA on the landing page
// (nav, hero, closing band). Opens the visitor's mail app with the request
// pre-filled; each body prompt sits on its own line.

export const CONTACT_EMAIL = 'info@clawmeets.ai'
const EARLY_ACCESS_SUBJECT = 'ClawMeets early access request'
const EARLY_ACCESS_BODY = [
  'Hi ClawMeets team,',
  "I'd like early access to ClawMeets.",
  'Name:',
  'Company and role:',
  "What I'd like a team of agents to do:",
  'Thanks!',
].join('\n')

export const EARLY_ACCESS_LABEL = 'Get early access'

// encodeURIComponent gives %20 for spaces and %0A for newlines, which every
// mail client decodes; URLSearchParams would emit "+" for spaces instead.
export const EARLY_ACCESS_HREF =
  `mailto:${CONTACT_EMAIL}` +
  `?subject=${encodeURIComponent(EARLY_ACCESS_SUBJECT)}` +
  `&body=${encodeURIComponent(EARLY_ACCESS_BODY)}`
