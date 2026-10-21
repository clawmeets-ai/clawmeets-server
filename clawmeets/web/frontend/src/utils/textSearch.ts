/**
 * What a typed query MEANS, for every search box on the desk.
 *
 * One definition, deliberately: the To-do rail and the SOP rail both search,
 * and two independent implementations is how `marketing ig` comes to find an
 * SOP but not the to-do about it. Domain-free on purpose — this module knows
 * about words and haystacks, never about to-dos or SOPs. Which FIELDS of a row
 * are searchable is the caller's question (`todoSearch.ts` answers it for a
 * to-do; `SopRail` answers it inline for an SOP).
 *
 * The rule: split the query on whitespace, and EVERY word must appear
 * somewhere — substring, case-insensitive, order-free. So `marketing ig`
 * matches "Marketing:product IG content", `ig marketing` matches it too, and
 * a half-typed `mark ig` still reaches it. AND rather than OR because a second
 * word is how a user narrows; OR would make every extra keystroke widen the
 * result set, which reads as the search not working.
 */

/** Split a free-text query into the words that must ALL be present. */
export function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * True when every token appears in some field. An empty token list matches
 * everything, so callers can pass an unsearched query straight through.
 *
 * Fields are joined with a space and matched as one string. That is safe
 * precisely BECAUSE tokens never contain whitespace (`searchTokens` split them
 * on it) — so no token can span the boundary between two fields and report a
 * match that is not in either one.
 */
export function matchesTokens(
  fields: ReadonlyArray<string | null | undefined>,
  tokens: readonly string[],
): boolean {
  if (!tokens.length) return true
  const hay = fields
    .filter((f): f is string => !!f)
    .join(' ')
    .toLowerCase()
  return tokens.every((t) => hay.includes(t))
}
