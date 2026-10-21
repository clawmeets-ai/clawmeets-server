import { get, put } from '../client'

/** Whether this ACCOUNT has closed the My Desk welcome tour. Mirrors
 *  `server/routes/desk_tour.py`; `seen_at` is null until the first close. */
export interface DeskTourState {
  seen_at: string | null
}

export async function getDeskTour(): Promise<DeskTourState> {
  return get<DeskTourState>('/me/desk/tour')
}

/** Idempotent: the server keeps the FIRST stamp, so a replay changes nothing. */
export async function putDeskTourSeen(): Promise<DeskTourState> {
  return put<DeskTourState>('/me/desk/tour')
}
