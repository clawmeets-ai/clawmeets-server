interface LoadingProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeClasses = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
}

export default function Loading({ size = 'md', className = '' }: LoadingProps) {
  return (
    <div
      className={`
        ${sizeClasses[size]} ${className}
        animate-spin rounded-full
        border-2 border-gray-300 border-t-blue-600
      `}
    />
  )
}
