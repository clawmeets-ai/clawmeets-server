import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Phone } from 'lucide-react'
import { connectWhatsApp } from '../../../api/endpoints/channels'
import type { ChannelConnection } from '../../../api/endpoints/channels'
import { SectionCard, SectionHeader } from '../primitives'
import { CONNECTIONS_KEY, useAction, when } from './channelsShared'
import type { ChannelKind } from './channelsShared'
import { ChannelSetupGuide } from './channelSetupGuides'
import { UNVERIFIED_CALLS_CAP } from './LineChannelCard'

/**
 * The WhatsApp-only parts of Agent Settings → Channels. The connected card
 * itself (status, Test / Disable / Remove, who may reach the agent, the
 * allowlist, the reply to people waiting, Requests) is the shared one in
 * ChannelsSection.tsx, driven by the `WHATSAPP` kind below; this file holds
 * what only WhatsApp (the Meta Cloud API) has: four values to connect, who the
 * number is, Meta's subscription check, the 24-hour window and the setup notes.
 *
 * None of the three secrets is kept after the connect request. The app secret
 * is never shown again, not even partly; only the access token's and the
 * verify token's last four are. The phone number ID is an identifier, shown in
 * full.
 */

/** Meta's verify token is ours to choose; the server asks for at least this. */
export const VERIFY_TOKEN_MIN = 16

export const WHATSAPP_COPY = {
  connectTitle: 'Connect a WhatsApp Business number',
  connectHelp:
    "From your Meta app (App Dashboard → WhatsApp → API Setup), copy the phone number ID and an access token; the app secret is under App settings → Basic. Make up a verify token — you'll paste the same value into your Meta app. The three secrets are stored encrypted. Only the two tokens' last four characters are shown again; the app secret is never shown.",
  tokenHint:
    'Use a System User permanent access token — the temporary token on the API Setup page expires in 24 hours.',
  verifyTokenHint: `At least ${VERIFY_TOKEN_MIN} characters. Any value you choose; Meta sends it back when it checks the callback URL.`,
  removeTitle: 'Remove this WhatsApp connection?',
  removeBody:
    "The agent stops answering on WhatsApp. Conversations stay in your threads as history. The allowlist, waiting requests and blocks for this number are deleted. Meta keeps calling the old callback URL until you remove it in your Meta app (App Dashboard → WhatsApp → Configuration) — we can't remove it for you.",
  disableTitle: 'Disable this WhatsApp connection?',
  disableBody:
    "Messages sent on WhatsApp while it's disabled are not delivered, even after you enable it again. Replies already queued wait until then.",
  allowlistHelp:
    "Phone numbers, with country code. If someone you added doesn't get through, Allow them from Requests.",
  allowlistLabel: 'phone number with country code',
  allowlistPlaceholder: '+1 415 555 0100',
  requestsHelp:
    'People not on the allowlist who messaged your WhatsApp number. Nothing they send reaches the agent until you allow them.',
  anyoneExtra: "On WhatsApp, every stranger's message reaches the agent.",
  callbackUrl: 'Callback URL',
  allFailedSignature:
    "Every call from Meta so far didn't match your app secret — check that the app secret is right.",
  someFailedSignature: (n: number) =>
    n >= UNVERIFIED_CALLS_CAP
      ? `${UNVERIFIED_CALLS_CAP.toLocaleString('en-US')}+ calls from Meta since the last good one didn't match your app secret.`
      : `${n} call${n === 1 ? '' : 's'} from Meta since the last good one didn't match your app secret.`,
  lastInbound: (at: number) => `Last message received ${when(at)}`,
  noInbound: 'No message received yet',
  handshakeOk: (at: number) => `Meta's subscription check last succeeded ${when(at)}`,
  noHandshake: "Meta hasn't checked the callback URL yet",
  heldWindow: (n: number) =>
    `${n} repl${n === 1 ? 'y' : 'ies'} held in the last 7 days because the 24-hour window had closed`,
  setupTitle: 'Set up in Meta',
  setupToken:
    "Use a System User permanent access token — the dashboard's temporary token expires in 24 hours.",
  setupWebhook:
    'In your Meta app (App Dashboard → WhatsApp → Configuration), paste the callback URL and your verify token, then subscribe the messages field.',
  setupTestNumber:
    "Meta's test number only delivers to up to 5 recipient numbers you registered; messages to anyone else fail.",
  setupWindow:
    "The agent can only reply within 24 hours of the customer's last message; later replies are held and not sent.",
  setupRemove:
    "After Remove, also remove the callback URL in the App Dashboard — we can't remove it for you.",
} as const

export const WHATSAPP: ChannelKind = {
  channel: 'whatsapp',
  removeTitle: WHATSAPP_COPY.removeTitle,
  removeBody: WHATSAPP_COPY.removeBody,
  disableTitle: WHATSAPP_COPY.disableTitle,
  disableBody: WHATSAPP_COPY.disableBody,
  allowlistHelp: WHATSAPP_COPY.allowlistHelp,
  allowlistPlaceholder: WHATSAPP_COPY.allowlistPlaceholder,
  allowlistLabel: WHATSAPP_COPY.allowlistLabel,
  requestsHelp: WHATSAPP_COPY.requestsHelp,
  tokenRejected:
    'Meta rejected the access token — create a System User permanent token in Meta Business Settings, then remove this connection and connect again',
  statusLabels: {
    permission_denied:
      "The access token can't send for this number — give the System User the whatsapp_business_messaging permission and assign it to this phone number, then press Test",
    number_not_registered:
      "This phone number isn't registered with the WhatsApp Cloud API — register it in your Meta app (App Dashboard → WhatsApp → API Setup), then press Test",
    number_unreachable:
      "This access token can't reach the phone number ID — check the number is still in your WhatsApp Business Account and assigned to the System User, then press Test",
    payment_issue:
      "There's a problem with the payment method on the WhatsApp Business Account — fix it in Meta Business Settings so answers can be sent",
    account_restricted:
      "Meta has restricted this WhatsApp Business Account (a policy or spam limit) — answers can't be sent until Meta lifts it",
    signature_mismatch:
      "Webhook calls don't match your app secret — remove this connection and connect again with the right app secret",
    no_webhook_yet:
      'No webhook received from Meta yet — paste the callback URL and verify token in your Meta app and subscribe the messages field',
    key_rotation_pending:
      "This server's callback URL changed — paste the callback URL above into your Meta app again (App Dashboard → WhatsApp → Configuration)",
  },
  // Nothing to reconnect: Meta's callback URL is pasted by hand in the App
  // Dashboard, so each remedy is a step the sentence names.
  reconnectCodes: [],
  anyoneExtra: WHATSAPP_COPY.anyoneExtra,
}

// ── who the number is ────────────────────────────────────────────────────

export function WhatsAppIdentity({ connection }: { connection: ChannelConnection }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <Phone className="w-5 h-5 text-emerald-600 flex-shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-bold text-gray-900 truncate" data-testid="whatsapp-account-name">
          {connection.account_name || 'WhatsApp number'}
        </p>
        <p className="text-xs text-gray-500 font-mono" data-testid="whatsapp-phone-number-id">
          Phone number ID {connection.phone_number_id ?? '—'}
        </p>
        <p className="text-xs text-gray-500 font-mono">Access token …{connection.secret_last4}</p>
        {connection.verify_token_last4 && (
          <p className="text-xs text-gray-500 font-mono">Verify token …{connection.verify_token_last4}</p>
        )}
      </div>
    </div>
  )
}

// ── health notes only WhatsApp has ───────────────────────────────────────

export function WhatsAppHealthNotes({ connection }: { connection: ChannelConnection }) {
  const held = connection.held_window_7d ?? 0
  return (
    <>
      <p className="text-[11px] text-gray-500" data-testid="whatsapp-last-inbound">
        {connection.last_inbound_at ? WHATSAPP_COPY.lastInbound(connection.last_inbound_at) : WHATSAPP_COPY.noInbound}
      </p>
      <p className="text-[11px] text-gray-500" data-testid="whatsapp-handshake">
        {connection.handshake_ok_at ? WHATSAPP_COPY.handshakeOk(connection.handshake_ok_at) : WHATSAPP_COPY.noHandshake}
      </p>
      {connection.unverified_calls > 0 && (
        <p role="note" data-testid="whatsapp-unverified" className="text-xs text-red-700">
          {connection.last_inbound_at === null
            ? WHATSAPP_COPY.allFailedSignature
            : WHATSAPP_COPY.someFailedSignature(connection.unverified_calls)}
        </p>
      )}
      {held > 0 && (
        <p role="note" data-testid="whatsapp-held-window" className="text-xs text-amber-800">
          {WHATSAPP_COPY.heldWindow(held)}
        </p>
      )}
    </>
  )
}

// ── connect ──────────────────────────────────────────────────────────────

export function WhatsAppConnectForm({ agentName }: { agentName: string }) {
  const queryClient = useQueryClient()
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [token, setToken] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [verifyToken, setVerifyToken] = useState('')
  const action = useAction()
  const phoneId = useId()
  const tokenId = useId()
  const secretId = useId()
  const verifyId = useId()
  const tokenHintId = useId()
  const verifyHintId = useId()
  const ready = !!phoneNumberId.trim() && !!token.trim() && !!appSecret.trim() && !!verifyToken.trim()
  // A hint only: the server decides what it accepts and says why in its 400.
  const verifyShort = !!verifyToken && verifyToken.trim().length < VERIFY_TOKEN_MIN

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const typedPhone = phoneNumberId.trim()
    const typedToken = token.trim()
    const typedSecret = appSecret.trim()
    const typedVerify = verifyToken.trim()
    if (!typedPhone || !typedToken || !typedSecret || !typedVerify) return
    // Cleared before the request: the three secrets live only in this call.
    // The phone number ID is an identifier and stays for a retry.
    setToken('')
    setAppSecret('')
    setVerifyToken('')
    const ok = await action.run('connect', () =>
      connectWhatsApp(agentName, typedPhone, typedToken, typedSecret, typedVerify))
    if (ok) {
      setPhoneNumberId('')
      await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })
    }
  }

  const field = 'px-3 py-2 text-sm border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-purple-500'
  return (
    <SectionCard>
      <SectionHeader title={WHATSAPP_COPY.connectTitle} subtitle={WHATSAPP_COPY.connectHelp} />
      <form onSubmit={submit} className="px-6 py-5 flex flex-col gap-3">
        <label htmlFor={phoneId} className="text-xs font-semibold text-gray-700">Phone number ID</label>
        <input
          id={phoneId}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={phoneNumberId}
          onChange={(e) => setPhoneNumberId(e.target.value)}
          placeholder="106540352242922"
          className={field}
        />
        <label htmlFor={tokenId} className="text-xs font-semibold text-gray-700">Access token</label>
        <input
          id={tokenId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={tokenHintId}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className={field}
        />
        <p id={tokenHintId} className="text-[11px] text-gray-500">{WHATSAPP_COPY.tokenHint}</p>
        <label htmlFor={secretId} className="text-xs font-semibold text-gray-700">App secret</label>
        <input
          id={secretId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={appSecret}
          onChange={(e) => setAppSecret(e.target.value)}
          className={field}
        />
        <label htmlFor={verifyId} className="text-xs font-semibold text-gray-700">Verify token</label>
        <input
          id={verifyId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={verifyHintId}
          value={verifyToken}
          onChange={(e) => setVerifyToken(e.target.value)}
          className={field}
        />
        <p
          id={verifyHintId}
          data-testid="whatsapp-verify-hint"
          className={`text-[11px] ${verifyShort ? 'text-amber-700' : 'text-gray-500'}`}
        >
          {WHATSAPP_COPY.verifyTokenHint}
        </p>
        <div>
          <button
            type="submit"
            disabled={!!action.busy || !ready}
            className="px-4 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep disabled:opacity-50"
          >
            {action.busy ? 'Connecting…' : 'Connect WhatsApp'}
          </button>
        </div>
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </form>
      <ChannelSetupGuide channel="whatsapp" />
    </SectionCard>
  )
}

// ── setup notes ──────────────────────────────────────────────────────────

export function WhatsAppSetupNotes() {
  return (
    <SectionCard>
      <SectionHeader title={WHATSAPP_COPY.setupTitle} />
      <ul className="px-6 py-5 space-y-2 list-disc list-inside text-xs text-gray-700" data-testid="whatsapp-setup-notes">
        <li>{WHATSAPP_COPY.setupToken}</li>
        <li>{WHATSAPP_COPY.setupWebhook}</li>
        <li>{WHATSAPP_COPY.setupTestNumber}</li>
        <li>{WHATSAPP_COPY.setupWindow}</li>
        <li>{WHATSAPP_COPY.setupRemove}</li>
      </ul>
    </SectionCard>
  )
}
