import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Copy, Mail, MessageCircle, Send } from 'lucide-react'
import { ApiError } from '../../../api/client'
import {
  WARNING_ANYONE,
  addAllowlistEntry,
  allowRequest,
  blockRequest,
  connectEmail,
  connectTelegram,
  deleteAllowlistEntry,
  disableConnection,
  enableConnection,
  listAllowlist,
  listConnections,
  reconnectConnection,
  removeConnection,
  setConnectionMode,
  setFixedReply,
  testConnection,
} from '../../../api/endpoints/channels'
import type { ChannelConnection, ChannelRequest } from '../../../api/endpoints/channels'
import { SectionCard, SectionHeader } from '../primitives'
import { SectionTitle } from './fields'
import { CONNECTIONS_KEY, errorText, requestsKey, useAction, useChannelRequests, waitingRequests, when } from './channelsShared'
import { ChannelSetupGuide } from './channelSetupGuides'
import type { ChannelKind } from './channelsShared'
import {
  AckTextCard, LINE, LineConnectForm, LineHealthNotes, LineSetupNotes, PushBanner, PushMeterCard,
} from './LineChannelCard'
import {
  WHATSAPP, WhatsAppConnectForm, WhatsAppHealthNotes, WhatsAppIdentity, WhatsAppSetupNotes, WHATSAPP_COPY,
} from './WhatsAppChannelCard'
import WebChatChannelCard from './WebChatChannelCard'
import HubChannelCard from './HubChannelCard'
import HubSendUsageCard from './HubSendUsageCard'
import HubInvitableAgentsCard from './HubInvitableAgentsCard'
import ChannelIsolationLine from './ChannelIsolationLine'
import BlockedDeploymentsCard from './BlockedDeploymentsCard'
import { useBlockedDeployments, useHubConfig } from '../../../hooks/useHub'
import HubContactLabel from '../../hub/HubContactLabel'
import { hubContactParts } from '../../../utils/hubDisplay'

export type { ChannelKind } from './channelsShared'

/**
 * Agent Settings → Channels: connect the agent to a Telegram bot, give it
 * an email address, connect a LINE Official Account and a WhatsApp Business
 * number (their own parts live in LineChannelCard.tsx and
 * WhatsAppChannelCard.tsx), turn on the web chat widget (WebChatChannelCard.tsx:
 * keys, allowed sites, snippets, the chat page), see whether each works, choose who may reach it,
 * and answer the people waiting.
 *
 * Everything shown comes from the API on every load — the token is typed once,
 * sent once and then dropped (never kept in state, storage or a URL); email
 * asks for no credential at all (the server's own SendGrid account sends and
 * receives, and its keys are never shown); the "anyone" warning is driven by
 * the connection's `warning` flag, not by what was clicked; and text that came
 * from outside (a stranger's first message, their name, a subject, an
 * attachment name, Telegram's error text) is rendered as plain text, never
 * markup.
 *
 * One channel is shown at a time behind a row of tabs (`?channel=<id>`, next
 * to the page's own `?section=channels`); with no `channel` in the URL it
 * opens on the first connected channel, else Telegram.
 *
 * The Hub tab (HubChannelCard.tsx) is shown when the server's hub mode is not
 * off, or while this agent still has a Hub row to turn off. Its row reuses the
 * Mode, Allowlist, fixed-reply and Requests cards below and never shows Test,
 * Reconnect, Enable/Disable or Remove (the server answers use_hub_routes). The
 * other tabs read config.channels_enabled: on a hub-only server the connection
 * list answers 200 with Hub rows only, so a 404 no longer means "off".
 */

export const COPY = {
  off: 'Channels are turned off on this server.',
  connectTitle: 'Connect a Telegram bot',
  connectHelp:
    'Create a bot with @BotFather in Telegram, then paste its token here. The token is stored encrypted; only its last four characters are shown again.',
  anyoneTitle: 'Let anyone reach this agent?',
  anyoneBody:
    'Strangers will reach an agent with its full tools — everything it can read, run and send. Rate limits apply: a sender who writes too often is dropped for a while.',
  anyoneBanner:
    'Anyone can message this agent. Strangers reach it with its full tools; rate limits apply.',
  removeTitle: 'Remove this Telegram connection?',
  removeBody:
    'The bot stops answering. Conversations stay in your threads as history. The allowlist, waiting requests and blocks for this bot are deleted.',
  disableTitle: 'Disable this Telegram connection?',
  disableBody:
    "The bot stops receiving messages. Anything people send to it while it's disabled is not delivered, even after you enable it again. Replies already queued wait until then.",
  emailConnectTitle: 'Give this agent an email address',
  emailConnectHelp:
    'People can then email the agent. Its replies come from the same address and arrive in the sender\'s conversation. No password or key is needed.',
  emailRemoveTitle: 'Remove this email address?',
  emailRemoveBody:
    'Mail to this address stops reaching the agent. Conversations stay in your threads as history. The allowlist, waiting requests and blocks for this address are deleted. Adding the address again later starts new conversations.',
  emailDisableTitle: 'Disable this email address?',
  emailDisableBody:
    "Mail sent to the agent while it's disabled is not delivered, even after you enable it again. Replies already queued wait until then.",
  unverified: "Couldn't confirm this sender",
  unverifiedHelp:
    "At least one message claims this address but didn't pass the sender check (SPF/DKIM). It may be forged — allow only if you're sure.",
  automaticDropped: (count: number) =>
    `Ignored ${count >= 1000 ? '1,000+' : count} automatic email${count === 1 ? '' : 's'}` +
    ' (bounces, no-reply senders, provider notices).',
  automaticLast: (domain: string, at: string, why: string | undefined) =>
    `Last: from ${domain}, ${at}${why ? ` — ${why}` : ''}.`,
} as const

/** Why a dropped mail counted as automatic (the server's `email_mail.AUTO_*`
 *  codes), in words. An unknown code from a newer server reads as nothing. */
const AUTOMATIC_REASONS: Record<string, string> = {
  auto_submitted: 'marked as sent automatically',
  precedence: 'bulk mail',
  autoreply_header: 'an auto-reply',
  mailing_list: 'a mailing list',
  bounce: 'a bounce',
  system_sender: 'a no-reply sender',
  delivery_report: 'a delivery report',
}

export const TELEGRAM: ChannelKind = {
  channel: 'telegram',
  removeTitle: COPY.removeTitle,
  removeBody: COPY.removeBody,
  disableTitle: COPY.disableTitle,
  disableBody: COPY.disableBody,
  allowlistHelp:
    "Telegram user ids (numbers) or @usernames. A @username is pinned to the first person who uses it, so a later owner of that name isn't let in.",
  allowlistPlaceholder: '123456789 or @username',
  requestsHelp:
    'People not on the allowlist who wrote to the bot. Nothing they send reaches the agent until you allow them.',
  tokenRejected: 'Token rejected — remove this connection and connect again with a new token',
  reconnectCodes: ['webhook_missing', 'webhook_error', 'key_rotation_pending'],
}

export const HUB: ChannelKind = {
  channel: 'hub',
  // Never shown: the Hub row has no Remove or Disable (HubChannelCard turns it off).
  removeTitle: '',
  removeBody: '',
  disableTitle: '',
  disableBody: '',
  allowlistHelp:
    'People on other servers you allowed from Requests. Each is one person on one server.',
  allowlistPlaceholder: null,
  requestsHelp:
    'People on other ClawMeets servers who messaged this agent over the hub. Nothing they send reaches the agent until you allow them.',
  tokenRejected: '',
  reconnectCodes: [],
}

export const EMAIL: ChannelKind = {
  channel: 'email',
  removeTitle: COPY.emailRemoveTitle,
  removeBody: COPY.emailRemoveBody,
  disableTitle: COPY.emailDisableTitle,
  disableBody: COPY.emailDisableBody,
  allowlistHelp:
    'Email addresses, or *@example.com for everyone at a domain. A sender is let in only when their mail passes SPF or DKIM for that domain; anything else waits in Requests.',
  allowlistPlaceholder: 'name@example.com or *@example.com',
  requestsHelp:
    'People not on the allowlist who emailed the agent. Nothing they send reaches the agent until you allow them.',
  tokenRejected: "This server's SendGrid key was rejected — ask the server's operator to replace it",
  // Email has no webhook of its own to register again.
  reconnectCodes: [],
}

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  working: { label: 'Working', tone: 'ok' },
  token_rejected: { label: TELEGRAM.tokenRejected, tone: 'bad' },
  sender_not_authorized: { label: "Replies can't be sent — the sending domain isn't set up at SendGrid", tone: 'bad' },
  webhook_missing: { label: 'Not receiving messages — reconnect', tone: 'bad' },
  webhook_error: { label: "Telegram couldn't deliver recent messages", tone: 'warn' },
  pending_updates: { label: 'Messages are waiting at Telegram', tone: 'warn' },
  disabled: { label: 'Disabled', tone: 'muted' },
  key_rotation_pending: { label: 'Reconnect to finish key rotation', tone: 'warn' },
  // LINE's own codes; LINE.statusLabels carries the full sentences.
  signature_mismatch: { label: 'Calls fail the signature check', tone: 'bad' },
  quota_exhausted: { label: 'Monthly message limit reached', tone: 'bad' },
  push_not_allowed: { label: "Messages can't be sent", tone: 'bad' },
  // WhatsApp's own codes; WHATSAPP.statusLabels carries the full sentences.
  permission_denied: { label: "The token can't send for this number", tone: 'bad' },
  number_not_registered: { label: "The number isn't registered", tone: 'bad' },
  number_unreachable: { label: "The token can't reach the number", tone: 'bad' },
  payment_issue: { label: 'Payment method problem', tone: 'bad' },
  account_restricted: { label: 'Account restricted', tone: 'bad' },
  no_webhook_yet: { label: 'No webhook received yet', tone: 'warn' },
}

const TONE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-800 border-amber-200',
  bad: 'bg-red-50 text-red-700 border-red-200',
  muted: 'bg-gray-50 text-gray-600 border-gray-200',
}

export function statusView(
  code: string | null, kind: ChannelKind = TELEGRAM,
): { label: string; tone: string; reconnect: boolean } {
  if (code === null) return { label: 'Not checked yet', tone: TONE.muted, reconnect: false }
  const known = STATUS[code]
  if (!known) return { label: 'Status unknown', tone: TONE.muted, reconnect: false }
  const label = code === 'token_rejected' ? kind.tokenRejected : (kind.statusLabels?.[code] ?? known.label)
  return { label, tone: TONE[known.tone], reconnect: kind.reconnectCodes.includes(code) }
}

export default function ChannelsSection({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: listConnections,
    retry: false,
  })
  // An older server has no /api/hub/config: no Hub tab, and the 404 rule below.
  const hubConfig = useHubConfig()

  const header = (
    <SectionTitle
      title="Channels"
      subtitle="Let people reach this agent from outside ClawMeets. Their messages arrive as Front Desk threads you own."
    />
  )

  if (isLoading || hubConfig.isLoading) return header
  const noGateway = error instanceof ApiError && error.status === 404
  const mine = (channel: ChannelId) => (data ?? []).find((c) => c.agent_id === agentId && c.channel === channel)
  const hubRow = mine('hub')
  const hub = hubConfig.data
  const hubTab = hub !== undefined && (hub.mode !== 'off' || hubRow !== undefined)
  if (noGateway && !hubTab) {
    return (
      <>
        {header}
        <p className="text-sm text-gray-600">{COPY.off}</p>
      </>
    )
  }
  if (error && !noGateway) {
    return (
      <>
        {header}
        <p role="alert" className="text-sm text-red-700">{errorText(error)}</p>
      </>
    )
  }
  const providersOn = hub ? hub.channels_enabled : !noGateway
  const connections: Record<ChannelId, ChannelConnection | undefined> = {
    telegram: providersOn ? mine('telegram') : undefined,
    email: providersOn ? mine('email') : undefined,
    line: providersOn ? mine('line') : undefined,
    whatsapp: providersOn ? mine('whatsapp') : undefined,
    webchat: providersOn ? mine('webchat') : undefined,
    hub: hubRow,
  }
  return (
    <>
      {header}
      <ChannelTabs
        connections={connections} agentId={agentId} agentName={agentName} hubTab={hubTab} providersOn={providersOn}
      />
    </>
  )
}

// ── tabs ─────────────────────────────────────────────────────────────────

type ChannelId = 'telegram' | 'email' | 'line' | 'whatsapp' | 'webchat' | 'hub'

/** Tab order; `region` names the panel (and is what screen readers announce). */
const CHANNEL_TABS: readonly { id: ChannelId; label: string; region: string }[] = [
  { id: 'telegram', label: 'Telegram', region: 'Telegram' },
  { id: 'email', label: 'Email', region: 'Email' },
  { id: 'line', label: 'LINE', region: 'LINE' },
  { id: 'whatsapp', label: 'WhatsApp', region: 'WhatsApp' },
  { id: 'webchat', label: 'Web chat', region: 'Web chat widget' },
  { id: 'hub', label: 'Hub', region: 'ClawMeets Hub' },
]

function ChannelTabs({ connections, agentId, agentName, hubTab, providersOn }: {
  connections: Record<ChannelId, ChannelConnection | undefined>
  agentId: string
  agentName: string
  hubTab: boolean
  providersOn: boolean
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabs = hubTab ? CHANNEL_TABS : CHANNEL_TABS.filter((t) => t.id !== 'hub')
  // Picked once, when the list first arrives, so connecting or removing a
  // channel doesn't move the user off the tab they're working in. A hub-only
  // server opens on the one tab that works there.
  const [fallback] = useState<ChannelId>(() =>
    tabs.find((t) => connections[t.id])?.id ?? (!providersOn && hubTab ? 'hub' : 'telegram'))
  const raw = searchParams.get('channel')
  const active = tabs.find((t) => t.id === raw)?.id ?? fallback
  const tabRefs = useRef<Partial<Record<ChannelId, HTMLButtonElement | null>>>({})
  const baseId = useId()

  const select = (id: ChannelId) => {
    // replace: flipping between channels shouldn't fill the Back stack.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('channel', id)
      return next
    }, { replace: true })
  }

  // Horizontal tablist keyboard support: ←/→ move, Home/End jump.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active)
    const last = tabs.length - 1
    const next =
      e.key === 'ArrowRight' ? Math.min(i + 1, last)
      : e.key === 'ArrowLeft' ? Math.max(i - 1, 0)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null
    if (next === null) return
    e.preventDefault()
    const id = tabs[next].id
    select(id)
    tabRefs.current[id]?.focus()
  }

  const connection = connections[active]
  const region = tabs.find((t) => t.id === active)!.region
  return (
    <>
      <div
        role="tablist"
        aria-label="Channels"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1"
      >
        {tabs.map(({ id, label }) => {
          const selected = id === active
          const c = connections[id]
          return (
            <button
              key={id}
              ref={(el) => { tabRefs.current[id] = el }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(id)}
              className={`shrink-0 flex items-center gap-2 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
                selected ? 'bg-purple-50 text-purple-800 font-bold' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              {label}
              {c && id !== 'webchat' && <WaitingBadge connectionId={c.id} />}
              {c && (
                <>
                  <span
                    aria-hidden="true"
                    data-testid={`channel-tab-dot-${id}`}
                    className={`w-1.5 h-1.5 rounded-full ${c.disabled ? 'bg-gray-400' : 'bg-emerald-500'}`}
                  />
                  <span className="sr-only">{c.disabled ? '(connected, disabled)' : '(connected)'}</span>
                </>
              )}
            </button>
          )
        })}
      </div>
      <section
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-label={region}
        className="space-y-6"
      >
        {!providersOn && active !== 'hub' && <p className="text-sm text-gray-600">{COPY.off}</p>}
        {providersOn && active === 'telegram' && (connection
          ? <ConnectedChannel connection={connection} kind={TELEGRAM} />
          : <ConnectForm agentName={agentName} />)}
        {providersOn && active === 'email' && (connection
          ? <ConnectedChannel connection={connection} kind={EMAIL} />
          : <EmailConnectForm agentName={agentName} />)}
        {providersOn && active === 'line' && (connection
          ? <ConnectedChannel connection={connection} kind={LINE} />
          : <LineConnectForm agentName={agentName} />)}
        {providersOn && active === 'whatsapp' && (connection
          ? <ConnectedChannel connection={connection} kind={WHATSAPP} />
          : <WhatsAppConnectForm agentName={agentName} />)}
        {providersOn && active === 'webchat' && <WebChatChannelCard agentName={agentName} connection={connection} />}
        {active === 'hub' && <HubPanel agentId={agentId} agentName={agentName} connection={connection} />}
      </section>
    </>
  )
}

// ── connect ──────────────────────────────────────────────────────────────

function ConnectForm({ agentName }: { agentName: string }) {
  const queryClient = useQueryClient()
  const [token, setToken] = useState('')
  const action = useAction()
  const inputId = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const typed = token.trim()
    if (!typed) return
    // Cleared before the request: the token lives only in this call.
    setToken('')
    const ok = await action.run('connect', () => connectTelegram(agentName, typed))
    if (ok) await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })
  }

  return (
    <SectionCard>
      <SectionHeader title={COPY.connectTitle} subtitle={COPY.connectHelp} />
      <form onSubmit={submit} className="px-6 py-5 flex flex-col gap-3">
        <label htmlFor={inputId} className="text-xs font-semibold text-gray-700">Bot token</label>
        <div className="flex gap-2">
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456789:AA…"
            className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button
            type="submit"
            disabled={!!action.busy || !token.trim()}
            className="px-4 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep disabled:opacity-50"
          >
            {action.busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </form>
      <ChannelSetupGuide channel="telegram" />
    </SectionCard>
  )
}

function EmailConnectForm({ agentName }: { agentName: string }) {
  const queryClient = useQueryClient()
  const action = useAction()
  const connect = async () => {
    const ok = await action.run('connect', () => connectEmail(agentName))
    if (ok) await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })
  }
  return (
    <SectionCard>
      <SectionHeader title={COPY.emailConnectTitle} subtitle={COPY.emailConnectHelp} />
      <div className="px-6 py-5 flex flex-col gap-3">
        <div>
          <button
            type="button"
            onClick={connect}
            disabled={!!action.busy}
            className="px-4 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep disabled:opacity-50"
          >
            {action.busy ? 'Creating address…' : 'Create email address'}
          </button>
        </div>
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </div>
      <ChannelSetupGuide channel="email" />
    </SectionCard>
  )
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${address}`}
      className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
    >
      <Copy className="w-3.5 h-3.5" />
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ── a connected channel ──────────────────────────────────────────────────

function ConnectedChannel({ connection, kind }: { connection: ChannelConnection; kind: ChannelKind }) {
  const queryClient = useQueryClient()
  const action = useAction()
  const [confirm, setConfirm] = useState<'remove' | 'disable' | 'anyone' | null>(null)
  const status = statusView(connection.status, kind)
  const isLine = kind.channel === 'line'
  const isWhatsApp = kind.channel === 'whatsapp'
  const anyone = (text: string) => (kind.anyoneExtra ? `${text} ${kind.anyoneExtra}` : text)

  const refresh = () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })
  const act = async (name: string, fn: () => Promise<unknown>) => {
    const ok = await action.run(name, fn)
    setConfirm(null)
    await refresh()
    return ok
  }

  return (
    <div className="space-y-6">
      {connection.warning === WARNING_ANYONE && (
        <div role="status" className="flex items-start gap-2 p-3 border rounded-lg text-xs bg-amber-50 border-amber-200 text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{anyone(COPY.anyoneBanner)}</span>
        </div>
      )}
      {isLine && <PushBanner connection={connection} />}
      <ChannelIsolationLine isolation={connection.isolation} heldConversations={connection.held_conversations} />

      <SectionCard>
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            {kind.channel === 'email' ? (
              <div className="flex items-center gap-3 min-w-0">
                <Mail className="w-5 h-5 text-purple-500 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-900 truncate font-mono" data-testid="email-address">
                    {connection.account_name}
                  </p>
                  <div className="flex items-center gap-3">
                    <CopyAddress address={connection.account_name} />
                    <span className="text-[11px] text-gray-500" data-testid="last-mail">
                      {connection.last_inbound_at
                        ? `Last mail received ${when(connection.last_inbound_at)}`
                        : 'No mail received yet'}
                    </span>
                  </div>
                </div>
              </div>
            ) : isWhatsApp ? (
              <WhatsAppIdentity connection={connection} />
            ) : isLine ? (
              <div className="flex items-center gap-3 min-w-0">
                <MessageCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-900 truncate" data-testid="line-bot-name">
                    {connection.account_name || 'LINE bot'}
                  </p>
                  <p className="text-xs text-gray-500 font-mono">Access token ···{connection.secret_last4}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 min-w-0">
                <Send className="w-5 h-5 text-sky-500 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-gray-900 truncate">{connection.account_name || 'Telegram bot'}</p>
                  <p className="text-xs text-gray-500 font-mono">Token …{connection.secret_last4}</p>
                </div>
              </div>
            )}
            <span data-testid="channel-status" className={`text-xs font-semibold px-2 py-1 rounded-full border ${status.tone}`}>
              {status.label}
            </span>
          </div>

          {isWhatsApp && (
            <div className="flex items-center gap-3 min-w-0">
              <p className="text-xs text-gray-600 min-w-0 truncate">
                {WHATSAPP_COPY.callbackUrl}{' '}
                <span className="font-mono" data-testid="whatsapp-callback-url">{connection.webhook_url}</span>
              </p>
              <CopyAddress address={connection.webhook_url} />
            </div>
          )}
          {kind.channel === 'email' && <EmailAutomaticNote connection={connection} />}
          {isLine && <LineHealthNotes connection={connection} />}
          {isWhatsApp && <WhatsAppHealthNotes connection={connection} />}
          {!isLine && !isWhatsApp && connection.status === 'webhook_error' && connection.status_detail && (
            <p className="text-xs text-gray-600">
              Telegram said: <span className="font-mono">{connection.status_detail}</span>
              {connection.status_count ? ` (${when(connection.status_count)})` : ''}
            </p>
          )}
          {kind.channel === 'email' && connection.status_detail
            && (connection.status === 'sender_not_authorized' || connection.status === 'token_rejected') && (
            <p className="text-xs text-gray-600" data-testid="email-status-detail">
              SendGrid said: <span className="font-mono">{connection.status_detail}</span>
            </p>
          )}
          {connection.status === 'pending_updates' && connection.status_count !== null && (
            <p className="text-xs text-gray-600">{connection.status_count} waiting</p>
          )}
          {connection.status_at && (
            <p className="text-[11px] text-gray-400">Checked {when(connection.status_at)}</p>
          )}

          <div className="flex flex-wrap gap-2">
            <ActionButton busy={action.busy} name="test" onClick={() => act('test', () => testConnection(connection.id))}>
              Test
            </ActionButton>
            {status.reconnect && !connection.disabled && (
              <ActionButton busy={action.busy} name="reconnect" onClick={() => act('reconnect', () => reconnectConnection(connection.id))}>
                Reconnect
              </ActionButton>
            )}
            {connection.disabled ? (
              <ActionButton busy={action.busy} name="enable" onClick={() => act('enable', () => enableConnection(connection.id))}>
                Enable
              </ActionButton>
            ) : (
              <ActionButton busy={action.busy} name="disable" onClick={() => setConfirm('disable')}>
                Disable
              </ActionButton>
            )}
            <ActionButton busy={action.busy} name="remove" danger onClick={() => setConfirm('remove')}>
              Remove
            </ActionButton>
          </div>
          {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
        </div>
        {kind.channel !== 'hub' && <ChannelSetupGuide channel={kind.channel} />}
      </SectionCard>

      {isLine && <PushMeterCard connection={connection} />}
      <ModeCard connection={connection} onAnyone={() => setConfirm('anyone')} onChanged={refresh} />
      <AllowlistCard connectionId={connection.id} kind={kind} />
      {isLine && <AckTextCard connection={connection} onSaved={refresh} />}
      <FixedReplyCard connection={connection} kind={kind} onSaved={refresh} />
      <RequestsCard connectionId={connection.id} kind={kind} />
      {isLine && <LineSetupNotes />}
      {isWhatsApp && <WhatsAppSetupNotes />}

      <ConfirmDialog
        open={confirm === 'remove'}
        title={kind.removeTitle}
        body={kind.removeBody}
        confirmLabel="Remove"
        busy={action.busy === 'remove'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => act('remove', () => removeConnection(connection.id))}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        title={kind.disableTitle}
        body={kind.disableBody}
        confirmLabel="Disable"
        busy={action.busy === 'disable'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => act('disable', () => disableConnection(connection.id))}
      />
      <ConfirmDialog
        open={confirm === 'anyone'}
        title={COPY.anyoneTitle}
        body={anyone(COPY.anyoneBody)}
        confirmLabel="Let anyone in"
        busy={action.busy === 'anyone'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => act('anyone', () => setConnectionMode(connection.id, 'anyone'))}
      />
    </div>
  )
}

/** The Hub tab: the Hub card, which agents it may bring in, then the shared cards on the agent's Hub row
 *  (it exists once the channel was first turned on), then Blocked servers. */
function HubPanel({ agentId, agentName, connection }: {
  agentId: string
  agentName: string
  connection: ChannelConnection | undefined
}) {
  const queryClient = useQueryClient()
  const action = useAction()
  const [anyone, setAnyone] = useState(false)
  // "Block everyone from X": the request whose server is about to be blocked.
  const [blockServer, setBlockServer] = useState<ChannelRequest | null>(null)
  const { block } = useBlockedDeployments(agentName)
  const refresh = () => queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })
  const server = blockServer ? hubContactParts(blockServer) : null
  return (
    <div className="space-y-6">
      {connection?.warning === WARNING_ANYONE && (
        <div role="status" className="flex items-start gap-2 p-3 border rounded-lg text-xs bg-amber-50 border-amber-200 text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{COPY.anyoneBanner}</span>
        </div>
      )}
      {connection && <WaitingBanner connectionId={connection.id} />}
      <HubChannelCard agentId={agentId} agentFullName={agentName} />
      <HubInvitableAgentsCard agentId={agentId} agentFullName={agentName} />
      <HubSendUsageCard agentId={agentId} />
      {connection && (
        <>
          <ModeCard connection={connection} onAnyone={() => setAnyone(true)} onChanged={refresh} />
          <AllowlistCard connectionId={connection.id} kind={HUB} />
          <FixedReplyCard connection={connection} kind={HUB} onSaved={refresh} />
          <RequestsCard connectionId={connection.id} kind={HUB} onBlockServer={setBlockServer} />
        </>
      )}
      <BlockedDeploymentsCard agentFullName={agentName} />
      {connection && blockServer && server && (
        <ConfirmDialog
          open
          title={`Block everyone from ${server.server}?`}
          body={`Nobody on ${server.server} (server fp ${server.fp}) can message this agent over the hub ` +
            'until you unblock it under Blocked servers.'}
          confirmLabel="Block server"
          busy={action.busy === 'block-server'}
          onCancel={() => setBlockServer(null)}
          onConfirm={async () => {
            const fp = blockServer.deployment_fingerprint!
            await action.run('block-server', () => block.mutateAsync(fp))
            setBlockServer(null)
            await queryClient.invalidateQueries({ queryKey: requestsKey(connection.id) })
          }}
        />
      )}
      {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      {connection && (
        <ConfirmDialog
          open={anyone}
          title={COPY.anyoneTitle}
          body={COPY.anyoneBody}
          confirmLabel="Let anyone in"
          busy={action.busy === 'anyone'}
          onCancel={() => setAnyone(false)}
          onConfirm={async () => {
            await action.run('anyone', () => setConnectionMode(connection.id, 'anyone'))
            setAnyone(false)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

/** Email: automatic mail from senders the agent has no conversation with is
 *  never answered, but the owner can see it came (a provider's "verify your
 *  sender" mail lands here). Only the domain and the kind of signal are kept. */
function EmailAutomaticNote({ connection }: { connection: ChannelConnection }) {
  const count = connection.automatic_dropped ?? 0
  if (count <= 0) return null
  const domain = connection.automatic_dropped_domain
  const at = connection.automatic_dropped_at
  const why = connection.automatic_dropped_reason
    ? AUTOMATIC_REASONS[connection.automatic_dropped_reason]
    : undefined
  return (
    <p data-testid="email-automatic-dropped" className="text-[11px] text-gray-500">
      {COPY.automaticDropped(count)}
      {domain && at ? ` ${COPY.automaticLast(domain, when(at), why)}` : ''}
    </p>
  )
}

function ActionButton({ busy, name, danger, onClick, children }: {
  busy: string | null; name: string; danger?: boolean; onClick: () => void; children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy !== null}
      className={`px-3 py-1.5 text-xs font-semibold border rounded-lg disabled:opacity-50 ${
        danger ? 'border-red-200 text-red-700 hover:bg-red-50' : 'border-gray-200 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {busy === name ? `${children}…` : children}
    </button>
  )
}

// ── who may reach the agent ──────────────────────────────────────────────

function ModeCard({ connection, onAnyone, onChanged }: {
  connection: ChannelConnection; onAnyone: () => void; onChanged: () => void
}) {
  const action = useAction()
  const toAllowlist = async () => {
    if (await action.run('mode', () => setConnectionMode(connection.id, 'allowlist'))) onChanged()
  }
  return (
    <SectionCard>
      <SectionHeader title="Who can message this agent" />
      <div className="px-6 py-5 space-y-2" role="radiogroup" aria-label="Who can message this agent">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`mode-${connection.id}`}
            checked={connection.mode === 'allowlist'}
            disabled={!!action.busy}
            onChange={toAllowlist}
          />
          <span><b>Only people on the allowlist.</b> Anyone else lands in Requests below for you to allow or block.</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`mode-${connection.id}`}
            checked={connection.mode === 'anyone'}
            disabled={!!action.busy}
            onChange={onAnyone}
          />
          <span><b>Anyone.</b> Strangers reach the agent directly.</span>
        </label>
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </div>
    </SectionCard>
  )
}

function AllowlistCard({ connectionId, kind }: { connectionId: string; kind: ChannelKind }) {
  const queryClient = useQueryClient()
  const key = ['channel-allowlist', connectionId]
  const { data: entries = [] } = useQuery({ queryKey: key, queryFn: () => listAllowlist(connectionId) })
  const [value, setValue] = useState('')
  const action = useAction()
  const inputId = useId()

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    const ok = await action.run('add', () => addAllowlistEntry(connectionId, value.trim()))
    if (ok) setValue('')
    await queryClient.invalidateQueries({ queryKey: key })
    await queryClient.invalidateQueries({ queryKey: requestsKey(connectionId) })
  }
  const remove = async (entryId: string) => {
    await action.run(`remove-${entryId}`, () => deleteAllowlistEntry(connectionId, entryId))
    await queryClient.invalidateQueries({ queryKey: key })
  }

  return (
    <SectionCard>
      <SectionHeader title="Allowlist" subtitle={kind.allowlistHelp} />
      <div className="px-6 py-5 space-y-3">
        {entries.length === 0 && <p className="text-xs text-gray-500">Nobody yet.</p>}
        <ul className="space-y-1">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                <span className="font-mono">
                  {entry.kind === 'username' ? `@${entry.value}` : entry.kind === 'domain' ? `*@${entry.value}` : entry.value}
                </span>
                {entry.pinned_to && (
                  <span className="ml-2 text-xs text-gray-500">pinned to id …{entry.pinned_to.slice(-4)}</span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Remove ${entry.value}`}
                disabled={!!action.busy}
                onClick={() => remove(entry.id)}
                className="text-xs text-red-700 hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {kind.allowlistPlaceholder !== null && (
          <form onSubmit={add} className="flex gap-2">
            <label htmlFor={inputId} className="sr-only">{kind.allowlistLabel ?? 'Add to allowlist'}</label>
            <input
              id={inputId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind.allowlistPlaceholder}
              className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
            <button type="submit" disabled={!!action.busy || !value.trim()} className="px-3 py-2 text-xs font-semibold border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              Add
            </button>
          </form>
        )}
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </div>
    </SectionCard>
  )
}

function FixedReplyCard({ connection, kind, onSaved }: {
  connection: ChannelConnection; kind: ChannelKind; onSaved: () => void
}) {
  const [text, setText] = useState(connection.fixed_reply)
  const action = useAction()
  const inputId = useId()
  useEffect(() => setText(connection.fixed_reply), [connection.fixed_reply])
  const save = async () => {
    if (await action.run('save', () => setFixedReply(connection.id, text))) onSaved()
  }
  return (
    <SectionCard>
      <SectionHeader title="Reply to people waiting" subtitle="Sent once to someone not on the allowlist. Leave empty to send nothing." />
      <div className="px-6 py-5 space-y-2">
        <label htmlFor={inputId} className="sr-only">Reply to people waiting</label>
        <textarea
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
        {kind.fixedReplyNote && <p className="text-[11px] text-gray-500">{kind.fixedReplyNote}</p>}
        <button
          type="button"
          onClick={save}
          disabled={!!action.busy || text === connection.fixed_reply}
          className="px-3 py-1.5 text-xs font-semibold border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          Save reply
        </button>
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </div>
    </SectionCard>
  )
}

// ── requests ─────────────────────────────────────────────────────────────

const FIXED_REPLY_LABEL: Record<string, string> = {
  pending: 'Reply queued', sending: 'Reply sending', sent: 'Reply sent',
  failed: 'Reply failed', expired: 'Reply not sent',
}

const REQUESTS_ANCHOR = 'channel-requests'

/** The count on a channel's tab: people waiting for Allow or Block. */
function WaitingBadge({ connectionId }: { connectionId: string }) {
  const { data = [] } = useChannelRequests(connectionId)
  const n = waitingRequests(data).length
  if (n === 0) return null
  return (
    <span
      data-testid="channel-tab-waiting"
      className="min-w-[1.25rem] px-1.5 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold leading-5 text-center"
    >
      {n}<span className="sr-only">{n === 1 ? ' request waiting' : ' requests waiting'}</span>
    </span>
  )
}

/** Above the Hub card, because Requests sits at the bottom of a long tab:
 *  a held first message is otherwise invisible until the owner scrolls. */
function WaitingBanner({ connectionId }: { connectionId: string }) {
  const { data = [] } = useChannelRequests(connectionId)
  const n = waitingRequests(data).length
  if (n === 0) return null
  return (
    <div role="status" className="flex items-center justify-between gap-3 p-3 border rounded-lg text-xs bg-amber-50 border-amber-200 text-amber-800">
      <span>
        <b>{n === 1 ? '1 person is waiting' : `${n} people are waiting`}</b> for you to let them in.
        Their messages are held until you allow them.
      </span>
      <button
        type="button"
        onClick={() => document.getElementById(REQUESTS_ANCHOR)?.scrollIntoView({ behavior: 'smooth' })}
        className="shrink-0 px-3 py-1.5 font-bold border border-amber-300 rounded-lg bg-white"
      >
        Review requests
      </button>
    </div>
  )
}

function RequestsCard({ connectionId, kind, onBlockServer }: {
  connectionId: string
  kind: ChannelKind
  /** Hub rows: "Block everyone from {server}", for rows that name a server. */
  onBlockServer?: (request: ChannelRequest) => void
}) {
  const queryClient = useQueryClient()
  const key = requestsKey(connectionId)
  const { data: requests = [] } = useChannelRequests(connectionId)
  const action = useAction()
  const [allowed, setAllowed] = useState<ChannelRequest | null>(null)
  const pending = waitingRequests(requests)

  const decide = async (request: ChannelRequest, verb: 'allow' | 'block') => {
    const outcome: { request: ChannelRequest | null } = { request: null }
    await action.run(`${verb}-${request.id}`, async () => {
      outcome.request = verb === 'allow'
        ? await allowRequest(connectionId, request.id)
        : await blockRequest(connectionId, request.id)
    })
    if (verb === 'allow' && outcome.request) setAllowed(outcome.request)
    await queryClient.invalidateQueries({ queryKey: key })
  }

  return (
    <div id={REQUESTS_ANCHOR}>
      <SectionCard>
        <SectionHeader title="Requests" subtitle={kind.requestsHelp} />
        <div className="px-6 py-5 space-y-3">
          {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
          {allowed && allowed.project_ids.length > 0 && (
            <p className="text-xs text-emerald-700">
              Allowed. <Link className="underline" to={`/projects/${allowed.project_ids[0]}`}>Open the thread</Link>
            </p>
          )}
          {pending.length === 0 && <p className="text-xs text-gray-500">No one is waiting.</p>}
          <ul className="space-y-3">
            {pending.map((request) => (
              <li key={request.id} data-testid="channel-request" className="border border-gray-100 rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 truncate">
                      {kind.channel === 'hub'
                        ? <HubContactLabel fields={request} fallbackName={request.display_name} />
                        : request.display_name}
                    </p>
                    {kind.channel === 'email' && (
                      <p className="text-xs text-gray-600 font-mono truncate" data-testid="request-sender">{request.user_key}</p>
                    )}
                    <p className="text-[11px] text-gray-500">
                      {request.handle ? `@${request.handle} · ` : ''}{when(request.created_at)}
                      {' · '}{request.held_count} held{request.dropped_count ? `, ${request.dropped_count} dropped` : ''}
                      {request.fixed_reply_state ? ` · ${FIXED_REPLY_LABEL[request.fixed_reply_state] ?? request.fixed_reply_state}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      type="button"
                      disabled={!!action.busy}
                      onClick={() => decide(request, 'allow')}
                      className="px-3 py-1.5 text-xs font-bold bg-accent text-white rounded-lg disabled:opacity-50"
                    >
                      Allow
                    </button>
                    <button
                      type="button"
                      disabled={!!action.busy}
                      onClick={() => decide(request, 'block')}
                      className="px-3 py-1.5 text-xs font-semibold border border-red-200 text-red-700 rounded-lg disabled:opacity-50"
                    >
                      {kind.channel === 'hub' ? 'Block this person' : 'Block'}
                    </button>
                    {onBlockServer && request.deployment_fingerprint && (
                      <button
                        type="button"
                        disabled={!!action.busy}
                        onClick={() => onBlockServer(request)}
                        className="px-3 py-1.5 text-xs font-semibold border border-red-200 text-red-700 rounded-lg disabled:opacity-50"
                      >
                        Block everyone from {hubContactParts(request)?.server}
                      </button>
                    )}
                  </div>
                </div>
                {request.unverified_count > 0 && (
                  <p
                    role="note"
                    data-testid="request-unverified"
                    className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1"
                  >
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span><b>{COPY.unverified}.</b> {COPY.unverifiedHelp}</span>
                  </p>
                )}
                {/* Exactly as sent, as text: never markdown, never HTML. */}
                <p className="text-sm text-gray-700 whitespace-pre-wrap break-words" data-testid="request-first-message">
                  {request.first_message}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </SectionCard>
    </div>
  )
}

// ── confirmation ─────────────────────────────────────────────────────────

function ConfirmDialog({ open, title, body, confirmLabel, busy, onConfirm, onCancel }: {
  open: boolean; title: string; body: string; confirmLabel: string; busy: boolean
  onConfirm: () => void; onCancel: () => void
}) {
  const titleId = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onCancel])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !busy && onCancel()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <h2 id={titleId} className="text-base font-bold text-gray-900">{title}</h2>
        </div>
        <p className="px-6 py-4 text-sm text-gray-700">{body}</p>
        <div className="px-6 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="px-4 py-2 text-sm font-semibold border border-gray-200 rounded-lg disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className="px-4 py-2 text-sm font-bold bg-red-600 text-white rounded-lg disabled:opacity-50">
            {busy ? `${confirmLabel}…` : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
