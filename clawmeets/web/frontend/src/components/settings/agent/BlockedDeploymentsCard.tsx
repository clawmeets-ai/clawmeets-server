import { useBlockedDeployments } from '../../../hooks/useHub'
import { formatHubDate, REMOTE_TEXT_CAP, safeRemoteText, shortFingerprint } from '../../../utils/hubDisplay'
import UnusualNameChip from '../../hub/UnusualNameChip'
import { SectionCard, SectionHeader } from '../primitives'
import { errorText } from './channelsShared'

/**
 * Blocked servers: every server this agent's owner blocked with "Block
 * everyone from X" on a Hub request. One row per server, keyed by its genesis
 * fingerprint, so a block survives the server rotating its key. The server's
 * current key shows as a grey label only when it differs, and is never a key.
 */
export default function BlockedDeploymentsCard({ agentFullName }: { agentFullName: string }) {
  const { blocked, unblock } = useBlockedDeployments(agentFullName)
  const rows = blocked.data ?? []
  const error = blocked.error ?? unblock.error

  return (
    <SectionCard>
      <SectionHeader
        title="Blocked servers"
        subtitle="Nobody on these servers can message this agent over the hub."
      />
      <div className="px-6 py-5 space-y-3">
        {error && <p role="alert" className="text-xs text-red-700">{errorText(error)}</p>}
        {blocked.isSuccess && rows.length === 0 && <p className="text-xs text-gray-500">No servers blocked.</p>}
        <ul className="space-y-1">
          {rows.map((row) => {
            const name = safeRemoteText(row.deployment_name, REMOTE_TEXT_CAP.name)
            const rotated = row.current_fingerprint !== undefined && row.current_fingerprint !== row.deployment_fingerprint
            return (
              <li key={row.deployment_fingerprint} data-testid="blocked-deployment" className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 flex flex-wrap items-center gap-x-2">
                  <span className="font-semibold text-gray-900 truncate">{name}</span>
                  <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                    fp {shortFingerprint(row.deployment_fingerprint)}
                  </span>
                  <UnusualNameChip name={row.deployment_name} />
                  {rotated && (
                    <span className="font-mono text-[11px] text-gray-400">
                      current key {shortFingerprint(row.current_fingerprint!)}
                    </span>
                  )}
                  <span className="text-[11px] text-gray-500">· since {formatHubDate(row.created_at)}</span>
                </span>
                <button
                  type="button"
                  aria-label={`Unblock ${name}`}
                  disabled={unblock.isPending}
                  onClick={() => unblock.mutate(row.deployment_fingerprint)}
                  className="text-xs text-red-700 hover:underline disabled:opacity-50 flex-shrink-0"
                >
                  Unblock
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </SectionCard>
  )
}
