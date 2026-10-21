import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Folder, Zap } from 'lucide-react'
import AgentAvatar from '../hero/AgentAvatar'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'

interface AgentRow {
  name: string
  title: string
  color: string
  av: string
  dur: number
  deliv: string
  tools: string[]
}

const AGENTS: AgentRow[] = [
  {
    name: 'market-agent',
    title: 'Pressure-test the positioning',
    color: 'var(--av-teal)',
    av: 'M',
    dur: 7200,
    deliv: 'positioning-review.md',
    tools: ['web.search', 'local.index'],
  },
  {
    name: 'design-agent',
    title: 'Mock the landing page',
    color: 'var(--av-pink)',
    av: 'D',
    dur: 9600,
    deliv: 'landing-mock.fig',
    tools: ['figma', 'brand.kit'],
  },
  {
    name: 'copy-agent',
    title: 'Write the hero and CTAs',
    color: 'var(--av-amber)',
    av: 'C',
    dur: 6600,
    deliv: 'hero-copy.md',
    tools: ['brand.voice', 'notion'],
  },
  {
    name: 'deputy-agent',
    title: 'Assemble for your review',
    color: 'var(--accent)',
    av: 'da',
    dur: 8400,
    deliv: 'review queue · 3 items',
    tools: ['orchestrate'],
  },
]

const PHASES = ['plan', 'tools', 'drafting', 'verify', 'ship'] as const
const PHASE_LABEL: Record<(typeof PHASES)[number], string> = {
  plan: 'Planning',
  tools: 'Calling tools',
  drafting: 'Drafting',
  verify: 'Verifying',
  ship: 'Shipping',
}

const PAUSE_MS = 1800

export default function ConsoleSection() {
  const reducedMotion = usePrefersReducedMotion()
  const [tick, setTick] = useState(0)
  const [inView, setInView] = useState(true)
  const sectionRef = useRef<HTMLElement | null>(null)
  const tickRef = useRef(0)

  const starts = useMemo(() => AGENTS.map((_, i) => i * 1200), [])

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  // Pause the ticker when the section scrolls out of view, so height changes
  // from agent rows cycling don't push sections below us up and down.
  useEffect(() => {
    if (reducedMotion) return
    const el = sectionRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting)
      },
      { rootMargin: '120px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [reducedMotion])

  useEffect(() => {
    if (reducedMotion) {
      // Park every agent at its "delivered" state deterministically.
      setTick(Math.max(...AGENTS.map((a, i) => starts[i] + a.dur)))
      return
    }
    if (!inView) return

    let raf = 0
    // Resume from where we paused rather than resetting.
    const start = performance.now() - tickRef.current
    const loop = (now: number) => {
      setTick(now - start)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [reducedMotion, inView, starts])

  return (
    <section
      ref={sectionRef}
      id="console"
      className="py-[88px]"
      style={{
        background: 'var(--bg-rail)',
        borderTop: '1px solid var(--line-1)',
      }}
    >
      <div className="max-w-6xl mx-auto px-7">
        <div className="console-grid grid gap-10 items-start">
          <div className="console-intro sticky top-[90px]">
            <div
              className="font-mono font-extrabold uppercase text-ink-3 mb-3"
              style={{ fontSize: 10.5, letterSpacing: '.08em' }}
            >
              08 — Parallel execution
            </div>
            <h2
              className="font-extrabold text-ink-1 m-0"
              style={{
                fontSize: 'clamp(30px, 3.8vw, 46px)',
                lineHeight: 1.1,
                letterSpacing: '-0.015em',
              }}
            >
              A whole team's work,
              <br />
              <span style={{ color: 'var(--accent)' }}>in an afternoon.</span>
            </h2>
            <p
              className="text-ink-2 mt-3.5"
              style={{ fontSize: 14, lineHeight: 1.55, maxWidth: 380 }}
            >
              Not one assistant grinding through everything in series — a crew working in
              parallel while you review.
            </p>
            <div
              className="mt-4"
              style={{
                padding: '14px 16px',
                border: '1px solid var(--line-2)',
                borderRadius: 'var(--r-md)',
                background: 'var(--bg-card)',
                maxWidth: 400,
              }}
            >
              <div
                className="font-mono font-bold text-ink-3 mb-2.5"
                style={{ fontSize: 10.5, letterSpacing: '.08em' }}
              >
                EXAMPLE: A GO-TO-MARKET PUSH
              </div>
              <div className="grid gap-2">
                {(
                  [
                    ['You', '"Launch a go-to-market push for the beta."', 'var(--av-indigo)'],
                    ['market-agent', 'pressure-tests the positioning', 'var(--av-teal)'],
                    ['design-agent', 'mocks the landing page', 'var(--av-pink)'],
                    ['copy-agent', 'writes the hero and CTAs', 'var(--av-amber)'],
                    ['You', 'review and approve. Hours, not weeks.', 'var(--av-indigo)'],
                  ] as const
                ).map(([who, what, color], i) => (
                  <div key={i} className="flex gap-2 items-baseline">
                    <span
                      className="shrink-0"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: color,
                        transform: 'translateY(-2px)',
                      }}
                    />
                    <span className="text-ink-2" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
                      <strong className="text-ink-1">{who}</strong> {what}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <ul
              className="list-none p-0 grid gap-2.5"
              style={{ margin: '14px 0 0' }}
            >
              {(
                [
                  [
                    'Parallel by default',
                    'No serial bottlenecks — the crew works the way a real team would',
                  ],
                  [
                    'Acceptance criteria',
                    'Every milestone declares what "done" means, before it runs',
                  ],
                  [
                    'Full audit trail',
                    'Every tool call, every artifact, every decision — replayable',
                  ],
                ] as const
              ).map(([a, b]) => (
                <li key={a} className="flex gap-2.5 items-start">
                  <Check
                    size={14}
                    strokeWidth={2.25}
                    style={{ color: 'var(--accent)', marginTop: 3, flexShrink: 0 }}
                  />
                  <div>
                    <div className="font-bold text-ink-1" style={{ fontSize: 13.5 }}>
                      {a}
                    </div>
                    <div className="text-ink-3" style={{ fontSize: 12.5 }}>
                      {b}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div
            className="bg-white rounded-md p-4"
            style={{
              border: '1px solid var(--line-2)',
              boxShadow: 'var(--shadow-1)',
            }}
          >
            <div
              className="flex items-center justify-between"
              style={{ padding: '4px 6px 12px', borderBottom: '1px solid var(--line-1)' }}
            >
              <div className="flex items-center gap-2">
                <Zap size={15} style={{ color: 'var(--accent)' }} />
                <span className="font-extrabold" style={{ fontSize: 14 }}>
                  Your team · live
                </span>
                <span className="font-mono text-ink-3 ml-1" style={{ fontSize: 11 }}>
                  working in parallel
                </span>
              </div>
              <span
                className="font-mono text-ink-3"
                style={{ fontSize: 10.5, letterSpacing: '.08em' }}
              >
                ● LIVE
              </span>
            </div>

            <div className="grid gap-2 mt-2.5">
              {AGENTS.map((a, i) => {
                const localT = (tick - starts[i]) % (a.dur + PAUSE_MS)
                const t = Math.max(0, localT)
                const progress = Math.min(100, (t / a.dur) * 100)
                const done = t >= a.dur
                const phaseIdx = Math.min(
                  PHASES.length - 1,
                  Math.floor((t / a.dur) * PHASES.length),
                )
                const phase = done ? 'ship' : PHASES[phaseIdx]

                return (
                  <div
                    key={a.name}
                    className="grid items-center gap-3 rounded-md"
                    style={{
                      padding: '12px 14px',
                      gridTemplateColumns: 'auto 1fr auto',
                      borderLeft: `3px solid ${a.color}`,
                      border: '1px solid var(--line-2)',
                      borderLeftWidth: 3,
                      background: done
                        ? 'color-mix(in srgb, var(--prio-quick-bg) 45%, #fff)'
                        : 'var(--bg-card)',
                      transition: reducedMotion ? undefined : 'background .4s',
                    }}
                  >
                    <AgentAvatar glyph={a.av} color={a.color} size={28} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span
                          className="font-mono font-bold text-ink-1"
                          style={{ fontSize: 11.5 }}
                        >
                          {a.name}
                        </span>
                        <span
                          className="text-ink-2 truncate"
                          style={{ fontSize: 12.5 }}
                        >
                          {a.title}
                        </span>
                      </div>
                      <div
                        className="rounded-full overflow-hidden mt-[3px]"
                        style={{ height: 4, background: 'var(--line-1)' }}
                      >
                        <div
                          className="h-full"
                          style={{
                            width: `${progress}%`,
                            background: done ? 'var(--prio-quick-fg)' : a.color,
                            transition: reducedMotion ? undefined : 'width .25s',
                          }}
                        />
                      </div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span
                          className="font-mono font-bold uppercase"
                          style={{
                            fontSize: 10,
                            color: done
                              ? 'var(--prio-quick-fg)'
                              : 'var(--ink-3)',
                            letterSpacing: '.04em',
                          }}
                        >
                          {done ? '✓ Delivered' : PHASE_LABEL[phase]}
                        </span>
                        {!done &&
                          a.tools.map((tl) => (
                            <span
                              key={tl}
                              className="font-mono text-ink-3"
                              style={{
                                fontSize: 9.5,
                                background: 'var(--bg-chip)',
                                border: '1px solid var(--line-1)',
                                padding: '0 5px',
                                borderRadius: 3,
                              }}
                            >
                              {tl}
                            </span>
                          ))}
                      </div>
                    </div>
                    <div
                      className="flex flex-col items-end gap-1 min-w-0"
                      style={{ maxWidth: 160 }}
                    >
                      {done ? (
                        <span
                          className="font-mono font-bold inline-flex items-center gap-1 min-w-0"
                          style={{
                            fontSize: 10.5,
                            color: 'var(--accent)',
                            background: 'var(--accent-softer)',
                            padding: '2px 7px',
                            borderRadius: 4,
                            maxWidth: '100%',
                          }}
                        >
                          <Folder size={10} style={{ flexShrink: 0 }} />
                          <span
                            className="truncate"
                            style={{ minWidth: 0 }}
                          >
                            {a.deliv}
                          </span>
                        </span>
                      ) : (
                        <span
                          className="font-mono text-ink-3"
                          style={{ fontSize: 10 }}
                        >
                          {Math.round(progress)}%
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .console-grid { grid-template-columns: 1fr 1.6fr; }
        @media (max-width: 1000px) {
          .console-grid { grid-template-columns: 1fr; }
          .console-intro { position: static !important; top: auto !important; }
        }
      `}</style>
    </section>
  )
}
