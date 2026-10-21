import type { HubContactFields } from '../../api/endpoints/hub'
import { hubContactParts, REMOTE_TEXT_CAP, safeRemoteText } from '../../utils/hubDisplay'
import { RECEIVING_COPY } from '../../utils/agentAccessCopy'
import UnusualNameChip from './UnusualNameChip'

/**
 * A person on another server, as the agent's owner sees them in Requests and
 * Front Desk: "{remote_username} from {deployment_name} · fp 3f9a1c2e".
 *
 * Drawn from the three structured fields, each in its own span, never from the
 * pre-joined contact_name: a username like "carol @ clawmeets.ai" stays inside
 * the bold name, and the real server follows "from" with its fingerprint. A
 * requester known only by key has no deployment_name: the label says "server"
 * and the fingerprint chip names it. Rows without the fields (every non-Hub
 * channel) show `fallbackName` as text. A request an agent sent for its
 * person adds "via their agent X" (via_agent).
 */
export default function HubContactLabel({ fields, fallbackName }: {
  fields: HubContactFields
  fallbackName: string
}) {
  const parts = hubContactParts(fields)
  // The requester's agent that sent this for them: remote text, name-capped.
  const via = fields.via_agent ? safeRemoteText(fields.via_agent, REMOTE_TEXT_CAP.name) : ''
  if (!parts) return <span data-testid="contact-fallback">{fallbackName}</span>
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1 min-w-0" data-testid="hub-contact">
      <bdi className="font-bold" data-testid="hub-contact-user">{parts.user}</bdi>
      <span className="font-normal text-gray-500">from</span>
      <bdi data-testid="hub-contact-server">{parts.server}</bdi>
      <span
        className="font-mono font-normal text-[10.5px] px-1 rounded bg-gray-100 text-gray-600"
        data-testid="hub-contact-fp"
        title={fields.deployment_fingerprint ?? undefined}
      >
        fp {parts.fp}
      </span>
      <UnusualNameChip name={fields.deployment_name} />
      {via && (
        <span className="font-normal text-gray-500" data-testid="hub-contact-via">
          {RECEIVING_COPY.viaAgent} <bdi className="text-gray-700">{via}</bdi>
          <UnusualNameChip name={fields.via_agent} />
        </span>
      )}
    </span>
  )
}
