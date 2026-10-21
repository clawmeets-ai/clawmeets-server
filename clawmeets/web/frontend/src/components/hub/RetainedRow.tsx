import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RetainedAgent } from '../../api/endpoints/hub'
import { useRetainAgent } from '../../hooks/useAgentAccess'
import { RETAIN_COPY } from '../../utils/agentAccessCopy'
import { formatHubDate, hubThreadPath, REMOTE_TEXT_CAP, safeRemoteText, shortFingerprint } from '../../utils/hubDisplay'
import RetainDialog, { retainErrorText } from './RetainDialog'
import { UnretainAction } from './RetainButton'

const SHOWN_CAPABILITIES = 4

/**
 * One retained agent, as it was at retain time: name@server, fingerprint,
 * description, capabilities, "Retained {date}", then by state:
 *   active           "In N rooms" (nothing at 0)
 *   unlisted         "Unlisted", or "Listed again — retain?" when the
 *                    directory shows it listed and not retained
 *   identity_changed "Identity changed" + "Retain again"
 *   anything else    a neutral chip
 * An agent of this server (is_local) shows "On this server" instead of a
 * fingerprint and "No longer shared" once its owner stops sharing it.
 * Message, on an active row, opens the ordinary DM for an agent of this
 * server and a hub thread for one of another server.
 * Every string is remote text, drawn as text.
 */
export default function RetainedRow({ agent, listedAgain }: { agent: RetainedAgent; listedAgain: boolean }) {
  const retain = useRetainAgent()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState(false)
  const local = agent.is_local === true
  const name = safeRemoteText(agent.name, REMOTE_TEXT_CAP.name)
  const server = safeRemoteText(agent.deployment_name, REMOTE_TEXT_CAP.name)
  const label = local ? name : `${name}@${server}`
  const description = safeRemoteText(agent.description, REMOTE_TEXT_CAP.description, true)
  const caps = agent.capabilities.map((c) => safeRemoteText(c, REMOTE_TEXT_CAP.capability)).filter(Boolean)
  const openDialog = () => { retain.reset(); setDialog(true) }

  const chip = (text: string, tone: string, testId: string) => (
    <span className={`px-1.5 rounded text-[11px] ${tone}`} data-testid={testId}>{text}</span>
  )
  let state: ReactNode
  switch (agent.state) {
    case 'active':
      state = agent.live_rooms > 0 ? chip(RETAIN_COPY.inRooms(agent.live_rooms), 'bg-emerald-50 text-emerald-700', 'retained-live') : null
      break
    case 'unlisted':
      state = local ? chip(RETAIN_COPY.noLongerShared, 'bg-gray-100 text-gray-600', 'retained-unlisted') : listedAgain ? (
        <button
          type="button"
          onClick={openDialog}
          className="px-1.5 rounded text-[11px] bg-indigo-50 text-indigo-700 hover:underline"
          data-testid="retained-listed-again"
        >
          {RETAIN_COPY.listedAgain}
        </button>
      ) : chip(RETAIN_COPY.unlisted, 'bg-gray-100 text-gray-600', 'retained-unlisted')
      break
    case 'identity_changed':
      state = (
        <>
          {chip(RETAIN_COPY.identityChangedChip, 'bg-amber-50 text-amber-800', 'retained-identity')}
          <button
            type="button"
            onClick={openDialog}
            className="px-1.5 rounded border border-gray-200 text-[11px] font-semibold text-gray-700 hover:bg-gray-50"
            data-testid="retained-retain-again"
          >
            {RETAIN_COPY.retainAgain}
          </button>
        </>
      )
      break
    default:
      state = chip(RETAIN_COPY.unknownState, 'bg-gray-100 text-gray-600', 'retained-unknown')
  }

  return (
    <li className="rounded-lg border border-gray-200 bg-white p-3" data-testid="retained-row">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="font-medium text-gray-900 truncate">
          {local ? <bdi>{name}</bdi> : <><bdi>{name}</bdi><span className="text-gray-400">@</span><bdi>{server}</bdi></>}
        </span>
        {local ? (
          <span className="text-[10.5px] px-1 rounded bg-gray-100 text-gray-600" data-testid="retained-local">
            {RETAIN_COPY.onThisServer}
          </span>
        ) : (
          <span className="font-mono text-[10.5px] px-1 rounded bg-gray-100 text-gray-600">
            {shortFingerprint(agent.deployment_fingerprint)}
          </span>
        )}
        {state}
        <span className="ml-auto text-[11px] text-gray-400">{RETAIN_COPY.retainedOn(formatHubDate(agent.retained_at))}</span>
      </div>
      {description && <p className="mt-1 text-sm text-gray-500 line-clamp-2 whitespace-pre-line">{description}</p>}
      {caps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {caps.slice(0, SHOWN_CAPABILITIES).map((cap, i) => (
            <span key={`${i}:${cap}`} className="px-2 py-0.5 bg-gray-50 border border-gray-200 text-gray-600 text-xs rounded">
              {cap}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex justify-end gap-3">
        {agent.state === 'active' && (
          <button
            type="button"
            onClick={() => navigate(local ? `/dm/${encodeURIComponent(agent.name)}` : hubThreadPath(agent.hub_agent_id))}
            className="text-xs font-semibold text-indigo-700 hover:underline"
            data-testid="retained-message"
          >
            {RETAIN_COPY.message}
          </button>
        )}
        <UnretainAction agent={{ ...agent, retained: true }} variant="button" />
      </div>
      <RetainDialog
        agentLabel={label}
        open={dialog}
        busy={retain.isPending}
        identityChanged={agent.state === 'identity_changed'}
        error={retain.isError ? retainErrorText(retain.error) : null}
        onCancel={() => setDialog(false)}
        onConfirm={() => retain.mutate(agent.hub_agent_id, { onSuccess: () => setDialog(false) })}
      />
    </li>
  )
}
