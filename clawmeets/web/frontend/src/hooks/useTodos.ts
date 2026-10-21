import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  captureTodo,
  deleteTodo,
  getDeskTodos,
  patchTodo,
  reorderTodos,
  type DeskTodo,
  type DeskTodoAttachmentInput,
} from '../api/endpoints/deskTodos'
import { associateTodoProject } from '../api/endpoints/deskTodoProjects'
import { useAuthStore } from '../stores/authStore'

/**
 * The manager's My Desk plate. Replaces the design mock's localStorage +
 * `window` CustomEvent bus with the real server store: `GET /me/desk/todos`
 * for the list (push-refreshed on `DESK_TODO_SYNC` via `useWebSocket`), plus
 * mutations that write through to the server and optimistically patch the
 * cache so the rail feels instant.
 *
 * Exposes `add` / `archive` / `remove` / `reorder` / `saveDraft`, plus
 * `captureWithDraft`, which creates an item that already carries a draft (the
 * desk message box's "Save to-do"), and `linkProject`, which wires an item to a
 * project or DM thread.
 *
 * NO VERB WRITES `state`, and none can: the field is derived server-side from
 * the projects a to-do spawned and has no key on `PatchTodoPayload`. The one
 * lifecycle write the browser makes is `archive`.
 *
 * There is deliberately no remove-on-dispatch verb. Sending a to-do's draft is
 * not the same as filing the to-do away, so only the checkbox, the trash icon,
 * a draft save and an explicit `rename` ever write to an item — every one of
 * them a thing the user asked for by name.
 */
export function useTodos() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id)
  const key = ['desk-todos'] as const

  const { data: todos = [], isLoading } = useQuery<DeskTodo[]>({
    queryKey: key,
    queryFn: getDeskTodos,
    enabled: !!userId,
    staleTime: 0,
  })

  const setCache = useCallback(
    (updater: (list: DeskTodo[]) => DeskTodo[]) => {
      queryClient.setQueryData<DeskTodo[]>(key, (prev) => updater(prev ?? []))
    },
    [queryClient],
  )
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: key }),
    [queryClient],
  )

  /** The capture. The POST answers with the finished wire row (`as_wire`, so
   *  `state` included), which is spliced into the cache the moment it lands —
   *  the row must not wait on the follow-up `GET`, which re-derives `state`
   *  for the WHOLE plate and is the slow half of the round trip. The
   *  invalidate still runs, to reconcile anything else that moved. */
  const addMutation = useMutation({
    mutationFn: (v: { text: string; labels?: string[] }) =>
      captureTodo(v.text, { labels: v.labels }),
    onMutate: () => queryClient.cancelQueries({ queryKey: key }),
    onSuccess: (created) => {
      // Prepended, matching the server's newest-first order. Guarded because
      // the `DESK_TODO_SYNC` push may already have refetched it in.
      setCache((list) =>
        list.some((x) => x.id === created.id) ? list : [created, ...list],
      )
      invalidate()
    },
  })

  const patchMutation = useMutation({
    mutationFn: (v: {
      id: string
      payload: Parameters<typeof patchTodo>[1]
    }) => patchTodo(v.id, v.payload),
    onSuccess: invalidate,
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteTodo(id),
    onSuccess: invalidate,
  })

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) => reorderTodos(orderedIds),
    onSuccess: invalidate,
  })

  /**
   * Capture a task. `onError` hands the raw throw to the caller, which is the
   * only one holding the words the owner typed — a refused capture must give
   * them back rather than vanish along with the cleared box.
   */
  const add = useCallback(
    (
      text: string,
      opts?: {
        labels?: string[]
        onError?: (err: unknown) => void
      },
    ) => {
      const t = text.trim()
      if (!t) return
      // `mutateAsync`, not `mutate` + per-call callbacks: react-query fires
      // those only for the LATEST call, so the first of two quick captures
      // would lose its refusal.
      addMutation
        .mutateAsync({ text: t, labels: opts?.labels })
        .catch((err) => opts?.onError?.(err))
    },
    [addMutation],
  )

  /**
   * File this item away, or put it back. The round checkbox on the left of a
   * row, and the ONLY lifecycle write the browser makes.
   *
   * IT NEVER TOUCHES `state`, and the optimistic patch is the place that could
   * quietly start: the previous version of this verb mirrored the checkbox into
   * the field the row rendered, which was right while that field was the
   * checkbox's own. It is not any more. `state` is derived from the projects the
   * to-do spawned, so mirroring would FABRICATE a Done chip on a row whose
   * projects are still running — and archiving a Working row would make it
   * flicker Done and back on the refetch.
   *
   * So the patch carries `archived` alone. The server returns a freshly derived
   * `state` on the response to a bare archive toggle, which equals the one
   * already in the cache, so the chip is identical before, during and after the
   * round trip. Nothing to mirror; nothing to flicker.
   */
  const archive = useCallback(
    (id: string) => {
      const cur = (queryClient.getQueryData<DeskTodo[]>(key) ?? []).find(
        (x) => x.id === id,
      )
      const next = !cur?.archived
      setCache((list) =>
        list.map((x) => (x.id === id ? { ...x, archived: next } : x)),
      )
      patchMutation.mutate({ id, payload: { archived: next } })
    },
    [patchMutation, queryClient, setCache],
  )

  /**
   * Wire this item to a project or DM thread — the write behind the composer's
   * **command**, which spawns a DM thread and links the to-do it was working.
   *
   * ASYNC AND THROWING, unlike `archive` and `remove`, and both halves of that
   * are the point:
   *
   *  - The caller needs to know. A link that fails silently leaves the owner
   *    believing the to-do is wired to a thread it will read New beside
   *    forever, and the only way to say so is to let the refusal out.
   *  - There is NOTHING TO PATCH OPTIMISTICALLY. `state` is derived from the
   *    association the server is only now being told about, so the browser
   *    cannot compute what the row becomes — it would be guessing `working`
   *    and would be wrong for a project that is already complete or failed.
   *    The response carries the freshly derived value; `invalidate` publishes
   *    it to every reader of the plate.
   *
   * Idempotent on the server, so a retry of a link that already landed is a
   * 200 no-op rather than an error the caller has to recognise.
   */
  const linkProject = useCallback(
    async (todoId: string, projectId: string): Promise<DeskTodo> => {
      try {
        return await associateTodoProject(todoId, projectId)
      } finally {
        invalidate()
      }
    },
    [invalidate],
  )

  const remove = useCallback(
    (id: string) => {
      setCache((list) => list.filter((x) => x.id !== id))
      removeMutation.mutate(id)
    },
    [removeMutation, setCache],
  )

  /**
   * Create a to-do that already carries a draft — the first press of the
   * message box's "Save to-do".
   *
   * Two round trips on purpose: `POST /me/desk/todos` accepts only a title (+
   * source/due), so the draft, its recipient AND its attachment bytes land
   * through the same PATCH every later save uses. Written against the raw
   * endpoints rather than the mutations above so the two calls stay ordered and
   * the cache is invalidated once, at the end, instead of refetching between
   * them.
   *
   * The bytes riding the second request is what keeps the ATTACHMENT write
   * atomic even though creation is two-phase: there is never a moment where a
   * blob exists that no plate row names. The POST-then-PATCH seam itself
   * predates this and is unchanged.
   *
   * Resolves to the saved record so the caller can bind the box to it — the
   * whole point of asking for a name only once — and read back the ids the
   * server minted for the files.
   */
  const captureWithDraft = useCallback(
    async (
      text: string,
      draftPrompt: string,
      recipient: { id: string; name: string } | null,
      attachments?: DeskTodoAttachmentInput[],
    ): Promise<DeskTodo> => {
      const created = await captureTodo(text.trim())
      try {
        return await patchTodo(created.id, {
          draft_prompt: draftPrompt,
          drafted: true,
          draft_recipient_id: recipient?.id ?? null,
          draft_recipient_name: recipient?.name ?? null,
          ...(attachments === undefined ? {} : { attachments }),
        })
      } finally {
        invalidate()
      }
    },
    [invalidate],
  )

  /**
   * Persist the edited draft, the currently-selected recipient, and — when the
   * caller passes them — the reconciled attachment desired-state, ALL IN ONE
   * PATCH. That single request is what makes the save atomic: no upload-then-
   * save window, so no partial success to explain.
   *
   * A `null` recipient clears the stored value; `undefined` leaves it untouched.
   * `attachments` follows the same three-way rule and it matters more here:
   * UNDEFINED omits the key entirely, so an ordinary text-only save, an
   * archive toggle or a label edit can never nuke a to-do's files. Passing `[]`
   * deletes every one of them, and only a caller that means it should.
   *
   * Async and returning the saved record, unlike the other verbs: attachment
   * ids are minted server-side and cannot be guessed, so the optimistic cache
   * patch deliberately covers text and recipient only and the tray adopts the
   * ids from the response. The throw is the caller's too — a refused save
   * carries a `detail` written for the user, and swallowing it into a
   * fire-and-forget mutation would drop that sentence on the floor.
   */
  const saveDraft = useCallback(
    async (
      id: string,
      draftPrompt: string,
      recipient?: { id: string; name: string } | null,
      attachments?: DeskTodoAttachmentInput[],
    ): Promise<DeskTodo> => {
      const recipientFields =
        recipient === undefined
          ? {}
          : {
              draft_recipient_id: recipient?.id ?? null,
              draft_recipient_name: recipient?.name ?? null,
            }
      setCache((list) =>
        list.map((x) =>
          x.id === id
            ? { ...x, draft_prompt: draftPrompt, drafted: true, ...recipientFields }
            : x,
        ),
      )
      try {
        return await patchTodo(id, {
          draft_prompt: draftPrompt,
          drafted: true,
          ...recipientFields,
          ...(attachments === undefined ? {} : { attachments }),
        })
      } finally {
        invalidate()
      }
    },
    [invalidate, setCache],
  )

  /**
   * Rename this item's title — the inline edit on the plate.
   *
   * Optimistic, and it ROLLS BACK on failure rather than merely re-invalidating,
   * for the same reason `setLabels` does: the new title is on screen the instant
   * the user presses Enter, so a refused write would otherwise leave the plate
   * showing a title the server never stored, with nothing on the row to say so.
   *
   * No-ops on a blank or unchanged title. Blank because a task with no text has
   * no handle left to grab — the row would still be there, unreadable and
   * un-clickable back into edit mode. Unchanged because opening the field and
   * pressing Enter without typing is a cancel, and it must not burn a PATCH or
   * bump `updated_at`.
   */
  const rename = useCallback(
    (id: string, text: string) => {
      const next = text.trim()
      if (!next) return
      const before = (queryClient.getQueryData<DeskTodo[]>(key) ?? []).find((x) => x.id === id)
      if (!before || before.text === next) return
      const previous = before.text
      setCache((list) => list.map((x) => (x.id === id ? { ...x, text: next } : x)))
      patchMutation.mutate(
        { id, payload: { text: next } },
        {
          onError: () => {
            setCache((list) =>
              list.map((x) => (x.id === id ? { ...x, text: previous } : x)),
            )
          },
        },
      )
    },
    [patchMutation, queryClient, setCache],
  )

  /**
   * REPLACE this item's label set. Optimistic like `saveDraft`, and it has to
   * ROLL BACK on failure rather than merely re-invalidating: the browser sends
   * a full replace, so the server's 400 rejects the WHOLE write — every chip
   * added before the rejected one would otherwise stay on screen having never
   * been saved.
   *
   * The cap is guarded at input time on every UI path, but this round trip is
   * the correctness boundary and not a duplicate of it: the cap is reachable by
   * RACE — the assistant or another tab adds labels between this tab's last
   * refetch and its PATCH — and then `labels.cap_exceeded` comes back carrying
   * the would-be RESULT size.
   *
   * `onError` gives the caller the raw throw so it can render
   * `labelErrorMessage`; the rollback happens either way.
   */
  const setLabels = useCallback(
    (id: string, slugs: string[], onError?: (err: unknown) => void) => {
      const before = (queryClient.getQueryData<DeskTodo[]>(key) ?? []).find((x) => x.id === id)
      if (!before) return
      const previous = before.labels ?? []
      setCache((list) => list.map((x) => (x.id === id ? { ...x, labels: slugs } : x)))
      patchMutation.mutate(
        { id, payload: { labels: slugs } },
        {
          onError: (err) => {
            setCache((list) =>
              list.map((x) => (x.id === id ? { ...x, labels: previous } : x)),
            )
            onError?.(err)
          },
        },
      )
    },
    [patchMutation, queryClient, setCache],
  )

  // Reorder against a partial (open-items) ordering: patch the cache to the
  // new order, then persist. The server appends any omitted ids in prior order.
  const reorder = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return
      const list = queryClient.getQueryData<DeskTodo[]>(key) ?? []
      const arr = [...list]
      const from = arr.findIndex((x) => x.id === fromId)
      const to = arr.findIndex((x) => x.id === toId)
      if (from < 0 || to < 0) return
      const [moved] = arr.splice(from, 1)
      arr.splice(to, 0, moved)
      setCache(() => arr)
      reorderMutation.mutate(arr.map((x) => x.id))
    },
    [queryClient, reorderMutation, setCache],
  )

  return {
    todos,
    isLoading,
    add,
    /** A capture is in flight — the rail's "Adding…" line. */
    adding: addMutation.isPending,
    /** The text of the capture in flight, for that line to name. */
    addingText: addMutation.isPending ? addMutation.variables?.text : undefined,
    captureWithDraft,
    archive,
    remove,
    rename,
    saveDraft,
    reorder,
    setLabels,
    linkProject,
  }
}
