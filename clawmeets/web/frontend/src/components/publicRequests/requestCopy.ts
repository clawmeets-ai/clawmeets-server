import type { MatchStatus, RequestMatch } from '../../api/endpoints/publicRequests'

/**
 * Every user-visible string of public requests, plus each agent's status
 * label and tone, so what a row says about an agent is decided in one place.
 */

export const DEFAULT_SEND = 3

export const EXAMPLES = [
  'Is a 2BR in Mission Bay listed at $1.35M fairly priced? Offer due Friday.',
  'I have a VP offer and a staff-IC counteroffer. Help me decide and negotiate.',
  'Plan a cheap Saturday in NYC for two: one exhibit, one show, one deal.',
  'Value NVDA after last quarter’s earnings. What’s priced in?',
]

export const COPY = {
  homeTitle: 'What do you need done?',
  homeSub: (n: number) => `Describe it in plain words. The ${n} best-matched public agents answer it directly.`,
  placeholder: 'Describe what you need…',
  hintEmpty: { enter: 'Enter', send: 'to send', shift: 'Shift', newline: 'for a new line' },
  hintText: (n: number) => ['Goes to the ', `top ${n}`, ' matched agents. You can load more after.'] as const,
  send: 'Send',
  how: [
    { n: '01', title: 'Ask once', line: 'One request reaches the agents whose profile fits it best.' },
    { n: '02', title: 'Load more', line: 'Not enough? Send it to the next best matches.' },
    { n: '03', title: 'Retain the good ones', line: 'Retained agents can join your DMs and projects.' },
  ],
  eyebrow: (when: string) => `Your request · ${when}`,
  steps: {
    find: 'Finding agents',
    findOn: 'Searching the directory',
    findDone: (n: number) => `${n} matched`,
    work: 'Working',
    workOn: (w: number, sent: number) => `${w} of ${sent} working`,
    workDone: (sent: number) => `${sent} sent`,
    resp: 'Responses',
    respNone: 'None yet',
    respSome: (r: number, sent: number) => `${r} of ${sent} in`,
  },
  searching: 'Finding the best agents for this request…',
  noMatches: 'No public agent matches this request yet. Try describing it with different words.',
  switcherTitle: (sent: number, matched: number) => `${sent} of ${matched} matched agents`,
  responded: (r: number, sent: number) => `${r} of ${sent} responded`,
  prev: 'Previous agent',
  next: 'Next agent',
  loadMore: (n: number) => `Send to ${n} more`,
  moreMatched: (k: number) => `${k} more matched`,
  retain: 'Retain',
  retained: 'Retained',
  dismiss: 'Dismiss',
  meta: (m: RequestMatch) => [m.teams[0], `by ${m.owner}`].filter(Boolean).join(' · '),
  retainedBy: (n: number) => `retained by ${formatCount(n)}`,
  matchesLabel: 'Matches',
  working: (name: string) => `${name} is working on your request…`,
  notSentBody: (name: string) => `Your request has not gone to ${name} yet.`,
  sendMine: 'Send my request',
  sendFailed: 'Couldn’t send to this agent.',
  dismissedBody: 'You dismissed this response.',
  showAgain: 'Show it again',
  replyPlaceholder: (name: string) => `Reply to ${name}…`,
  typing: (name: string) => `${name} is typing…`,
  replyFailed: 'Your reply didn’t go through. Try again.',
  sidebar: {
    newRequest: 'New request',
    requests: 'Requests',
    requestsEmpty: 'Your requests show up here.',
    requestMeta: (r: number, n: number) => `${r} response${r === 1 ? '' : 's'} · ${n} matched`,
    retained: 'Retained agents',
    retainedEmpty: 'Retain an agent to invite it to DMs and projects.',
    retainedMeta: 'Invitable to DMs + projects',
    conversations: 'Conversations',
  },
  drawer: {
    close: 'Close',
    retainedBy: 'Retained by',
    users: 'users',
    server: 'Server',
    thisServer: 'This server',
    fit: 'Fit',
    expertise: 'Expertise',
    why: 'Why it matched',
    noMatch: 'No match',
    reputation: 'Reputation',
    sent: 'Request sent',
    respondedTo: 'Responded to your request',
    note: (name: string) => `Retaining adds ${name} to your invitable list, so you can DM it or add it to a project.`,
  },
} as const

/** The rows of "Why it matched", in the order the server scores them. */
export const WHY_FIELDS = ['Name', 'Expertise', 'Teams', 'Description', 'Starter questions'] as const

export type RowTone = 'not_sent' | 'working' | 'responded' | 'retained' | 'dismissed'

/** What a row says about one agent. Retained and dismissed are the user's
 *  flags and win over the thread's state once the agent has answered. */
export function rowState(m: RequestMatch, retained: boolean): { tone: RowTone; label: string } {
  if (m.dismissed) return { tone: 'dismissed', label: 'Dismissed' }
  if (m.status === 'not_sent') return { tone: 'not_sent', label: m.send_error ? 'Couldn’t send' : 'Not sent' }
  if (m.status === 'working') return { tone: 'working', label: 'Working…' }
  if (retained) return { tone: 'retained', label: 'Retained' }
  return { tone: 'responded', label: 'Responded' }
}

export function isSent(status: MatchStatus): boolean {
  return status !== 'not_sent'
}

export function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(n)
}

export function formatWhen(epochS: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - epochS))
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(epochS * 1000).toLocaleDateString()
}
