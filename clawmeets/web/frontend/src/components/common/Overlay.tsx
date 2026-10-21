interface OverlayProps {
  isOpen: boolean
  onClose: () => void
}

export default function Overlay({ isOpen, onClose }: OverlayProps) {
  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-40 bg-black/50 lg:hidden"
      onClick={onClose}
    />
  )
}
