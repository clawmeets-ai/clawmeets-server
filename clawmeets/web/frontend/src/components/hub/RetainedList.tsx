import { useHubConfig } from '../../hooks/useHub'
import { useRetainedAgents } from '../../hooks/useAgentAccess'
import { RETAIN_COPY } from '../../utils/agentAccessCopy'
import RetainedRow from './RetainedRow'

/**
 * The user's own retained agents (GET /api/hub/retained), shown by the
 * directory's "Retained" filter instead of search results: a search shows only
 * what matched, this list is the whole set. `listedNow` holds the ids the
 * loaded directory shows as listed and not retained, which turns an
 * "Unlisted" row into "Listed again — retain?".
 */
export default function RetainedList({ listedNow }: { listedNow: ReadonlySet<string> }) {
  const { data: config } = useHubConfig()
  const { data: rows, isLoading, isError } = useRetainedAgents()
  const note = (text: string, testId: string) => (
    <p className="text-sm text-gray-500" data-testid={testId}>{text}</p>
  )

  if (isLoading) return note('Loading…', 'retained-loading')
  if (isError) return note(RETAIN_COPY.failedList, 'retained-failed')
  if (!rows || rows.length === 0) {
    return config?.mode === 'off' ? note(RETAIN_COPY.hubOff, 'retained-hub-off') : note(RETAIN_COPY.noneRetained, 'retained-empty')
  }
  return (
    <ul className="space-y-2" data-testid="retained-list">
      {rows.map((a) => (
        <RetainedRow key={a.hub_agent_id} agent={a} listedAgain={listedNow.has(a.hub_agent_id)} />
      ))}
    </ul>
  )
}
