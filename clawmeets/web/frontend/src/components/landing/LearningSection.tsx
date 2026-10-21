import { useEffect, useMemo, useState } from 'react'
import { Play, ArrowRight } from 'lucide-react'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'

interface Signal {
  tag: 'EDIT' | 'APPROVE' | 'REJECT' | 'PIN'
  who: string
  text: string
}

interface PlaybookRule {
  area: string
  before: string
  after: string
  delta: string
}

const SIGNALS: readonly Signal[] = [
  { tag: 'EDIT',    who: 'You', text: 'Changed tone in the launch brief from "playful" to "direct".' },
  { tag: 'APPROVE', who: 'You', text: 'Approved the calendar block at 9–10:30 over the 3pm slot.' },
  { tag: 'REJECT',  who: 'You', text: 'Sent back competitor matrix — said "use logos, not text".' },
  { tag: 'PIN',     who: 'You', text: 'Pinned this Notion doc as canonical brand voice.' },
  { tag: 'EDIT',    who: 'You', text: 'Re-ordered milestones — moved design before engineering.' },
  { tag: 'APPROVE', who: 'You', text: 'Shipped marketing brief on first review. No edits.' },
] as const

const PLAYBOOK: readonly PlaybookRule[] = [
  { area: 'Voice',    before: 'Playful, casual',        after: 'Direct, declarative',            delta: '+2 confidence' },
  { area: 'Calendar', before: 'Schedules afternoons',   after: 'Protects 9–10:30 for deep work', delta: '+18% accept' },
  { area: 'Briefs',   before: 'Text-heavy comparisons', after: 'Logo grid + 2-line summary',     delta: '-1 review pass' },
  { area: 'Sources',  before: 'Searches the web first', after: 'Brand-voice doc · pinned',       delta: '+1 trusted src' },
] as const

const AGENT_NAMES = ['design-agent', 'engineer-agent', 'marketing-agent', 'calendar-agent'] as const

const TAG_FG: Record<Signal['tag'], string> = {
  APPROVE: '#1a8a52',
  REJECT:  '#b8312f',
  PIN:     '#8a6a1a',
  EDIT:    'var(--accent)',
}
const TAG_BG: Record<Signal['tag'], string> = {
  APPROVE: 'rgba(26,138,82,.10)',
  REJECT:  'rgba(184,49,47,.10)',
  PIN:     'rgba(138,106,26,.10)',
  EDIT:    'var(--accent-soft)',
}

export default function LearningSection() {
  const reducedMotion = usePrefersReducedMotion()
  const [tick, setTick] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused || reducedMotion) return
    const id = setInterval(() => setTick((t) => t + 1), 1800)
    return () => clearInterval(id)
  }, [paused, reducedMotion])

  const signalIdx = tick % SIGNALS.length
  const visibleSignals = useMemo(() => {
    const arr: Array<Signal & { age: number; key: string }> = []
    for (let i = 0; i < 5; i++) {
      arr.push({
        ...SIGNALS[(signalIdx - i + SIGNALS.length * 4) % SIGNALS.length],
        age: i,
        key: `${tick}-${i}`,
      })
    }
    return arr
  }, [tick, signalIdx])

  const reflecting = tick % 3 === 2
  const playbookIdx = Math.floor(tick / 3) % PLAYBOOK.length
  const current = PLAYBOOK[playbookIdx]

  return (
    <section
      id="learning"
      className="py-[88px]"
      style={{ borderTop: '1px solid var(--line-1)' }}
    >
      <div className="max-w-6xl mx-auto px-7">
        <div className="lrn-head grid items-end mb-10" style={{ gridTemplateColumns: '1.2fr 1fr', gap: 40 }}>
          <div>
            <div
              className="font-mono font-extrabold uppercase text-ink-3 mb-3"
              style={{ fontSize: 10.5, letterSpacing: '.08em' }}
            >
              07 — Self-improving crew
            </div>
            <h2
              className="font-extrabold text-ink-1 m-0"
              style={{ fontSize: 'clamp(30px, 3.8vw, 46px)', lineHeight: 1.05, letterSpacing: '-0.025em' }}
            >
              Every agent gets <span style={{ color: 'var(--accent)' }}>sharper</span>
              <br />
              the more you ship together.
            </h2>
          </div>
          <p className="m-0 text-ink-2" style={{ fontSize: 15, lineHeight: 1.55, maxWidth: 440 }}>
            Every edit, approval, and rejection is a signal. The whole crew — deputy and specialists — reflects on each milestone, updates a shared playbook, and ships the next one a little closer to how you'd have done it yourself.
          </p>
        </div>

        <div
          className="lrn-grid grid"
          style={{ gridTemplateColumns: '1fr 1fr 1.1fr', gap: 12 }}
          aria-live="off"
          aria-hidden="true"
        >
          {/* CARD 1: Signals stream */}
          <div
            className="bg-white flex flex-col rounded-md"
            style={{
              padding: '18px 18px 14px',
              gap: 10,
              minHeight: 340,
              border: '1px solid var(--line-2)',
            }}
          >
            <div className="flex items-center justify-between">
              <div
                className="font-mono font-extrabold text-ink-3"
                style={{ fontSize: 10.5, letterSpacing: '.1em' }}
              >
                1 · SIGNALS
              </div>
              <div
                className="font-mono flex items-center"
                style={{ fontSize: 10.5, color: 'var(--accent)', gap: 6 }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--accent)',
                  }}
                />
                LIVE
              </div>
            </div>
            <p className="m-0 text-ink-2" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              Every action you take on a deliverable is a labeled signal — captured locally, never sent off-device.
            </p>
            <div
              className="flex flex-col relative overflow-hidden"
              style={{ flex: 1, gap: 6, marginTop: 4 }}
            >
              {visibleSignals.map((s, i) => {
                const opacity = Math.max(0, 1 - i * 0.22)
                return (
                  <div
                    key={s.key}
                    className="grid items-start"
                    style={{
                      gridTemplateColumns: 'auto 1fr',
                      gap: 10,
                      padding: '8px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--line-2)',
                      background: 'var(--bg-card)',
                      opacity,
                      transition: reducedMotion ? undefined : 'opacity .4s, transform .4s',
                      animation: i === 0 && !reducedMotion ? 'lrnSigIn .4s ease-out both' : 'none',
                    }}
                  >
                    <span
                      className="font-mono"
                      style={{
                        fontSize: 9.5,
                        fontWeight: 800,
                        letterSpacing: '.05em',
                        padding: '3px 6px',
                        borderRadius: 3,
                        color: TAG_FG[s.tag],
                        background: TAG_BG[s.tag],
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {s.tag}
                    </span>
                    <span className="text-ink-1" style={{ fontSize: 12, lineHeight: 1.45 }}>
                      {s.text}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="font-mono text-ink-4" style={{ fontSize: 10, marginTop: 4 }}>
              local-only · no telemetry
            </div>
          </div>

          {/* CARD 2: Reflection */}
          <div
            className="bg-white flex flex-col rounded-md relative overflow-hidden"
            style={{
              padding: '18px 18px 14px',
              gap: 10,
              minHeight: 340,
              border: '1px solid var(--line-2)',
            }}
          >
            <div className="flex items-center justify-between">
              <div
                className="font-mono font-extrabold text-ink-3"
                style={{ fontSize: 10.5, letterSpacing: '.1em' }}
              >
                2 · REFLECTION
              </div>
              <div
                className="font-mono flex items-center"
                style={{
                  fontSize: 10.5,
                  color: reflecting ? 'var(--accent)' : 'var(--ink-4)',
                  gap: 6,
                  transition: reducedMotion ? undefined : 'color .4s',
                }}
              >
                {reflecting ? (
                  <>
                    RUNNING
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: 'var(--accent)',
                      }}
                    />
                  </>
                ) : (
                  'IDLE'
                )}
              </div>
            </div>
            <p className="m-0 text-ink-2" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              Each agent replays its own work, compares your edits to its draft, and writes an honest post-mortem. The deputy rolls them up into one shared update.
            </p>

            <div
              className="flex flex-col justify-center relative"
              style={{
                flex: 1,
                gap: 10,
                padding: '10px 12px',
                background: 'var(--bg-proposal)',
                border: '1px solid var(--accent-soft)',
                borderRadius: 8,
                marginTop: 4,
              }}
            >
              <div className="flex items-center" style={{ gap: 8 }}>
                <span
                  className="inline-flex items-center justify-center font-extrabold rounded-full"
                  style={{
                    width: 24,
                    height: 24,
                    fontSize: 9,
                    background: 'var(--av-indigo)',
                    color: '#fff',
                  }}
                >
                  da
                </span>
                <span className="font-mono font-bold" style={{ fontSize: 11 }}>
                  {AGENT_NAMES[playbookIdx]}
                </span>
                <span className="font-mono text-ink-3" style={{ fontSize: 10 }}>
                  · post-mortem #{1287 + tick}
                </span>
              </div>
              <div className="text-ink-1" style={{ fontSize: 13, lineHeight: 1.5 }}>
                "
                <span style={{ borderBottom: '2px solid var(--accent-soft)' }}>{current.area}</span>
                : I drafted with{' '}
                <em className="text-ink-3" style={{ fontStyle: 'normal' }}>
                  {current.before}
                </em>
                , you shipped it as <strong>{current.after}</strong>. I'll bias toward your phrasing on next milestone."
              </div>
              <div className="flex flex-wrap" style={{ gap: 6 }}>
                <span
                  className="font-mono font-extrabold"
                  style={{
                    fontSize: 10,
                    padding: '3px 7px',
                    borderRadius: 999,
                    background: 'var(--accent)',
                    color: '#fff',
                    letterSpacing: '.04em',
                  }}
                >
                  HEURISTIC UPDATED
                </span>
                <span
                  className="font-mono font-extrabold text-ink-2"
                  style={{
                    fontSize: 10,
                    padding: '3px 7px',
                    borderRadius: 999,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--line-2)',
                    letterSpacing: '.04em',
                  }}
                >
                  {current.delta}
                </span>
              </div>
            </div>

            <div className="flex items-center" style={{ gap: 8, marginTop: 4 }}>
              <Play size={11} style={{ color: 'var(--ink-3)', flexShrink: 0 }} />
              <div
                className="relative overflow-hidden"
                style={{ flex: 1, height: 3, background: 'var(--line-2)', borderRadius: 999 }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${((tick % 3) + 1) * 33}%`,
                    background: 'var(--accent)',
                    transition: reducedMotion ? undefined : 'width .6s',
                  }}
                />
              </div>
              <span className="font-mono text-ink-4" style={{ fontSize: 10 }}>
                replay
              </span>
            </div>
          </div>

          {/* CARD 3: Playbook diff */}
          <div
            className="bg-white flex flex-col rounded-md"
            style={{
              padding: '18px 18px 14px',
              gap: 10,
              minHeight: 340,
              border: '1px solid var(--line-2)',
            }}
          >
            <div className="flex items-center justify-between">
              <div
                className="font-mono font-extrabold text-ink-3"
                style={{ fontSize: 10.5, letterSpacing: '.1em' }}
              >
                3 · PLAYBOOK
              </div>
              <div className="font-mono text-ink-3" style={{ fontSize: 10.5 }}>
                v0.{42 + Math.floor(tick / 3)}
              </div>
            </div>
            <p className="m-0 text-ink-2" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              The whole crew shares one playbook — your taste, written as rules every agent follows. Diff history is auditable. Roll back any rule you don't like.
            </p>
            <div className="grid" style={{ flex: 1, gap: 6, marginTop: 4 }}>
              {PLAYBOOK.map((p, i) => {
                const isLatest = i === playbookIdx
                return (
                  <div
                    key={p.area}
                    className="grid"
                    style={{
                      border: '1px solid',
                      borderColor: isLatest ? 'var(--accent)' : 'var(--line-2)',
                      background: isLatest ? 'var(--bg-proposal)' : 'var(--bg-card)',
                      borderRadius: 8,
                      padding: '9px 11px',
                      gridTemplateColumns: '1fr auto',
                      gap: 6,
                      transition: reducedMotion ? undefined : 'all .4s',
                      boxShadow: isLatest ? 'var(--shadow-1)' : 'none',
                    }}
                  >
                    <div className="flex flex-col min-w-0" style={{ gap: 2 }}>
                      <div className="flex items-center" style={{ gap: 6 }}>
                        <span
                          className="font-mono font-extrabold text-ink-1"
                          style={{ fontSize: 10.5, letterSpacing: '.05em' }}
                        >
                          {p.area.toUpperCase()}
                        </span>
                        {isLatest && (
                          <span
                            className="font-mono font-extrabold"
                            style={{
                              fontSize: 9,
                              padding: '1px 5px',
                              borderRadius: 3,
                              background: 'var(--accent)',
                              color: '#fff',
                              letterSpacing: '.04em',
                            }}
                          >
                            JUST UPDATED
                          </span>
                        )}
                      </div>
                      <div
                        className="flex items-center flex-wrap text-ink-2"
                        style={{ fontSize: 11.5, lineHeight: 1.4, gap: 6 }}
                      >
                        <span
                          className="text-ink-4"
                          style={{ textDecoration: 'line-through' }}
                        >
                          {p.before}
                        </span>
                        <ArrowRight
                          size={10}
                          style={{ color: 'var(--accent)', flexShrink: 0 }}
                        />
                        <span className="font-bold text-ink-1">{p.after}</span>
                      </div>
                    </div>
                    <div className="flex items-center">
                      <span
                        className="font-mono font-bold"
                        style={{
                          fontSize: 9.5,
                          padding: '2px 6px',
                          borderRadius: 999,
                          background: 'rgba(26,138,82,.1)',
                          color: '#1a8a52',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {p.delta}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {!reducedMotion && (
          <div className="flex justify-end items-center" style={{ marginTop: 14, gap: 8 }}>
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              aria-pressed={paused}
              className="font-mono font-extrabold text-ink-3"
              style={{
                fontSize: 10.5,
                padding: '5px 11px',
                background: 'transparent',
                border: '1px solid var(--line-2)',
                borderRadius: 999,
                cursor: 'pointer',
                letterSpacing: '.05em',
              }}
            >
              {paused ? '▶ RESUME LOOP' : '❚❚ PAUSE LOOP'}
            </button>
          </div>
        )}
      </div>

      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          @keyframes lrnSigIn {
            from { opacity: 0; transform: translateY(-6px); }
            to   { opacity: 1; transform: translateY(0); }
          }
        }
        @media (max-width: 1100px) {
          .lrn-grid { grid-template-columns: 1fr 1fr !important; }
          .lrn-grid > :nth-child(3) { grid-column: 1 / -1 !important; }
        }
        @media (max-width: 760px) {
          .lrn-grid { grid-template-columns: 1fr !important; }
          .lrn-grid > :nth-child(3) { grid-column: auto !important; }
          .lrn-head { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </section>
  )
}
