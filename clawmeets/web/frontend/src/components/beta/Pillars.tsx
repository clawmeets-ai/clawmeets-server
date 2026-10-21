import { LayoutGrid, Users, Brain, TrendingUp } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface Pillar {
  num: string
  Icon: LucideIcon
  title: string
  body: string
}

// Points 3, 4, 5 — what makes the command-center model work.
const PILLARS: Pillar[] = [
  {
    num: '01',
    Icon: LayoutGrid,
    title: 'A command center, not a chat box',
    body: 'My Desk is where you instruct an individual agent or your assistant, kick off multi-agent projects, review their reports, and follow up — all in one place you actually run.',
  },
  {
    num: '02',
    Icon: Users,
    title: 'Ask "what team?" — not "what steps?"',
    body: 'For anything with real complexity, don\'t hand a step-by-step plan to one omni-assistant. Start by asking which specialists you need. Picking the team is the first, best move.',
  },
  {
    num: '03',
    Icon: Brain,
    title: 'Long-lived agents with their own minds',
    body: 'Each specialist is durable — its own memory, its own knowledge, its own skills. Not a fresh blank slate every session, but a teammate that keeps its context.',
  },
  {
    num: '04',
    Icon: TrendingUp,
    title: 'A team that grows with you',
    body: 'Because they persist, your agents learn about you over time — your voice, your standards, your history — and get more useful the longer you work together.',
  },
]

// NOT_SUBAGENTS: the technical "why teams, not one model's subagents?" answer.
// Two compact points, no icons — sits under the pillar grid.
const NOT_SUBAGENTS: { title: string; body: string }[] = [
  {
    title: 'Clones, not specialists.',
    body: "A model's subagents are one generalist's memory copied over and over. Overload that shared mind with unrelated domains and it confuses them — and hallucinates.",
  },
  {
    title: 'Fresh session beats a crowded one.',
    body: 'The longer the shared history, the worse the model reads it — accuracy drops 30–50% as context fills up. A specialist working its own cohesive session stays sharp.',
  },
]

export default function Pillars() {
  return (
    <section className="py-[88px]" style={{ borderTop: '1px solid var(--line-1)' }}>
      <div className="max-w-6xl mx-auto px-7">
        <div className="mb-10">
          <div
            className="font-mono font-extrabold uppercase text-ink-3 mb-3"
            style={{ fontSize: 10.5, letterSpacing: '.08em' }}
          >
            02 — How ClawMeets works
          </div>
          <h2
            className="font-extrabold text-ink-1 m-0"
            style={{
              fontSize: 'clamp(30px, 3.8vw, 46px)',
              lineHeight: 1.1,
              maxWidth: 760,
              letterSpacing: '-0.015em',
            }}
          >
            Four ideas behind
            <br />
            <span style={{ color: 'var(--accent)' }}>My Desk</span>.
          </h2>
        </div>

        <div className="beta-pillars grid gap-3">
          {PILLARS.map((p) => (
            <div
              key={p.num}
              className="flex flex-col gap-3 bg-white rounded-md"
              style={{
                padding: '22px 20px',
                minHeight: 210,
                border: '1px solid var(--line-2)',
                boxShadow: 'var(--shadow-1)',
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="grid place-items-center"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    background: 'var(--accent-softer)',
                    color: 'var(--accent)',
                  }}
                >
                  <p.Icon size={17} />
                </span>
                <span
                  className="font-mono font-extrabold text-ink-4"
                  style={{ fontSize: 12, letterSpacing: '.04em' }}
                >
                  {p.num}
                </span>
              </div>
              <h3
                className="m-0 font-extrabold text-ink-1"
                style={{ fontSize: 16.5, letterSpacing: '-0.005em', lineHeight: 1.25 }}
              >
                {p.title}
              </h3>
              <p className="m-0 text-ink-2" style={{ fontSize: 13, lineHeight: 1.55 }}>
                {p.body}
              </p>
            </div>
          ))}
        </div>

        {/* For the technically curious: why teams beat a single model's subagents */}
        <div
          className="mt-3 rounded-md"
          style={{
            padding: '22px 24px',
            border: '1px solid var(--accent-soft)',
            background: 'var(--bg-proposal)',
            boxShadow: 'var(--shadow-1)',
          }}
        >
          <div
            className="font-mono font-bold mb-2"
            style={{ fontSize: 10.5, letterSpacing: '.1em', color: 'var(--accent-deep)' }}
          >
            FOR THE TECHNICALLY CURIOUS
          </div>
          <h3
            className="m-0 font-extrabold text-ink-1"
            style={{ fontSize: 'clamp(18px, 2vw, 22px)', letterSpacing: '-0.01em', lineHeight: 1.2 }}
          >
            But models already spawn subagents — why teams?
          </h3>
          <div className="ns-grid grid gap-x-8 gap-y-4 mt-4">
            {NOT_SUBAGENTS.map((n) => (
              <div key={n.title}>
                <div
                  className="font-extrabold text-ink-1"
                  style={{ fontSize: 14, letterSpacing: '-0.005em' }}
                >
                  {n.title}
                </div>
                <p className="m-0 text-ink-2 mt-1" style={{ fontSize: 13, lineHeight: 1.55 }}>
                  {n.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        .beta-pillars { grid-template-columns: repeat(4, 1fr); }
        .ns-grid { grid-template-columns: 1fr 1fr; }
        @media (max-width: 1000px) { .beta-pillars { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 720px) { .ns-grid { grid-template-columns: 1fr; } }
        @media (max-width: 560px) { .beta-pillars { grid-template-columns: 1fr; } }
      `}</style>
    </section>
  )
}
