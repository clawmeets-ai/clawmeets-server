import type { ReactNode } from 'react'

/** Shared building blocks for the Agent Settings section bodies. */

export const inputClass =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 transition-colors bg-gray-50/50 placeholder-gray-400'

export function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[11px] bg-gray-100 px-1 py-0.5 rounded">{children}</code>
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-gray-800 mb-1.5">
        {label}
      </label>
      {children}
      {hint && <div className="mt-1.5 text-xs text-gray-500 leading-relaxed">{hint}</div>}
    </div>
  )
}

/** Closed-by-default disclosure for long "how it works" help text. */
export function HelpDisclosure({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  return (
    <details className="group mt-1.5 text-xs text-gray-500">
      <summary className="cursor-pointer select-none font-semibold text-purple-700 hover:text-purple-800 list-none inline-flex items-center gap-1">
        <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>▸</span>
        {summary}
      </summary>
      <div className="mt-2 space-y-2 leading-relaxed">{children}</div>
    </details>
  )
}

export function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5">
      <span aria-hidden className="mt-0.5 text-amber-500 text-sm leading-none">⚑</span>
      <div className="text-xs text-amber-900 leading-relaxed">{children}</div>
    </div>
  )
}

/** Section title + one-line purpose, at the top of the right-hand pane. */
export function SectionTitle({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div>
        <h2 className="text-lg font-bold text-gray-900">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
