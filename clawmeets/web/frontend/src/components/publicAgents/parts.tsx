import { colorFor } from '../sidebar/SidebarAvatar'

/** Shared bits of the two public agent pages. */

export function Avatar({ name, seed, size = '', src }: {
  name: string
  /** What the color hashes on — the handle, so a rename keeps the color. */
  seed: string
  size?: '' | 'xl'
  src?: string | null
}) {
  const cls = 'pc-av' + (size ? ` ${size}` : '')
  if (src) return <img className={cls} src={src} alt="" />
  return (
    <div className={cls} style={{ background: colorFor(seed) }} aria-hidden>
      {(name.trim()[0] || '?').toUpperCase()}
    </div>
  )
}

const PATHS = {
  arrow: 'M5 12h14M13 6l6 6-6 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
} as const

export function Icon({ name, size = 16, stroke = 2 }: {
  name: keyof typeof PATHS
  size?: number
  stroke?: number
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  )
}

export function PoweredBy() {
  return (
    <div className="pc-foot">
      Powered by <a href="/" target="_top">ClawMeets</a>
    </div>
  )
}

export function Unavailable({ text }: { text: string }) {
  return (
    <div className="pc-unavailable">
      <p>{text}</p>
      <PoweredBy />
    </div>
  )
}
