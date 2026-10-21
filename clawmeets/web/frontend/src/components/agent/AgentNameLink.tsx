import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { agentStartPath } from './AgentViewActions'

interface Props {
  /** Full agent name (`{username}-{suffix}`) — what the start view's route resolves. */
  agentName: string
  className?: string
  children: ReactNode
}

/**
 * An agent's rendered name as a link to its start view, so wherever an agent
 * is named (desk card byline, DM header, participant lists, a computer's
 * agents) one click opens it. Keeps the surrounding text styling; only adds
 * the underline on hover.
 */
export default function AgentNameLink({ agentName, className = '', children }: Props) {
  return (
    <Link to={agentStartPath(agentName)} className={`hover:underline ${className}`}>
      {children}
    </Link>
  )
}
