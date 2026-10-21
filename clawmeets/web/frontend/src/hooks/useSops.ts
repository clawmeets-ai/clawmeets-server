import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createSop,
  deleteSop,
  getDeskSops,
  patchSop,
  type DeskSop,
  type SopDraft,
} from '../api/endpoints/deskSops'
import { useAuthStore } from '../stores/authStore'

/**
 * The user's SOP library — stored, reusable prompts with typed `{{blanks}}`.
 *
 * `GET /me/desk/sops` for the list, push-refreshed on `DESK_SOP_SYNC` via
 * `useWebSocket`. Because the server fans that envelope out to *every* live
 * session the user holds, a library edited in one browser tab updates in all
 * the others without a reload.
 *
 * Mutations write through and optimistically patch the cache so the rail feels
 * instant; the subsequent invalidate reconciles against the server.
 */
export function useSops() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id)
  const key = ['desk-sops'] as const

  const { data: sops = [], isLoading } = useQuery<DeskSop[]>({
    queryKey: key,
    queryFn: getDeskSops,
    enabled: !!userId,
    staleTime: 0,
  })

  const setCache = useCallback(
    (updater: (list: DeskSop[]) => DeskSop[]) => {
      queryClient.setQueryData<DeskSop[]>(key, (prev) => updater(prev ?? []))
    },
    [queryClient],
  )
  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: key }),
    [queryClient],
  )

  const createMutation = useMutation({
    mutationFn: (d: Omit<SopDraft, 'id'>) => createSop(d),
    onSuccess: invalidate,
  })

  const patchMutation = useMutation({
    mutationFn: (v: { id: string; fields: Partial<Omit<SopDraft, 'id'>> }) =>
      patchSop(v.id, v.fields),
    onSuccess: invalidate,
  })

  const removeMutation = useMutation({
    mutationFn: (id: string) => deleteSop(id),
    // Even on failure, resync — the row may have been deleted from another
    // session, which is exactly the state the list should end up in.
    onSettled: invalidate,
  })

  /**
   * Create-or-update. The authoring dialog is the only writer, so one verb
   * covers both: an `id` means edit in place, its absence means create.
   * Always sends both agent fields, so "unassigned" round-trips as an explicit
   * null rather than silently keeping a stale recipient.
   */
  const save = useCallback(
    (draft: SopDraft) => {
      const { id, ...fields } = draft
      const clean = {
        ...fields,
        title: fields.title.trim(),
        body: fields.body.trim(),
      }
      if (!clean.title || !clean.body) return
      if (id) {
        setCache((list) => list.map((s) => (s.id === id ? { ...s, ...clean } : s)))
        patchMutation.mutate({ id, fields: clean })
      } else {
        createMutation.mutate(clean)
      }
    },
    [createMutation, patchMutation, setCache],
  )

  const remove = useCallback(
    (id: string) => {
      setCache((list) => list.filter((s) => s.id !== id))
      removeMutation.mutate(id)
    },
    [removeMutation, setCache],
  )

  return { sops, isLoading, save, remove }
}
