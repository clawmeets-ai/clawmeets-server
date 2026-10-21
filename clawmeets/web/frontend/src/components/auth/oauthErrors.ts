// Single source of truth for ALL auth error copy — password sign-in AND OAuth
// invite-login — used by BOTH surfaces:
//   1. the JSON path (loginUser / validateInvite / startOAuth /
//      exchangeOAuthCode throw an AuthContractError with `.code`), and
//   2. the redirect path (/app/login?error=<CODE> after a failed callback).
// Two disjoint code namespaces share this map: OAuth's 13 SCREAMING_SNAKE codes
// and AUTH_CONTRACT's lower_snake codes. Unknown / future codes degrade to a
// generic safe message so a new backend code never renders blank.
// (OAuth half ported verbatim from the standalone oauth_invite_login errorMap.ts.)

import type { OAuthProvider } from '../../types'

// Human label for {provider} interpolation.
const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  google: 'Google',
  github: 'GitHub',
}

// code -> message. `{provider}` is interpolated when a provider is known.
const MESSAGES: Record<string, string> = {
  INVITE_MALFORMED: "That code doesn't look right — check for typos.",
  INVITE_NOT_FOUND: "We couldn't find that invite. Double-check the code.",
  INVITE_ALREADY_REDEEMED: 'This invite has already been used.',
  INVITE_EXPIRED: 'This invite has expired. Ask your inviter for a new one.',
  INVITE_REVOKED: 'This invite is no longer valid.',
  INVITE_REQUIRED: 'You need an invite to create an account. Enter your code to continue.',
  PROVIDER_UNSUPPORTED: 'Something went wrong on our end. Please try again.',
  OAUTH_ACCESS_DENIED: 'Sign-in was cancelled. You can try again anytime.',
  OAUTH_STATE_INVALID: 'Your sign-in session expired. Please start again.',
  OAUTH_EXCHANGE_FAILED: "We couldn't finish signing you in. Please try again.",
  OAUTH_EMAIL_UNVERIFIED: "Your {provider} email isn't verified — verify it with {provider} and retry.",
  OAUTH_EMAIL_MISSING: "{provider} didn't share an email address. Try the other provider.",
  NO_SESSION: 'Please sign in to continue.',
  SIGNUP_CLOSED: 'Sign-up is closed on this server. Ask its operator for an account.',
  signup_closed: 'Sign-up is closed on this server. Ask its operator for an account.',
  EMAIL_UNPROVEN:
    "An account already uses this email address, but the address was never confirmed. " +
    "Sign in with that account's password instead, or ask this server's operator.",

  // --- Password sign-in (AUTH_CONTRACT §4/§5). Every string here is generic by
  // construction: none names a field, and none can distinguish "no such account"
  // from "wrong password" — the four §4.1 cases must be indistinguishable in the
  // UI exactly as they are on the wire.
  //
  // `rate_limited` is DELIBERATELY absent. §7 says to treat a future 429
  // generically rather than special-case it now, so it must keep falling through
  // to GENERIC_FALLBACK. A test locks that in — this is not an oversight.
  invalid_credentials: 'Invalid credentials. Check your username or email and password.',
  email_not_verified: 'Email not verified. Check your email for the verification link.',
  invalid_request: 'Enter your username or email and your password.',
}

const GENERIC_FALLBACK = 'Something went wrong. Please try again.'

// Codes the backend tags field:"code" — render inline under the invite input on
// the JSON path. INVITE_REQUIRED is handled separately (see needsInvite) so it
// gets the recovery notice rather than a plain inline error.
const INVITE_FIELD_CODES = new Set<string>([
  'INVITE_MALFORMED',
  'INVITE_NOT_FOUND',
  'INVITE_ALREADY_REDEEMED',
  'INVITE_EXPIRED',
  'INVITE_REVOKED',
])

// code -> human text. Interpolates {provider} (capitalised) when supplied; falls
// back to a bare "the provider" so the string is never left with a literal token.
export function messageForCode(code: string, provider?: OAuthProvider): string {
  const template = MESSAGES[code] ?? GENERIC_FALLBACK
  const label = provider ? PROVIDER_LABEL[provider] : 'the provider'
  return template.replace(/\{provider\}/g, label)
}

// True for invite codes that belong under the code input (excludes INVITE_REQUIRED).
export function isInviteFieldError(code: string): boolean {
  return INVITE_FIELD_CODES.has(code)
}

// True only for INVITE_REQUIRED -> the Login page shows the recovery notice.
export function needsInvite(code: string): boolean {
  return code === 'INVITE_REQUIRED'
}
