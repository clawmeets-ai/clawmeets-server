import { Fragment } from 'react'

// Three-segment progress rail (Invite / Username / Sign up) for the stepped
// sign-up. Completed = filled accent + check; current = white fill, accent
// border, accent number; upcoming = soft fill, faint number. Connectors turn
// accent once passed. Colors ride the app's --accent / --line tokens.
const LABELS = ['Invite', 'Username', 'Sign up']

// `labels` overrides the rail, e.g. without the Invite step on a server that
// needs no invitation code.
export function StepProgress({ step, labels = LABELS }: { step: number; labels?: string[] }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      {labels.map((label, i) => {
        const done = i < step
        const current = i === step
        return (
          <Fragment key={label}>
            <div className="flex items-center gap-1.5">
              <div
                className="flex items-center justify-center font-bold"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  fontSize: 11.5,
                  background: done ? 'var(--accent)' : current ? '#fff' : 'var(--accent-softer)',
                  color: done ? '#fff' : current ? 'var(--accent)' : 'var(--ink-4)',
                  border: current ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: '.2s',
                }}
              >
                {done ? '✓' : i + 1}
              </div>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: current ? 700 : 500,
                  color: i <= step ? 'var(--ink-2)' : 'var(--ink-4)',
                }}
              >
                {label}
              </span>
            </div>
            {i < LABELS.length - 1 && (
              <div
                style={{
                  width: 18,
                  height: 2,
                  borderRadius: 2,
                  background: done ? 'var(--accent)' : 'var(--line-2)',
                }}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
