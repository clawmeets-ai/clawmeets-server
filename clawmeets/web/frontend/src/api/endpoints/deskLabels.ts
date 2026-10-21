import { get, post, patch, del } from '../client'

/**
 * The My Desk label registry — the owner's GTD vocabulary (`@office`,
 * `@garage`, …). Six calls, mirroring `deskSops.ts` shape-for-shape.
 *
 * ONE THING THAT IS NOT LIKE `deskTodos.ts`, and it is the mistake muscle
 * memory makes: `GET /me/desk/labels` returns `{"labels": [...]}`, an
 * ENVELOPE, where `GET /me/desk/todos` returns a bare list. So does the
 * reorder verb. Both unwrap here, so no caller ever sees the envelope.
 */

/**
 * ONE KIND. `'state'` is retired: lifecycle is the server-derived `DeskTodo.state`
 * now, an axis the owner does not write and a label cannot express.
 *
 * A UNION OF ONE RATHER THAN NO FIELD AT ALL, on purpose. The wire still
 * carries `kind` and the server still answers `labels.invalid_kind` /
 * `kind_immutable` / `kind_conflict` / `kind_mismatch`, so a type that says so
 * keeps those refusals legible. And a registry written before the retirement
 * keeps its stored `state` rows — nothing on disk is deleted; the server
 * coerces one to a context on READ, so from here the axis has simply stopped
 * existing. Those slugs are still attached to real to-dos, and nothing in this
 * client offers to clean them up.
 */
export type LabelKind = 'context'

export type PaletteToken =
  | 'blue'
  | 'green'
  | 'indigo'
  | 'teal'
  | 'amber'
  | 'pink'
  | 'slate'
  | 'plum'

/** Palette ORDER is load-bearing: it is the tie-break in `nextColor()`, and it
 *  is the same tuple as `PALETTE` in `clawmeets/models/desk_label.py`. The two
 *  are independent mirrors of the frozen contract, not a shared file. */
export const PALETTE: readonly PaletteToken[] = [
  'blue',
  'green',
  'indigo',
  'teal',
  'amber',
  'pink',
  'slate',
  'plum',
] as const

/** At most this many labels on one to-do. The server refuses a write whose
 *  RESULT exceeds it (`labels.cap_exceeded`, carrying the would-be result
 *  size). Deliberately looser than the chip-render cap so the storage limit is
 *  never the thing making a UI decision — nothing derives one from the other. */
export const MAX_LABELS_PER_TODO = 8

/** Past this a slug is REFUSED (`labels.slug_too_long`), never truncated. The
 *  mock's `.slice(0, 32)` would send a value the server rejects. */
export const MAX_SLUG_LEN = 32

/** One registry row.
 *
 *  `slug` is identity and is never rewritten — a true slug change is a merge
 *  into a newly created slug. NOTE what is absent: no `locked` (the field was
 *  removed rather than pinned false) and no `glyph` (the `@` is rendered from
 *  `kind`, stored nowhere).
 *
 *  `created_at` / `updated_at` on a SEED row are the fixed constant
 *  `1970-01-01T00:00:00+00:00`, not the clock, until the first registry write
 *  materializes them. Nothing keys on them; never sort by them and expect
 *  meaning. */
export interface DeskLabel {
  slug: string
  name: string
  kind: LabelKind
  color: PaletteToken | null
  created_at: string
  updated_at: string
}

export interface CreateLabelBody {
  name: string
  slug?: string
  kind?: LabelKind
  color?: PaletteToken
}

export async function getDeskLabels(): Promise<DeskLabel[]> {
  const body = await get<{ labels: DeskLabel[] }>('/me/desk/labels')
  // A registry the server could not parse at all comes back as ZERO ROWS, not
  // as the seed — so `[]` is a legitimate 200 and must survive as `[]` rather
  // than being coerced to anything. Only a missing/foreign-shaped key falls
  // back, and that is a wire fault, not a content answer.
  return Array.isArray(body?.labels) ? body.labels : []
}

export async function createLabel(body: CreateLabelBody): Promise<DeskLabel> {
  return post<DeskLabel>('/me/desk/labels', body)
}

/** Display name and/or colour, in place.
 *
 *  Takes NO `kind`. The server accepts an equal echo as a no-op and answers a
 *  changed one with `labels.kind_immutable`, but the manage sheet must never
 *  "PATCH the whole row back" — if this call ever carries `kind`, that is a bug
 *  in the caller, not a feature of the route. */
export async function patchLabel(
  slug: string,
  fields: { name?: string; color?: PaletteToken | null },
): Promise<DeskLabel> {
  return patch<DeskLabel>(`/me/desk/labels/${encodeURIComponent(slug)}`, fields)
}

/** Array position IS the ordering — this verb is the ordering write. Unknown
 *  slugs are ignored and omitted rows are appended in prior order. */
export async function reorderLabels(orderedSlugs: string[]): Promise<DeskLabel[]> {
  const body = await post<{ labels: DeskLabel[] }>('/me/desk/labels/reorder', {
    ordered_slugs: orderedSlugs,
  })
  return Array.isArray(body?.labels) ? body.labels : []
}

export interface DeleteLabelResult {
  status: 'deleted'
  slug: string
  /** How many to-dos it came off. The confirm dialog reads this out from local
   *  counts BEFORE the call and the response confirms it after. */
  detached_from: number
}

export async function deleteLabel(slug: string): Promise<DeleteLabelResult> {
  return del<DeleteLabelResult>(`/me/desk/labels/${encodeURIComponent(slug)}`)
}

export interface MergeLabelResult {
  status: 'merged'
  from: string
  /** LOAD-BEARING: without it this tab cannot tell a merge from a delete and
   *  would have to degrade to clear-and-notice. The sibling `into` on the
   *  DESK_LABEL_SYNC envelope is what every OTHER tab reads for the same
   *  thing. Nobody may trim either. */
  into: string
  moved: number
}

export async function mergeLabel(slug: string, into: string): Promise<MergeLabelResult> {
  return post<MergeLabelResult>(`/me/desk/labels/${encodeURIComponent(slug)}/merge`, {
    into,
  })
}
