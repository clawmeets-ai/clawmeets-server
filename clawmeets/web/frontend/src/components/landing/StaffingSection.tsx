import { Check, Sparkles, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface Step {
  Icon: LucideIcon
  title: string
  body: string
}

const STEPS: Step[] = [
  {
    Icon: Sparkles,
    title: 'Ask for an expert.',
    body: 'Tell your assistant the expertise you want. It creates the agent, starts it, and bootstraps it into an industry expert on its own.',
  },
  {
    Icon: Zap,
    title: 'Or just start the work.',
    body: 'Kick off a project and your assistant suggests the specialists it needs — no guessing your roster in advance.',
  },
  {
    Icon: Check,
    title: 'You approve, it staffs.',
    body: 'Nothing spins up without your yes. Bring agents on as the work calls for them, not speculatively up front.',
  },
]

export default function StaffingSection() {
  return (
    <section
      id="staffing"
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
            05 — Your team staffs itself
          </div>
          <h2
            className="font-extrabold text-ink-1 m-0"
            style={{
              fontSize: 'clamp(30px, 3.8vw, 46px)',
              lineHeight: 1.1,
              maxWidth: 820,
              letterSpacing: '-0.015em',
            }}
          >
            You don't hire ahead of time.
            <br />
            <span style={{ color: 'var(--accent)' }}>The team grows as the work does.</span>
          </h2>
          <p
            className="text-ink-2 mt-4"
            style={{ fontSize: 15, lineHeight: 1.55, maxWidth: 640 }}
          >
            Describe what you need — your assistant creates the agent, spins it up, and has it
            deep-research your industry to become a real expert. Start a project, and if it needs
            a specialist you don't have yet, your assistant tells you who to bring on. You just
            approve.
          </p>
        </div>

        <div className="staff-grid grid gap-3">
          {STEPS.map((s) => (
            <div
              key={s.title}
              className="flex flex-col gap-3 bg-white rounded-md"
              style={{
                padding: '22px 20px',
                minHeight: 160,
                border: '1px solid var(--line-2)',
                boxShadow: 'var(--shadow-1)',
              }}
            >
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
              <h3
                className="m-0 font-extrabold text-ink-1"
                style={{ fontSize: 16, letterSpacing: '-0.005em' }}
              >
                {s.title}
              </h3>
              <p className="m-0 text-ink-2" style={{ fontSize: 13, lineHeight: 1.55 }}>
                {s.body}
              </p>
            </div>
          ))}
        </div>

        <p
          className="text-ink-3 mt-4"
          style={{ fontSize: 12.5, lineHeight: 1.55, maxWidth: 640 }}
        >
          No blank org chart to fill in. No agents you didn't ask for. The right specialist shows
          up exactly when the task needs one.
        </p>
      </div>

      <style>{`
        .staff-grid { grid-template-columns: repeat(3, 1fr); }
        @media (max-width: 900px) { .staff-grid { grid-template-columns: 1fr; } }
      `}</style>
    </section>
  )
}
