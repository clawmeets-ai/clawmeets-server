import type { SearchHit } from '../../types'
import { splitSnippet } from '../../utils/snippetHighlight'
import Timestamp from '../common/Timestamp'

interface MessageHitRowProps {
  hit: SearchHit
  /**
   * DM rows only: the thread's display name, recovered client-side from the
   * cached project list. `room_label` is the agent's name and is identical
   * across that agent's N threads, so without this two different threads read
   * as the same group. Omitted on a cache miss — never blocks, never fetches.
   */
  threadTitle?: string
}

/**
 * One message search hit inside the ⌘K palette.
 *
 * SECURITY: `snippet` is PLAIN TEXT that may contain '<' and '&' (contract
 * §3.5). Every part renders as a JSX text node so React escapes it — never
 * MarkdownBody, never dangerouslySetInnerHTML. The <mark> wrapper is the only
 * element involved. The ellipses come from the `truncated` booleans rather than
 * from the string, so they can never land inside a highlight or shift an offset.
 *
 * Presentational only: no fetching, no navigation, no keyboard handling — the
 * palette owns all three.
 */
export default function MessageHitRow({ hit, threadTitle }: MessageHitRowProps) {
  const parts = splitSnippet(hit.snippet, hit.match_offsets)

  return (
    <span className="flex flex-col min-w-0 flex-1 gap-0.5">
      <span className="flex items-baseline gap-1.5 min-w-0">
        <span className="truncate text-[12.5px] font-semibold text-ink-1">
          {hit.author_name}
        </span>
        <Timestamp date={hit.ts} />
      </span>
      <span className="text-[12.5px] leading-snug text-ink-2 line-clamp-2 text-left">
        {hit.snippet_truncated_start && '…'}
        {parts.map((part, i) =>
          part.match ? (
            <mark key={i} className="bg-[var(--accent-softer)] text-ink-1 font-semibold rounded-[2px]">
              {part.text}
            </mark>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
        {hit.snippet_truncated_end && '…'}
      </span>
      {threadTitle && (
        <span className="truncate text-[11px] text-ink-4">{threadTitle}</span>
      )}
    </span>
  )
}
