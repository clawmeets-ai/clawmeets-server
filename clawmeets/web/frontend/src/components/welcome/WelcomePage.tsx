import { useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Copy, Loader2, RotateCw } from 'lucide-react'
import { useAssistantAgent } from '../../hooks/useAssistantAgent'
import { useComputers } from '../../hooks/useComputers'
import { useInstallCommand, useInstallProgress } from '../../hooks/useInstall'
import { useUIStore } from '../../stores/uiStore'
import ManualSetup, { CodeBlock } from './RunnerSetup'
import {
  HEADLINE,
  MENTAL_MODEL,
  READY_ACTION,
  READY_HREF,
  READY_NOTE,
  READY_TITLE,
  OS_TABS,
  WINDOWS_DEV_MODE,
  checklist,
  defaultOs,
  failedStep,
  hasStarted,
  isReady,
  narrate,
  type ChecklistRow,
  type InstallOs,
  type NarratedStep,
} from './welcomeCopy'
import './WelcomePage.css'

// Public-folder asset: needs BASE_URL because Vite sets base: '/app/'.
const MARK_SRC = `${import.meta.env.BASE_URL}clawmeets-mark.svg`

/**
 * The zero state: one command, a live checklist, one sentence, one action.
 *
 * ## What this replaced, and why
 *
 * It used to be a four-step setup manual — a collapsed Python drawer, three
 * tabbed install methods, three more commands to paste, and a Windows
 * prerequisite — ending in a button. Every one of those steps could fail
 * silently, and the page had no way to tell the user that any of them had. So
 * the common outcome was a user who believed they were set up, saw nothing
 * happen, and left.
 *
 * Three things carry the replacement:
 *
 * 1. **One command.** `useInstallCommand` mints it on mount. The command is
 *    assembled server-side, so this file never builds it.
 * 2. **A checklist the SERVER drives.** Every row is an observation — a live
 *    computer socket, a model-CLI report from that machine, a live agent socket.
 *    No optimistic ticks: a row cannot go green because a script said so. The
 *    rules live in `welcomeCopy.ts`, one function per row, so the claim is
 *    auditable in one place.
 * 3. **One obvious next thing, once it is green.** Not a tour.
 *
 * ## Two panels, strictly separated
 *
 * The install narrative ("Installing…", "Signing in…") is what the MACHINE says
 * it is doing. The checklist is what the server knows. They are rendered as two
 * different things on purpose: a finished narrative above three waiting rows is
 * the honest picture of a script that ran and did not achieve anything, and it
 * is a far better diagnostic than a single merged bar that would have to pick
 * one of the two stories to tell.
 */

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** The command, verbatim, with a copy button.
 *
 * Rendered through `<pre>` with `white-space: pre` so the string on screen is
 * character-for-character the string on the clipboard — no tokenizing, no `$`
 * prefix, no reflow. A command that wrapped mid-token would be copied correctly
 * and read wrongly, and this one contains a secret the user cannot eyeball.
 */
function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    try {
      navigator.clipboard?.writeText(command)
    } catch {
      // ignore — unsupported clipboard, button still flashes
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }
  return (
    <div className="zs__cmd">
      <pre className="zs__cmd-pre"><code>{command}</code></pre>
      <button
        type="button"
        className={'zs__cmd-copy' + (copied ? ' is-copied' : '')}
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy command'}
        title={copied ? 'Copied' : 'Copy command'}
      >
        {copied ? (
          <>
            <Check className="w-4 h-4" strokeWidth={3} aria-hidden />
            Copied
          </>
        ) : (
          <>
            <Copy className="w-4 h-4" aria-hidden />
            Copy
          </>
        )}
      </button>
    </div>
  )
}

/** One checklist row.
 *
 * `waiting` gets a hollow ring rather than a cross. A user who has not run the
 * command yet has done nothing wrong, and a first render full of red marks is a
 * page that opens by blaming them.
 */
function Row({ row }: { row: ChecklistRow }) {
  return (
    <li className={`zs__row is-${row.state}`}>
      <span className="zs__row-mark" aria-hidden>
        {row.state === 'done' ? <Check className="w-3.5 h-3.5" strokeWidth={3.5} /> : null}
      </span>
      <span className="zs__row-body">
        <span className="zs__row-label">{row.label}</span>
        {row.detail ? <span className="zs__row-detail">{row.detail}</span> : null}
      </span>
      <span className="zs__row-sr">
        {row.state === 'done' ? 'done' : row.state === 'problem' ? 'needs attention' : 'waiting'}
      </span>
    </li>
  )
}

/** The machine's own account of what it is doing. Only rendered once it has
 *  started reporting — before that there is no story, and six grey rows would be
 *  noise on the one screen that has to stay simple. */
function Narrative({ steps }: { steps: NarratedStep[] }) {
  const failed = failedStep(steps)
  return (
    <div className="zs__narrative">
      <div className="zs__narrative-head">On your computer</div>
      <ol className="zs__steps">
        {steps.map((step) => (
          <li key={step.key} className={`zs__step is-${step.state}`}>
            <span className="zs__step-mark" aria-hidden>
              {step.state === 'done' ? <Check className="w-3 h-3" strokeWidth={3.5} /> : null}
              {step.state === 'running' ? <Loader2 className="w-3 h-3 zs__spin" /> : null}
            </span>
            <span className="zs__step-label">{step.label}</span>
          </li>
        ))}
      </ol>
      {failed ? (
        <div className="zs__failure">
          <div className="zs__failure-title">Stopped at: {failed.label}</div>
          {/* The reason, verbatim. A user who closed the terminal has nowhere
              else to learn it, so it is shown rather than summarized away. */}
          {failed.detail ? <pre className="zs__failure-detail">{failed.detail}</pre> : null}
          <div className="zs__failure-hint">
            Fix that, then run <code>clawmeets doctor</code> on the same computer — it
            prints the exact command for anything still missing.
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The one Windows prerequisite the script cannot satisfy for the user. Shown
 *  on the Windows tab, next to the command it would otherwise break. */
function WindowsDevMode() {
  const w = WINDOWS_DEV_MODE
  return (
    <div className="rs__prereq">
      <div className="rs__prereq-title">{w.title}</div>
      <p className="rs__prereq-body">{w.body}</p>
      <p className="rs__prereq-body">
        {w.pathLead}
        <strong>{w.pathTarget}</strong>
        {w.pathTail}
      </p>
      <CodeBlock code={w.code} />
    </div>
  )
}

const OS_PANEL_ID = 'zs-os-panel'

/** macOS / Linux | Windows. Plain buttons with tab roles: two options, no
 *  routing, and the selection is not worth persisting. Left/Right arrows move
 *  between tabs, as the tab pattern expects. */
function OsTabs({ os, onChange }: { os: InstallOs; onChange: (os: InstallOs) => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const i = OS_TABS.findIndex((t) => t.key === os)
    const next = OS_TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + OS_TABS.length) % OS_TABS.length]
    onChange(next.key)
    document.getElementById(`zs-os-tab-${next.key}`)?.focus()
  }
  return (
    <div className="zs__tabs" role="tablist" aria-label="Your computer's operating system">
      {OS_TABS.map((tab) => (
        <button
          key={tab.key}
          id={`zs-os-tab-${tab.key}`}
          type="button"
          role="tab"
          aria-selected={os === tab.key}
          aria-controls={OS_PANEL_ID}
          tabIndex={os === tab.key ? 0 : -1}
          className={'zs__tab' + (os === tab.key ? ' is-active' : '')}
          onClick={() => onChange(tab.key)}
          onKeyDown={onKeyDown}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default function WelcomePage() {
  const { command, windowsCommand, isLoading, error, retry } = useInstallCommand()
  const [os, setOs] = useState<InstallOs>(() => defaultOs(navigator.userAgent))
  const tab = OS_TABS.find((t) => t.key === os) ?? OS_TABS[0]
  const { data: progress } = useInstallProgress()
  const { data: computers } = useComputers()
  const assistant = useAssistantAgent()
  const setRailContext = useUIStore((s) => s.setRailContext)

  const rows = checklist(computers, assistant)
  const ready = isReady(rows)

  // The declared step list comes from whichever response has it. Both carry it
  // so the narrative has its full height whether the page was loaded before the
  // install or halfway through one.
  const declared = progress?.steps ?? []
  const steps = narrate(declared, progress?.run)
  const started = hasStarted(progress?.run)

  return (
    <div className="welcome-page">
      <div className="zs">
        <div className="zs__hero">
          <img className="zs__mark" src={MARK_SRC} alt="" width={40} height={40} />
          <h1>{ready ? READY_TITLE : HEADLINE}</h1>
          {/* The mental model, always. It is one sentence and it is the only
              explanation on the page, so it does not get hidden behind a
              disclosure — the question it answers ("where do my agents
              actually live?") is the one people ask after onboarding, not
              during it, which is exactly why it belongs here. */}
          <p className="zs__model">{MENTAL_MODEL}</p>
        </div>

        {ready ? (
          <div className="zs__ready">
            <p className="zs__ready-note">{READY_NOTE}</p>
            {/* The rail only syncs its context from the URL on mount, so a
                plain link would land on the desk with the welcome page's
                panel-less rail state. Select Desk explicitly so the My Desk
                side panel opens alongside the main view. */}
            <Link to={READY_HREF} className="zs__ready-btn" onClick={() => setRailContext('desk')}>
              {READY_ACTION}
              <ArrowRight className="w-4 h-4" aria-hidden />
            </Link>
          </div>
        ) : (
          <div className="zs__command">
            <OsTabs os={os} onChange={setOs} />
            {/* The panel is attached to the tab strip so the command reads as
                belonging to the selected OS, not as a separate block below. */}
            <div
              className="zs__os-panel"
              id={OS_PANEL_ID}
              role="tabpanel"
              aria-labelledby={`zs-os-tab-${os}`}
            >
              {os === 'windows' ? <WindowsDevMode /> : null}
              <div className="zs__command-lead">{tab.lead}</div>
              {isLoading ? (
                <div className="zs__cmd zs__cmd--loading">
                  <Loader2 className="w-4 h-4 zs__spin" aria-hidden />
                  <span>Preparing your command…</span>
                </div>
              ) : error ? (
                // The token is single-use and short-lived, so a failed mint is
                // recoverable by asking again — which is worth a button, because
                // the alternative the user would otherwise reach for is a page
                // reload that loses nothing but feels like a dead end.
                <div className="zs__cmd zs__cmd--error">
                  <span>Could not prepare your command.</span>
                  <button type="button" className="zs__retry" onClick={retry}>
                    <RotateCw className="w-3.5 h-3.5" aria-hidden />
                    Try again
                  </button>
                </div>
              ) : (
                <CommandBlock command={os === 'windows' ? windowsCommand : command} />
              )}
              <div className="zs__command-note">{tab.note}</div>
            </div>
          </div>
        )}

        {started ? <Narrative steps={steps} /> : null}

        <ul className="zs__rows" aria-label="Setup status">
          {rows.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </ul>

        {/* Last, collapsed, and deliberately still here: anyone who will not
            pipe a script into their shell needs the long way, and hiding it
            entirely would trade one stuck audience for another. Collapsed
            because it is not the path. */}
        {!ready ? <ManualSetup /> : null}
      </div>
    </div>
  )
}
