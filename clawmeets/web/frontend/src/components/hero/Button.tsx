import type { ReactNode } from 'react'

type Variant = 'primary' | 'ghost'
type Size = 'sm' | 'md'

interface CommonProps {
  variant?: Variant
  size?: Size
  className?: string
  children: ReactNode
}

interface AnchorProps extends CommonProps {
  href: string
  onClick?: never
  title?: string
  type?: never
}

interface ButtonProps extends CommonProps {
  href?: never
  onClick?: () => void
  title?: string
  type?: 'button' | 'submit'
}

type Props = AnchorProps | ButtonProps

const base =
  'inline-flex items-center gap-1.5 rounded-md font-semibold transition-colors select-none ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

const sizeClass: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
}

const variantClass: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-deep',
  ghost:
    'bg-white text-ink-2 border border-[color:var(--line-2)] hover:bg-accent-softer hover:text-accent-deep',
}

export default function Button(props: Props) {
  const { variant = 'primary', size = 'md', className = '', children } = props
  const cls = `${base} ${sizeClass[size]} ${variantClass[variant]} ${className}`.trim()

  if ('href' in props && props.href !== undefined) {
    return (
      <a href={props.href} className={cls} title={props.title}>
        {children}
      </a>
    )
  }

  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      title={props.title}
      className={cls}
    >
      {children}
    </button>
  )
}
