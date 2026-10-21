import { hasUnusualCharacters } from '../../utils/hubDisplay'

export const UNUSUAL_CHARACTERS_TEXT = 'contains unusual characters'

/**
 * The "contains unusual characters" chip, shown beside a server name that has
 * any character outside printable ASCII (a look-alike such as a Cyrillic а in
 * "аcme.dev"). The hub's name rules are the first check; this is the
 * browser's own, so a name that slips past them is still marked wherever it
 * is shown. `name` is the name as received, before safeRemoteText.
 */
export default function UnusualNameChip({ name }: { name: string | null | undefined }) {
  if (!name || !hasUnusualCharacters(name)) return null
  return (
    <span
      className="ml-1 inline-block shrink-0 rounded bg-amber-50 px-1.5 text-[11px] font-normal normal-case tracking-normal text-amber-800"
      data-testid="chip-unusual"
    >
      {UNUSUAL_CHARACTERS_TEXT}
    </span>
  )
}
