import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

// The My Desk welcome tour: five steps that explain what the desk is for
// before an owner has used it. It opens on its own once per ACCOUNT (the
// "seen" flag is server-side, `useDeskTour`) and again from the ⓘ beside the
// "My Desk" heading. DeskPage owns when it is open; this component owns only
// which step is showing.
//
// The copy is lifted from the home page ("Their plan is a to-do list. Ours is
// a spec you sign", "A contract, then only the redlines") and from the seeded
// SYSTEM SOPs (`models/desk_sop.py`), so the tour, the landing page and the
// owner's own SOP rail say the same thing. The round limits quoted in the
// loops step are the ones the idea-to-product SOPs actually carry.

/** One model agent the owner has, shown as a mentor in the second step. */
export interface TourModelAgent {
  name: string
  label: string
}

interface DeskWelcomeTourProps {
  /** The owner's own model agents, at most three. Empty → the step names the
   *  usual three generically rather than inventing agents the owner has. */
  modelAgents: TourModelAgent[]
  /** `finished` is true only for the last step's "Start with…" button; every
   *  other way out (×, Skip, Esc, the scrim) is a plain close. */
  onClose: (finished: boolean) => void
}

const STEP_LABELS = [
  'Welcome to My Desk',
  'Your first to-dos',
  'SOPs',
  'Projects',
  'Loops in the plan',
]

const FALLBACK_MODEL_AGENTS: TourModelAgent[] = [
  { name: 'claude', label: 'Claude Code' },
  { name: 'codex', label: 'Codex' },
  { name: 'gemini', label: 'Gemini CLI' },
]

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export default function DeskWelcomeTour({ modelAgents, onClose }: DeskWelcomeTourProps) {
  const [step, setStep] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const last = STEP_LABELS.length - 1
  const go = (k: number) => setStep(Math.max(0, Math.min(last, k)))

  // Focus lands on Next so Enter walks the tour; on unmount it goes back to
  // whatever had it (the ⓘ on a replay), not to <body>.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    nextRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  // Arrows, Esc, and a Tab trap — a modal whose focus can wander onto the desk
  // behind it is a modal only to sighted mouse users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false)
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(last, s + 1))
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1))
      else if (e.key === 'Tab' && dialogRef.current) {
        const els = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement,
        )
        if (els.length === 0) return
        const first = els[0]
        const end = els[els.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          end.focus()
        } else if (!e.shiftKey && document.activeElement === end) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, last])

  const mentors = modelAgents.length > 0 ? modelAgents : FALLBACK_MODEL_AGENTS
  const mentorNames = mentors.map((m) => m.name).join(', ')

  return (
    <div className="sop-scrim tour-scrim" onMouseDown={() => onClose(false)}>
      <div
        ref={dialogRef}
        className="tour"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`tour-title-${step}`}
      >
        <div className="tour-top">
          <span className="tour-step" aria-live="polite">
            {STEP_LABELS[step]} · {step + 1} of {STEP_LABELS.length}
          </span>
          <button type="button" className="sop-dlg-x" onClick={() => onClose(false)} aria-label="Close tour">
            <X size={15} />
          </button>
        </div>

        <div className="tour-viewport">
          <div className="tour-track" style={{ transform: `translateX(-${step * 100}%)` }}>
            {/* 1 — dispatch center */}
            <section className="tour-slide" aria-roledescription="slide" aria-hidden={step !== 0}>
              <div className="tour-art">
                <div className="tour-mini">
                  <div className="tour-mini-left">
                    <div className="tour-zone">
                      <span className="tour-badge">2</span>
                      <span className="tour-zone-t">Send: one command box</span>
                      <div className="tour-bar" style={{ width: '70%' }} />
                      Pick any agent and send. No new tab, no new thread to babysit.
                    </div>
                    <div className="tour-zone">
                      <span className="tour-badge">3</span>
                      <span className="tour-zone-t">Review: reports land here</span>
                      <div className="tour-rep">
                        <Chip>@researcher</Chip>
                        <span className="tour-st tour-st--ok">REVIEW</span>
                        <span>Competitive scan is ready</span>
                      </div>
                      <div className="tour-rep">
                        <Chip>@designer</Chip>
                        <span className="tour-st tour-st--warn">WORKING</span>
                        <span>Onboarding flow, v2</span>
                      </div>
                    </div>
                  </div>
                  <div className="tour-zone">
                    <span className="tour-badge">1</span>
                    <span className="tour-zone-t">Plan: to-dos</span>
                    <div className="tour-bar" />
                    <div className="tour-bar" style={{ width: '80%' }} />
                    <div className="tour-bar" style={{ width: '60%' }} />
                    Draft and refine prompts here. Send one when it's ready.
                  </div>
                </div>
              </div>
              <h2 id="tour-title-0">Run your agents from one desk, not a stack of chat tabs</h2>
              <p className="tour-lede">
                You don't juggle a thread per agent. My Desk works like a dispatch center: you plan
                the work, send it out, and review what comes back.
              </p>
              <div className="tour-pts">
                <Point title="Plan on the right">
                  Every to-do is a prompt you can keep refining. It waits until you send it.
                </Point>
                <Point title="Send from the box">
                  Choose an agent and press <span className="tour-q">command</span>. It moves to{' '}
                  <i>Working</i>.
                </Point>
                <Point title="Review below">
                  Finished reports show up under the box. Read, reply or follow up in place.
                </Point>
              </div>
            </section>

            {/* 2 — the starter to-dos: a mentored assistant */}
            <section className="tour-slide" aria-roledescription="slide" aria-hidden={step !== 1}>
              <div className="tour-art">
                <div className="tour-graph">
                  <div className="tour-g-col">
                    <span className="tour-cap">Already on this computer</span>
                    {mentors.map((m) => (
                      <div key={m.name} className="tour-node">
                        {m.name}
                        <small>your {m.label} history</small>
                      </div>
                    ))}
                  </div>
                  <div className="tour-g-arrow">
                    mentor<span aria-hidden="true">⟶</span>
                  </div>
                  <div className="tour-g-col">
                    <span className="tour-cap">To-do · step 1</span>
                    <div className="tour-node tour-node--me">
                      Your assistant
                      <small>already knows your projects, conventions, decisions and priorities</small>
                    </div>
                  </div>
                  <div className="tour-g-arrow">
                    registers
                    <br />& mentors<span aria-hidden="true">⟶</span>
                  </div>
                  <div className="tour-g-col">
                    <span className="tour-cap">Agents it registers</span>
                    <div className="tour-node tour-node--new">
                      thinking partner<small>industry: decisions</small>
                    </div>
                    <div className="tour-node tour-node--new">
                      researcher<small>industry: your field</small>
                    </div>
                    <div className="tour-node tour-node--new">
                      + any role<small>you pick role + industry</small>
                    </div>
                  </div>
                </div>
              </div>
              <h2 id="tour-title-1">Your first to-dos set up an assistant that already knows you</h2>
              <p className="tour-lede">
                You don't start from a blank chat. The model agents already on this computer (
                {mentorNames}) have seen your work.{' '}
                <span className="tour-q">Get to know me &amp; staff my priorities</span> has them brief
                your assistant on your projects, conventions and past decisions. Then it asks only what
                they couldn't answer.
              </p>
              <div className="tour-pts">
                <Point title="Your assistant registers & mentors the rest">
                  Ask it for a new agent (or use{' '}
                  <span className="tour-q">SYSTEM:Register new agent</span>): name the role and
                  industry. Your assistant registers it and mentors it, so it arrives knowing how you
                  work.
                </Point>
                <Point title="Specialists, not clones">
                  Each agent keeps its own memory and does deep research in its own field. You don't
                  get copies of one overloaded generalist.
                </Point>
                <Point title="Better over time">
                  Agents stick around, so they learn your voice and standards instead of starting
                  fresh each session.
                </Point>
              </div>
            </section>

            {/* 3 — SOPs */}
            <section className="tour-slide" aria-roledescription="slide" aria-hidden={step !== 2}>
              <div className="tour-art">
                <div className="tour-cmp">
                  <div className="tour-old">
                    <span className="tour-h">A skill / script</span>
                    <pre>{`if idea_valid:
  for step in plan:
    run(step)
    if fail: retry(3)
else:
  exit()`}</pre>
                    <div className="tour-old-note">
                      Fixed control flow. It breaks on the first case nobody coded for.
                    </div>
                  </div>
                  <div className="tour-new">
                    <span className="tour-h">An SOP · From idea validation to product</span>
                    <div className="tour-chain">
                      <Hop who="angel_investor">pressure-tests the idea, then hands it to</Hop>
                      <Hop who="product · market">set the ICP and go-to-market, then hand off to</Hop>
                      <div className="tour-judg">
                        “The ICP is too broad. Sending it back to market before design.”
                      </div>
                      <Hop who="designer">designs, then hands off to</Hop>
                      <Hop who="engineering">
                        builds, then reports back to <b>you</b>
                      </Hop>
                    </div>
                  </div>
                </div>
              </div>
              <h2 id="tour-title-2">SOPs: repeatable work handed from agent to agent</h2>
              <p className="tour-lede">
                An SOP reads like a real standard operating procedure:{' '}
                <i>agent X handles this, then hands off to agent Y</i>. There's no hard-coded if/else
                or loop. Each agent uses judgment about what to pass on, when to send work back, and
                when to stop and ask you.
              </p>
              <div className="tour-pts">
                <Point title="Pre-set SOPs included">
                  Find them in the <span className="tour-q">SOP</span> tab: register an agent, create
                  a project, convene a panel, plus a step-by-step playbook that takes an idea all the
                  way to a product.
                </Point>
                <Point title="Fill in the blanks">
                  Each SOP is a saved prompt with blanks. Fill them in and send it like any to-do.
                </Point>
                <Point title="Run it again or schedule it">
                  Weekly reviews, month-end close, onboarding: write it once, run it whenever you
                  need.
                </Point>
              </div>
            </section>

            {/* 4 — projects: a signed spec, then only redlines */}
            <section className="tour-slide" aria-roledescription="slide" aria-hidden={step !== 3}>
              <div className="tour-art">
                <div className="tour-two">
                  <div className="tour-card">
                    <div className="tour-h">A plan in a coding CLI</div>
                    <div className="tour-tl">☑ Research competitors</div>
                    <div className="tour-tl tour-tl--x">☐ Referral flow</div>
                    <div className="tour-tl tour-tl--add">
                      ☐ Run paid ads <small>added by agent</small>
                    </div>
                    <div className="tour-tl">☐ Build waitlist page</div>
                    <div className="tour-said">“I adjusted the plan to be more efficient.”</div>
                    <div className="tour-lim">
                      You approve steps once. The agent rewrites them as it goes, so at the end{' '}
                      <b>you re-read everything</b>.
                    </div>
                  </div>
                  <div className="tour-card tour-card--p">
                    <div className="tour-h">A ClawMeets project · a spec you sign</div>
                    <div className="tour-spec">
                      <div className="tour-sh">
                        <b>SPEC · Q3 beta launch</b>
                        <span>✓ signed by you</span>
                      </div>
                      <div className="tour-sr">
                        <em>Goal</em>500 qualified waitlist signups by Oct 31
                      </div>
                      <div className="tour-sr">
                        <em>Out of scope</em>Paid ads
                      </div>
                      <div className="tour-sr">
                        <em>Done means</em>Flow passes code review
                      </div>
                    </div>
                    <div className="tour-north">
                      <Chip>marketing</Chip>
                      <Chip>designer</Chip>
                      <Chip>frontend</Chip>
                      <em>work on their own, to the spec ↑</em>
                    </div>
                    <div className="tour-rl">
                      <div className="tour-rlh">REDLINE · from @marketing · conflicts with “Out of scope”</div>
                      <div className="tour-del">− Paid ads</div>
                      <div className="tour-add">+ $2k paid LinkedIn test, week 2</div>
                      <div className="tour-rlf">
                        <span className="tour-mb tour-mb--p">Approve</span>
                        <span className="tour-mb">Reply</span>
                        <span className="tour-mb">Reject</span>
                        <span className="tour-same">all other clauses unchanged</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <h2 id="tour-title-3">Projects: sign the spec once, then review only the redlines</h2>
              <p className="tour-lede">
                This isn't the plan you approve in a coding CLI, a step list the agent keeps
                rewriting. A project plan is a <b>spec of the outcome</b>: the goal, the must-haves,
                what's out of scope, and what “done” means. You sign it, and the agents work on their
                own toward it. They can't change it. Anything that would go off the spec comes back to
                you as a redline.
              </p>
              <div className="tour-pts">
                <Point title="Agents stay autonomous">
                  They choose the steps. The spec only fixes where those steps have to end up, and a
                  different agent checks the work against it.
                </Point>
                <Point title="You stay in the loop cheaply">
                  You review a two-line redline, not four long reports. No agent can quietly make a big
                  change.
                </Point>
                <Point title="When to make one">
                  If you'd be happy with whatever comes back, DM it. If the work has to meet a goal,
                  make it a project. Try <span className="tour-q">SYSTEM:Create new project</span>.
                </Point>
              </div>
            </section>

            {/* 5 — loops written into the plan */}
            <section className="tour-slide" aria-roledescription="slide" aria-hidden={step !== 4}>
              <div className="tour-art">
                <div className="tour-cmp tour-cmp--loop">
                  <div className="tour-old">
                    <span className="tour-h">A loop in code</span>
                    <pre>{`for r in range(10):
  pitch = revise(pitch, fb)
  fb = critique(pitch)
  if fb.score > 0.8:
    break`}</pre>
                    <div className="tour-old-note">Someone has to turn “good enough” into a number.</div>
                  </div>
                  <div className="tour-new">
                    <span className="tour-h">A loop in the signed plan · Validate idea</span>
                    <div className="tour-clause">
                      <em>Each round</em>You revise the pitch → <Chip>angel_investor</Chip> critiques it
                    </div>
                    <div className="tour-clause">
                      <em>Stop when</em>the investor would invest · no real progress · 10 rounds max
                    </div>
                    <div className="tour-rounds">
                      <Round n={1} verdict="REVISE">
                        “Who exactly is the user? Too broad.”
                      </Round>
                      <Round n={2} verdict="REVISE">
                        “First-time golfers is sharper. Where's the evidence?”
                      </Round>
                      <Round n={3} verdict="STOP · accepted" hit>
                        “I'd invest if a 100-user beta keeps 40% at week 4.”
                      </Round>
                    </div>
                  </div>
                </div>
              </div>
              <h2 id="tour-title-4">Write the loop into the plan, not into code</h2>
              <p className="tour-lede">
                The best results come from rounds of draft, critique and revise. In a project, you
                write that loop in plain words in the plan: who does what each round, and when to stop.
                The agents run the rounds themselves and judge the exit condition you signed, so they
                don't stop early or loop forever.
              </p>
              <div className="tour-pts">
                <Point title="Each round, in plain words">
                  “You revise the pitch, the investor critiques it.” No scores or thresholds to invent.
                </Point>
                <Point title="Exit conditions you sign">
                  The goal is met, no real progress is being made, or the round limit is hit. Whichever
                  comes first.
                </Point>
                <Point title="Already in your SOPs">
                  The idea-to-product playbook runs this way: up to 10 rounds with the investor, then up
                  to 8 each on go-to-market, product spec and design.
                </Point>
              </div>
            </section>
          </div>
        </div>

        <div className="tour-foot">
          <div className="tour-dots" role="group" aria-label="Tour steps">
            {STEP_LABELS.map((label, k) => (
              <button
                key={label}
                type="button"
                className={k === step ? 'is-on' : undefined}
                aria-label={`Step ${k + 1}: ${label}`}
                aria-current={k === step ? 'step' : undefined}
                onClick={() => go(k)}
              />
            ))}
          </div>
          <div className="tour-foot-r">
            <button type="button" className="sop-btn tour-skip" onClick={() => onClose(false)}>
              Skip tour
            </button>
            {step > 0 && (
              <button type="button" className="sop-btn" onClick={() => go(step - 1)}>
                Back
              </button>
            )}
            <button
              ref={nextRef}
              type="button"
              className="sop-btn sop-btn--primary"
              onClick={() => (step === last ? onClose(true) : go(step + 1))}
            >
              {step === last ? 'Start with “Get to know me”' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="tour-chip">
      <span className="tour-chip-d" />
      {children}
    </span>
  )
}

function Point({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="tour-pt">
      <b>{title}</b>
      {children}
    </div>
  )
}

function Hop({ who, children }: { who: string; children: React.ReactNode }) {
  return (
    <div className="tour-hop">
      <span className="tour-hop-ag">
        <Chip>{who}</Chip>
      </span>
      <span className="tour-hop-arrow">→</span>
      <span>{children}</span>
    </div>
  )
}

function Round({
  n,
  verdict,
  hit,
  children,
}: {
  n: number
  verdict: string
  hit?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={hit ? 'tour-rd tour-rd--hit' : 'tour-rd'}>
      <span className="tour-rd-n">{n}</span>
      {children}
      <span className={hit ? 'tour-st tour-st--ok' : 'tour-st tour-st--warn'}>{verdict}</span>
    </div>
  )
}
