import type { DeskTodo } from '../api/endpoints/deskTodos'
import { matchesTokens, searchTokens } from './textSearch'

/**
 * WHICH FIELDS OF A TO-DO A SEARCH CAN REACH. The query language itself lives
 * in `textSearch.ts`; this module answers the one domain question it refuses
 * to — what counts as the text of a to-do.
 *
 * The rule that picks the list: a field is searchable only if a match in it is
 * VISIBLE ON THE ROW. A query that hits the full `draft_prompt` would leave a
 * row on the plate with no matching word anywhere on it, which reads as the
 * filter being broken rather than as a clever deep match. So: the to-do's own
 * text, the draft's recipient, and its label slugs — every one of which is
 * painted on the row.
 */
export function todoSearchFields(t: DeskTodo): Array<string | null | undefined> {
  return [
    t.text,
    t.draft_recipient_name,
    ...(t.labels ?? []),
  ]
}

/**
 * Tokenize a query typed into the To-do rail's box.
 *
 * That box is also the capture box and the label autocomplete's input, so a
 * half-typed `@marketing` token is a normal thing to find in it. Stripping the
 * sigil makes the search agree with what the owner is plainly doing — typing
 * `@marketing` narrows the plate to rows carrying the `marketing` slug at the
 * same time as it opens the label menu, instead of matching nothing because no
 * stored slug starts with an `@`.
 */
export function todoQueryTokens(query: string): string[] {
  return searchTokens(query)
    .map((t) => t.replace(/^[@#]+/, ''))
    .filter(Boolean)
}

/** Every token present somewhere the row actually shows. */
export function matchesTodoSearch(t: DeskTodo, tokens: readonly string[]): boolean {
  return matchesTokens(todoSearchFields(t), tokens)
}
