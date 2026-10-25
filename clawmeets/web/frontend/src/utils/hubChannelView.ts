import type { HubChannel, HubConfig } from '../api/endpoints/hub'
import { formatAge, formatHubDate, formatHubTime, REMOTE_TEXT_CAP, safeRemoteText } from './hubDisplay'

/**
 * The Hub card in Settings → Channels, as data: which sentence each channel
 * status shows, and whether the switch can be clicked. Every sentence is the
 * approved copy. The hub's own words (status_detail) are quoted after our
 * sentence as plain text and never replace it.
 */

export interface HubToggleState {
  on: boolean
  clickable: boolean
  /** What a click does. */
  opens: 'enable' | 'dialog' | null
}

/**
 * Turning on needs eligible, mode 'full', registration 'active' and a status
 * that is not hub_not_registered. In mode 'auto' the server need not be
 * registered yet: the enable answers hub_owner_unverified and the enrollment
 * dialog registers it. Turning off is allowed whenever the channel is
 * enabled — every mode, every status — so an owner can always delist.
 */
export function hubToggleState(ch: HubChannel, cfg: HubConfig): HubToggleState {
  if (ch.enabled) return { on: true, clickable: true, opens: 'dialog' }
  const canEnable = ch.eligible && (
    cfg.mode === 'auto'
      ? cfg.registration !== 'suspended' && (REGISTERED.has(cfg.registration) || cfg.hub_link !== 'untrusted')
      : cfg.mode === 'full' && cfg.registration === 'active' && ch.status !== 'hub_not_registered'
  )
  return { on: false, clickable: canEnable, opens: canEnable ? 'enable' : null }
}

export type HubCardTone = 'ok' | 'pending' | 'warn' | 'error' | 'muted'

export interface HubChannelViewModel {
  /** "List this agent on the ClawMeets Hub" | "Listed on the ClawMeets Hub" | "Not listed" */
  heading: string
  /** Our sentence for the status. */
  title: string
  /** Further lines, in order. */
  lines: string[]
  /** The hub's own words, quoted as text after our sentence. */
  quoted: string | null
  action: 'turn_off_on' | 'reconnect' | null
  /** Offer the card's own "Make public" button: listing needs a public agent. */
  makePublic: boolean
  /** Offer "Make private": the agent is public but not listed (shared on this
   *  server before the switch became the one sharing control). */
  makePrivate: boolean
  chips: string[]
  tone: HubCardTone
}

const LIST = 'List this agent on the ClawMeets Hub'
const LISTED = 'Listed on the ClawMeets Hub'
const NOT_LISTED = 'Not listed'

export const HUB_CARD_COPY = {
  offBody: (display: string) =>
    `Turning this on shares ${display}: anyone can find it in the directory and message it, people on this ` +
    'server and on other ClawMeets servers. Their messages arrive here as Front Desk threads, and your ' +
    'allowlist, Requests and blocks apply.',
  sharingOff: 'Sharing is turned off on this server.',
  sharedNotListed: 'Shared on this server but not listed: people who know its name can still message it.',
  makePrivate: 'Make private',
  makingPrivate: 'Making private…',
  nonDefaultHub:
    'This server uses a hub other than hub.clawmeets.ai. Only list agents here if you trust whoever runs it.',
  stillWaiting: 'Still waiting for the hub',
  checkAgain: 'Check again',
  turnOffOn: 'Turn off and on again',
  reconnect: 'Reconnect',
  unknown: 'Status unknown',
  notPublic: 'Only public agents can be listed. Make this agent public, then turn on the switch.',
  makePublic: 'Make public',
  makingPublic: 'Making public…',
  notAvailable: "The ClawMeets Hub isn't available yet.",
  dispatchLabel: 'Accept requests the hub routes to this agent',
  dispatchBody:
    'When someone asks the hub for help without naming an agent, the hub may send their request here if it ' +
    'looks like a good fit. Each one runs this agent once and counts against your model usage.',
  dispatchCapLabel: 'Most per day',
  dispatchToday: (n: number, cap: number) => `${n} of ${cap} routed requests today`,
  dispatchSaving: 'Saving…',
} as const

const REJECTS: Record<string, { title: string; line: string }> = {
  name_conflict: {
    title: 'Another agent already uses this name on the hub',
    line: 'Rename the agent, then turn the channel off and on again.',
  },
  deployment_suspended: {
    title: 'The hub has suspended this server',
    line: "No agent on this server can be listed. Contact this server's operator.",
  },
  over_quota: {
    title: 'This server has listed as many agents as the hub allows',
    line: 'Turn the Hub channel off on another agent first.',
  },
  client_too_old: {
    title: 'This server is too old for the hub',
    line: 'The server needs an update. Ask its operator.',
  },
  invalid_listing: {
    title: "The hub refused this agent's listing details",
    line: "Edit the agent's description, capabilities or avatar, then turn the channel off and on again.",
  },
  invalid_name: {
    title: "This agent's name can't be used on the hub",
    line: 'Hub names may use only lowercase a–z, 0–9, "-" and ".". Rename the agent, then turn the channel off and on again.',
  },
  delisted_by_hub: {
    title: "The hub's moderators removed this listing",
    line: "Turning the channel off and on again won't list it again. To appeal, contact the hub's operator.",
  },
  owner_unverified: {
    title: 'The hub needs to confirm your email address first',
    line: 'Turn the channel off and on again to get a code.',
  },
  owner_banned: {
    title: "This email address can't list agents on the hub",
    line: "To appeal, contact the hub's operator.",
  },
}

/** Reject reasons a turn-off-and-on can fix. */
const RETRYABLE_REJECTS = new Set(['name_conflict', 'invalid_listing', 'invalid_name', 'over_quota', 'owner_unverified'])

const REGISTERED = new Set(['active', 'suspended'])

/**
 * The card for one channel. `display` is this agent as others would see it
 * (name@deployment_name); `nowMs` dates the "last contact" line.
 */
export function hubChannelView(ch: HubChannel, cfg: HubConfig, display: string, nowMs: number): HubChannelViewModel {
  const quoted = ch.status_detail ? safeRemoteText(ch.status_detail, REMOTE_TEXT_CAP.detail) : null
  // Off but public: shared on this server before the switch was the one
  // sharing control. Every off card says so and offers Make private.
  const legacy = !ch.enabled && ch.public === true
  const vm = (v: Partial<HubChannelViewModel> & Pick<HubChannelViewModel, 'heading' | 'title'>): HubChannelViewModel => {
    const out: HubChannelViewModel = {
      lines: [], quoted: null, action: null, makePublic: false, makePrivate: false, chips: [], tone: 'muted', ...v,
    }
    return legacy
      ? { ...out, lines: [...out.lines, HUB_CARD_COPY.sharedNotListed], makePublic: false, makePrivate: true }
      : out
  }
  const listedAs = ch.listed_as ? safeRemoteText(ch.listed_as, REMOTE_TEXT_CAP.name) : display
  const key = ch.key_last4 ? `Key ····${ch.key_last4}` : null

  if (cfg.mode === 'off' || ch.status === 'hub_off_on_server') {
    return vm({ heading: LIST, title: HUB_CARD_COPY.sharingOff, tone: 'muted' })
  }
  // Listing needs a public agent: say so, with the card's Make public button.
  const notPublic = () => vm({
    heading: LIST,
    // The server sends the bare code 'agent_not_public' here: never show a code.
    title: ch.ineligible_reason && ch.ineligible_reason !== 'agent_not_public'
      ? ch.ineligible_reason : HUB_CARD_COPY.notPublic,
    makePublic: true,
    tone: 'muted',
  })

  const lazy = cfg.mode === 'auto'
  if (lazy && !ch.enabled && cfg.registration !== 'suspended' &&
      (ch.status === 'hub_not_registered' || !REGISTERED.has(cfg.registration))) {
    // Not on the hub yet, but turning on sets it up: the plain offer. Until
    // the default hub launches its key is a placeholder, so the link reads
    // untrusted: say the hub isn't there yet, not that it is an impostor.
    // A private agent can't take the offer, so it hears why instead.
    if (cfg.hub_link === 'untrusted') return vm({ heading: LIST, title: HUB_CARD_COPY.notAvailable, tone: 'muted' })
    if (ch.status === 'agent_not_public' || !ch.eligible) return notPublic()
    return vm({ heading: LIST, title: HUB_CARD_COPY.offBody(display), tone: 'muted' })
  }
  // In mode auto an enabled channel's own status says how its setup is going.
  if (!lazy && (ch.status === 'hub_not_registered' || !REGISTERED.has(cfg.registration))) {
    return vm({
      heading: LIST,
      // Not ch.ineligible_reason: that is a bare code ('agent_not_public').
      title: "This server isn't registered with the hub yet. Ask its operator.",
      lines: cfg.registration === 'pending_email'
        ? ['Registration is waiting for the operator to confirm an email code.'] : [],
      tone: 'muted',
    })
  }
  if (cfg.registration === 'suspended') {
    return vm({ heading: NOT_LISTED, ...REJECTS.deployment_suspended, lines: [REJECTS.deployment_suspended.line], tone: 'error' })
  }
  if (ch.status === 'hub_untrusted' || cfg.hub_link === 'untrusted') {
    return vm({
      heading: NOT_LISTED,
      title: "The hub's identity doesn't match the one saved for this URL",
      lines: ['Nothing is sent to it. This can mean the hub URL was changed or someone is impersonating the hub. ' +
        "Ask this server's operator."],
      tone: 'error',
    })
  }
  if (ch.status === 'agent_not_public' || !ch.eligible) return notPublic()
  if (cfg.mode === 'discover_only') {
    return ch.enabled && ch.status === 'connected'
      ? vm({
          heading: LISTED,
          title: 'Browse-only: not accepting messages',
          lines: ["This server can browse the hub but can't send or receive hub messages right now. " +
            'Others still see this agent, marked "not accepting messages".'],
          chips: ['browse-only: not accepting messages'],
          tone: 'warn',
        })
      : vm({ heading: LIST, title: "This server can browse the hub but can't list agents right now.", tone: 'muted' })
  }

  switch (ch.status) {
    case 'off':
      return vm({ heading: LIST, title: HUB_CARD_COPY.offBody(display), tone: 'muted' })
    case 'enabling':
      return vm({ heading: LIST, title: 'Asking the hub to list this agent…', tone: 'pending' })
    case 'connected': {
      const atCap = ch.runs_today >= ch.daily_run_cap
      const contact = ch.last_success_at !== null
        ? `Last contact ${formatAge(Math.max(0, nowMs / 1000 - ch.last_success_at))} ago` : null
      const lines = [
        [contact, key].filter(Boolean).join(' · '),
        `Runs started by hub messages today: ${ch.runs_today} / ${ch.daily_run_cap} (read-only)`,
      ].filter(Boolean)
      if (atCap) {
        lines.push(`Daily limit reached. New hub messages are refused until ${formatHubTime(ch.runs_reset_at)}.`)
      }
      return vm({
        heading: LISTED, title: `Listed as ${listedAs}`, lines,
        chips: atCap ? ['Daily limit reached'] : [], tone: atCap ? 'warn' : 'ok',
      })
    }
    case 'hub_unreachable': {
      const parts = [
        ch.last_success_at !== null ? `Last success ${formatHubTime(ch.last_success_at)}` : null,
        ch.next_retry_at !== null ? `next try ${formatHubTime(ch.next_retry_at)}` : null,
      ].filter(Boolean)
      return vm({
        heading: LISTED,
        title: "Can't reach the hub — retrying",
        lines: [
          ...(parts.length ? [parts.join(' · ')] : []),
          'Your listing may look stale to others. Replies already accepted wait and are sent when the hub is back.',
        ],
        tone: 'warn',
      })
    }
    case 'key_revoked':
      return vm({
        heading: NOT_LISTED,
        title: "This agent's hub key was revoked",
        lines: ['No messages are sent or received over the hub. Turn the channel off and on again to issue a new key.'],
        action: 'turn_off_on',
        tone: 'error',
      })
    case 'key_rotation_pending':
      return vm({
        heading: LISTED,
        title: 'Automatic key renewal failed — reconnect',
        lines: [[ch.rotate_by !== null ? `Current key expires ${formatHubDate(ch.rotate_by)}` : null, key]
          .filter(Boolean).join(' · ')].filter(Boolean),
        action: 'reconnect',
        tone: 'warn',
      })
    case 'hub_cannot_reach_deployment':
      return vm({
        heading: NOT_LISTED,
        title: "The hub couldn't confirm this server",
        lines: ["Ask this server's operator to check its hub connection."],
        quoted,
        tone: 'error',
      })
    case 'rejected': {
      const r = ch.reject_reason ? REJECTS[ch.reject_reason] : undefined
      return vm({
        heading: NOT_LISTED,
        title: r?.title ?? 'The hub refused this listing',
        lines: r ? [r.line] : [],
        quoted,
        action: ch.reject_reason && RETRYABLE_REJECTS.has(ch.reject_reason) ? 'turn_off_on' : null,
        tone: 'error',
      })
    }
    default:
      return vm({ heading: ch.enabled ? LISTED : LIST, title: HUB_CARD_COPY.unknown, quoted, tone: 'muted' })
  }
}

/** The turn-off dialog's body: a sentence with a 0 count is left out.
 *  Off makes the agent private, so it says who stops getting replies. */
export function turnOffDialogText(ch: HubChannel, agentName: string): { title: string; body: string[] } {
  const body = ['The agent is removed from the hub and made private: nobody else can find it or message it, ' +
    'on this server or another.']
  const local = ch.local_conversations ?? 0
  if (local > 0) {
    body.push(`${local} ${local === 1 ? 'person' : 'people'} on this server ${local === 1 ? 'has' : 'have'} ` +
      `open conversations with it. They will stop getting replies.`)
  }
  if (ch.open_conversations > 0) {
    body.push(`Your ${ch.open_conversations} open conversation${ch.open_conversations === 1 ? '' : 's'} ` +
      `with other servers stay${ch.open_conversations === 1 ? 's' : ''} in Front Desk as history.`)
  }
  if (ch.in_flight_messages > 0) {
    body.push(`${ch.in_flight_messages} repl${ch.in_flight_messages === 1 ? 'y is' : 'ies are'} still on ` +
      'their way: replies already being written keep sending for up to 10 minutes. ' +
      'Anything not delivered by then will not be sent.')
  }
  if (ch.owner_isolated) {
    body.push('Owner isolation will turn off. Turning it on again needs a fresh confirmation.')
  }
  return { title: `Stop sharing ${agentName}?`, body }
}
