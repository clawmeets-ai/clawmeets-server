import { useCallback, useEffect, useRef } from 'react'

interface ResizeHandleProps {
  side: 'left' | 'right'
  onResize: (delta: number) => void
}

export default function ResizeHandle({ side, onResize }: ResizeHandleProps) {
  const isDragging = useRef(false)
  const startX = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    startX.current = e.clientX
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = e.clientX - startX.current
      startX.current = e.clientX
      // For a right-side panel, dragging left should increase width
      onResize(side === 'left' ? delta : -delta)
    }

    const handleMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [onResize, side])

  return (
    <div
      onMouseDown={handleMouseDown}
      className="hidden lg:flex items-center justify-center w-1 hover:w-1.5 cursor-col-resize group flex-shrink-0 transition-all"
    >
      <div className="w-0.5 h-8 rounded-full bg-gray-300 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  )
}
