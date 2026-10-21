import { useState } from 'react'
import { Check, ChevronDown, Copy } from 'lucide-react'
import './RunnerSetup.css'

// The long way round, collapsed.
//
// The zero state's one-liners (`curl … | sh` on macOS and Linux, a PowerShell
// scriptblock on Windows) are the path. This drawer exists for anyone who will
// not pipe a script into their shell — a reasonable position. They get the same
// steps, spelled out, and can read each one before running it. Windows-specific
// notes stay inline on the steps they affect; the Developer Mode prerequisite
// lives on the welcome page's Windows tab, next to the command it would break.
//
// It is ONE list, not a tabbed matrix. The previous revision tabbed Step 0 by
// operating system and Step 1 by install method (uv / pip / pipx) — six command
// variants for a decision almost nobody needed to make, on the screen where a
// new user has the least context to make it. uv is the answer; pip and pipx are
// gone from this surface. Anyone who needs them is not reading the welcome page.
//
// Commands render CHARACTER-FOR-CHARACTER through a verbatim <pre> — no reflow,
// no `$` prefix, no tokenizing — so the copied string equals what is shown.

type Entry = {
  label: string
  code: string
  note?: string
}

/** Single source of truth for every rendered string in this drawer. */
const MANUAL = {
  summaryTitle: 'Prefer to run the steps yourself?',
  summaryBody: 'These are the same steps the command above runs, one at a time.',

  steps: [
    {
      label: '1. Install uv — it brings its own Python, so yours is untouched',
      code: `curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"`,
      note: 'Windows (PowerShell): irm https://astral.sh/uv/install.ps1 | iex — uv adds itself to PATH; close and reopen PowerShell afterwards.',
    },
    {
      label: '2. Install ClawMeets and the piece that keeps this computer connected',
      code: `uv tool install --python 3.11 clawmeets
uv tool install --python 3.11 clawmeets-daemon`,
      // The 3.11 pin is a Python-version pin, not a preference: patchright
      // (browser stealth) ships no 3.14 wheels, so an unpinned install either
      // fails to resolve or silently drops browser support.
      note: 'ClawMeets needs Python 3.11–3.13; the pin keeps the install deterministic whatever your default is.',
    },
    {
      label: '3. Sign in on this computer',
      code: `clawmeets user login <your-username>`,
      note: 'Signed up with Google or GitHub? Add --provider google (or github) to open the browser sign-in.',
    },
    {
      label: '4. Create your assistant',
      code: `clawmeets assistant register`,
    },
    {
      label: '5. Connect this computer, and have it reconnect when you log in',
      code: `clawmeets computer install --user <your-username>`,
      note: 'No pairing code needed once you are signed in — it fetches its own. --user keeps each account on this computer separate. Starting at login is set up on macOS and Linux only.',
    },
    {
      label: '6. Start your agents',
      code: `clawmeets start`,
      note: 'Windows: turn on Developer Mode first (Settings → System → For developers), or this stops with WinError 1314.',
    },
    {
      label: '7. Check it worked',
      code: `clawmeets doctor`,
      // The reason this step is worth a row of its own: it is the only one that
      // can tell the user about the failure the other six cannot detect — a
      // model CLI that is installed but not signed in.
      note: 'Prints the exact command to fix anything missing, including a model CLI that is installed but not signed in.',
    },
  ] satisfies Entry[],

} as const

/** Verbatim terminal block with a copy button. Clipboard failures are swallowed
 *  (the button still flashes), matching the zero state's own copy control. */
export function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    try {
      navigator.clipboard?.writeText(code)
    } catch {
      // ignore — unsupported clipboard, button still flashes
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  return (
    <div className="rs__code">
      <pre className="rs__pre"><code>{code}</code></pre>
      <button
        type="button"
        className={'rs__copy' + (copied ? ' rs__copy--copied' : '')}
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy command'}
        title={copied ? 'Copied' : 'Copy command'}
      >
        {copied ? (
          <Check className="w-3.5 h-3.5" strokeWidth={3} />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rs__note">{children}</p>
}

/**
 * The collapsed manual-install drawer.
 *
 * Exported as the default under the old module name so the route and any test
 * importing it keep resolving; the component it renders is no longer a step in
 * the main flow, which is why the exported name says what it is.
 */
export default function ManualSetup() {
  return (
    <details className="rs rs--manual">
      <summary className="rs__summary">
        <div className="rs__summary-text">
          <div className="rs__summary-title">{MANUAL.summaryTitle}</div>
          <div className="rs__summary-sub">{MANUAL.summaryBody}</div>
        </div>
        <ChevronDown className="rs__chev w-5 h-5" aria-hidden />
      </summary>

      <div className="rs__body">
        {MANUAL.steps.map((entry) => (
          <div className="rs__unit" key={entry.label}>
            <div className="rs__label">{entry.label}</div>
            <CodeBlock code={entry.code} />
            {entry.note ? <Note>{entry.note}</Note> : null}
          </div>
        ))}

      </div>
    </details>
  )
}
