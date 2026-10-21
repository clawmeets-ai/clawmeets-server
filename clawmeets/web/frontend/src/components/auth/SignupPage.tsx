import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  registerUser,
  joinWaitlist,
  getSignupConfig,
  type SignupConfig,
  validateInvite,
  OAuthContractError,
  type UserResponse,
} from '../../api/endpoints/auth'
import AuthShell, {
  AuthCard,
  BrandHeader,
  ErrorNotice,
  Field,
  InlineSpinner,
  OrDivider,
  PrimaryButton,
  StatusField,
  StatusIcon,
  StepMessage,
  SuccessNotice,
  type FieldStatus,
} from './AuthShell'
import { ProviderButtons } from './ProviderButtons'
import { StepProgress } from './StepProgress'
import { useUsernameCheck } from './useUsernameCheck'
import { messageForCode } from './oauthErrors'

// Small text link used for "Join the waitlist", "← Back", "← Back to sign up".
function TextLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-auto"
      style={{
        background: 'none',
        border: 'none',
        font: 'inherit',
        fontSize: 13,
        color: 'var(--ink-3)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

export default function SignupPage() {
  const [view, setView] = useState<'signup' | 'waitlist'>('signup')
  const [step, setStep] = useState<0 | 1 | 2>(0)

  // The server's sign-up mode. Until it answers (or if it can't), behave as
  // invite-only — the default every server had before the setting existed.
  const [signup, setSignup] = useState<SignupConfig>({ mode: 'invite', invitation_code_required: true })
  useEffect(() => {
    let live = true
    getSignupConfig()
      .then((cfg) => {
        if (!live) return
        setSignup(cfg)
        if (!cfg.invitation_code_required) setStep((s) => (s === 0 ? 1 : s))
      })
      .catch(() => {})
    return () => { live = false }
  }, [])
  const firstStep = signup.invitation_code_required ? 0 : 1

  // Step 0 — invite
  const [code, setCode] = useState('')
  const [codeStatus, setCodeStatus] = useState<FieldStatus>('idle')
  const [codeMsg, setCodeMsg] = useState('')

  // Step 1 — username (debounced live availability)
  const un = useUsernameCheck()

  // Step 2 — method
  const [agree, setAgree] = useState(false)
  const [showEmail, setShowEmail] = useState(false)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [registrationResult, setRegistrationResult] = useState<UserResponse | null>(null)

  // Waitlist
  const [waitlistEmail, setWaitlistEmail] = useState('')
  const [waitlistLoading, setWaitlistLoading] = useState(false)
  const [waitlistError, setWaitlistError] = useState<string | null>(null)
  const [waitlistJoined, setWaitlistJoined] = useState(false)

  // Verify the invite code (advisory, non-consuming). On success advance to the
  // username step after a short beat so the green ring reads; on failure show an
  // inline message keyed off the stable error code.
  const verify = async () => {
    const c = code.trim()
    if (!c) return
    try {
      await validateInvite(c)
      setCodeStatus('ok')
      setCodeMsg('')
      setTimeout(() => setStep(1), 350)
    } catch (err) {
      setCodeStatus('bad')
      setCodeMsg(
        err instanceof OAuthContractError
          ? messageForCode(err.code)
          : "That code isn't valid.",
      )
    }
  }

  const handleEmailSignup = async () => {
    if (!email.trim() || pw.length < 6) return
    setError(null)
    setIsLoading(true)
    try {
      const result = await registerUser(un.clean, pw, email.trim(), code.trim())
      setRegistrationResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setIsLoading(false)
    }
  }

  const handleWaitlist = async () => {
    if (!/.+@.+\..+/.test(waitlistEmail)) return
    setWaitlistError(null)
    setWaitlistLoading(true)
    try {
      await joinWaitlist(waitlistEmail.trim())
      setWaitlistJoined(true)
    } catch (err) {
      setWaitlistError(err instanceof Error ? err.message : 'Failed to join waitlist')
    } finally {
      setWaitlistLoading(false)
    }
  }

  const isTerminal = registrationResult !== null
  const showSubtitle = view === 'signup' && !isTerminal && signup.invitation_code_required

  return (
    <AuthShell>
      <AuthCard>
        <BrandHeader subtitle={showSubtitle ? 'Invite-only · early access' : undefined} />

        {isTerminal ? (
          // Email/password path is verification-gated: register creates an
          // unverified account + sends the email, so this is "check your inbox",
          // not a logged-in success. (OAuth logs in via the callback exchange
          // and never renders this card — the button navigates away.)
          <div className="cm-fade flex flex-col gap-4">
            <SuccessNotice>
              {registrationResult?.email_verified
                ? 'Account created. You can sign in now.'
                : 'Account created. Check your email to verify your account.'}
            </SuccessNotice>
            <p style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
              {registrationResult?.email_verified ? 'Then' : 'Once verified,'} run <code>clawmeets assistant register</code> on your machine to create
              your personal assistant.
            </p>
            <Link
              to="/"
              className="block w-full text-center font-bold text-white bg-accent hover:bg-accent-deep transition-colors"
              style={{ padding: '11px 16px', borderRadius: 10, fontSize: 14 }}
            >
              Back to Sign in
            </Link>
          </div>
        ) : signup.mode === 'closed' ? (
          <div className="cm-fade flex flex-col gap-4">
            <ErrorNotice>{messageForCode('signup_closed')}</ErrorNotice>
            <Link
              to="/"
              className="block w-full text-center font-bold text-white bg-accent hover:bg-accent-deep transition-colors"
              style={{ padding: '11px 16px', borderRadius: 10, fontSize: 14 }}
            >
              Back to Sign in
            </Link>
          </div>
        ) : view === 'waitlist' ? (
          <div className="cm-fade flex flex-col gap-4">
            {waitlistJoined ? (
              <div className="text-center flex flex-col gap-3 py-2">
                <div className="font-extrabold" style={{ fontSize: 17, color: 'var(--ink-1)' }}>
                  You're on the list ✨
                </div>
                <div style={{ fontSize: 13.5, color: 'var(--ink-3)', lineHeight: 1.55 }}>
                  We'll email <b style={{ color: 'var(--accent)' }}>{waitlistEmail}</b> an invite
                  ASAP. Have a strong use case? Email{' '}
                  <a href="mailto:info@clawmeets.ai" className="font-bold" style={{ color: 'var(--accent)' }}>
                    info@clawmeets.ai
                  </a>{' '}
                  to expedite access.
                </div>
              </div>
            ) : (
              <>
                <div className="text-center">
                  <div className="font-extrabold" style={{ fontSize: 17, color: 'var(--ink-1)' }}>
                    Request an invite
                  </div>
                  <div className="mt-1" style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                    Leave your email and we'll extend an invite ASAP.
                  </div>
                </div>
                <Field
                  id="waitlistEmail"
                  label="Email"
                  type="email"
                  value={waitlistEmail}
                  onChange={setWaitlistEmail}
                  placeholder="you@email.com"
                  autoFocus
                  autoComplete="email"
                />
                {waitlistError && <ErrorNotice>{waitlistError}</ErrorNotice>}
                <PrimaryButton
                  disabled={waitlistLoading || !/.+@.+\..+/.test(waitlistEmail)}
                  onClick={handleWaitlist}
                >
                  {waitlistLoading ? <InlineSpinner label="Joining…" /> : 'Join the waitlist'}
                </PrimaryButton>
              </>
            )}
            <TextLink onClick={() => { setView('signup'); setWaitlistJoined(false) }}>
              ← Back to sign up
            </TextLink>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <StepProgress
              step={step - firstStep}
              labels={firstStep === 0 ? undefined : ['Username', 'Sign up']}
            />

            <div style={{ minHeight: 232 }}>
              {step === 0 && (
                <div className="cm-fade flex flex-col gap-4">
                  <div className="text-center">
                    <div className="font-extrabold" style={{ fontSize: 17, color: 'var(--ink-1)' }}>
                      Enter your invite
                    </div>
                    <div className="mt-1" style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                      ClawMeets is invite-only for now.
                    </div>
                  </div>
                  <StatusField
                    id="invitationCode"
                    label="Invitation code"
                    value={code}
                    onChange={(v) => { setCode(v); setCodeStatus('idle'); setCodeMsg('') }}
                    onEnter={() => void verify()}
                    placeholder="XXXXXX"
                    status={codeStatus}
                    autoFocus
                    inputStyle={{
                      textTransform: 'uppercase',
                      letterSpacing: '2px',
                      fontWeight: 700,
                      textAlign: 'center',
                      fontSize: 17,
                    }}
                    iconRight={codeStatus === 'ok' ? <StatusIcon status="ok" /> : null}
                    message={
                      codeStatus === 'bad' ? (
                        <StepMessage status="bad">{codeMsg}</StepMessage>
                      ) : undefined
                    }
                  />
                  <PrimaryButton disabled={!code.trim()} onClick={() => void verify()}>
                    Verify code
                  </PrimaryButton>
                  <TextLink onClick={() => setView('waitlist')}>
                    No invitation code?{' '}
                    <span style={{ color: 'var(--accent)', fontWeight: 700 }}>Join the waitlist</span>
                  </TextLink>
                </div>
              )}

              {step === 1 && (
                <div className="cm-fade flex flex-col gap-4">
                  <div className="text-center">
                    <div className="font-extrabold" style={{ fontSize: 17, color: 'var(--ink-1)' }}>
                      Claim your username
                    </div>
                    <div className="mt-1" style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                      This is your public profile link — pick it once.
                    </div>
                  </div>
                  {/* The lowercase-only rule is stated up front, not just after
                      a bad keystroke. The server enforces it three ways: this
                      hint, the live GET /auth/username-available check below
                      (whose `reason` is rendered verbatim), and — for any caller
                      that gets past both — a 400 invalid_request from
                      /auth/register whose actionable message surfaces in the
                      error notice on step 3. */}
                  <StatusField
                    id="username"
                    label="Username (lowercase only)"
                    value={un.value}
                    onChange={un.setValue}
                    placeholder="yourname"
                    status={un.status}
                    autoFocus
                    autoComplete="username"
                    iconRight={<StatusIcon status={un.status} />}
                    message={<StepMessage status={un.status}>{un.msg}</StepMessage>}
                  />
                  <PrimaryButton disabled={un.status !== 'ok'} onClick={() => setStep(2)}>
                    Continue
                  </PrimaryButton>
                </div>
              )}

              {step === 2 && (
                <div className="cm-fade flex flex-col gap-3">
                  <div className="text-center">
                    <div className="font-extrabold" style={{ fontSize: 17, color: 'var(--ink-1)' }}>
                      Finish sign up
                    </div>
                    <div className="mt-1" style={{ fontSize: 13, color: 'var(--ink-3)' }}>
                      Signing up as <b style={{ color: 'var(--accent)' }}>@{un.clean}</b>
                    </div>
                  </div>

                  <label className="flex items-start gap-2 cursor-pointer" style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.4 }}>
                    <input
                      type="checkbox"
                      checked={agree}
                      onChange={(e) => setAgree(e.target.checked)}
                      className="mt-[3px] h-4 w-4 rounded cursor-pointer"
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span>
                      I agree to the{' '}
                      <a href="/tos" target="_blank" rel="noopener noreferrer" className="font-bold" style={{ color: 'var(--accent)' }}>
                        Terms of Service
                      </a>{' '}
                      and{' '}
                      <a href="/privacy" target="_blank" rel="noopener noreferrer" className="font-bold" style={{ color: 'var(--accent)' }}>
                        Privacy Policy
                      </a>
                      .
                    </span>
                  </label>

                  {/* Method block is gated on the terms checkbox: 50% + no pointer
                      events until agreed (matches the design). */}
                  <div
                    className="flex flex-col gap-3"
                    style={{
                      opacity: agree ? 1 : 0.5,
                      pointerEvents: agree ? 'auto' : 'none',
                      transition: 'opacity .2s',
                    }}
                  >
                    {!showEmail ? (
                      <>
                        {/* Terms already gate the block; code carries the invite,
                            username carries the chosen slug into /start. */}
                        <ProviderButtons code={code.trim()} username={un.clean} />
                        <OrDivider />
                        <button
                          type="button"
                          onClick={() => setShowEmail(true)}
                          className="w-full flex items-center justify-center font-bold transition-colors"
                          style={{
                            padding: '10px 16px',
                            borderRadius: 10,
                            fontSize: 14,
                            color: 'var(--ink-1)',
                            background: '#fff',
                            border: '1px solid var(--line-2)',
                          }}
                        >
                          Sign up with email &amp; password
                        </button>
                      </>
                    ) : (
                      <div className="flex flex-col gap-3">
                        <Field
                          id="email"
                          label="Email"
                          type="email"
                          value={email}
                          onChange={setEmail}
                          placeholder="you@email.com"
                          autoFocus
                          autoComplete="email"
                        />
                        <Field
                          id="password"
                          label="Password"
                          type="password"
                          value={pw}
                          onChange={setPw}
                          placeholder="Create a password (min 6 chars)"
                          autoComplete="new-password"
                        />
                        {error && <ErrorNotice>{error}</ErrorNotice>}
                        <PrimaryButton
                          disabled={isLoading || !email.trim() || pw.length < 6}
                          onClick={handleEmailSignup}
                        >
                          {isLoading ? <InlineSpinner label="Creating account…" /> : 'Create account'}
                        </PrimaryButton>
                        <TextLink onClick={() => { setShowEmail(false); setError(null) }}>
                          ← Back to social sign up
                        </TextLink>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {step > firstStep && (
              <TextLink onClick={() => setStep((s) => (s - 1) as 0 | 1)}>← Back</TextLink>
            )}
            <p className="text-center" style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              Already have an account?{' '}
              <Link to="/" className="font-bold" style={{ color: 'var(--accent)' }}>
                Sign in
              </Link>
            </p>
          </div>
        )}
      </AuthCard>
    </AuthShell>
  )
}
