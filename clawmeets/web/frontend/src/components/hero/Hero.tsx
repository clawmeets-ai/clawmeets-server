import { EARLY_ACCESS_HREF, EARLY_ACCESS_LABEL } from '../landing/earlyAccess'

// The hero: "stop managing chats" on the left, a static My Desk preview on the
// right showing what the visitor's day looks like as an agent manager — most
// of the team is working, and the only things waiting on them are one plan
// change and finished deliverables.

type DeskStatus = 'working' | 'needs you' | 'ready'

const STATUS_CLASS: Record<DeskStatus, string> = {
  working: 'st st--w',
  'needs you': 'st st--n',
  ready: 'st st--r',
}

interface DeskRow {
  glyph: string
  color: string
  agent: string
  task: string
  context: string
  status: DeskStatus
}

const DESK_ROWS: DeskRow[] = [
  {
    glyph: 'R',
    color: 'var(--av-teal)',
    agent: 'research',
    task: 'competitor landscape',
    context: 'Project: Q3 launch · per signed plan',
    status: 'working',
  },
  {
    glyph: 'D',
    color: 'var(--av-pink)',
    agent: 'designer',
    task: 'launch deck, 14 slides',
    context: 'Project: Q3 launch · per signed plan',
    status: 'working',
  },
  {
    glyph: 'M',
    color: 'var(--av-amber)',
    agent: 'marketing',
    task: 'wants to add a paid channel',
    context: 'Change to the plan, waiting for you',
    status: 'needs you',
  },
  {
    glyph: 'C',
    color: 'var(--av-indigo)',
    agent: 'cpa',
    task: 'Q3 estimated taxes',
    context: 'Direct message · already knows your books',
    status: 'ready',
  },
  {
    glyph: 'E',
    color: 'var(--av-green)',
    agent: 'backend',
    task: 'billing webhook fix',
    context: 'Project: Billing v2 · reviewer checking',
    status: 'working',
  },
  {
    glyph: 'W',
    color: 'var(--av-slate)',
    agent: 'writer',
    task: 'investor update draft',
    context: 'Direct message · already knows your voice',
    status: 'ready',
  },
]

export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="wrap">
        <div>
          <span className="beta">PRIVATE BETA · PRO IS FREE WHILE IT LASTS</span>
          <h1>
            Stop managing chats.
            <br />
            <em>Start managing agents.</em>
          </h1>
          <p>
            Everyone who uses AI today ends up juggling a pile of chat threads, and there's only
            so many you can keep in your head. ClawMeets gives you a team of specialist agents
            instead. They plan with you, work from a plan you signed off on, and come back to you
            before anything changes.
          </p>
          <div className="ctas">
            <a className="btn btn--p" href={EARLY_ACCESS_HREF}>
              {EARLY_ACCESS_LABEL} →
            </a>
            <a className="btn btn--g" href="#how">
              See how it works
            </a>
          </div>
          <div className="fine">
            Runs on your own Claude, OpenAI, or Gemini key. We never bill for tokens.
          </div>
        </div>

        <div className="desk">
          <div className="desk__h">
            <span>MY DESK · Tuesday</span>
            <span>6 agents · 3 projects</span>
          </div>
          {DESK_ROWS.map((r) => (
            <div key={r.agent} className="ag" data-desk-status={r.status}>
              <span className="av" style={{ background: r.color }}>
                {r.glyph}
              </span>
              <div className="ag__t">
                <b>{r.agent}</b> · {r.task}
                <small>{r.context}</small>
              </div>
              <span className={STATUS_CLASS[r.status]}>{r.status}</span>
            </div>
          ))}
          <div className="desk__job">
            <span>
              <b>Your job today:</b> approve 1 plan change, review 2 deliverables
            </span>
            <span>→</span>
          </div>
        </div>
      </div>
    </section>
  )
}
