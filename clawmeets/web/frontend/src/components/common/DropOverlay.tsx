import { Upload } from 'lucide-react'

interface DropOverlayProps {
  visible: boolean
  label?: string
}

/**
 * Absolutely-positioned dashed drop hint rendered inside a `relative` composer
 * card. Returns null when !visible. Non-interactive (pointer-events-none) so it
 * never eats the drop event the parent's onDrop must receive. Purely
 * presentational — matches the app's accent/purple focus styling.
 */
export default function DropOverlay({
  visible,
  label = 'Drop files to attach',
}: DropOverlayProps) {
  if (!visible) return null
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-purple-400 bg-purple-50/90 backdrop-blur-[1px]">
      <div className="flex items-center gap-2 text-sm font-semibold text-accent-deep">
        <Upload className="w-4 h-4" />
        {label}
      </div>
    </div>
  )
}
