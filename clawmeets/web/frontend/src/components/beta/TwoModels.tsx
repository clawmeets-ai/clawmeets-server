import { Check, MessageSquare } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { LayoutGrid } from 'lucide-react'

interface ModelCard {
  eyebrow: string
  Icon: LucideIcon
  title: string
  body: string
  points: string[]
  accent: boolean
}

// Points 2 & 3 — the two mental models, side by side.
const MODELS: ModelCard[] = [
  {
    eyebrow: 'ChatGPT · Claude · Gemini',
    Icon: MessageSquare,
    title: 'A thread with one omni-assistant',
    body: 'The experience is optimized for a single personal assistant that possesses every skill — you talk to it in one long conversation and it tries to do everything itself.',
    points: [
      'One generalist, one thread',
      'You steer every step by hand',
      'Big projects sprawl across tabs',
    ],
    accent: false,
  },
  {
    eyebrow: 'ClawMeets',
    Icon: LayoutGrid,
    title: 'A command center for your agent team',
    body: 'My Desk is where you instruct an individual agent — or ask your assistant to create and coordinate a multi-agent project. Then you review each report and follow up, like running a team.',
    points: [
      'Instruct one agent, or a whole crew',
      'Your assistant plans & coordinates',
      'Review reports, then follow up',
    ],
    accent: true,
  },
]

export default function TwoModels() {
  return (
    <section
      id="two-models"
      className="py-[88px]"
      style={{ background: 'var(--bg-rail)', borderTop: '1px solid var(--line-1)' }}
    >
      <div className="max-w-6xl mx-auto px-7">
        <div className="mb-10">
          <div
            className="font-mono font-extrabold uppercase text-ink-3 mb-3"
            style={{ fontSize: 10.5, letterSpacing: '.08em' }}
          >
            01 — Two mental models
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
            One assistant to chat with,
            <br />
            or <span style={{ color: 'var(--accent)' }}>a team to command</span>.
          </h2>
        </div>

        <div className="beta-models grid gap-3">
          {MODELS.map((m) => (
            <div
              key={m.title}
              className="flex flex-col gap-3.5 rounded-md"
              style={{
                padding: '24px 22px',
                background: m.accent ? 'var(--bg-proposal)' : 'var(--bg-card)',
                border: m.accent ? '1px solid var(--accent-soft)' : '1px solid var(--line-2)',
                boxShadow: 'var(--shadow-1)',
              }}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="grid place-items-center"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 9,
                    background: m.accent ? 'var(--accent)' : 'var(--bg-pill-muted)',
                    color: m.accent ? '#fff' : 'var(--ink-3)',
                  }}
                >
                  <m.Icon size={17} />
                </span>
                <span
                  className="font-mono font-bold uppercase"
                  style={{
                    fontSize: 10.5,
                    letterSpacing: '.1em',
                    color: m.accent ? 'var(--accent-deep)' : 'var(--ink-3)',
                  }}
                >
                  {m.eyebrow}
                </span>
              </div>
              <h3
                className="m-0 font-extrabold text-ink-1"
                style={{ fontSize: 21, letterSpacing: '-0.01em', lineHeight: 1.2 }}
              >
                {m.title}
              </h3>
              <p className="m-0 text-ink-2" style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                {m.body}
              </p>
              <div className="grid gap-2 mt-1">
                {m.points.map((p) => (
                  <div key={p} className="flex items-center gap-2.5 text-ink-2" style={{ fontSize: 13 }}>
                    <span
                      className="grid place-items-center shrink-0 text-white"
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 5,
                        background: m.accent ? 'var(--accent)' : 'var(--ink-4)',
                      }}
                    >
                      <Check size={10} strokeWidth={3} />
                    </span>
                    {p}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .beta-models { grid-template-columns: 1fr 1fr; }
        @media (max-width: 900px) { .beta-models { grid-template-columns: 1fr; } }
      `}</style>
    </section>
  )
}
