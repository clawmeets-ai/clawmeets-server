/**
 * Read the `exp` claim out of a JWT we already trust, as epoch MILLISECONDS.
 *
 * NOT a validator. There is no signature check here and there must never be
 * one: the server is the only party that can verify these, and pretending
 * otherwise in the browser would be worse than useless.
 *
 * Both tokens carry exp — server/auth.py:58 (access, 1 h) and :79 (refresh,
 * 30 d). JWT is base64URL, not base64: '-'->'+', '_'->'/', re-pad to a
 * multiple of 4 before atob.
 *
 * Returns 0 — "already expired" — for anything that will not decode. NEVER
 * Infinity and never Date.now(): the chip's expired badge reads this, and a
 * token that cannot be parsed must not render as Live.
 */
export function decodeExp(token: string): number {
  const payload = token.split('.')[1]
  if (!payload) return 0

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const claims: unknown = JSON.parse(atob(padded))
    if (typeof claims !== 'object' || claims === null) return 0
    const exp = (claims as { exp?: unknown }).exp
    // A non-numeric or non-finite exp is an undecodable token, not a
    // long-lived one.
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : 0
  } catch {
    return 0
  }
}
