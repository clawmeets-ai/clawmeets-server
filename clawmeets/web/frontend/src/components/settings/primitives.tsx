import type { ReactNode } from 'react'

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex items-start justify-center overflow-y-auto py-10">
      <div className="max-w-3xl w-full px-6 space-y-6">
        {children}
      </div>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  titleExtra,
}: {
  title: ReactNode
  subtitle?: ReactNode
  titleExtra?: ReactNode
}) {
  return (
    <div className="mb-2">
      <h1 className="text-[26px] leading-[1.15] font-extrabold tracking-[-0.02em] text-gray-900 flex items-center gap-3">
        {title}
        {titleExtra}
      </h1>
      {subtitle && <p className="text-sm text-gray-500 leading-relaxed max-w-2xl mt-2">{subtitle}</p>}
    </div>
  )
}

export function SectionCard({ children }: { children: ReactNode }) {
  return (
    <div className="border border-gray-200 rounded-xl bg-white">
      {children}
    </div>
  )
}

export function SectionHeader({
  title,
  icon,
  subtitle,
  action,
}: {
  title: string
  icon?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
      <div>
        <h2 className="text-base font-bold text-gray-900 flex items-center gap-2">
          {icon && <span className="text-purple-600">{icon}</span>}
          {title}
        </h2>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium text-gray-400 uppercase tracking-wider">{label}</span>
      <span className="text-sm text-gray-900">{children}</span>
    </div>
  )
}

export function Alert({ type, message }: { type: 'success' | 'error' | 'warning'; message: string }) {
  const styles =
    type === 'success'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
      : type === 'warning'
      ? 'bg-amber-50 border-amber-200 text-amber-800'
      : 'bg-red-50 border-red-200 text-red-700'
  return (
    <div className={`p-3 border rounded-lg text-xs ${styles}`}>
      {message}
    </div>
  )
}

export function Badge({ variant, children }: { variant: 'success' | 'warning'; children: ReactNode }) {
  const styles = variant === 'success'
    ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
    : 'text-amber-600 bg-amber-50 border-amber-200'
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${styles}`}>
      {children}
    </span>
  )
}
