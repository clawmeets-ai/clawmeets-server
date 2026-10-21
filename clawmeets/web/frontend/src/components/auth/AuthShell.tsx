import { useState, type CSSProperties, type ReactNode } from 'react'
import type { OAuthProvider } from '../../types'

// Live-validation status shared by the sign-up invite + username steps.
export type FieldStatus = 'idle' | 'checking' | 'ok' | 'bad'

// Public-folder asset: needs BASE_URL because Vite sets base: '/app/'.
const MARK_SRC = `${import.meta.env.BASE_URL}clawmeets-mark.svg`

interface AuthShellProps {
  children: ReactNode
}

/**
 * Outer frame shared by sign-in and sign-up pages:
 * full-viewport dark-purple gradient with a centered column that holds
 * one or more cards.
 */
export default function AuthShell({ children }: AuthShellProps) {
  return (
    <div
      className="min-h-screen flex items-start sm:items-center justify-center py-10 px-4"
      style={{
        background:
          'linear-gradient(135deg, #3d0f63 0%, #1a0530 55%, #0f031d 100%)',
      }}
    >
      <div
        className="w-full flex flex-col gap-5"
        style={{ maxWidth: 420 }}
      >
        {children}
      </div>
    </div>
  )
}

export function BrandHeader({ subtitle }: { subtitle?: string }) {
  return (
    <div className="text-center mb-6">
      <img
        src={MARK_SRC}
        alt=""
        width={56}
        height={56}
        className="mx-auto mb-3"
        style={{ display: 'block' }}
      />
      <div
        className="inline-flex items-baseline font-extrabold"
        style={{
          fontSize: 28,
          letterSpacing: '-0.015em',
          lineHeight: 1,
        }}
      >
        <span style={{ color: 'var(--ink-1)' }}>Claw</span>
        <span style={{ color: 'var(--accent)' }}>Meets</span>
      </div>
      {subtitle && (
        <div
          className="mt-2"
          style={{ color: 'var(--ink-3)', fontSize: 14 }}
        >
          {subtitle}
        </div>
      )}
    </div>
  )
}

export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div
      className="bg-white"
      style={{
        padding: '32px 28px',
        borderRadius: 14,
        boxShadow: 'var(--shadow-pop)',
      }}
    >
      {children}
    </div>
  )
}

interface FieldProps {
  id: string
  label: string
  type?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  autoComplete?: string
}

export function Field({
  id,
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  autoFocus,
  autoComplete,
}: FieldProps) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block font-bold mb-1.5"
        style={{ color: 'var(--ink-1)', fontSize: 13 }}
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        className="auth-input w-full"
        style={{
          padding: '11px 13px',
          border: '1px solid var(--line-2)',
          borderRadius: 8,
          fontSize: 14,
          color: 'var(--ink-1)',
          background: '#fff',
          outline: 'none',
          transition: 'border-color .15s, box-shadow .15s',
        }}
      />
    </div>
  )
}

// Trailing status glyph for the sign-up live-validation inputs: spinner while
// checking, a filled check when ok, a filled ✕ when bad. Colors ride the app's
// prio tokens (quick=green, urgent=red) so it matches the rest of the product.
export function StatusIcon({ status }: { status: FieldStatus }) {
  if (status === 'checking') {
    return (
      <span
        className="inline-block w-[15px] h-[15px] rounded-full animate-spin"
        style={{ border: '2px solid var(--accent-soft)', borderTopColor: 'var(--accent)' }}
        aria-hidden="true"
      />
    )
  }
  if (status === 'ok') {
    return (
      <svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="var(--prio-quick-fg)" />
        <path d="M6 10l3 3 5-6" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'bad') {
    return (
      <svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="9" fill="var(--prio-urgent-fg)" />
        <path d="M7 7l6 6M13 7l-6 6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  return null
}

// Inline validation message under a stepped field. ok=green, bad=red, else muted.
export function StepMessage({ status, children }: { status: FieldStatus; children?: ReactNode }) {
  if (!children) return null
  const color =
    status === 'ok'
      ? 'var(--prio-quick-fg)'
      : status === 'bad'
        ? 'var(--prio-urgent-fg)'
        : 'var(--ink-3)'
  return (
    <span style={{ fontSize: 12.5, color, fontWeight: status === 'idle' ? 400 : 600 }}>
      {children}
    </span>
  )
}

// Status-aware text input for the invite + username steps: the border/glow ring
// reflects live-validation status (green ok / red bad), falling back to the
// accent focus ring. Distinct from Field (which uses the .auth-input class whose
// !important focus ring would fight the status ring). An optional trailing icon
// slot holds the StatusIcon.
export function StatusField({
  id,
  label,
  value,
  onChange,
  placeholder,
  status = 'idle',
  type = 'text',
  autoFocus,
  autoComplete,
  inputStyle,
  iconRight,
  onEnter,
  message,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  status?: FieldStatus
  type?: string
  autoFocus?: boolean
  autoComplete?: string
  inputStyle?: CSSProperties
  iconRight?: ReactNode
  onEnter?: () => void
  message?: ReactNode
}) {
  const [focus, setFocus] = useState(false)
  const ring =
    status === 'ok'
      ? 'var(--prio-quick-fg)'
      : status === 'bad'
        ? 'var(--prio-urgent-fg)'
        : focus
          ? 'var(--accent)'
          : 'var(--line-2)'
  const glow =
    status === 'ok'
      ? 'var(--prio-quick-bg)'
      : status === 'bad'
        ? 'var(--prio-urgent-bg)'
        : focus
          ? 'var(--accent-softer)'
          : 'transparent'
  return (
    <div>
      <label htmlFor={id} className="block font-bold mb-1.5" style={{ color: 'var(--ink-1)', fontSize: 13 }}>
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) {
              e.preventDefault()
              onEnter()
            }
          }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          className="auth-input w-full"
          style={{
            padding: '11px 13px',
            paddingRight: iconRight ? 40 : 13,
            border: `1.5px solid ${ring}`,
            borderRadius: 8,
            fontSize: 14,
            color: 'var(--ink-1)',
            background: '#fff',
            outline: 'none',
            boxShadow: `0 0 0 3px ${glow}`,
            transition: 'border-color .15s, box-shadow .15s',
            ...inputStyle,
          }}
        />
        {iconRight && (
          <div className="absolute -translate-y-1/2 flex items-center" style={{ right: 12, top: '50%' }}>
            {iconRight}
          </div>
        )}
      </div>
      {message && <div className="mt-1.5">{message}</div>}
    </div>
  )
}

export function PrimaryButton({
  type = 'button',
  disabled,
  onClick,
  children,
}: {
  type?: 'button' | 'submit'
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className="w-full font-bold text-white transition-colors bg-accent hover:bg-accent-deep disabled:bg-accent-soft disabled:cursor-not-allowed disabled:text-white"
      style={{
        padding: '11px 16px',
        borderRadius: 10,
        fontSize: 14,
      }}
    >
      {children}
    </button>
  )
}

export function InlineSpinner({ label }: { label: string }) {
  return (
    <span className="flex items-center justify-center gap-2">
      <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
      {label}
    </span>
  )
}

export function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--prio-urgent-bg)',
        color: 'var(--prio-urgent-fg)',
        border: '1px solid var(--prio-urgent-bg)',
        borderRadius: 8,
        padding: '10px 12px',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  )
}

// A notice that is neither a rejection nor a success but an actionable next
// step — today, only the 403 email_not_verified sign-in branch. Uses the muted
// purple prio-normal tokens deliberately: not ErrorNotice's red, not
// SuccessNotice's green. That colour difference IS the "rendered distinctly"
// requirement in AUTH_CONTRACT §4.2.
export function InfoNotice({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--prio-normal-bg)',
        color: 'var(--prio-normal-fg)',
        border: '1px solid var(--prio-normal-bg)',
        borderRadius: 8,
        padding: '10px 12px',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  )
}

export function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--prio-quick-bg)',
        color: 'var(--prio-quick-fg)',
        border: '1px solid var(--prio-quick-bg)',
        borderRadius: 8,
        padding: '10px 12px',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  )
}

// "—— or ——" horizontal rule separating the password form from the provider
// buttons on both the Login and Signup cards.
export function OrDivider() {
  return (
    <div className="flex items-center gap-3" role="separator" aria-orientation="horizontal">
      <span style={{ flex: 1, height: 1, background: 'var(--line-2)' }} />
      <span style={{ color: 'var(--ink-3)', fontSize: 12, fontWeight: 700 }}>or</span>
      <span style={{ flex: 1, height: 1, background: 'var(--line-2)' }} />
    </div>
  )
}

// Brand marks for the provider buttons. Google keeps its four-colour "G";
// GitHub uses a single-colour mark tinted to the ink token.
function ProviderIcon({ provider }: { provider: OAuthProvider }) {
  if (provider === 'google') {
    return (
      <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z" />
        <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34z" />
        <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
      </svg>
    )
  }
  return (
    <svg width={18} height={18} viewBox="0 0 16 16" aria-hidden="true" fill="var(--ink-1)">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

// White, bordered "Continue with …" button matched to the AuthShell tokens.
// `busy` swaps the label for a spinner; `disabled` gates the Signup path until
// the invite validates. Presentational only — the click handler lives in
// ProviderButtons.
export function ProviderButton({
  provider,
  label,
  busy,
  disabled,
  onClick,
}: {
  provider: OAuthProvider
  label: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
      className="w-full flex items-center justify-center gap-2.5 font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        padding: '10px 16px',
        borderRadius: 10,
        fontSize: 14,
        color: 'var(--ink-1)',
        background: '#fff',
        border: '1px solid var(--line-2)',
      }}
    >
      {busy ? (
        <span className="flex items-center justify-center gap-2" style={{ color: 'var(--ink-2)' }}>
          <span
            className="w-4 h-4 border-2 rounded-full animate-spin"
            style={{ borderColor: 'var(--line-2)', borderTopColor: 'transparent' }}
          />
          Redirecting…
        </span>
      ) : (
        <>
          <ProviderIcon provider={provider} />
          <span>{label}</span>
        </>
      )}
    </button>
  )
}
