import { Globe, Mail, MessageCircle, Network, Phone, Send, Radio } from 'lucide-react'
import { channelName } from '../../utils/channelThreads'

const ICONS: Record<string, typeof Send> = {
  telegram: Send,
  email: Mail,
  line: MessageCircle,
  whatsapp: Phone,
  webchat: Globe,
  hub: Network,
}

/** A channel's icon, named for assistive tech ("Telegram", "Email", "LINE",
 *  "WhatsApp", "Web chat"). The name is also the tooltip. `decorative` hides it from
 *  assistive tech where the channel's name is already written beside it. */
export default function ChannelBadge({ channel, size = 12, decorative = false }: {
  channel: string; size?: number; decorative?: boolean
}) {
  const Icon = ICONS[channel] ?? Radio
  const name = channelName(channel)
  if (decorative) {
    return <Icon className="shrink-0 text-ink-3" style={{ width: size, height: size }} aria-hidden />
  }
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      data-testid="channel-badge"
      className="shrink-0 inline-flex items-center justify-center text-ink-3"
    >
      <Icon className="shrink-0" style={{ width: size, height: size }} aria-hidden />
    </span>
  )
}
