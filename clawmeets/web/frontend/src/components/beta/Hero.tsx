import { ArrowRight, Folder, Plus } from 'lucide-react'
import Button from '../hero/Button'
import AgentAvatar from '../hero/AgentAvatar'
import { SIGNUP_HREF } from './constants'

const AV = {
  indigo: 'var(--av-indigo)',
  accent: 'var(--accent)',
  teal: 'var(--av-teal)',
  pink: 'var(--av-pink)',
  amber: 'var(--av-amber)',
}

interface DeskAgent {
  name: string
  role: string
  glyph: string
  color: string
  status: string
}

const DESK_AGENTS: DeskAgent[] = [
  { name: 'research-agent', role: 'Specialist · research', glyph: 'R', color: AV.teal, status: 'working' },
  { name: 'design-agent', role: 'Specialist · design', glyph: 'D', color: AV.pink, status: 'working' },
  { name: 'marketing-agent', role: 'Specialist · marketing', glyph: 'M', color: AV.amber, status: 'done' },
]

// Point 1 — the vision: everyone should have a team of agents working for them.
export default function Hero() {
  return (
    <section className="pt-14 pb-[72px]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div
          className="inline-flex items-center gap-2 mb-[26px] rounded-full"
          style={{
            padding: '5px 11px',
            background: 'var(--accent-softer)',
            border: '1px solid var(--accent-soft)',
          }}
        >
          <span
            style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)' }}
          />
          <span
            className="font-mono"
            style={{ fontSize: 11, color: 'var(--accent-deep)', letterSpacing: '.06em' }}
          >
            PRIVATE BETA · FOR FRIENDS · YOU'RE INVITED
          </span>
        </div>

        <div className="beta-hero-grid grid items-center gap-12">
          <div>
            <h1
              className="font-extrabold text-ink-1 m-0 mb-[18px]"
              style={{
                fontSize: 'clamp(38px, 5.2vw, 64px)',
                lineHeight: 1.03,
                letterSpacing: '-0.02em',
              }}
            >
              Everyone deserves
              <br />
              <span style={{ color: 'var(--accent)' }}>a team of agents</span>
              <br />
              working for them.
            </h1>
            <p
              className="text-ink-2 mb-[26px]"
              style={{ fontSize: 17, lineHeight: 1.5, maxWidth: 540 }}
            >
              ChatGPT, Claude, and Gemini give you one omni-assistant to chat with.
              ClawMeets gives you a command center — <strong>My Desk</strong> — where you
              direct a crew of specialist agents, review what they ship, and follow up.
              You're one of the first friends I'm letting in.
            </p>
            <div className="flex gap-2.5 flex-wrap mb-[14px]">
              <Button variant="primary" href={SIGNUP_HREF}>
                Sign up <ArrowRight size={12} />
              </Button>
              <Button variant="ghost" href="#two-models">
                See the difference
              </Button>
            </div>
            <div
              className="font-mono uppercase text-ink-3"
              style={{ fontSize: 11, letterSpacing: '.08em' }}
            >
              Not another chatbot. A team you actually manage.
            </div>
          </div>

          {/* Static "My Desk" command-center preview */}
          <div
            className="beta-desk grid overflow-hidden rounded-lg bg-white"
            style={{
              minHeight: 420,
              border: '1px solid var(--line-1)',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <div
              className="flex items-center gap-2.5 bg-white"
              style={{ padding: '12px 16px', borderBottom: '1px solid var(--line-1)' }}
            >
              <span
                className="grid place-items-center text-white rounded"
                style={{ width: 22, height: 22, background: 'var(--accent)', fontSize: 12, fontWeight: 800 }}
              >
                ⌘
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-extrabold text-ink-1" style={{ fontSize: 14 }}>
                  My Desk
                </div>
                <div className="font-mono text-ink-3" style={{ fontSize: 10.5 }}>
                  1 assistant · 3 specialists on watch
                </div>
              </div>
              <span
                className="font-mono font-extrabold"
                style={{
                  fontSize: 10,
                  color: 'var(--prio-quick-fg)',
                  background: 'var(--prio-quick-bg)',
                  padding: '2px 7px',
                  borderRadius: 4,
                  letterSpacing: '.06em',
                }}
              >
                ● LIVE
              </span>
            </div>

            <div style={{ padding: '14px 16px' }}>
              <div
                className="flex items-center gap-2.5 rounded-md mb-3"
                style={{
                  padding: '10px 12px',
                  background: 'var(--bg-rail)',
                  border: '1px solid var(--line-1)',
                }}
              >
                <Plus size={14} style={{ color: 'var(--ink-3)' }} />
                <span className="flex-1 text-ink-2" style={{ fontSize: 12.5 }}>
                  Plan my product launch next week…
                </span>
                <span
                  className="grid place-items-center text-white rounded"
                  style={{ width: 24, height: 24, background: 'var(--accent)' }}
                >
                  <ArrowRight size={12} />
                </span>
              </div>

              <div
                className="font-mono font-extrabold uppercase text-ink-3 mb-2"
                style={{ fontSize: 10, letterSpacing: '.08em' }}
              >
                Deputy assembled a team
              </div>
              <div className="grid gap-1.5 mb-3">
                {DESK_AGENTS.map((a) => (
                  <div
                    key={a.name}
                    className="flex items-center gap-2.5 rounded-md bg-white"
                    style={{ padding: '8px 10px', border: '1px solid var(--line-1)' }}
                  >
                    <AgentAvatar glyph={a.glyph} color={a.color} size={26} />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono font-bold text-ink-1 truncate" style={{ fontSize: 11.5 }}>
                        {a.name}
                      </div>
                      <div className="font-mono text-ink-3 truncate" style={{ fontSize: 9.5 }}>
                        {a.role}
                      </div>
                    </div>
                    <span
                      className="font-mono font-extrabold"
                      style={{
                        fontSize: 9.5,
                        letterSpacing: '.06em',
                        color: a.status === 'done' ? 'var(--prio-quick-fg)' : 'var(--accent-deep)',
                        background: a.status === 'done' ? 'var(--prio-quick-bg)' : 'var(--prio-normal-bg)',
                        padding: '2px 6px',
                        borderRadius: 3,
                      }}
                    >
                      ● {a.status === 'done' ? 'REPORT READY' : 'WORKING'}
                    </span>
                  </div>
                ))}
              </div>

              <div
                className="flex items-center gap-2 rounded-md"
                style={{
                  padding: '8px 10px',
                  background: 'var(--bg-proposal)',
                  border: '1px solid var(--accent-soft)',
                }}
              >
                <Folder size={12} style={{ color: 'var(--accent)' }} />
                <span className="text-ink-2 flex-1" style={{ fontSize: 12 }}>
                  1 report waiting for your review
                </span>
                <span className="font-mono font-bold text-accent" style={{ fontSize: 10.5, color: 'var(--accent-deep)' }}>
                  Review →
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .beta-hero-grid { grid-template-columns: 1fr 1.05fr; }
        @media (max-width: 1050px) {
          .beta-hero-grid { grid-template-columns: 1fr; }
        }
      `}</style>
    </section>
  )
}
