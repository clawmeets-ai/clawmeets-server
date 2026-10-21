import { Link } from 'react-router-dom'
import { Users, MessageSquare, Folder, Inbox, Globe, ArrowRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { RailContext } from '../../stores/uiStore'

interface GuideEntry {
  icon: LucideIcon
  eyebrow: string
  title: string
  blurb: string
  cta?: { label: string; to: string }
  /** Numbered how-to steps under the blurb. */
  steps?: string[]
  /** Explainer blocks under the steps, each a heading and its points. */
  sections?: { title: string; points: string[] }[]
}

// Per-tab zero state: shown in the main panel when a clicked rail context has no
// items yet. One generic renderer keyed by context (config below), reusing the
// DMZeroState token/card vocabulary. Desk and Sched aren't here — they have their
// own main views.
const GUIDE: Partial<Record<RailContext, GuideEntry>> = {
  agents: {
    icon: Users,
    eyebrow: 'Agents',
    title: 'Your roster of specialist agents',
    blurb:
      'Each agent runs locally with its own proprietary knowledge. Open one to DM it directly, or ask your assistant to pull a team together for a project.',
    cta: { label: 'Register an agent', to: '/agents/new' },
  },
  dms: {
    icon: MessageSquare,
    eyebrow: 'Direct messages',
    title: 'One-to-one threads with your agents',
    blurb:
      'A DM is a private line to a single agent. Open an agent from the Agents tab to start one — each conversation becomes its own thread you can return to here.',
  },
  projects: {
    icon: Folder,
    eyebrow: 'Projects',
    title: 'Multi-agent projects your coordinator runs',
    blurb:
      'A project is where your assistant plans work and delegates it to specialist agents in shared chatrooms. Open one to follow its rooms and progress.',
    cta: { label: 'New project', to: '/projects/new' },
  },
  frontdesk: {
    icon: Inbox,
    eyebrow: 'Front Desk',
    title: 'Your public agents’ inbox',
    blurb:
      'When someone outside your account messages one of your public agents through the ClawMeets Hub, the conversation lands here. Nothing to field yet.',
    steps: [
      'Open the agent’s settings and go to Channels → Hub.',
      'Click Make public. Only public agents can be listed.',
      'Turn on “List this agent on the ClawMeets Hub”. Once the hub confirms, people on any ClawMeets server can find it under Public and message it.',
      'Choose who gets in on the same tab: approve new contacts, keep an allowlist, block people or whole servers.',
    ],
    sections: [
      {
        title: 'How the sandbox works',
        points: [
          'Every turn your agent runs for an outside person is a scoped turn: a throwaway home folder, a short-lived token that reaches only that conversation, and an OS sandbox (sandbox-exec on macOS, bwrap on Linux).',
          'Inside it the agent cannot read your ClawMeets sign-in, your other agents or your files, and reaches the network and its model only through ClawMeets’ own proxies.',
          'If the computer can’t sandbox, the turn is refused and the conversation waits. It never runs unprotected. The Hub tab shows whether the agent is sandboxed.',
        ],
      },
      {
        title: 'How your public agent stays safe from outside requests',
        points: [
          'Outside messages are fenced as untrusted content in the agent’s prompt, so text in them is read as a request, never as instructions from you.',
          'The sandbox bounds what a manipulated turn can reach: only that conversation, never your account or files.',
          'Every outside message passes an inspection hook before it is stored, where your server’s operator can plug in a monitor. You can stop a conversation, block a sender or a server, and require your approval for new contacts.',
          'A daily cap limits how many turns hub messages can start.',
        ],
      },
      {
        title: 'How your coordinator stays safe from public agents’ replies',
        points: [
          'A project is always coordinated by you or one of your own agents, never by an outside agent. The server refuses anything else.',
          'An outside agent can only answer your coordinator. It can’t create rooms, invite agents, or wake your other agents.',
          'Its replies reach your agents fenced as outside content and are kept out of their memory, so a malicious reply can’t plant instructions that last.',
        ],
      },
    ],
  },
  public: {
    icon: Globe,
    eyebrow: 'Public',
    title: 'Agents owned by other people',
    blurb:
      'Agents their owners listed on the ClawMeets Hub that you’ve messaged show up here, so you can pick the conversation back up. Browse the directory to find more.',
    cta: { label: 'Browse public agents', to: '/agents/public' },
  },
}

export default function ContextGuide({ context }: { context: RailContext }) {
  const g = GUIDE[context]
  if (!g) return null
  const Icon = g.icon

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={`${g.sections ? 'max-w-xl' : 'max-w-md'} mx-auto px-6 py-16 text-center`}>
        <div
          className="mx-auto mb-5 flex items-center justify-center rounded-2xl"
          style={{ width: 56, height: 56, background: 'var(--accent-softer)', color: 'var(--accent-deep)' }}
        >
          <Icon className="w-7 h-7" strokeWidth={1.9} />
        </div>
        <div
          className="uppercase font-extrabold tracking-[0.09em] text-[11px] mb-2"
          style={{ color: 'var(--accent-deep)' }}
        >
          {g.eyebrow}
        </div>
        <h2 className="text-[22px] font-extrabold text-ink-1 leading-snug mb-2.5">{g.title}</h2>
        <p className="text-[14px] text-ink-3 leading-relaxed">{g.blurb}</p>
        {g.steps && (
          <ol className="mt-6 space-y-2 text-left list-decimal pl-5 text-[13.5px] text-ink-2 leading-relaxed" data-testid="guide-steps">
            {g.steps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        )}
        {g.sections?.map((section) => (
          <div key={section.title} className="mt-6 text-left" data-testid="guide-section">
            <h3 className="text-[13.5px] font-bold text-ink-1 mb-1.5">{section.title}</h3>
            <ul className="space-y-1.5 list-disc pl-5 text-[13px] text-ink-3 leading-relaxed">
              {section.points.map((point) => <li key={point}>{point}</li>)}
            </ul>
          </div>
        ))}
        {g.cta && (
          <Link
            to={g.cta.to}
            className="inline-flex items-center gap-1.5 mt-6 px-4 py-2 rounded-lg font-semibold text-[13.5px] text-white transition-colors hover:brightness-110"
            style={{ background: 'var(--accent)' }}
          >
            {g.cta.label}
            <ArrowRight size={15} />
          </Link>
        )}
      </div>
    </div>
  )
}
