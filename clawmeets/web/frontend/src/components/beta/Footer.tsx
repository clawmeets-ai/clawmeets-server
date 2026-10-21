import { ArrowRight } from 'lucide-react'
import Button from '../hero/Button'
import { Wordmark } from '../landing/Nav'
import { SIGNUP_HREF } from './constants'

// Closing sign-up CTA + slim footer. The Sign up button is the one action
// this whole page exists to drive.
export default function Footer() {
  return (
    <footer
      style={{
        background: 'var(--bg-sidebar)',
        padding: '80px 0 36px',
        borderTop: '1px solid var(--line-1)',
      }}
    >
      <div className="max-w-6xl mx-auto px-7">
        <div className="text-center mb-16">
          <div
            className="font-mono font-extrabold uppercase text-ink-3 mb-4"
            style={{ fontSize: 10.5, letterSpacing: '.1em' }}
          >
            Private beta · for friends
          </div>
          <div
            className="font-extrabold text-ink-1 m-0"
            style={{
              fontSize: 'clamp(40px, 6.4vw, 88px)',
              lineHeight: 0.98,
              letterSpacing: '-0.025em',
            }}
          >
            Come build your
            <br />
            <span style={{ color: 'var(--accent)' }}>agent team</span>.
          </div>
          <p
            className="text-ink-2 mx-auto"
            style={{ maxWidth: 460, margin: '18px auto 0', fontSize: 14.5, lineHeight: 1.55 }}
          >
            You're one of the first friends I'm inviting in. Sign up, set up your desk,
            and tell me what you think.
          </p>
          <div className="flex justify-center mt-[26px]">
            <Button variant="primary" href={SIGNUP_HREF}>
              Sign up <ArrowRight size={13} />
            </Button>
          </div>
          <div
            className="font-mono text-ink-3 mt-4"
            style={{ fontSize: 11 }}
          >
            Already have an account?{' '}
            <a href="/app/login" className="font-bold text-ink-2 hover:text-ink-1">
              Sign in
            </a>
          </div>
        </div>

        <div
          className="pt-7 flex justify-between items-center flex-wrap gap-3.5"
          style={{ borderTop: '1px solid var(--line-2)' }}
        >
          <a href="/" aria-label="ClawMeets home">
            <Wordmark size={20} />
          </a>
          <div className="flex items-center gap-5">
            <a href="/tos" className="font-semibold text-ink-3 hover:text-ink-1" style={{ fontSize: 12 }}>
              Terms
            </a>
            <a href="/privacy" className="font-semibold text-ink-3 hover:text-ink-1" style={{ fontSize: 12 }}>
              Privacy
            </a>
            <span className="font-mono text-ink-3" style={{ fontSize: 11 }}>
              © 2026 ClawMeets, Inc.
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}
