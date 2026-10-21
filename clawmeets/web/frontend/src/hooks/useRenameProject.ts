import { useMutation, useQueryClient, type QueryClient, type UseMutationResult } from '@tanstack/react-query'
import { renameProject } from '../api/endpoints'
import { ApiError } from '../api/client'
import type { Project } from '../types'

/**
 * The rename mutation for a thread's `display_name` — the whole of the
 * client-side rename behaviour except the input widget itself.
 *
 * It lives in a hook rather than inside `InlineEditableTitle` on purpose. Two
 * different things are going on when a title is renamed, and they belong to
 * different owners: "how does an inline title behave when you type in it" is a
 * widget concern, and "which caches hold this name, in what shape, and how do
 * they roll back" is knowledge about THIS resource. Putting the second in the
 * component would mean the DM header and the project header each carried a copy
 * of the cache map, and any future rename surface would carry a third.
 *
 * WHY PATCH THE CACHES RATHER THAN JUST INVALIDATE. Every surface that renders
 * a thread name — the sidebar rows, the DM rail, the Projects panel, the Front
 * Desk panel, the Cmd-K palette, the scheduled-message labels — derives from
 * exactly the three query keys below. Patching them is what makes all of those
 * flip in the same frame as the header, with zero code changes on their side.
 * Invalidation alone would leave them stale until each refetch landed.
 *
 * WHY ALSO INVALIDATE, IN `onSettled`. The server rewrites what we send
 * (NFC + invisible strip + whitespace collapse + trim), and the *normalized*
 * value is what it stores: "Trip   plan" comes back "Trip plan". The optimistic
 * patch necessarily holds our local input, so without the invalidate the header
 * and the sidebar would sit on the un-normalized string until something else
 * refetched them. The invalidate is what lets the server's value win.
 */

export interface RenameVars {
  projectId: string
  displayName: string
}

/**
 * A rename failure, already translated into something worth showing a user.
 *
 * The translation happens here rather than in the component because it is
 * knowledge about this route's error contract, not about text inputs. `status`
 * is kept so a caller can still branch on it.
 */
export class RenameError extends Error {
  constructor(
    message: string,
    public status?: number,
    public original?: unknown
  ) {
    super(message)
    this.name = 'RenameError'
  }
}

/**
 * Map a rejection from `renameProject` onto user-facing copy.
 *
 * 400 and 403 surface the server's `detail` sentence verbatim — it is written
 * to be read next to the input ("Thread name must be 60 characters or fewer.",
 * "You do not have permission to rename this thread."), and paraphrasing it
 * here would be a second place to keep in sync.
 *
 * Note what is NOT handled: 401. `api/client.ts:fetchWithAuth` owns 401 — it
 * refreshes, replays once, and logs the user out on a second one. That is
 * precisely why the server returns 403 and never 401 for "not allowed", and
 * why a 403 must not be re-routed into any session-expiry path here.
 */
export function renameErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 403) {
      return error.message || 'That name was rejected.'
    }
    if (error.status === 404) {
      return 'This conversation no longer exists.'
    }
  }
  return "Couldn't save. Try again."
}

/** The three keys every thread-name-rendering surface derives from. */
const RENAME_CACHE_KEYS = [
  (projectId: string) => ['project', projectId] as const,
  () => ['user-projects'] as const,
  () => ['all-projects'] as const,
]

/**
 * Rewrite one cached entry with a new display name.
 *
 * Handles both shapes the keys hold — `['project', id]` is a single `Project`,
 * the two list keys are `Project[]` — and leaves every other field, and every
 * other project, untouched. Returns the entry unchanged when it holds no
 * matching project, so React Query does not churn unrelated subscribers.
 */
function withDisplayName(entry: unknown, projectId: string, displayName: string): unknown {
  if (Array.isArray(entry)) {
    let changed = false
    const next = (entry as Project[]).map((p) => {
      if (p?.id !== projectId) return p
      changed = true
      return { ...p, display_name: displayName }
    })
    return changed ? next : entry
  }
  const project = entry as Project | undefined
  if (project && project.id === projectId) {
    return { ...project, display_name: displayName }
  }
  return entry
}

/**
 * Apply `displayName` across all three keys. Partial key matching does the work
 * that would otherwise need the principal id: `['user-projects']` matches the
 * real `['user-projects', userId]` entry without this hook having to know whose
 * plate is cached.
 */
function applyDisplayName(
  queryClient: QueryClient,
  projectId: string,
  displayName: string
): void {
  for (const key of RENAME_CACHE_KEYS) {
    queryClient.setQueriesData({ queryKey: key(projectId) }, (entry: unknown) =>
      withDisplayName(entry, projectId, displayName)
    )
  }
}

export function useRenameProject(): UseMutationResult<Project, RenameError, RenameVars> {
  const queryClient = useQueryClient()

  return useMutation<Project, RenameError, RenameVars, Array<[readonly unknown[], unknown]>>({
    mutationFn: async ({ projectId, displayName }) => {
      try {
        return await renameProject(projectId, displayName)
      } catch (error) {
        throw new RenameError(
          renameErrorMessage(error),
          error instanceof ApiError ? error.status : undefined,
          error
        )
      }
    },

    // Snapshot, then patch. `cancelQueries` first because a GET that is already
    // in flight would otherwise resolve *after* the patch and overwrite the new
    // name with the stale one — the one race the optimistic update cannot
    // survive on its own.
    onMutate: async ({ projectId, displayName }) => {
      const snapshots: Array<[readonly unknown[], unknown]> = []
      for (const key of RENAME_CACHE_KEYS) {
        const queryKey = key(projectId)
        await queryClient.cancelQueries({ queryKey })
        snapshots.push(...queryClient.getQueriesData({ queryKey }))
      }
      applyDisplayName(queryClient, projectId, displayName)
      return snapshots
    },

    // The server's value, not ours. Writing it here means the normalized name
    // ("Trip plan" for our "Trip   plan") is on screen the moment the 200 lands,
    // rather than one refetch later.
    onSuccess: (project, { projectId }) => {
      if (project?.display_name != null) {
        applyDisplayName(queryClient, projectId, project.display_name)
      }
    },

    // Restore every snapshot verbatim. The headers read their value out of
    // these caches, so the old name reappears on its own — no component holds a
    // second copy of the truth to also put back.
    onError: (_error, _vars, snapshots) => {
      for (const [queryKey, data] of snapshots ?? []) {
        queryClient.setQueryData(queryKey, data)
      }
    },

    // Runs on both paths. After a success it reconciles our optimistic string
    // with the stored one; after a rollback it repairs any drift. Note this
    // fires alongside the CHANGELOG_UPDATE the server broadcasts back to THIS
    // tab (we are not excluded from the fan-out) — both converge on the same
    // refetch, and neither can regress the value, because the write has already
    // committed by the time either one is issued.
    onSettled: (_data, _error, { projectId }) => {
      for (const key of RENAME_CACHE_KEYS) {
        queryClient.invalidateQueries({ queryKey: key(projectId) })
      }
    },
  })
}
