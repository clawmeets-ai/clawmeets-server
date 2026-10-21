import { EARLY_ACCESS_HREF, EARLY_ACCESS_LABEL } from './earlyAccess'

// Public-folder asset: needs BASE_URL because Vite sets base: '/app/'.
const MARK_SRC = `${import.meta.env.BASE_URL}clawmeets-mark.svg`

interface WordmarkProps {
  size?: number
}

export function Wordmark({ size = 22 }: WordmarkProps) {
  const markSize = Math.round(size * 1.15)
  return (
    <span
      className="inline-flex items-center font-extrabold text-ink-1"
      style={{
        fontSize: size,
        letterSpacing: '-0.01em',
        gap: Math.round(size * 0.38),
        lineHeight: 1,
      }}
    >
      <img
        src={MARK_SRC}
        alt=""
        width={markSize}
        height={markSize}
        style={{ flexShrink: 0, display: 'block' }}
      />
      ClawMeets
    </span>
  )
}

// [number, label, section id]. Each id must match a section mounted in
// app/page.tsx (LandingPage.test enforces it).
export const SECTIONS: [string, string, string][] = [
  ['01', 'Why', 'why'],
  ['02', 'Why a team', 'team'],
  ['03', 'How it works', 'how'],
  ['04', "What's different", 'diff'],
  ['05', 'Knowledge', 'know'],
]

export default function Nav() {
  return (
    <header className="nav">
      <div className="wrap">
        <a className="logo" href="#top" aria-label="ClawMeets home">
          <Wordmark size={20} />
        </a>
        <nav className="nav__links">
          {SECTIONS.map(([n, label, id]) => (
            <a key={id} href={`#${id}`}>
              <span>{n}</span>
              {label}
            </a>
          ))}
        </nav>
        <div className="nav__r">
          <a href="/app/login">Log in</a>
          <a className="btn btn--p btn--sm" href={EARLY_ACCESS_HREF}>
            {EARLY_ACCESS_LABEL} →
          </a>
        </div>
      </div>
    </header>
  )
}
