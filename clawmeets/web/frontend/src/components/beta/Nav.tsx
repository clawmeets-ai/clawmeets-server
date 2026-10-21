import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import Button from '../hero/Button'
import { Wordmark } from '../landing/Nav'
import { SIGNUP_HREF } from './constants'

// Slim nav for the beta page — wordmark + the single Sign up CTA.
// No in-page section links: this page has one job, get friends signed up.
export default function Nav() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div
      className="sticky top-0 z-50"
      style={{
        background: 'rgba(255,255,255,.9)',
        backdropFilter: 'saturate(1.1)',
        borderBottom: scrolled ? '1px solid var(--line-1)' : '1px solid transparent',
        transition: 'border-color .2s',
      }}
    >
      <div
        className="max-w-6xl mx-auto flex items-center justify-between gap-6"
        style={{ padding: '14px 28px' }}
      >
        <a href="/" aria-label="ClawMeets home">
          <Wordmark />
        </a>
        <div className="flex items-center gap-2.5">
          <a
            href="/app/login"
            className="font-semibold text-ink-2 hover:text-ink-1"
            style={{ fontSize: 12.5 }}
          >
            Sign in
          </a>
          <Button variant="primary" href={SIGNUP_HREF}>
            Sign up <ArrowRight size={12} />
          </Button>
        </div>
      </div>
    </div>
  )
}
