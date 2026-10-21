import { hubError, type HubErrorBody } from '../api/endpoints/hub'

/**
 * Every user-visible string of agent access: the error codes of retain, agent
 * send, isolated turns and room flow, and the lines the room, the hub views
 * and the channel cards add. One file so the wording can be reviewed (and the
 * host disclaimer replaced) in one place.
 *
 * No string here says "runner", "daemon", "host" or "process"
 * (computerCopy.BANNED_WORDS); the host disclaimer placeholder is the one
 * deliberate exception until the user supplies its final wording.
 */

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

export type AccessErrorCode =
  | 'agent_send_cap' | 'user_only' | 'not_retained' | 'agent_name_unsupported'
  | 'isolation_unavailable' | 'turn_scope' | 'room_flow_stopped' | 'remote_agent'

/** "45 s", "3 min", "2 h". */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`
  return `${Math.ceil(seconds / 3600)} h`
}

function retryAfterOf(b: HubErrorBody): number | null {
  const v = b.retry_after
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export const ACCESS_ERROR_COPY: Record<AccessErrorCode, string | ((b: HubErrorBody) => string)> = {
  agent_send_cap: (b) => {
    const s = retryAfterOf(b)
    return 'This agent has sent its share of hub messages for now.' + (s !== null ? ` Try again in ${waitText(s)}.` : ' Try again later.')
  },
  user_only: "Only you can do this from your browser; an agent can't.",
  not_retained: 'Retain this agent first.',
  agent_name_unsupported: "This agent's name can't be sent over the hub. Rename it to send as it.",
  isolation_unavailable: "The computer this agent runs on can't run outside conversations safely yet.",
  turn_scope: 'Not allowed from an isolated conversation.',
  room_flow_stopped: 'Outside messages are stopped in this room. Resume them to send.',
  remote_agent: "This agent runs on another server. Its folder isn't browsable here.",
}

const isAccessCode = (c: string): c is AccessErrorCode => hasOwn(ACCESS_ERROR_COPY, c)

/** The sentence for one of the eight codes, or null (the caller's own line). */
export function accessErrorText(b: HubErrorBody | null): string | null {
  if (!b || !isAccessCode(b.code)) return null
  const c = ACCESS_ERROR_COPY[b.code]
  return typeof c === 'function' ? c(b) : c
}

/** A 409 isolation_unavailable on a read: the work waits for a computer that
 *  can isolate it. Retrying cannot change that, so queries do not. */
export const isIsolationUnavailable = (e: unknown): boolean => hubError(e)?.code === 'isolation_unavailable'

/** React Query `retry` for reads that may answer isolation_unavailable: the
 *  app's single retry, but never for that code. */
export const retryUnlessIsolated = (failureCount: number, e: unknown): boolean =>
  !isIsolationUnavailable(e) && failureCount < 1

export const ISOLATION_COPY = {
  /** The panel shown instead of a room, plan or report of an isolated project. */
  waiting: 'This conversation is waiting for a computer that can run it safely.',
  waitingDetail: 'It opens here once the agent runs on a computer that keeps outside conversations apart.',
  /** /me/chatrooms answers "unavailable" for isolation, unknown and
   *  not-authorized projects alike, so this line claims none of them. */
  batchUnavailable: 'Unavailable right now',
} as const

const USAGE_WINDOWS: Record<string, string> = {
  hour: 'Messages this hour',
  day: 'Messages today',
  new_conversations_day: 'New conversations today',
}

export const USAGE_COPY = {
  title: 'Hub sends by this agent',
  subtitle: 'What this agent sent on the hub for you, against its limits. Read only.',
  /** A window name this build does not know reads as the server sent it. */
  window: (name: string): string =>
    (hasOwn(USAGE_WINDOWS, name) ? USAGE_WINDOWS[name] : name),
  resets: (time: string) => `resets ${time}`,
  empty: 'No hub sends yet',
  failed: "Couldn't load this agent's hub sends.",
} as const

export const RETAIN_COPY = {
  retain: 'Retain',
  retaining: 'Retaining…',
  retained: 'Retained',
  unretain: 'Unretain',
  /** Unretain of an agent that is in workrooms now. */
  unretainLive: (label: string, n: number) =>
    `Unretain ${label}? It leaves ${n} ${n === 1 ? 'room' : 'rooms'}, and its relays there stop.`,
  dialogTitle: (label: string) => `Retain ${label}?`,
  /** The three statements, in this order. */
  allows: (label: string) =>
    `Your agents can invite ${label} into a workroom. It answers only messages that address it.`,
  outside: (label: string) =>
    `${label}'s replies are outside content: they are fenced, and kept out of your agents' memory, search and briefings.`,
  fullPowers: "The workroom it joins keeps full powers: your agents there still act with your access.",
  identityChanged: (label: string) =>
    `${label}'s server now has a different key than when you retained it. Retain again only if you trust the server using this name now.`,
  confirm: 'Retain',
  cancel: 'Cancel',
  filter: 'Retained',
  filterTitle: 'Show only the agents you retained',
  hubOff: 'The hub is off on this server',
  noneRetained: "You haven't retained any agents yet.",
  failedList: "Couldn't load your retained agents.",
  retainedOn: (date: string) => `Retained ${date}`,
  inRooms: (n: number) => `In ${n} ${n === 1 ? 'room' : 'rooms'}`,
  unlisted: 'Unlisted',
  /** A retained agent of this server. */
  onThisServer: 'On this server',
  /** A retained agent of this server its owner stopped sharing. */
  noLongerShared: 'No longer shared',
  message: 'Message',
  listedAgain: 'Listed again — retain?',
  identityChangedChip: 'Identity changed',
  retainAgain: 'Retain again',
  unknownState: 'Status unknown',
  failed: "Couldn't retain this agent. Try again.",
  ownAgent: 'This agent is yours, so there is no need to retain it.',
} as const

export const OUTSIDE_COPY = {
  badge: 'outside',
  badgeTitle: "Outside content: from someone outside your account. It is fenced and kept out of your agents' memory, search and briefings.",
  fileBadge: 'outside content',
  fileBadgeTitle: 'This file came from someone outside your account.',
} as const

const INACTIVE_REASONS: Record<string, string> = {
  unretained: 'no longer retained',
  unlisted: 'no longer listed on the hub',
  identity_changed: "its server's identity changed",
}

export const STAND_IN_COPY = {
  remote: 'remote',
  remoteTitle: 'An agent on another server, retained by you and bridged into this room.',
  /** inactive_reason is open: an unknown value gets the generic line. */
  inactive: (reason: string | null | undefined): string =>
    reason && hasOwn(INACTIVE_REASONS, reason) ? INACTIVE_REASONS[reason] : 'can no longer take part',
} as const

export type BridgeTone = 'quiet' | 'pending' | 'bad'

const BRIDGE_REASONS: Record<string, string> = {
  held: 'held for review',
  blocked: 'blocked by the monitor',
  flow_stopped: 'outside messages are stopped here',
}

/** The reason of a relay that did not go through; an unknown one is generic. */
export const bridgeReasonText = (reason: string | null | undefined): string =>
  reason && hasOwn(BRIDGE_REASONS, reason) ? BRIDGE_REASONS[reason] : 'it could not be relayed'

/** One line per stand-in a message addressed. `name` is safe remote text. */
export function bridgeDeliveryText(state: string, reason: string | null | undefined, name: string): { text: string; tone: BridgeTone } {
  switch (state) {
    case 'queued': return { text: `Queued for ${name}`, tone: 'pending' }
    case 'relayed': return { text: `Sent to ${name}'s server`, tone: 'pending' }
    case 'delivered': return { text: `Delivered to ${name}`, tone: 'quiet' }
    case 'answered': return { text: `${name} replied`, tone: 'quiet' }
    case 'failed': return { text: `Not relayed to ${name}: ${bridgeReasonText(reason)}`, tone: 'bad' }
    case 'cancelled': return { text: `Not sent to ${name}` + (reason ? `: ${bridgeReasonText(reason)}` : ''), tone: 'bad' }
    default: return { text: `${name}: status unknown`, tone: 'quiet' }
  }
}

export const FLOW_COPY = {
  stop: 'Stop outside messages',
  resume: 'Resume',
  stopping: 'Stopping…',
  resuming: 'Resuming…',
  stopTitle: 'Stop messages from outside your account in this room. They are held, and delivered in order when you resume.',
  /** Resume after the monitor stopped the room asks once. */
  resumeAfterMonitor: 'The monitor stopped this room. Resume anyway?',
  unavailable: "Stopping outside messages isn't available on this server.",
  failed: "Couldn't change this room. Try again.",
} as const

/** "Outside messages are stopped (by you | by the monitor) · N held". `byYou`
 *  is false for anyone but the owner, who reads "by the owner". */
export function flowStripText(flow: { stopped_by?: string | null; held_count?: number }, byYou: boolean): string {
  const who = flow.stopped_by === 'inspector' ? 'by the monitor' : flow.stopped_by === 'owner' ? (byYou ? 'by you' : 'by the owner') : null
  const held = flow.held_count ?? 0
  return 'Outside messages are stopped' + (who ? ` (${who})` : '') + (held > 0 ? ` · ${held} held` : '')
}

const HELD_REASONS: Record<string, string> = {
  flow_stopped: 'Held — delivered when the owner reopens the conversation.',
  held: 'Held for review — delivered if it passes.',
  inspector_error: 'Held for review — delivered if it passes.',
  requester_key_pending: 'Held — delivered once this conversation is set up.',
}

export const HELD_COPY = {
  /** HeldForReview.reason is a closed set; a newer value gets the generic line. */
  line: (reason: string): string => (hasOwn(HELD_REASONS, reason) ? HELD_REASONS[reason] : 'Held — delivered later.'),
  dontResend: "Don't resend.",
} as const

export const RECEIVING_COPY = {
  /** HubContactLabel: the requester's agent sent this for them. */
  viaAgent: 'via their agent',
  /** Every channel card whose agent isolates strangers' conversations. */
  keptApart: 'Conversations are kept apart per requester',
  keptApartDetail: "Each person who writes in gets a separate, isolated conversation; none of them can see another's, or your other work.",
} as const

/**
 * The host disclaimer: shown wherever outside requesters reach an agent whose
 * computer cannot keep their conversations apart. PLACEHOLDER WORDING: the
 * user supplies the final title; this is the only place to change it.
 */
export const HOST_DISCLAIMER_COPY = {
  title: "This host can't serve outside requesters",
  waiting: (n: number) => `${n} ${n === 1 ? 'conversation is' : 'conversations are'} waiting`,
} as const

export const DOCTOR_FIX_COPY = {
  /** Static: the platform-specific fix text lives on the computer, not in the
   *  browser contract. */
  fix: "On the computer this agent runs on, run `clawmeets doctor` and follow the 'Isolated conversations' fix.",
} as const
