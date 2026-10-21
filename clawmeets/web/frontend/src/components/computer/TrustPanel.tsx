import { Check, Shield, SquareTerminal, X } from 'lucide-react'
import type { ComputerConsent } from '../../api/endpoints/computers'
import { splitInlineCode } from './computerCopy'

/**
 * "What this connection can do" — the fixed command set, what the agents can
 * do, and whether the terminal is on, as product copy.
 *
 * This is the place in the product where the server can cause code to run on
 * the user's own machine, against a "your data stays on your machine" pitch. So
 * what the connection can do is rendered on the page rather than living only in
 * the code. On the Computer page it folds out from the ⓘ beside the machine's
 * name (the My Desk pattern), so it is one click from the title without pushing
 * every control down the page; the kill switch stays visible under the section
 * list regardless.
 *
 * Every line comes from the server (`GET /me/computers/consent`), derived from
 * the same allowlist the command route enforces and the machine re-checks. A
 * hardcoded copy here could drift from what is actually enforced.
 *
 * It no longer promises that nothing else can run: the agents act as the user
 * and run commands, and the terminal (on by default) is a full shell. Saying
 * so plainly — and naming the one command that turns the terminal off — is the
 * honest version of the panel the old promise used to be.
 *
 * The same component renders inside the pairing dialog, so the text the user
 * reads before connecting and the text the page shows afterwards are literally
 * the same element.
 */
export default function TrustPanel({
  consent,
  terminalEnabled,
}: {
  consent: ComputerConsent | undefined
  /** The machine's reported terminal switch. `null`/omitted = its software
   *  predates the terminal. The pairing dialog passes `true`: a newly
   *  connected computer has it on. */
  terminalEnabled?: boolean | null
}) {
  // Rendering nothing beats rendering a SHORTER list. A partial allowlist next
  // to the words "only a fixed set of things" is an untrue claim.
  if (!consent) return null

  const terminalLine =
    terminalEnabled === true
      ? consent.terminal_on
      : terminalEnabled === false
        ? consent.terminal_off
        : "Terminal: update this computer's software to use it."

  return (
    <section
      className="rounded-xl overflow-hidden"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--line-2)' }}
    >
      <header className="px-4 pt-3.5 pb-2.5" style={{ borderBottom: '1px solid var(--line-1)' }}>
        <h2 className="flex items-center gap-2 text-[15px] font-extrabold" style={{ color: 'var(--ink-1)' }}>
          <Shield size={16} style={{ color: 'var(--accent)' }} />
          What this connection can do
        </h2>
      </header>

      <div className="grid gap-0 md:grid-cols-2">
        <div className="px-4 py-3" style={{ borderRight: '1px solid var(--line-1)' }}>
          <p className="text-[12.5px] mb-2" style={{ color: 'var(--ink-2)' }}>
            The server can ask this computer to do only a fixed set of things:
          </p>
          <ul className="space-y-1.5">
            {consent.allowed.map((item) => (
              <li
                key={item.action}
                className="flex items-start gap-2 text-[13px]"
                style={{ color: 'var(--ink-1)' }}
              >
                <Check size={14} strokeWidth={2.6} className="mt-[3px] shrink-0" style={{ color: '#0d6d57' }} />
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="px-4 py-3 space-y-2.5">
          {consent.agents_note && (
            <p className="text-[13px]" style={{ color: 'var(--ink-1)' }}>
              {consent.agents_note}
            </p>
          )}
          {terminalLine && (
            <p className="flex items-start gap-2 text-[13px]" style={{ color: 'var(--ink-1)' }}>
              <SquareTerminal size={14} className="mt-[3px] shrink-0" style={{ color: 'var(--accent)' }} />
              <span>
                <InlineCode text={terminalLine} />
              </span>
            </p>
          )}
          {consent.never.length > 0 && (
            <div>
              <h3
                className="text-[10.5px] font-extrabold uppercase tracking-[0.08em] mb-1.5"
                style={{ color: 'var(--ink-3)' }}
              >
                Never
              </h3>
              <ul className="space-y-1.5">
                {consent.never.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-[13px]"
                    style={{ color: 'var(--ink-1)' }}
                  >
                    <X size={14} strokeWidth={2.6} className="mt-[3px] shrink-0" style={{ color: 'var(--interrupt)' }} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/** Server text with its `backticked` commands as inline code. */
function InlineCode({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((part, i) =>
        part.code ? (
          <code
            key={i}
            className="font-mono text-[12px] px-1 py-[1px] rounded break-all"
            style={{ background: 'var(--bg-rail)', border: '1px solid var(--line-2)' }}
          >
            {part.text}
          </code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}
