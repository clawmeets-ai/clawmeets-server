import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Globe } from 'lucide-react'
import { hubError, type HubEnrollment } from '../../api/endpoints/hub'
import { useHubEnrollment } from '../../hooks/useHub'

/**
 * "Set up hub access": the one dialog that puts this server on the hub (when
 * it isn't yet) and confirms this user's email as an owner of hub agents. One
 * emailed code does both.
 *
 * Opened by whatever the hub refused for want of it (turning an agent's Hub
 * channel on, a hub search); `onDone` retries that action. Steps: (1) accept
 * the terms, which sends the code; (2) enter the code; (3) verified, which
 * calls onDone at once. An owner already verified never sees a step. A server
 * whose hub is off, or that only its operator may register, shows why with
 * just a Close button.
 */

export const ENROLL_COPY = {
  title: 'Set up hub access',
  termsLabel: 'I accept the ClawMeets Hub terms',
  terms: 'Terms',
  version: (v: string) => `version ${v}`,
  contact: "Your server will join the ClawMeets Hub and you'll be its contact for hub notices.",
  sendCode: 'Send code',
  sending: 'Sending…',
  sentTo: (email: string) => `We sent a code to ${email}.`,
  sentToYou: 'We sent a code to your email address.',
  codeLabel: 'Code',
  confirm: 'Confirm',
  confirming: 'Checking…',
  resend: 'Send a new code',
  resent: 'We sent a new code.',
  close: 'Close',
  cancel: 'Cancel',
  loading: 'Loading…',
  hubOff: 'The hub is turned off on this server.',
  loadFailed: "Couldn't load your hub setup. Try again.",
} as const

const ERRORS: Record<string, string> = {
  enroll_busy: 'Someone else on this server is finishing the hub setup. Try again in a minute.',
  hub_untrusted: "The ClawMeets Hub isn't available yet.",
  enroll_operator_only: "Only this server's operator can connect it to the hub.",
  enroll_email_unverified: 'Verify your ClawMeets email address first.',
  enroll_code_invalid: "That code isn't right.",
  enroll_code_expired: 'That code expired. Send a new one.',
  owner_banned: "This email address can't list agents on the hub.",
  tos_outdated: 'The hub terms changed. Read them again, then accept.',
  hub_off_on_server: ENROLL_COPY.hubOff,
  hub_unreachable: "Can't reach the hub. Try again in a minute.",
  rate_limited: 'Too many tries. Wait a minute, then try again.',
}

/** One plain sentence for a failed enrollment call. */
export function enrollErrorText(e: unknown): string {
  const b = hubError(e)
  if (b && ERRORS[b.code]) return ERRORS[b.code]
  return 'Something went wrong. Try again.'
}

/** The sentence when this user cannot enroll here at all, else null. */
function blockedText(en: HubEnrollment): string | null {
  if (en.server === 'off') return ENROLL_COPY.hubOff
  if (en.server === 'operator_only') return ERRORS.enroll_operator_only
  return null
}

/** The terms link only for an http(s) URL. */
const isWebUrl = (u: string) => /^https?:\/\//i.test(u)

export default function HubEnrollmentDialog({ onDone, onClose }: {
  /** Called once, when this user is a verified owner. Retry the action here. */
  onDone: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const codeId = useId()
  const { enrollment, start, confirm } = useHubEnrollment()
  const [accepted, setAccepted] = useState(false)
  const [code, setCode] = useState('')
  // The code step is shown once a code went out, from this dialog or before.
  const [step, setStep] = useState<'terms' | 'code' | null>(null)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = useRef(false)

  const en = enrollment.data
  const busy = start.isPending || confirm.isPending

  useEffect(() => {
    if (!en || done.current) return
    if (en.owner === 'verified') {
      done.current = true
      onDone()
      return
    }
    setStep((s) => s ?? (en.owner === 'code_sent' ? 'code' : 'terms'))
  }, [en, onDone])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const send = async (again: boolean) => {
    if (!en || busy) return
    setError(null)
    setResent(false)
    try {
      await start.mutateAsync(en.tos_version)
      setStep('code')
      setResent(again)
    } catch (e) {
      setError(enrollErrorText(e))
      if (hubError(e)?.code === 'tos_outdated') {
        setAccepted(false)
        setStep('terms')
        void enrollment.refetch()
      }
    }
  }

  const submitCode = async (e: FormEvent) => {
    e.preventDefault()
    const c = code.trim()
    if (!c || busy) return
    setError(null)
    setResent(false)
    try {
      await confirm.mutateAsync(c)
    } catch (err) {
      setError(enrollErrorText(err))
    }
  }

  const blocked = en ? blockedText(en) : null
  const button = 'px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50'
  const secondary = `${button} border border-gray-200 text-gray-700`
  const primary = `${button} font-bold bg-purple-600 text-white`

  let body: ReactNode
  let actions: ReactNode
  if (enrollment.error) {
    body = <p role="alert" className="text-red-700">{ENROLL_COPY.loadFailed}</p>
    actions = <button type="button" onClick={onClose} className={secondary}>{ENROLL_COPY.close}</button>
  } else if (!en || step === null) {
    body = <p className="text-gray-500">{ENROLL_COPY.loading}</p>
    actions = <button type="button" onClick={onClose} className={secondary}>{ENROLL_COPY.cancel}</button>
  } else if (blocked) {
    body = <p data-testid="enroll-blocked">{blocked}</p>
    actions = <button type="button" onClick={onClose} className={secondary}>{ENROLL_COPY.close}</button>
  } else if (step === 'terms') {
    body = (
      <>
        {en.becomes_contact && <p data-testid="enroll-contact">{ENROLL_COPY.contact}</p>}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            disabled={busy}
            className="mt-0.5"
          />
          <span>{ENROLL_COPY.termsLabel}</span>
        </label>
        <p className="text-xs text-gray-500 pl-6">
          {isWebUrl(en.tos_url) ? (
            <a href={en.tos_url} target="_blank" rel="noopener noreferrer" className="underline">{ENROLL_COPY.terms}</a>
          ) : ENROLL_COPY.terms}
          {' · '}{ENROLL_COPY.version(en.tos_version)}
        </p>
      </>
    )
    actions = (
      <>
        <button type="button" onClick={onClose} disabled={busy} className={secondary}>{ENROLL_COPY.cancel}</button>
        <button type="button" onClick={() => send(false)} disabled={!accepted || busy} className={primary}>
          {start.isPending ? ENROLL_COPY.sending : ENROLL_COPY.sendCode}
        </button>
      </>
    )
  } else {
    body = (
      <form id={`${codeId}-form`} onSubmit={submitCode} className="space-y-2">
        <p>{en.email_masked ? ENROLL_COPY.sentTo(en.email_masked) : ENROLL_COPY.sentToYou}</p>
        <label htmlFor={codeId} className="block text-xs font-semibold text-gray-600">{ENROLL_COPY.codeLabel}</label>
        <input
          id={codeId}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode="numeric"
          autoFocus
          disabled={confirm.isPending}
          className="w-full px-3 py-2 border border-gray-200 rounded-lg font-mono tracking-widest"
        />
        <button type="button" onClick={() => send(true)} disabled={busy} className="text-xs underline text-gray-600 disabled:opacity-50">
          {ENROLL_COPY.resend}
        </button>
        {resent && <p role="status" className="text-xs text-gray-600">{ENROLL_COPY.resent}</p>}
      </form>
    )
    actions = (
      <>
        <button type="button" onClick={onClose} disabled={busy} className={secondary}>{ENROLL_COPY.cancel}</button>
        <button type="submit" form={`${codeId}-form`} disabled={!code.trim() || busy} className={primary}>
          {confirm.isPending ? ENROLL_COPY.confirming : ENROLL_COPY.confirm}
        </button>
      </>
    )
  }

  // Already verified: onDone runs from the effect; draw nothing meanwhile.
  if (en?.owner === 'verified') return null

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
        data-testid="hub-enrollment-dialog"
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <Globe className="w-5 h-5 text-purple-500 flex-shrink-0" />
          <h2 id={titleId} className="text-base font-bold text-gray-900">{ENROLL_COPY.title}</h2>
        </div>
        <div className="px-6 py-4 space-y-3 text-sm text-gray-700">
          {body}
          {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        </div>
        <div className="px-6 py-3 border-t border-gray-100 flex flex-wrap justify-end gap-2">{actions}</div>
      </div>
    </div>,
    document.body,
  )
}
