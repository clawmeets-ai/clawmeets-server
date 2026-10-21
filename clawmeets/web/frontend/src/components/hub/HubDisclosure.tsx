import { REMOTE_TEXT_CAP, safeRemoteText, shortFingerprint } from '../../utils/hubDisplay'
import UnusualNameChip from './UnusualNameChip'

/** What the note needs about the remote side: an agent item before the
 *  thread exists, then start_conversation.target or the thread's hub_target. */
export interface DisclosureTarget {
  deployment_name: string
  deployment_fingerprint: string
  current_fingerprint?: string
  deployment_url: string | null
  deployment_url_verified: boolean
  first_contact?: boolean
}

/**
 * The "hosted on X" note, shown before the first message. It says where the
 * message goes and who can read it, and how the other side will see the user
 * (config.sender_label, never built here). Identity is the genesis
 * fingerprint; "(current key …)" is a label shown only when it differs. The
 * address is text, never a link, and only when the server verified it.
 */
export default function HubDisclosure({ target, senderLabel }: { target: DisclosureTarget; senderLabel: string }) {
  const dep = safeRemoteText(target.deployment_name, REMOTE_TEXT_CAP.name)
  const fp = shortFingerprint(target.deployment_fingerprint)
  const current = target.current_fingerprint
  const showCurrent = current !== undefined && current !== target.deployment_fingerprint
  const url = target.deployment_url_verified ? safeRemoteText(target.deployment_url, REMOTE_TEXT_CAP.name) : ''
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-sm text-gray-800" data-testid="hub-disclosure">
      {target.first_contact && (
        <span className="mb-2 inline-block rounded bg-indigo-100 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700">
          new to you
        </span>
      )}
      <UnusualNameChip name={target.deployment_name} />
      <p>
        This agent is hosted on <bdi className="font-semibold">{dep}</bdi>, not on this server. What you send goes
        through the ClawMeets Hub to <bdi>{dep}</bdi>, whose operator can read it, and the hub can read it in transit.
        They will see you as <bdi className="font-semibold" data-testid="hub-sender-label">{safeRemoteText(senderLabel, REMOTE_TEXT_CAP.name)}</bdi>.
      </p>
      <p className="mt-2 text-xs text-gray-600" data-testid="hub-disclosure-identity">
        Server fingerprint <span className="font-mono">{fp}</span>
        {showCurrent && <> (current key <span className="font-mono">{shortFingerprint(current)}</span>)</>}
        {' · '}
        {url ? <>address <bdi data-testid="hub-disclosure-url">{url}</bdi> ✓ verified</> : 'address not verified'}
      </p>
    </div>
  )
}
