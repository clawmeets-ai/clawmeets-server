import type { DeskSop } from '../api/endpoints/deskSops'

/**
 * Sections in the SOP rail, derived from the title and nothing else.
 *
 * A title written `Prefix:Name` files the SOP under a `Prefix` heading and
 * shows as `Name` on the card; a title with no prefix lands in "Yours".
 * `Marketing:product IG content` → a Marketing section holding
 * "product IG content".
 *
 * THE TITLE IS THE ONLY STORE. There is no section field on `DeskSop`, no
 * registry of section names, and no server-side validation of the prefix — so
 * renaming an SOP is the entire mechanism for moving it, creating a section, or
 * emptying one, and nothing can drift out of sync with anything. That is also
 * why this lives in `utils/` rather than inside the rail: `SopItem` needs the
 * display name and the rail needs the grouping, and the two must agree about
 * where the prefix ends.
 *
 * The starter SOPs every account is seeded with (`models/desk_sop.py`) use the
 * `SYSTEM:` prefix, which is how they stay out of the owner's own list without
 * being a distinct kind of row. They are ordinary SOPs: editable, deletable,
 * and re-sectionable by rename like any other.
 */

/** SOPs with no prefix. Named for the reader, who owns every row in the rail. */
export const OWN_SECTION = 'Yours'

/** The seeded starter SOPs, sorted to the bottom — see `sortSections`. */
export const SYSTEM_SECTION = 'SYSTEM'

/**
 * Longest prefix we will read as a section name.
 *
 * A cap is what keeps `Reminder: chase the Q3 invoice before Friday` from
 * silently becoming a "Reminder" section — a sentence that merely contains a
 * colon is prose, not filing. 32 characters comfortably fits any real section
 * name ("Marketing", "Brand Design", "Customer Success") while a prose clause
 * that long is rare enough to be worth the occasional miss. The failure is
 * cheap either way: the SOP just stays in "Yours".
 */
const MAX_PREFIX = 32

export interface SopTitle {
  /** The prefix as the owner typed it, or null when there isn't one. */
  section: string | null
  /** What the card shows — the title minus its prefix. Never empty. */
  name: string
}

/**
 * Split a stored title into its section prefix and its display name.
 *
 * Only the FIRST colon splits, so `Marketing:Q3: the reset` is a Marketing SOP
 * named "Q3: the reset" rather than a nested anything. Both halves must be
 * non-empty after trimming, which is what makes `:leading` and `trailing:`
 * plain titles instead of a section with no name.
 */
export function splitSopTitle(title: string): SopTitle {
  const raw = (title ?? '').trim()
  const i = raw.indexOf(':')
  if (i <= 0 || i > MAX_PREFIX) return { section: null, name: raw }
  const section = raw.slice(0, i).trim()
  const name = raw.slice(i + 1).trim()
  // A prefix that spans a line break was never a prefix.
  if (!section || !name || /[\r\n]/.test(section)) return { section: null, name: raw }
  return { section, name }
}

/** What the card shows in place of the raw title. */
export function sopDisplayName(title: string): string {
  return splitSopTitle(title).name
}

export interface SopSection {
  /** Case-folded, so `marketing:` and `Marketing:` are one section. */
  key: string
  /** Heading text — the first spelling encountered wins. */
  label: string
  sops: DeskSop[]
}

/**
 * Group a (already filtered) list into rail sections.
 *
 * Rows inside a section are ordered BY NAME — the DISPLAY name, so the shared
 * prefix never decides it. "Recently used" is built separately by `SopRail`
 * from `recentIds` and stays most-recent-first: it is the one list whose whole
 * job is recency. Everywhere else the library is a reference you scan, and a
 * newest-first one reshuffles under you every time you write an SOP.
 *
 * Search results are name-ordered too. The filter is a boolean match, not a
 * relevance ranking, so there is no ordering there to lose.
 *
 * Empty sections don't exist: a section IS its rows.
 */
export function groupSops(sops: DeskSop[]): SopSection[] {
  const byKey = new Map<string, SopSection>()
  for (const sop of sops) {
    const label = splitSopTitle(sop.title).section ?? OWN_SECTION
    const key = label.toLowerCase()
    const hit = byKey.get(key)
    if (hit) hit.sops.push(sop)
    else byKey.set(key, { key, label, sops: [sop] })
  }
  for (const section of byKey.values()) section.sops.sort(byName)
  return sortSections([...byKey.values()])
}

/**
 * Case- and accent-insensitive, `SOP 2` before `SOP 10`.
 *
 * The DISPLAY name, not the stored title: every row in a section shares the
 * same prefix, so sorting on the raw title would just sort on the part that is
 * identical and then fall through to the name anyway — except where two
 * spellings of one section co-exist (`marketing:` and `Marketing:` are one
 * section by design), where it would interleave them by case.
 *
 * Ties break on id so the order is TOTAL: two SOPs can legitimately share a
 * display name, and a comparator returning 0 leaves them at the mercy of the
 * input order, which is the newest-first order this function exists to stop
 * leaking through.
 */
const byName = (a: DeskSop, b: DeskSop) =>
  sopDisplayName(a.title).localeCompare(sopDisplayName(b.title), undefined, {
    numeric: true,
    sensitivity: 'base',
  }) || a.id.localeCompare(b.id)

/**
 * "Yours" first, the seeded SYSTEM section last, everything else alphabetical
 * between them.
 *
 * The owner's own work outranks boilerplate they didn't write — and on a fresh
 * account, where "Yours" is empty and SYSTEM is the whole library, pinning
 * SYSTEM last costs nothing because it is also first.
 */
function sortSections(sections: SopSection[]): SopSection[] {
  const rank = (s: SopSection) =>
    s.key === OWN_SECTION.toLowerCase() ? 0 : s.key === SYSTEM_SECTION.toLowerCase() ? 2 : 1
  return sections.sort(
    (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, undefined, { numeric: true }),
  )
}
