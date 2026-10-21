import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getDeskTour, putDeskTourSeen, type DeskTourState } from '../api/endpoints/deskTour'

const DESK_TOUR_KEY = ['desk-tour']

/**
 * The My Desk welcome tour's "seen" flag, held per account on the server.
 *
 * `ready` is true only once the GET has SUCCEEDED. A failed read (a server
 * that predates the route, a network blip) leaves it false, and the desk only
 * auto-opens the tour on `ready && !seenAt` — so a read we couldn't make never
 * throws the tour over an established owner's desk.
 *
 * `markSeen` writes the cache first: the desk must not re-open the tour on a
 * refetch that lands before the PUT does.
 */
export function useDeskTour() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: DESK_TOUR_KEY,
    queryFn: getDeskTour,
    staleTime: Infinity,
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: putDeskTourSeen,
    onSuccess: (state) => queryClient.setQueryData<DeskTourState>(DESK_TOUR_KEY, state),
  })

  const markSeen = () => {
    if (query.data?.seen_at) return
    queryClient.setQueryData<DeskTourState>(DESK_TOUR_KEY, { seen_at: new Date().toISOString() })
    mutation.mutate()
  }

  return { ready: query.isSuccess, seenAt: query.data?.seen_at ?? null, markSeen }
}
