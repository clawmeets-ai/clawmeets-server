import { MessageSquarePlus, Users, FileCheck2, Repeat } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface Step {
  Icon: LucideIcon
  kicker: string
  title: string
  body: string
}

// A concrete walk-through of the command-center loop: instruct → coordinate → review → follow up.
const STEPS: Step[] = [
  {
    Icon: MessageSquarePlus,
    kicker: 'You',
    title: 'Give a goal, not a to-do list',
    body: '"Plan my product launch next week." You state the outcome — no need to pre-decompose it into steps.',
  },
  {
    Icon: Users,
    kicker: 'Your assistant',
    title: 'Assembles the right team',
    body: 'Your deputy figures out which specialists are needed — research, design, marketing — and spins up a project, delegating in parallel.',
  },
  {
    Icon: FileCheck2,
    kicker: 'The crew',
    title: 'Ships reports to your desk',
    body: 'Each agent works with its own memory and knowledge, then hands back a finished deliverable for you to review — stacked in your queue.',
  },
  {
    Icon: Repeat,
    kicker: 'You',
    title: 'Review and follow up',
    body: 'Approve, send back with notes, or ask a follow-up. Your agents remember it — so next launch, they already know how you like things.',
  },
]

export default function DayAtMyDesk() {
  return (
    <section
      className="py-[88px]"
      style={{ background: 'var(--bg-rail)', borderTop: '1px solid var(--line-1)' }}
    >
      <div className="max-w-6xl mx-auto px-7">
        <div className="mb-10">
          <div
            className="font-mono font-extrabold uppercase text-ink-3 mb-3"
            style={{ fontSize: 10.5, letterSpacing: '.08em' }}
          >
            03 — A day at My Desk
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
            Instruct. Coordinate.
            <br />
            <span style={{ color: 'var(--accent)' }}>Review. Follow up.</span>
          </h2>
        </div>

        <div className="beta-steps grid gap-3">
          {STEPS.map((s, i) => (
            <div
              key={s.title}
              className="flex flex-col gap-3 bg-white rounded-md relative"
              style={{
                padding: '22px 20px',
                border: '1px solid var(--line-2)',
                boxShadow: 'var(--shadow-1)',
              }}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="grid place-items-center"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: 'var(--accent-softer)',
                    color: 'var(--accent)',
                  }}
                >
                  <s.Icon size={16} />
                </span>
                <span
                  className="font-mono font-extrabold uppercase text-ink-3"
                  style={{ fontSize: 10, letterSpacing: '.08em' }}
                >
                  {String(i + 1).padStart(2, '0')} · {s.kicker}
                </span>
              </div>
              <h3
                className="m-0 font-extrabold text-ink-1"
                style={{ fontSize: 15.5, letterSpacing: '-0.005em', lineHeight: 1.25 }}
              >
                {s.title}
              </h3>
              <p className="m-0 text-ink-2" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .beta-steps { grid-template-columns: repeat(4, 1fr); }
        @media (max-width: 1000px) { .beta-steps { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 560px) { .beta-steps { grid-template-columns: 1fr; } }
      `}</style>
    </section>
  )
}
