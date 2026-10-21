import { AtSign, Folder, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import AgentAvatar from '../hero/AgentAvatar'

interface Capability {
  Icon: LucideIcon
  title: string
  body: string
}

const CAPABILITIES: Capability[] = [
  {
    Icon: Zap,
    title: 'Build your team instantly.',
    body: 'Spin up a crew of expert agents, each specialized in its own domain — in one click.',
  },
  {
    Icon: Folder,
    title: 'Onboard with your own docs.',
    body: 'Drop in your training docs and each agent learns your unique insight, follows it truthfully, and works tirelessly for you.',
  },
  {
    Icon: AtSign,
    title: 'Delegate like a boss.',
    body: 'DM any agent directly, or ask your assistant to orchestrate a multi-agent project — and if it needs a specialist you don’t have yet, it’ll suggest bringing one on before it starts. Agents do the work; you just review and approve.',
  },
]

interface CrewMember {
  key: string
  name: string
  title: string
  color: string
  av: string
  blurb: string
  tools: string[]
}

const CREW: CrewMember[] = [
  {
    key: 'research',
    name: 'research-agent',
    title: 'Researcher',
    color: 'var(--av-teal)',
    av: 'R',
    blurb: 'Scans web, docs, and your local knowledge. Cites every source.',
    tools: ['web.search', 'crunchbase', 'local.index', 'arxiv'],
  },
  {
    key: 'design',
    name: 'design-agent',
    title: 'Designer',
    color: 'var(--av-pink)',
    av: 'D',
    blurb: 'Drafts decks, specs, and flows using your brand kit.',
    tools: ['figma', 'brand.kit', 'local.deck'],
  },
  {
    key: 'engineer',
    name: 'engineer-agent',
    title: 'Engineer',
    color: 'var(--av-indigo)',
    av: 'E',
    blurb: 'Scaffolds code, opens PRs, runs your test suite locally.',
    tools: ['git', 'shell', 'editor', 'run.tests'],
  },
  {
    key: 'marketing',
    name: 'marketing-agent',
    title: 'Marketer',
    color: 'var(--av-amber)',
    av: 'M',
    blurb: 'Positioning, channel plans, copy — grounded in your voice.',
    tools: ['ga4', 'notion', 'mailchimp'],
  },
  {
    key: 'calendar',
    name: 'calendar-agent',
    title: 'Scheduler',
    color: 'var(--av-green)',
    av: 'K',
    blurb: 'Replans your week. Protects focus time. Handles conflicts.',
    tools: ['gcal', 'outlook', 'zoom'],
  },
  {
    key: 'finance',
    name: 'finance-agent',
    title: 'Finance',
    color: '#8a6a1c',
    av: 'F',
    blurb: 'Tracks burn, invoices, receipts. Flags anomalies quietly.',
    tools: ['stripe', 'quickbooks', 'plaid'],
  },
]

export default function CrewSection() {
  return (
    <section
      id="crew"
      className="py-[88px]"
      style={{
        background: 'var(--bg-rail)',
        borderTop: '1px solid var(--line-1)',
      }}
    >
      <div className="max-w-6xl mx-auto px-7">
        <div className="mb-9">
          <div
            className="font-mono font-extrabold uppercase text-ink-3 mb-3"
            style={{ fontSize: 10.5, letterSpacing: '.08em' }}
          >
            03 — Your team
          </div>
          <h2
            className="font-extrabold text-ink-1 m-0"
            style={{
              fontSize: 'clamp(30px, 3.8vw, 46px)',
              lineHeight: 1.1,
              maxWidth: 860,
              letterSpacing: '-0.015em',
            }}
          >
            Train a new agent as needed.
            <br />
            <span style={{ color: 'var(--accent)' }}>Delegate like a boss.</span>
          </h2>
        </div>

        <div className="cap-grid grid gap-3 mb-7">
          {CAPABILITIES.map((c) => (
            <div
              key={c.title}
              className="flex gap-3 items-start"
              style={{
                padding: '14px 16px',
                border: '1px solid var(--line-2)',
                borderRadius: 'var(--r-md)',
                background: 'var(--bg-rail)',
              }}
            >
              <span
                className="grid place-items-center shrink-0"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: 'var(--accent-softer)',
                  color: 'var(--accent)',
                }}
              >
                <c.Icon size={15} />
              </span>
              <div>
                <div className="font-extrabold text-ink-1" style={{ fontSize: 13.5 }}>
                  {c.title}
                </div>
                <div className="text-ink-2 mt-0.5" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                  {c.body}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="crew-grid grid gap-3">
          {CREW.map((c) => (
            <div
              key={c.key}
              className="flex flex-col gap-3 bg-white rounded-md"
              style={{
                padding: '18px 20px',
                minHeight: 172,
                border: '1px solid var(--line-2)',
                boxShadow: 'var(--shadow-1)',
              }}
            >
              <div className="flex items-center gap-2.5">
                <AgentAvatar glyph={c.av} color={c.color} size={34} />
                <div className="min-w-0">
                  <div className="font-mono font-bold text-ink-1" style={{ fontSize: 12 }}>
                    {c.name}
                  </div>
                  <div
                    className="font-mono uppercase text-ink-3"
                    style={{ fontSize: 10, letterSpacing: '.06em' }}
                  >
                    {c.title}
                  </div>
                </div>
              </div>
              <div className="text-ink-2 flex-1" style={{ fontSize: 13, lineHeight: 1.5 }}>
                {c.blurb}
              </div>
              <div className="flex flex-wrap gap-1">
                {c.tools.map((t) => (
                  <span
                    key={t}
                    className="font-mono text-ink-3"
                    style={{
                      fontSize: 10,
                      background: 'var(--bg-chip)',
                      border: '1px solid var(--line-1)',
                      padding: '1px 6px',
                      borderRadius: 3,
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .cap-grid { grid-template-columns: repeat(3, 1fr); }
        .crew-grid { grid-template-columns: repeat(3, 1fr); }
        @media (max-width: 1100px) { .crew-grid { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 900px)  { .cap-grid, .crew-grid { grid-template-columns: 1fr; } }
      `}</style>
    </section>
  )
}
