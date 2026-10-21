export interface SnippetPart {
  text: string
  match: boolean
}

/**
 * Splits a search snippet into alternating plain / matched parts, using
 * SEARCH_API_CONTRACT.md §3.5's algorithm.
 *
 * Offsets are UTF-16 code-unit indices — half-open, non-overlapping, ascending —
 * which is exactly what String.prototype.slice consumes. That conversion happens
 * server-side precisely so a leading astral character (an emoji) cannot shift
 * every later highlight by one; do not "simplify" it into code-point indexing.
 *
 *   - empty `offsets`  -> a single non-match part. Legal, NOT an error.
 *   - trailing tail    -> emitted after the last range.
 *   - defensive        -> ranges are clamped into [0, snippet.length] and any
 *                         range that would move the cursor backwards or covers
 *                         nothing is skipped, so a malformed payload degrades to
 *                         plain text instead of throwing inside a render.
 *
 * Pure and synchronous.
 */
export function splitSnippet(
  snippet: string,
  offsets: Array<[number, number]>,
): SnippetPart[] {
  const parts: SnippetPart[] = []
  let cursor = 0

  for (const [rawStart, rawEnd] of offsets) {
    const start = Math.max(cursor, Math.min(rawStart, snippet.length))
    const end = Math.max(start, Math.min(rawEnd, snippet.length))
    if (end === start) continue
    if (start > cursor) parts.push({ text: snippet.slice(cursor, start), match: false })
    parts.push({ text: snippet.slice(start, end), match: true })
    cursor = end
  }

  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), match: false })
  return parts
}
