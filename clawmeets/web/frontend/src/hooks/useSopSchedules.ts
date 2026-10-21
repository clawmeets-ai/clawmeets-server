import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getScheduledMessages } from '../api/endpoints/scheduledMessages'
import { matchSopSchedules } from '../utils/sopSchedule'
import type { ScheduledMessage } from '../api/endpoints/scheduledMessages'

/**
 * SOP id → the recurring message that fires it.
 *
 * A SOP's cadence is not stored on the SOP. The schedule is an ordinary
 * recurring message the assistant addresses to itself, and the
 * `<!-- clawmeets:sop-run:<id> -->` marker in its body IS the link — so the
 * cadence is recovered by scanning, not by a join. That's what keeps
 * scheduling free of a schema change (same trick `briefSchedule` uses).
 *
 * Shares the `['scheduled-messages']` query key with the /scheduled page, so
 * cancelling a schedule there clears the chip here without extra plumbing.
 */
export function useSopSchedules(): Map<string, ScheduledMessage> {
  const { data } = useQuery({
    queryKey: ['scheduled-messages'],
    queryFn: () => getScheduledMessages(true),
  })
  return useMemo(() => matchSopSchedules(data), [data])
}
