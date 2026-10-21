import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { connectLine, setAckText } from '../../../api/endpoints/channels'
import type { ChannelConnection } from '../../../api/endpoints/channels'
import { SectionCard, SectionHeader } from '../primitives'
import { CONNECTIONS_KEY, useAction, when } from './channelsShared'
import type { ChannelKind } from './channelsShared'
import { ChannelSetupGuide } from './channelSetupGuides'

/**
 * The LINE-only parts of Agent Settings → Channels. The connected card itself
 * (status, Test / Disable / Remove, who may reach the agent, the allowlist,
 * the reply to people waiting, Requests) is the shared one in
 * ChannelsSection.tsx, driven by the `LINE` kind below; this file holds what
 * only LINE has: two credentials to connect, the monthly push-message meter,
 * the acknowledgement sent on LINE's reply token, and the setup notes.
 *
 * Neither credential is kept after the connect request. The channel secret is
 * never shown again, not even partly; only the access token's last four are.
 */

/** The server stops counting refused webhook calls here. */
export const UNVERIFIED_CALLS_CAP = 1000

export const LINE_COPY = {
  connectTitle: 'Connect a LINE Official Account',
  connectHelp:
    'From the LINE Developers console, copy the channel secret (Basic settings tab) and a channel access token (Messaging API tab). Both are stored encrypted. Only the access token\'s last four characters are shown again; the channel secret is never shown.',
  tokenHint: "The long-lived token from the Messaging API tab; short-lived / v2.1 tokens aren't supported yet.",
  removeTitle: 'Remove this LINE connection?',
  removeBody:
    'The agent stops answering on LINE. Conversations stay in your threads as history. The allowlist, waiting requests and blocks for this account are deleted. LINE keeps calling the old webhook URL until you turn off "Use webhook" or point it elsewhere in the LINE Developers console.',
  disableTitle: 'Disable this LINE connection?',
  disableBody:
    "Messages sent on LINE while it's disabled are not delivered, even after you enable it again. Replies already queued wait until then.",
  allowlistHelp:
    'People appear in Requests after they message your LINE account; Allow them there.',
  requestsHelp:
    'People not on the allowlist who messaged your LINE account. Nothing they send reaches the agent until you allow them.',
  anyoneExtra: "On LINE, every stranger's answer also uses push-message quota.",
  fixedReplyNote: 'Each new request uses one push message.',
  allFailedSignature:
    'Every call from LINE so far failed the signature check — check that the channel secret is right.',
  someFailedSignature: (n: number) =>
    n >= UNVERIFIED_CALLS_CAP
      ? `${UNVERIFIED_CALLS_CAP.toLocaleString('en-US')}+ calls from LINE since the last good one failed the signature check.`
      : `${n} call${n === 1 ? '' : 's'} from LINE since the last good one failed the signature check.`,
  webhookErrorHttp: (code: number) => `This server answered LINE's test call with HTTP ${code}.`,
  ackTitle: 'Acknowledgement',
  ackHelp:
    "Sent right away on LINE's reply token when a message reaches the agent, so the person knows it arrived. It doesn't use push messages. Leave empty to send none.",
  pushTitle: 'Push messages',
  pushHelp:
    "The agent's answers are sent as LINE push messages, which count against the account's monthly limit. The figures are approximate.",
  pushUnchecked: 'Not checked yet — press Test',
  pushNoLimit: 'No monthly limit set',
  pushBanner: (percent: number) =>
    `${percent}% of this month's push messages are used. When they run out, answers can't be sent until next month or until the plan is raised.`,
  pushReached:
    "Push-message limit reached for this month — the agent's answers on LINE aren't being sent.",
  setupTitle: 'Set up in LINE',
  setupAutoReply:
    "In LINE Official Account Manager, turn OFF auto-reply messages and greeting messages — otherwise the person gets LINE's canned reply as well as the agent's.",
  setupGroups: 'Turn off "Allow bot to join group chats" — group chats aren\'t answered.',
} as const

export const LINE: ChannelKind = {
  channel: 'line',
  removeTitle: LINE_COPY.removeTitle,
  removeBody: LINE_COPY.removeBody,
  disableTitle: LINE_COPY.disableTitle,
  disableBody: LINE_COPY.disableBody,
  allowlistHelp: LINE_COPY.allowlistHelp,
  // No free-text input: a LINE user id is never shown to the person, so the
  // only practical way in is Allow on a request.
  allowlistPlaceholder: null,
  requestsHelp: LINE_COPY.requestsHelp,
  tokenRejected:
    'LINE rejected the channel access token — issue a new long-lived token in the LINE Developers console, then remove this connection and connect again',
  statusLabels: {
    webhook_missing:
      'LINE isn\'t pointed at this server, or "Use webhook" is off — turn on "Use webhook" in the LINE Developers console (Messaging API tab), then press Test',
    webhook_error: "LINE's test call to this server's webhook got an error",
    signature_mismatch:
      "The channel secret doesn't match — LINE's calls fail the signature check. Remove this connection and connect again with the right channel secret",
    quota_exhausted:
      "This month's push-message limit is reached — answers can't be sent until next month or until the plan is raised",
    push_not_allowed: "LINE doesn't allow this channel to send push messages, so answers can't be sent",
  },
  // Reconnect sets LINE's webhook URL to this server again (it can't turn
  // "Use webhook" on — that is the console step the sentence names).
  reconnectCodes: ['webhook_missing', 'key_rotation_pending'],
  anyoneExtra: LINE_COPY.anyoneExtra,
  fixedReplyNote: LINE_COPY.fixedReplyNote,
}

// ── the push-message meter ───────────────────────────────────────────────

/** The banner shows from this share of the monthly limit, inclusive. */
export const PUSH_WARN_PERCENT = 80

export type PushLevel = 'unchecked' | 'no_limit' | 'ok' | 'warn' | 'reached'

export interface PushMeter {
  level: PushLevel
  used: number | null
  limit: number | null
  /** Whole percent, rounded down so 79.9% never reads as the banner's 80%. */
  percent: number | null
  asOf: number | null
}

/**
 * The whole rule. LINE's own monthly-limit answer (`push_limit_reached`, or
 * the `quota_exhausted` status) wins over the figures (they are
 * approximate); otherwise at or past the limit is reached, and at or past
 * PUSH_WARN_PERCENT of it warns. Integer arithmetic, so 160 of 200 is exactly
 * the threshold.
 */
export function pushMeter(
  c: Pick<ChannelConnection, 'push_used' | 'push_limit' | 'push_as_of' | 'status' | 'push_limit_reached'>,
): PushMeter {
  const exhausted = c.push_limit_reached === true || c.status === 'quota_exhausted'
  if (c.push_as_of === null) {
    return { level: exhausted ? 'reached' : 'unchecked', used: null, limit: null, percent: null, asOf: null }
  }
  const used = c.push_used ?? 0
  if (c.push_limit === null) {
    return { level: exhausted ? 'reached' : 'no_limit', used, limit: null, percent: null, asOf: c.push_as_of }
  }
  const limit = c.push_limit
  const percent = limit > 0 ? Math.floor((used * 100) / limit) : 100
  let level: PushLevel = 'ok'
  if (exhausted || used >= limit) level = 'reached'
  else if (used * 100 >= limit * PUSH_WARN_PERCENT) level = 'warn'
  return { level, used, limit, percent, asOf: c.push_as_of }
}

/** Above the connected card: the 80% warning, or the limit-reached notice. */
export function PushBanner({ connection }: { connection: ChannelConnection }) {
  const meter = pushMeter(connection)
  if (meter.level === 'reached') {
    return (
      <div role="alert" data-testid="push-reached" className="flex items-start gap-2 p-3 border rounded-lg text-xs bg-red-50 border-red-200 text-red-700">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span>{LINE_COPY.pushReached}</span>
      </div>
    )
  }
  if (meter.level === 'warn' && meter.percent !== null) {
    return (
      <div role="status" data-testid="push-banner" className="flex items-start gap-2 p-3 border rounded-lg text-xs bg-amber-50 border-amber-200 text-amber-800">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span>{LINE_COPY.pushBanner(meter.percent)}</span>
      </div>
    )
  }
  return null
}

const BAR: Record<PushLevel, string> = {
  unchecked: 'bg-gray-300', no_limit: 'bg-gray-300', ok: 'bg-emerald-500', warn: 'bg-amber-500', reached: 'bg-red-500',
}

export function PushMeterCard({ connection }: { connection: ChannelConnection }) {
  const meter = pushMeter(connection)
  const asOf = meter.asOf !== null ? ` (as of ${when(meter.asOf)})` : ''
  let line: string
  if (meter.used === null) line = LINE_COPY.pushUnchecked
  else if (meter.limit === null) line = `${meter.used} push messages used this month${asOf}`
  else line = `${meter.used} of ${meter.limit} push messages used this month${asOf}`
  return (
    <SectionCard>
      <SectionHeader title={LINE_COPY.pushTitle} subtitle={LINE_COPY.pushHelp} />
      <div className="px-6 py-5 space-y-2" data-testid="push-meter">
        <p className="text-sm text-gray-800" data-testid="push-line">{line}</p>
        {meter.used !== null && meter.limit === null && (
          <p className="text-xs text-gray-500">{LINE_COPY.pushNoLimit}</p>
        )}
        {meter.percent !== null && (
          <div className="flex items-center gap-3">
            <div
              role="meter"
              aria-label="Push messages used this month"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(meter.percent, 100)}
              className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden"
            >
              <div className={`h-full ${BAR[meter.level]}`} style={{ width: `${Math.min(meter.percent, 100)}%` }} />
            </div>
            <span className="text-xs font-semibold text-gray-700 tabular-nums">{meter.percent}%</span>
          </div>
        )}
        {meter.level === 'reached' && meter.used === null && (
          <p className="text-xs text-red-700">{LINE_COPY.pushReached}</p>
        )}
      </div>
    </SectionCard>
  )
}

// ── health notes only LINE has ───────────────────────────────────────────

export function LineHealthNotes({ connection }: { connection: ChannelConnection }) {
  return (
    <>
      {connection.status === 'webhook_error' && connection.status_count !== null && (
        <p className="text-xs text-gray-600" data-testid="line-webhook-error">
          {LINE_COPY.webhookErrorHttp(connection.status_count)}
        </p>
      )}
      {connection.unverified_calls > 0 && (
        <p role="note" data-testid="line-unverified" className="text-xs text-red-700">
          {connection.last_inbound_at === null
            ? LINE_COPY.allFailedSignature
            : LINE_COPY.someFailedSignature(connection.unverified_calls)}
        </p>
      )}
    </>
  )
}

// ── connect ──────────────────────────────────────────────────────────────

export function LineConnectForm({ agentName }: { agentName: string }) {
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState('')
  const [token, setToken] = useState('')
  const action = useAction()
  const secretId = useId()
  const tokenId = useId()
  const hintId = useId()
  const ready = !!secret.trim() && !!token.trim()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const typedSecret = secret.trim()
    const typedToken = token.trim()
    if (!typedSecret || !typedToken) return
    // Cleared before the request: both values live only in this call.
    setSecret('')
    setToken('')
    const ok = await action.run('connect', () => connectLine(agentName, typedSecret, typedToken))
    if (ok) await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })
  }

  const field = 'px-3 py-2 text-sm border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-purple-500'
  return (
    <SectionCard>
      <SectionHeader title={LINE_COPY.connectTitle} subtitle={LINE_COPY.connectHelp} />
      <form onSubmit={submit} className="px-6 py-5 flex flex-col gap-3">
        <label htmlFor={secretId} className="text-xs font-semibold text-gray-700">Channel secret</label>
        <input
          id={secretId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          className={field}
        />
        <label htmlFor={tokenId} className="text-xs font-semibold text-gray-700">Channel access token</label>
        <input
          id={tokenId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={hintId}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className={field}
        />
        <p id={hintId} className="text-[11px] text-gray-500">{LINE_COPY.tokenHint}</p>
        <div>
          <button
            type="submit"
            disabled={!!action.busy || !ready}
            className="px-4 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep disabled:opacity-50"
          >
            {action.busy ? 'Connecting…' : 'Connect LINE'}
          </button>
        </div>
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </form>
      <ChannelSetupGuide channel="line" />
    </SectionCard>
  )
}

// ── acknowledgement ──────────────────────────────────────────────────────

export function AckTextCard({ connection, onSaved }: { connection: ChannelConnection; onSaved: () => void }) {
  const saved = connection.ack_text ?? ''
  const [text, setText] = useState(saved)
  const action = useAction()
  const inputId = useId()
  useEffect(() => setText(saved), [saved])
  const save = async () => {
    if (await action.run('save', () => setAckText(connection.id, text))) onSaved()
  }
  return (
    <SectionCard>
      <SectionHeader title={LINE_COPY.ackTitle} subtitle={LINE_COPY.ackHelp} />
      <div className="px-6 py-5 space-y-2">
        <label htmlFor={inputId} className="sr-only">{LINE_COPY.ackTitle}</label>
        <textarea
          id={inputId}
          value={text}
          maxLength={1000}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        <button
          type="button"
          onClick={save}
          disabled={!!action.busy || text === saved}
          className="px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          Save acknowledgement
        </button>
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </div>
    </SectionCard>
  )
}

// ── setup notes ──────────────────────────────────────────────────────────

export function LineSetupNotes() {
  return (
    <SectionCard>
      <SectionHeader title={LINE_COPY.setupTitle} />
      <ul className="px-6 py-5 space-y-2 list-disc list-inside text-xs text-gray-700" data-testid="line-setup-notes">
        <li>{LINE_COPY.setupAutoReply}</li>
        <li>{LINE_COPY.setupGroups}</li>
      </ul>
    </SectionCard>
  )
}
