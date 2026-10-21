import type { EpochSeconds } from '../../api/endpoints/hub'
import { useHubAvatar } from '../../hooks/useHub'
import { initials } from '../../utils/hubDisplay'

/**
 * A remote agent's avatar. The PNG is fetched with the bearer token through
 * useHubAvatar (an <img src={avatar_url}> would get a 401) and shown from a
 * local object URL; the cache key carries the listing's refresh time. Anything
 * else (no avatar, an error, a non-PNG, a path that is not the same-origin
 * proxy) shows the initials. Never gated on the hub's mode.
 */
export default function HubAvatar({ avatarUrl, refreshedAt, name, size = 36 }: {
  avatarUrl: string | null
  refreshedAt?: EpochSeconds
  name: string
  size?: number
}) {
  const url = useHubAvatar(avatarUrl, refreshedAt)
  const box = { width: size, height: size }
  if (url) {
    return <img src={url} alt="" style={box} className="rounded-lg object-cover flex-shrink-0" data-testid="hub-avatar-img" />
  }
  return (
    <span
      aria-hidden="true"
      style={box}
      className="rounded-lg bg-indigo-100 text-indigo-700 font-bold text-sm flex items-center justify-center flex-shrink-0"
      data-testid="hub-avatar-initials"
    >
      {initials(name)}
    </span>
  )
}
