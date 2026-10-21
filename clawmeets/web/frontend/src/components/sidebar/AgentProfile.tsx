import { Link } from 'react-router-dom'
import type { User } from '../../types'
import { useLogout } from '../../hooks/useLogout'
import { Settings, LogOut } from 'lucide-react'

interface UserProfileProps {
  user?: User | null
}

export default function UserProfile({ user }: UserProfileProps) {
  const logout = useLogout()

  if (!user) {
    return null
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white font-bold text-sm">
        {user.username.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sidebar-text-active truncate">
          {user.username}
        </div>
      </div>
      <Link
        to="/settings"
        className="text-channel hover:text-channel-active transition-colors"
        title="Settings"
      >
        <Settings className="w-4 h-4" />
      </Link>
      <button
        onClick={logout}
        className="flex items-center gap-1 text-channel hover:text-channel-active text-sm transition-colors"
        title="Logout"
      >
        <LogOut className="w-3.5 h-3.5" />
        Logout
      </button>
    </div>
  )
}
