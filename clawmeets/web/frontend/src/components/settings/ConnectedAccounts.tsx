import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link2, KeyRound, CheckCircle2, AlertTriangle } from 'lucide-react'
import { getAvailableSkills, getAgentSkills } from '../../api/endpoints/skills'
import { ApiError } from '../../api/client'
import {
  selectPendingSkillAuth,
  useSkillAuthStore,
} from '../../stores/skillAuthStore'
import { describeScopes } from '../../utils/oauthScopeCopy'
import { PRIVACY_POLICY_URL, TERMS_URL } from '../../utils/legalUrls'
import { useDisconnectIntegration } from '../../hooks/useDisconnectIntegration'
import PreConsentModal from '../agent/PreConsentModal'
import DisconnectConfirmModal from './DisconnectConfirmModal'

export interface ConnectedAccountsProps {
  agentId: string
}

interface RowMessage {
  type: 'success' | 'info' | 'error'
  text: string
}

/**
 * Connected-accounts panel (gap G2, frontend). Lists this agent's OAuth-
 * connected Google integrations with an explicit Disconnect / Remove-access
 * control — distinct from uninstall (removes the skill) and re-authenticate
 * (mints a fresh grant). Wired to backend's revoke endpoint via
 * `useDisconnectIntegration`.
 *
 * Contract honesty (per backend's plan-disconnect-revoke.html §3): tokens live
 * runner-side and never transit the server, so there is no server-side
 * "is it connected?" read and no Google-side revoke confirmation. Consequences
 * the UI honors:
 *   - Connected state is inferred BEST-EFFORT from the installed-OAuth-skill
 *     list (labelled as such — not a live truth).
 *   - A 200 means the revoke was *initiated* async runner-side; the row renders
 *     optimistically disconnected ("Access removed — reconnect anytime"), never
 *     claiming Google confirmed it.
 *   - When the runner has minted a fresh consent URL (a dead/expired grant), the
 *     row surfaces a "Re-authentication needed" state with a Reconnect action —
 *     the recovery path required when the backend signals a dead grant.
 */
export function ConnectedAccounts({ agentId }: ConnectedAccountsProps): JSX.Element {
  const { data: installed = [] } = useQuery({
    queryKey: ['agent-skills', agentId],
    queryFn: () => getAgentSkills(agentId),
    enabled: !!agentId,
  })
  const { data: catalog = [] } = useQuery({
    queryKey: ['skills'],
    queryFn: () => getAvailableSkills(),
  })

  // Best-effort connected list: installed skills whose registry entry declares
  // an OAuth `auth` block. Presence == "connected (best-effort)".
  const accounts = useMemo(() => {
    const byName = new Map(catalog.map((s) => [s.name, s]))
    return installed
      .map((name) => byName.get(name))
      .filter((s): s is NonNullable<typeof s> => !!s && s.auth != null)
      .map((s) => ({ name: s.name, scopes: s.auth?.scopes ?? [] }))
  }, [installed, catalog])

  const disconnect = useDisconnectIntegration(agentId)
  // Rows the user has optimistically disconnected this session. The skill stays
  // installed, so a best-effort refetch would still list it — this set keeps the
  // row honestly showing "Access removed" until the page reloads.
  const [disconnected, setDisconnected] = useState<Set<string>>(new Set())
  const [messages, setMessages] = useState<Record<string, RowMessage>>((): Record<string, RowMessage> => ({}))
  const [busyName, setBusyName] = useState<string | null>(null)

  const setMessage = (name: string, msg: RowMessage) =>
    setMessages((prev) => ({ ...prev, [name]: msg }))

  const handleDisconnect = async (skillName: string) => {
    setBusyName(skillName)
    try {
      await disconnect.mutateAsync({ skillName })
      // 200 => revoke initiated runner-side (NOT confirmed at Google).
      setDisconnected((prev) => new Set(prev).add(skillName))
      setMessage(skillName, { type: 'success', text: 'Disconnect requested.' })
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      if (status === 404) {
        // Already gone on the runner — treat as disconnected.
        setDisconnected((prev) => new Set(prev).add(skillName))
        setMessage(skillName, { type: 'info', text: 'Already disconnected.' })
      } else if (status === 503) {
        setMessage(skillName, {
          type: 'error',
          text: "That agent's computer is offline; try again when it reconnects.",
        })
      } else if (status === 400) {
        setMessage(skillName, {
          type: 'error',
          text: "This integration doesn't use Google sign-in, so there's nothing to disconnect.",
        })
      } else if (status === 401 || status === 403) {
        setMessage(skillName, { type: 'error', text: "You don't have permission to do that." })
      } else {
        setMessage(skillName, {
          type: 'error',
          text: 'Could not disconnect right now. Please try again.',
        })
      }
    } finally {
      setBusyName(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <Link2 className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-gray-500 leading-relaxed">
          Google integrations this agent has connected. Disconnecting withdraws
          the agent&rsquo;s access and deletes its stored token — the skill stays
          installed but must be reconnected before it can be used again. This
          list is inferred from installed OAuth skills.
        </p>
      </div>

      {accounts.length === 0 ? (
        <p className="text-sm text-gray-400 py-4 text-center">No connected Google accounts.</p>
      ) : (
        <div className="space-y-2">
          {accounts.map((acct) => (
            <ConnectedAccountRow
              key={acct.name}
              agentId={agentId}
              skillName={acct.name}
              scopes={acct.scopes}
              disconnected={disconnected.has(acct.name)}
              busy={busyName === acct.name}
              message={messages[acct.name] ?? null}
              onConfirmDisconnect={() => handleDisconnect(acct.name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ConnectedAccountRow({
  agentId,
  skillName,
  scopes,
  disconnected,
  busy,
  message,
  onConfirmDisconnect,
}: {
  agentId: string
  skillName: string
  scopes: string[]
  disconnected: boolean
  busy: boolean
  message: RowMessage | null
  onConfirmDisconnect: () => Promise<void>
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reconnectOpen, setReconnectOpen] = useState(false)
  // A pending consent URL for this (agent, skill) is the runner's signal that
  // re-authentication is needed (dead/expired/revoked grant → fresh URL minted).
  const pending = useSkillAuthStore(selectPendingSkillAuth(agentId, skillName))
  const clearPending = useSkillAuthStore((s) => s.clear)
  const scopeRows = describeScopes(scopes)

  const needsReauth = !!pending && !disconnected

  const handleConfirm = async () => {
    await onConfirmDisconnect()
    setConfirmOpen(false)
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-bold text-gray-900 truncate">{skillName}</h4>
            {disconnected ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gray-500 bg-gray-50 border border-gray-200 rounded-full px-1.5 py-0.5">
                Access removed
              </span>
            ) : needsReauth ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5">
                <AlertTriangle className="w-2.5 h-2.5" />
                Re-authentication needed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">
                <CheckCircle2 className="w-2.5 h-2.5" />
                Connected
              </span>
            )}
          </div>
          {disconnected ? (
            <p className="text-xs text-gray-500 mt-0.5">Access removed — reconnect anytime.</p>
          ) : needsReauth ? (
            <p className="text-xs text-amber-700 mt-0.5">
              This integration&rsquo;s access has expired or been revoked. Reconnect to keep using it.
            </p>
          ) : scopeRows.length > 0 ? (
            <p className="text-xs text-gray-500 mt-0.5 truncate" title={scopeRows.map((r) => r.title).join(' · ')}>
              {scopeRows.map((r) => r.title).join(' · ')}
            </p>
          ) : null}
        </div>

        {!disconnected &&
          (needsReauth ? (
            <button
              type="button"
              onClick={() => setReconnectOpen(true)}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-blue-200 text-blue-700 bg-white hover:bg-blue-50 hover:border-blue-300 transition-colors"
            >
              <KeyRound className="w-3.5 h-3.5" />
              Reconnect
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="flex-shrink-0 px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-200 text-red-700 bg-white hover:bg-red-50 hover:border-red-300 transition-colors"
            >
              Disconnect
            </button>
          ))}
      </div>

      {message && (
        <p
          className={`text-xs mt-2 ${
            message.type === 'success'
              ? 'text-emerald-700'
              : message.type === 'error'
              ? 'text-red-700'
              : 'text-gray-500'
          }`}
        >
          {message.text}
        </p>
      )}

      <DisconnectConfirmModal
        open={confirmOpen}
        integrationName={skillName}
        busy={busy}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmOpen(false)}
      />

      {reconnectOpen && pending && (
        <PreConsentModal
          open={reconnectOpen}
          integrationName={skillName}
          scopes={scopes}
          authUrl={pending.auth_url}
          privacyPolicyUrl={PRIVACY_POLICY_URL}
          termsUrl={TERMS_URL}
          onContinue={() => {
            window.open(pending.auth_url, '_blank', 'noopener,noreferrer')
            clearPending(agentId, skillName)
            setReconnectOpen(false)
          }}
          onCancel={() => setReconnectOpen(false)}
        />
      )}
    </div>
  )
}

export default ConnectedAccounts
