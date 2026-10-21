import { get, post, patch, del } from '../client'
import type { AttachedFilePayload } from '../attachments'

/** A real uploaded attachment on a to-do — bytes on the server, addressed by
 *  an opaque server-minted id. */
export interface DeskTodoAttachment {
  id: string
  /** Original filename. DISPLAY ONLY — never a path segment: the blob on disk
   *  is named by `id`, so no client-supplied string reaches the filesystem. */
  name: string
  size: number
  content_type: string
  sha256: string
  created_at: string
}

/** One entry of the desired-state array a save sends. `keep` names a stored
 *  id; the other arm is a new upload, reusing `AttachedFilePayload`'s
 *  `{filename, content_b64}` shape by import — the same convention the atomic
 *  user-message endpoint already takes.
 *
 *  The `name` (stored) vs `filename` (inbound) asymmetry is deliberate: each
 *  half inherits an existing precedent rather than inventing a third name. It
 *  must not be "fixed". */
export type DeskTodoAttachmentInput = { keep: string } | AttachedFilePayload

/** The ticket axis. LOWERCASE SLUGS on the wire precisely so the UI owns the
 *  words — `utils/ticketView.ts:ticketLabel` is the only place "Working" and
 *  "Done" are spelled — `completed` renders as "Done". */
export type TicketState = 'new' | 'working' | 'failed' | 'completed'

/** One item on the manager's My Desk plate — captured by the user or pushed
 *  by an agent via `clawmeets todo publish`. Carries ONLY what the owner can
 *  edit in the UI: name (`text`), labels, draft prompt, recipient and
 *  attachments. An agent's suggested recipient arrives as `draft_recipient_*`.
 *  (The server also keeps `by_agent_id` for delete authz; the UI never reads
 *  it, so it is deliberately untyped here.)
 *
 *  TWO INDEPENDENT AXES, and keeping them independent is the whole feature:
 *  `state` is derived and read-only, `archived` is the owner's and writable,
 *  and neither one moves the other. */
export interface DeskTodo {
  id: string
  owner_user_id: string
  text: string
  /** DERIVED server-side from the projects this to-do spawned, and never
   *  settable by hand. REQUIRED and never null on every to-do-returning
   *  response — list, create, patch, publish and reorder alike, and a bare
   *  archive toggle that changes no association still comes back with a freshly
   *  derived value.
   *
   *  The derivation, stated here so a reader does not have to go to the server
   *  for it: every contributing association COMPLETED -> `completed`; any one
   *  not complete -> `working`; none contributing but at least one that
   *  resolved to a FAILED project -> `failed`; none at all -> `new`. A project
   *  that does not resolve (deleted) and a project whose status is FAILED are
   *  both NON-contributing — a failure never pins the row to `working` — but
   *  only the deleted one is INVISIBLE. A to-do with one failed project and
   *  one still running is `working`; a dangling id still reads `new`. */
  state: TicketState
  /** The owner filed it away. REPLACES `status`, which is gone from the wire.
   *  A real boolean rather than a renamed two-value string, so no third value
   *  can later re-invent lifecycle state on this axis.
   *
   *  Independent of `state` in both directions: archiving never moves the
   *  state and the state never archives anything. Archived + Working is a
   *  legitimate row, and the plate has to render it as one. */
  archived: boolean
  /** `len(project_ids)` — the count of ids STORED, not the count that still
   *  resolves. Present on every row, archived or not.
   *
   *  The stored reading is deliberate: `(association_count: 2, state: "new")`
   *  is how a dangling association becomes legible, where a resolved count
   *  would report 0, agree with `new`, and hide it. It is also why the chip's
   *  tooltip says "3 linked" and never "3 running" — a dangling id is inside
   *  this number and "linked" stays true with it there. */
  association_count: number
  /** The stored ids. ONE ID SPACE: DM threads and regular projects alike.
   *  REQUIRED, never null, never absent, `[]` when empty — on every row of
   *  every response, archived or not. `Field(default_factory=list)` on the
   *  model, the same mechanism as `attachments`, so "never null" is a fact the
   *  compiler enforces rather than a comment every reader has to trust. No
   *  reader coalesces. */
  project_ids: string[]
  created_at: string
  updated_at: string
  draft_prompt?: string | null
  draft_recipient_id?: string | null
  draft_recipient_name?: string | null
  /** Real stored attachments. ALWAYS a list, never `null` — `[]` on every row
   *  written before attachments existed (server-side `default_factory`, so no
   *  migration). Typed REQUIRED, not optional, so "never null" is a fact the
   *  compiler enforces rather than a comment every reader has to trust. */
  attachments: DeskTodoAttachment[]
  drafted?: boolean
  /** Bare normalized label slugs, first-seen order preserved. Nothing reads
   *  the order — but nothing may scramble it either, so it round-trips as
   *  sent. Absent on every plate written before labels existed, which is why
   *  it is optional and why every reader coalesces to `[]`. */
  labels?: string[]
}

export async function getDeskTodos(): Promise<DeskTodo[]> {
  return get<DeskTodo[]>('/me/desk/todos')
}

/** Capture one item. An unregistered slug in `labels` is ACCEPTED, never
 *  rejected — the server auto-registers it as a `context` with no colour and
 *  emits one `DESK_LABEL_SYNC{action:'add'}` per row it creates. */
export async function captureTodo(
  text: string,
  opts?: { labels?: string[] },
): Promise<DeskTodo> {
  return post<DeskTodo>('/me/desk/todos', {
    text,
    ...(opts?.labels?.length ? { labels: opts.labels } : {}),
  })
}

export interface PatchTodoPayload {
  /** File it away, or put it back. The ONLY lifecycle write the browser makes
   *  — `state` is derived and has no payload key at all, here or anywhere. */
  archived?: boolean
  text?: string
  draft_prompt?: string
  draft_recipient_id?: string | null
  draft_recipient_name?: string | null
  drafted?: boolean
  /** Three-way: absent leaves the stored list alone, `null` clears
   *  it, a list REPLACES it.
   *
   *  NOTE what is deliberately ABSENT: `add_labels` / `remove_labels`. The
   *  browser always holds the current list — that is the same fact that earns
   *  it full-replace — so it never needs a delta, and typing one here would
   *  invite a call site that must not exist. The deltas are for the CLI and
   *  for agents, which do not. */
  labels?: string[] | null
  /** Three-way, like `labels`: key ABSENT leaves the stored set untouched, `[]`
   *  removes all, a list reconciles to exactly that set — anything stored whose
   *  id is absent is DELETED.
   *
   *  There is deliberately no `remove` list: absence IS the delete signal, so a
   *  client cannot express "keep and delete" at once and a re-sent upload
   *  REPLACES rather than duplicates. The cost of that shape is that a caller
   *  which forgets a kept id deletes it — which is exactly why absent-means-
   *  untouched exists, and why every emitter goes through
   *  `buildAttachmentDesiredState`. Unlike `labels`, there is no `null` arm. */
  attachments?: DeskTodoAttachmentInput[]
}

export async function patchTodo(
  id: string,
  payload: PatchTodoPayload,
): Promise<DeskTodo> {
  return patch<DeskTodo>(`/me/desk/todos/${id}`, payload)
}

export async function reorderTodos(orderedIds: string[]): Promise<DeskTodo[]> {
  return post<DeskTodo[]>('/me/desk/todos/reorder', { ordered_ids: orderedIds })
}

export async function deleteTodo(id: string): Promise<void> {
  await del(`/me/desk/todos/${id}`)
}
