import type { EpochSeconds, HubAgent, HubContactFields, HubTarget, RetainedAgent } from '../api/endpoints/hub'
import type { Project } from '../types'
import { UNNAMED_CONTACT } from './channelThreads'

/**
 * Pure display rules for hub objects: timestamps, fingerprints, remote text,
 * the avatar path check, the directory dedupe and the sidebar buckets. No React.
 *
 * Every string a remote server chose (names, descriptions, capabilities, the
 * hub's status words) goes through safeRemoteText and is rendered as a React
 * text node — never markup, never an href or src.
 */

/** The ONLY converter for EpochSeconds. ISO fields elsewhere keep their parsers. */
export function epochToDate(s: EpochSeconds): Date {
  return new Date(s * 1000)
}

/** "Sat 14:05" in the viewer's time zone: the delivery lines' deadlines. */
export function formatHubTime(s: EpochSeconds): string {
  return epochToDate(s).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/** "3 Oct 2026, 14:05": dates further out (key expiry, "since"). */
export function formatHubDate(s: EpochSeconds): string {
  return epochToDate(s).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** "just now", "12 min", "3 h", "9 days": an age in seconds. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return 'less than a minute'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`
  const days = Math.floor(seconds / 86400)
  return days === 1 ? '1 day' : `${days} days`
}

/** First 8 characters of a fingerprint, for chips. Never a key. */
export function shortFingerprint(fp: string): string {
  return fp.slice(0, 8)
}

/** Caps for remote text, by kind (characters, counted as code points). */
export const REMOTE_TEXT_CAP = {
  name: 80,
  username: 40,
  description: 500,
  capability: 40,
  detail: 300,
} as const

// Bidi controls, default-ignorable code points (zero-width characters, variation
// selectors, the U+E00xx tag characters used for invisible prompt smuggling)
// and C0/C1 controls. Newline is handled separately so descriptions keep it.
const INVISIBLE = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]|[\x00-\x09\x0B-\x1F\x7F-\x9F]/gu

/** Strip invisible and direction-changing characters; newlines survive. */
export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, '')
}

/** Strip invisible and direction-changing characters, then cap the length.
 *  `null`/`undefined` read as "". Newlines survive only when allowed. */
export function safeRemoteText(s: string | null | undefined, cap: number, allowNewline = false): string {
  if (!s) return ''
  let out = stripInvisible(s)
  if (!allowNewline) out = out.replace(/\n+/g, ' ')
  const chars = Array.from(out)
  return chars.length > cap ? chars.slice(0, cap - 1).join('') + '…' : out
}

/** True when a name has a character outside printable ASCII: a confusable risk. */
export function hasUnusualCharacters(s: string): boolean {
  return /[^\x20-\x7E]/.test(s)
}

/** A server name reduced to how it looks: look-alike letter runs and
 *  separators fold together, so names that read the same compare equal. */
export function nameSkeleton(name: string): string {
  return name.toLowerCase()
    .replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd')
    .replace(/[1i|]/g, 'l').replace(/0/g, 'o').replace(/5/g, 's')
    .replace(/[-_.\s]+/g, '.')
}

// The id is the server's agent_ref, written unencoded: a 16-character
// fingerprint, "~", then an agent name (hub_protocol/ids.py). So no "." or
// ".." segment, no percent-encoding and no other character can get through.
const PROXY_AVATAR = /^\/api\/hub\/agents\/[a-z0-9]{16}~[a-z0-9][a-z0-9._-]{0,62}\/avatar$/

/** True only for a same-origin path of the form /api/hub/agents/{fingerprint}~{name}/avatar. */
export function isProxyAvatarUrl(u: string | null | undefined): u is string {
  return typeof u === 'string' && PROXY_AVATAR.test(u)
}

/** Initials for an avatar fallback, from the remote name. */
export function initials(name: string): string {
  const clean = safeRemoteText(name, REMOTE_TEXT_CAP.name).replace(/[^\p{L}\p{N}]/gu, '')
  return (Array.from(clean)[0] ?? '?').toUpperCase()
}

/**
 * The "On other servers" list: hide agents of this server (`is_local`, or the
 * server's own genesis fingerprint once it has one), then keep one item per
 * hub_agent_id — the newest listing wins. The id is compared as a whole string.
 */
export function dedupeRemote(agents: HubAgent[], ownFingerprint: string | null): HubAgent[] {
  const byId = new Map<string, HubAgent>()
  for (const a of agents) {
    if (a.is_local) continue
    if (ownFingerprint !== null && a.deployment_fingerprint === ownFingerprint) continue
    const seen = byId.get(a.hub_agent_id)
    if (!seen || a.listing_refreshed_at > seen.listing_refreshed_at) byId.set(a.hub_agent_id, a)
  }
  return [...byId.values()]
}

/**
 * This server's own agents as the hub lists them (is_local), newest listing
 * per id. They keep the in-process path: Message opens the ordinary DM, never
 * a hub thread.
 */
export function localListed(agents: HubAgent[]): HubAgent[] {
  const byId = new Map<string, HubAgent>()
  for (const a of agents) {
    if (!a.is_local) continue
    const seen = byId.get(a.hub_agent_id)
    if (!seen || a.listing_refreshed_at > seen.listing_refreshed_at) byId.set(a.hub_agent_id, a)
  }
  return [...byId.values()]
}

/** Stale: not seen for more than 7 days (a frontend default). */
export const STALE_AFTER_S = 7 * 86400

export function isStaleListing(a: Pick<HubAgent, 'last_seen_at'>, nowMs: number): boolean {
  return a.last_seen_at !== null && nowMs / 1000 - a.last_seen_at > STALE_AFTER_S
}

export interface HubBucket {
  /** Genesis fingerprint: the bucket key. */
  fingerprint: string
  /** "acme.dev", or "acme.dev · 3f9a1c2e" when another bucket has the same name. */
  label: string
  /** The name as received, for the unusual-characters check. */
  deploymentName: string
  projects: (Project & { hub_target: HubTarget })[]
}

const activity = (p: Project) => p.last_modified ?? p.created_at

/**
 * Sidebar buckets: projects with a hub_target, one bucket per GENESIS
 * deployment_fingerprint (so a key rotation never splits a bucket, and two
 * servers that share a name never merge), headed by the deployment name. When
 * two buckets share a name, both headers add the short fingerprint. Buckets
 * sort by name, rows newest first.
 */
export function groupHubThreads(projects: Project[]): HubBucket[] {
  const byFp = new Map<string, HubBucket>()
  for (const p of projects) {
    const t = p.hub_target
    if (!t) continue
    let b = byFp.get(t.deployment_fingerprint)
    if (!b) {
      b = {
        fingerprint: t.deployment_fingerprint,
        label: safeRemoteText(t.deployment_name, REMOTE_TEXT_CAP.name),
        deploymentName: t.deployment_name,
        projects: [],
      }
      byFp.set(t.deployment_fingerprint, b)
    }
    b.projects.push(p as Project & { hub_target: HubTarget })
  }
  const buckets = [...byFp.values()]
  // Two servers whose names only look alike (acme.dev, acrne.dev, acme-dev)
  // get the fingerprint as well as two with the same name; so does a name
  // with unusual characters, which can look like any other.
  const nameCount = new Map<string, number>()
  for (const b of buckets) nameCount.set(nameSkeleton(b.label), (nameCount.get(nameSkeleton(b.label)) ?? 0) + 1)
  for (const b of buckets) {
    const confusable = (nameCount.get(nameSkeleton(b.label)) ?? 0) > 1 || hasUnusualCharacters(b.deploymentName)
    if (confusable) b.label = `${b.label} · ${shortFingerprint(b.fingerprint)}`
    b.projects.sort((x, y) => activity(y).localeCompare(activity(x)))
  }
  return buckets.sort((x, y) => x.label.localeCompare(y.label) || x.fingerprint.localeCompare(y.fingerprint))
}

/** A retained agent of another server as `name@server`, both parts remote
 *  text. The one label the Agents panel, Cmd-K and the desk all show. */
export function retainedHubLabel(r: Pick<RetainedAgent, 'name' | 'deployment_name'>): string {
  return `${safeRemoteText(r.name, REMOTE_TEXT_CAP.name)}@${safeRemoteText(r.deployment_name, REMOTE_TEXT_CAP.name)}`
}

/** The route of a hub thread (or a new-chat draft when projectId is absent). */
export function hubThreadPath(hubAgentId: string, projectId?: string): string {
  const base = `/hub/${encodeURIComponent(hubAgentId)}`
  return projectId ? `${base}/${encodeURIComponent(projectId)}` : base
}

/** A Hub requester's parts, from the structured fields only (never the
 *  pre-joined contact_name). null for rows that are not Hub rows. A requester
 *  known only by key has no server name: "server", and the fingerprint names it. */
export function hubContactParts(f: HubContactFields): { user: string; server: string; fp: string } | null {
  const fp = f.deployment_fingerprint
  if (!fp) return null
  return {
    user: safeRemoteText(f.remote_username, REMOTE_TEXT_CAP.username) || UNNAMED_CONTACT,
    server: safeRemoteText(f.deployment_name, REMOTE_TEXT_CAP.name) || 'server',
    fp: shortFingerprint(fp),
  }
}

/** The same, as one line for tooltips and sorting: "carol from acme.dev · fp 3f9a1c2e". */
export function hubContactText(f: HubContactFields): string | null {
  const p = hubContactParts(f)
  return p && `${p.user} from ${p.server} · fp ${p.fp}`
}
