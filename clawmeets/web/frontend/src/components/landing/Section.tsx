import type { ReactNode } from 'react'

// The anatomy every numbered homepage section shares, in order: label →
// headline → description → comparison. Styles live in styles/homepage.css.

export function SectionLabel({ n, label }: { n: string; label: string }) {
  return (
    <div className="draw">
      <span className="draw__n">{n}</span>
      <span className="draw__t">{label}</span>
    </div>
  )
}

interface SectionProps {
  id: string
  n: string
  label: string
  /** First clause of the headline, in ink. */
  headline: ReactNode
  /** Second clause of the headline, in the accent colour. */
  accent?: ReactNode
  description: ReactNode
  tint?: boolean
  children?: ReactNode
}

export default function Section({
  id,
  n,
  label,
  headline,
  accent,
  description,
  tint,
  children,
}: SectionProps) {
  return (
    <section className={tint ? 'sec sec--tint' : 'sec'} id={id}>
      <div className="wrap">
        <SectionLabel n={n} label={label} />
        <h2 className="km">
          {headline}
          {accent && (
            <>
              {' '}
              <em>{accent}</em>
            </>
          )}
        </h2>
        <p className="desc">{description}</p>
        {children}
      </div>
    </section>
  )
}

export interface WayProps {
  title: string
  lede: string
  /** The illustrative mock: cluttered on the old side, crisp on the new. */
  children: ReactNode
  /** Footer line. Both sides use the same label so the outcomes read as a pair. */
  limit?: { label: string; text: ReactNode; bar?: boolean }
}

function Way({ side, title, lede, children, limit }: WayProps & { side: 'old' | 'new' }) {
  return (
    <div className={`way ${side}`}>
      <span className="tag">{side === 'old' ? 'The old way' : 'The ClawMeets way'}</span>
      <h3>{title}</h3>
      <p>{lede}</p>
      <div className="way__body">{children}</div>
      {limit && (
        <div className="limit">
          <b>{limit.label}</b> {limit.text}
          {limit.bar && (
            <div className="bar">
              <i />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function Compare({ old, new: next }: { old: WayProps; new: WayProps }) {
  return (
    <div className="cmp">
      <Way side="old" {...old} />
      <div className="cmp__arrow" aria-hidden="true">
        <span>→</span>
      </div>
      <Way side="new" {...next} />
    </div>
  )
}
