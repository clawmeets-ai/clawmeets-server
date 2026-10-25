import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Globe } from 'lucide-react'
import { hubError, type HubChannel, type HubConfig } from '../../../api/endpoints/hub'
import { updateAgent } from '../../../api/endpoints/agents'
import { hubChannelKey, useHubChannel, useHubConfig } from '../../../hooks/useHub'
import { HUB_CARD_COPY, hubChannelView, hubToggleState, type HubCardTone } from '../../../utils/hubChannelView'
import { REMOTE_TEXT_CAP, safeRemoteText } from '../../../utils/hubDisplay'
import { SectionCard } from '../primitives'
import { errorText } from './channelsShared'
import HubTurnOffDialog from './HubTurnOffDialog'
import HubEnrollmentDialog from '../../hub/HubEnrollmentDialog'
import ChannelIsolationLine from './ChannelIsolationLine'
import IsolationRecheckButton from './IsolationRecheckButton'
import HubDispatchSetting from './HubDispatchSetting'

/**
 * The Hub tab's own card: the switch that lists this agent on the ClawMeets
 * Hub, what the hub last said about it, and the turn-off dialog.
 *
 * Every sentence comes from hubChannelView (utils/hubChannelView.ts); this file
 * only draws it. The channel object is replaced whole by the hub_channel_status
 * push (useHubChannel), so the card follows the hub without polling except
 * while it waits to be listed. The hub's own words (status_detail) and the hub
 * URL are shown as text, never as markup or a link.
 */

/** How long "Asking the hub…" may last before the card offers Check again. */
export const ENABLING_PATIENCE_MS = 2 * 60_000

const TONE: Record<HubCardTone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending: 'bg-sky-50 text-sky-700 border-sky-200',
  warn: 'bg-amber-50 text-amber-800 border-amber-200',
  error: 'bg-red-50 text-red-700 border-red-200',
  muted: 'bg-gray-50 text-gray-600 border-gray-200',
}

/** A refused enable says the server's hub state moved before the push or a
 *  config refetch can: show the card for that state at once. Only while the
 *  channel is off — an enabled channel's own status always wins. */
function withEnableError(ch: HubChannel, cfg: HubConfig, error: unknown): [HubChannel, HubConfig] {
  if (ch.enabled) return [ch, cfg]
  switch (hubError(error)?.code) {
    case 'hub_not_registered': return [{ ...ch, status: 'hub_not_registered' }, cfg]
    case 'hub_untrusted': return [{ ...ch, status: 'hub_untrusted' }, cfg]
    case 'hub_off_on_server': return [{ ...ch, status: 'hub_off_on_server' }, cfg]
    case 'agent_not_public': return [{ ...ch, status: 'agent_not_public', eligible: false }, cfg]
    case 'hub_discover_only': return [ch, { ...cfg, mode: 'discover_only' }]
    default: return [ch, cfg]
  }
}

const SHOWN_AS_STATE = new Set([
  'hub_not_registered', 'hub_untrusted', 'hub_off_on_server', 'agent_not_public', 'hub_discover_only',
  'hub_owner_unverified',
])

/** A refused enable the enrollment dialog can fix: the owner's email isn't
 *  confirmed, or (mode auto) the server isn't on the hub yet. */
function needsEnrollment(error: unknown, cfg: HubConfig | undefined): boolean {
  const code = hubError(error)?.code
  return code === 'hub_owner_unverified' || (code === 'hub_not_registered' && cfg?.mode === 'auto')
}

function errorLine(error: unknown): string | null {
  if (!error) return null
  const body = hubError(error)
  if (body && SHOWN_AS_STATE.has(body.code)) return null
  return body ? safeRemoteText(body.message, REMOTE_TEXT_CAP.detail) : errorText(error)
}

export default function HubChannelCard({ agentId, agentFullName }: { agentId: string; agentFullName: string }) {
  const config = useHubConfig()
  const { channel, enable, disable } = useHubChannel(agentFullName)
  const refetchChannel = useCallback(() => { void channel.refetch() }, [channel])
  const queryClient = useQueryClient()
  // Listing needs a public agent: the card makes it public itself, so the Hub
  // tab is the one place an owner publishes an agent.
  const makePublic = useMutation({
    mutationFn: () => updateAgent(agentId, { discoverable_through_registry: true }),
    onSuccess: () => {
      enable.reset()
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: hubChannelKey(agentFullName) })
    },
  })
  // Off but public (shared on this server before the switch was the one
  // sharing control): the card can make it private.
  const makePrivate = useMutation({
    mutationFn: () => updateAgent(agentId, { discoverable_through_registry: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: hubChannelKey(agentFullName) })
    },
  })
  const [dialog, setDialog] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [enablingSince, setEnablingSince] = useState<number | null>(null)
  // One request at a time: isPending only updates on the next render.
  const running = useRef(false)
  const once = async (fn: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true
    try {
      await fn()
    } catch {
      // Shown from the mutation's error.
    } finally {
      running.current = false
    }
  }

  // A refused enable stands in for the server's state only until the server
  // says something newer: a hub_channel_status push or a refetch of the
  // channel or the config after the refusal drops it.
  const errorAt = useRef(0)
  const { error: enableError, reset: resetEnable } = enable
  useEffect(() => {
    if (enableError) errorAt.current = Date.now()
  }, [enableError])
  const heardAt = Math.max(channel.dataUpdatedAt, config.dataUpdatedAt)
  useEffect(() => {
    if (enableError && heardAt > errorAt.current) resetEnable()
  }, [heardAt, enableError, resetEnable])

  const status = channel.data?.status
  useEffect(() => {
    if (status !== 'enabling') {
      setEnablingSince(null)
      return
    }
    setEnablingSince((s) => s ?? Date.now())
    const t = setInterval(() => setNowMs(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [status])

  if (channel.error) {
    return (
      <SectionCard>
        <p role="alert" className="px-6 py-5 text-sm text-red-700">{errorLine(channel.error) ?? errorText(channel.error)}</p>
      </SectionCard>
    )
  }
  if (!channel.data || !config.data) {
    return <SectionCard><p className="px-6 py-5 text-sm text-gray-500">Loading…</p></SectionCard>
  }

  const [ch, cfg] = withEnableError(channel.data, config.data, enable.error)
  const display = ch.listed_as
    ?? (cfg.deployment_name ? `${agentFullName}@${cfg.deployment_name}` : agentFullName)
  const view = hubChannelView(ch, cfg, display, nowMs)
  const toggle = hubToggleState(ch, cfg)
  const busy = enable.isPending || disable.isPending
  const stillWaiting = ch.status === 'enabling' && enablingSince !== null && nowMs - enablingSince >= ENABLING_PATIENCE_MS
  const failure = errorLine(enable.error) ?? errorLine(disable.error) ??
    (makePublic.error ? errorText(makePublic.error) : null) ?? (makePrivate.error ? errorText(makePrivate.error) : null)
  const hubUrl = safeRemoteText(ch.hub_url, REMOTE_TEXT_CAP.detail)

  // An enable refused for want of enrollment opens the dialog; when it is
  // done the same enable runs again, with the same client_request_id (the
  // hook keeps it until a success).
  const tryEnable = async () => {
    try {
      await enable.mutateAsync()
    } catch (e) {
      if (needsEnrollment(e, config.data)) setEnrolling(true)
      throw e
    }
  }
  const onSwitch = () => {
    if (!toggle.clickable || busy) return
    if (toggle.opens === 'dialog') setDialog(true)
    else if (toggle.opens === 'enable') once(tryEnable)
  }
  const turnOffOn = () => once(async () => {
    await disable.mutateAsync(false)
    await tryEnable()
  })
  const enrolled = () => {
    setEnrolling(false)
    once(tryEnable)
  }
  const turnOff = (stopNow: boolean) => once(async () => {
    try {
      await disable.mutateAsync(stopNow)
    } finally {
      setDialog(false)
    }
  })

  return (
    <SectionCard>
      <div className="px-6 py-5 space-y-3" data-testid="hub-channel-card">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Globe className="w-5 h-5 text-purple-500 flex-shrink-0" />
            <h3 className="text-sm font-bold text-gray-900">{view.heading}</h3>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={toggle.on}
            aria-disabled={!toggle.clickable || busy}
            aria-label="List this agent on the ClawMeets Hub"
            onClick={onSwitch}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
              toggle.on ? 'bg-purple-600' : 'bg-gray-300'
            } ${toggle.clickable && !busy ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white shadow transition-transform ${
                toggle.on ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className={`rounded-lg border px-3 py-2 text-sm ${TONE[view.tone]}`} role="status" data-testid="hub-status">
          <p className="font-semibold">{view.title}</p>
          {view.lines.map((line) => <p key={line} className="text-xs mt-1">{line}</p>)}
          {view.quoted && (
            <p className="text-xs mt-1" data-testid="hub-said">
              Hub said: <q className="font-mono">{view.quoted}</q>
            </p>
          )}
          {view.chips.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {view.chips.map((chip) => (
                <span key={chip} className="text-[11px] font-semibold px-2 py-0.5 rounded-full border border-current">{chip}</span>
              ))}
            </div>
          )}
        </div>

        <ChannelIsolationLine isolation={ch.isolation} heldConversations={ch.held_conversations} />
        {ch.isolation !== undefined && ch.isolation !== 'sandboxed' && (
          <IsolationRecheckButton agentId={agentId} onDone={refetchChannel} />
        )}

        {ch.enabled && <HubDispatchSetting channel={ch} agentFullName={agentFullName} />}

        {stillWaiting && (
          <div className="flex items-center gap-3 text-xs text-gray-600">
            <span>{HUB_CARD_COPY.stillWaiting}</span>
            <button type="button" onClick={() => channel.refetch()} className="underline">{HUB_CARD_COPY.checkAgain}</button>
          </div>
        )}

        {view.makePublic && (
          <div>
            <button
              type="button"
              disabled={makePublic.isPending}
              onClick={() => makePublic.mutate()}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50"
            >
              {makePublic.isPending ? HUB_CARD_COPY.makingPublic : HUB_CARD_COPY.makePublic}
            </button>
          </div>
        )}

        {view.makePrivate && (
          <div>
            <button
              type="button"
              disabled={makePrivate.isPending}
              onClick={() => makePrivate.mutate()}
              className="px-3 py-1.5 text-xs font-semibold border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {makePrivate.isPending ? HUB_CARD_COPY.makingPrivate : HUB_CARD_COPY.makePrivate}
            </button>
          </div>
        )}

        {view.action && (
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={view.action === 'reconnect' ? () => once(tryEnable) : turnOffOn}
              className="px-3 py-1.5 text-xs font-semibold border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {view.action === 'reconnect' ? HUB_CARD_COPY.reconnect : HUB_CARD_COPY.turnOffOn}
            </button>
          </div>
        )}

        <p className="text-[11px] text-gray-500" data-testid="hub-url">
          Hub: <span className="font-mono">{hubUrl}</span>
        </p>
        {!ch.hub_url_is_default && (
          <p className="flex items-start gap-1.5 text-xs text-amber-800" data-testid="hub-url-warning">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>{HUB_CARD_COPY.nonDefaultHub}</span>
          </p>
        )}
        {failure && <p role="alert" className="text-xs text-red-700">{failure}</p>}
      </div>

      {dialog && (
        <HubTurnOffDialog
          channel={ch}
          agentName={agentFullName}
          busy={disable.isPending}
          onConfirm={turnOff}
          onCancel={() => setDialog(false)}
        />
      )}
      {enrolling && <HubEnrollmentDialog onDone={enrolled} onClose={() => setEnrolling(false)} />}
    </SectionCard>
  )
}
