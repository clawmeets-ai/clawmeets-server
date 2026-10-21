import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../stores/authStore'
import { useAgents } from './useAgents'
import { useDmThreads } from './useDmThreads'
import { useUserProjects } from './useProjects'
import { useProjectsWithChatrooms } from './useProjectsWithChatrooms'
import { useActiveWorkStore } from '../stores/activeWorkStore'
import { useUnreadStore } from '../stores/unreadStore'
import { useDeskReadState } from './useDeskReadState'
import { getDeskLatestMessages } from '../api/endpoints/deskLatestMessages'
import { getChatroomDisplayName } from '../utils/chatroomDisplay'
import { hubThreadPath, REMOTE_TEXT_CAP, safeRemoteText } from '../utils/hubDisplay'
import { isContactId, storedSenderName } from '../utils/messageSender'
import { isChatFileEvent, isChatMessage, type AgentCard, type ChatLogEntry, type ChatMessage } from '../types'
import type { PlanSummary } from '../api/endpoints/projectPlans'

// Each desk card is a DM or Project whose user-communication room has something
// the manager should see. Lanes are derived from real backend signals — no
// synthetic priority/kind fields (those design-only bits are skipped).
// `read` is a presentational lane the frontend sets on "Recently done"
// cards (useDeskRecentlyDone) — never emitted by useDeskUpdates, which only
// decides the three live lanes below.
export type DeskLane = 'reply' | 'report' | 'progress' | 'read'

// A file attached to a desk card's latest message (a sibling ChatFileEvent).
export interface DeskFile {
  filename: string
  entryType: 'file_created' | 'file_updated'
}

export interface DeskUpdate {
  projectId: string
  lane: DeskLane
  kind: 'dm' | 'project'
  agent: AgentCard | null
  agentName: string
  /** mono source label: DM thread title or project name. */
  sourceName: string
  /** secondary source line ("direct message" / "# user-communication"). */
  roomLabel: string
  title: string
  quote: string
  /** True when `quote` is the USER'S OWN message — they wrote last and the
   *  agent hasn't answered yet — so the card labels it as their request rather
   *  than the agent's response. Absent ⇒ the agent's words. */
  quoteIsYours?: boolean
  /** Set when `quote` is an outside contact's words (a channel thread whose
   *  newest message came from Telegram, email, …): that person's display name.
   *  Absent ⇒ the quote is the agent's or the user's own. */
  quoteFromContact?: string
  /** from_participant_id of the quoted message (the quote and its files), or
   *  null when not known (no message, or a signed-off card: the wire carries
   *  no author). The card asks the room's trust rule about this author. */
  quoteAuthorId: string | null
  /** The quoted message was stamped outside_isolated: outside for good,
   *  whatever the room's live participant rule says about its author. */
  quoteOutsideIsolated: boolean
  ts: string
  /** newest message id — the cursor Dismiss marks as seen. */
  latestMessageId: string | null
  /** files that rode in with the latest message (empty when none). */
  files: DeskFile[]
  /** in-app destination for "Open thread / Open project". */
  navTo: string
  /** The project's plan summary, or null when it has no plan (every DM, and
   *  any pre-feature project). The card's Plan band reads it and adds nothing
   *  to `open_notes_for_you`. */
  plan: PlanSummary | null
  /** Non-null EXACTLY when a real completion report exists. Already fetched
   *  onto `Candidate` off the project list and already in memory; forwarded
   *  here so the card's REPORT band can be PRESENT without a per-card request.
   *  A PASS-THROUGH — not a new field on the wire, and nothing derives it. */
  reportPublishedAt: string | null
  /** A hub thread (an agent of another server). It is written only through
   *  the hub send route, so Send Back goes there, and the whole thread is
   *  outside content. Absent on every other card. */
  hubThread?: boolean
}

export interface DeskCounts {
  reply: number
  report: number
  progress: number
}

// Desk-scoped unread key. The desk keys lastSeen by (project, user-comm room)
// so Dismiss persists per card without an extra room-id lookup.
export function deskRoomKey(projectId: string): string {
  return `${projectId}|user-communication`
}

// Seen-cursor value written when dismissing a card that has no message to
// anchor on (e.g. a completed project with an empty user-communication room).
export const DISMISS_SENTINEL = '__dismissed__'

const MAX_CANDIDATES = 30

// Query-key root for the batched desk feed; useWebSocket invalidates it.
export const DESK_LATEST_MESSAGES_KEY = 'desk-latest-messages'

interface Candidate {
  projectId: string
  kind: 'dm' | 'project'
  title: string
  coordinatorId: string
  lastModified: string
  // The gating fact the report lane reads. Non-null ⇒ a real completion report
  // exists (⇒ project is completed). null for DMs and completed-no-report.
  reportPublishedAt: string | null
  plan: PlanSummary | null
  /** A hub thread: the agent is on another server, so there is no agent card;
   *  the card names it `name@server` and opens the hub thread. */
  hub?: { hubAgentId: string; label: string }
}

function newestMessage(entries: ChatLogEntry[] | undefined): ChatMessage | null {
  if (!entries) return null
  let best: ChatMessage | null = null
  for (const e of entries) {
    if (!isChatMessage(e) || e.is_ack) continue
    if (!best || (e.ts ?? '') >= (best.ts ?? '')) best = e
  }
  return best
}

// The file events that rode in with `msg`: same sender, and the event's
// source_version points back at msg — either msg.source_version === it (an
// agent reply + its update_file share one source_version) or msg.version ===
// it (a user/root message the file was appended to). Mirrors MessageList's
// grouping rule. Dedupes by filename (latest wins). Returns [] when msg is null.
function filesForMessage(
  entries: ChatLogEntry[] | undefined,
  msg: ChatMessage | null,
): DeskFile[] {
  if (!entries || !msg) return []
  const byName = new Map<string, DeskFile>()
  for (const e of entries) {
    if (!isChatFileEvent(e) || e.source_version == null) continue
    if (e.from_participant_id !== msg.from_participant_id) continue
    const matches =
      (msg.source_version != null && msg.source_version === e.source_version) ||
      (msg.version != null && msg.version === e.source_version)
    if (!matches) continue
    byName.set(e.filename, { filename: e.filename, entryType: e.entry_type })
  }
  return [...byName.values()]
}

/**
 * Derives the My Desk update feed + lane counts from live signals: the user's
 * DMs + regular projects, each project's newest user-communication message,
 * the active-work store, and per-card seen cursors. All consumers (desk header,
 * rail badges, pulse stats) call this hook and read the same react-query cache,
 * so counts stay consistent without a lifted counter.
 */
export function useDeskUpdates(): {
  updates: DeskUpdate[]
  counts: DeskCounts
  // `isLoading` now also means "not yet safe to trust the reply/report lanes".
  isLoading: boolean
  // Server read-state hydrated — exposed for the header's caught-up guard.
  ready: boolean
} {
  const { user } = useAuthStore()
  const { data: agents } = useAgents()
  const { groups } = useDmThreads()
  const { data: userProjects } = useUserProjects()
  const { data: projectViews, isLoading: projectsLoading } = useProjectsWithChatrooms()

  const activeParticipants = useActiveWorkStore((s) => s.participants)
  const lastSeenMessages = useUnreadStore((s) => s.lastSeenMessages)

  // Hydrate server-persisted read-state into the store (GET on mount/focus).
  // Mounted here so it rides wherever the desk renders; the query is deduped by
  // key across every consumer of useDeskUpdates. `ready` flips true once the
  // server watermarks are folded into the store, gating the read/unread lanes.
  const { hydrated: ready } = useDeskReadState()

  const agentById = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  )

  // Build the candidate set: one card per DM thread + one per regular project,
  // most-recent first, capped for cost.
  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = []
    for (const g of groups) {
      for (const t of g.threads) {
        out.push({
          projectId: t.projectId,
          kind: 'dm',
          title: t.title || 'Direct message',
          coordinatorId: g.agent.id,
          lastModified: t.lastModified,
          reportPublishedAt: null, // DMs never carry a completion report
          plan: null, // nor a plan: there is no shared-context room to hang one on
        })
      }
    }
    // Hub threads the user started (from the desk, Cmd-K or the directory):
    // useDmThreads skips them, because their partner has no agent card here.
    for (const p of userProjects ?? []) {
      const t = p.hub_target
      if (!t || p.created_by !== user?.id) continue
      out.push({
        projectId: p.id,
        kind: 'dm',
        title: p.display_name || 'Hub conversation',
        coordinatorId: '',
        lastModified: p.last_modified ?? p.created_at ?? '',
        reportPublishedAt: null,
        plan: null,
        hub: { hubAgentId: t.hub_agent_id, label: safeRemoteText(t.display, REMOTE_TEXT_CAP.name * 2) },
      })
    }
    for (const pv of projectViews ?? []) {
      if (pv.is_viewer) continue // read-only shared projects aren't your desk
      out.push({
        projectId: pv.project_id,
        kind: 'project',
        title: pv.project_name || 'Project',
        coordinatorId: pv.coordinator_id ?? '',
        lastModified: pv.last_modified || pv.created_at || '',
        reportPublishedAt: pv.report_published_at ?? null,
        plan: pv.plan ?? null,
      })
    }
    out.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''))
    return out.slice(0, MAX_CANDIDATES)
  }, [groups, userProjects, projectViews, user?.id])

  // Fetch the newest user-communication activity for every candidate in ONE
  // request. The server returns only each room's newest message + its files
  // (not the whole log), and CHANGELOG_UPDATE invalidates this key (see
  // useWebSocket.ts). The key is the SORTED id set, so re-ordering candidates
  // doesn't refetch; when the set does change, the previous response stays on
  // screen (keepPreviousData) for the cards it already covered.
  const candidateIds = useMemo(() => candidates.map((c) => c.projectId).filter(Boolean), [candidates])
  const idsKey = useMemo(() => [...candidateIds].sort().join(','), [candidateIds])
  const latestQuery = useQuery({
    queryKey: [DESK_LATEST_MESSAGES_KEY, idsKey],
    queryFn: () => getDeskLatestMessages(idsKey ? idsKey.split(',') : []),
    enabled: candidateIds.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    // Live updates arrive over the socket; a tab switch alone changes nothing.
    refetchOnWindowFocus: false,
    retry: 1,
  })
  const latestData = latestQuery.data
  const latestIds = useMemo(() => new Set(latestData?.ids ?? []), [latestData])

  const projectHasActiveWork = useMemo(() => {
    const set = new Set<string>()
    for (const key of activeParticipants.keys()) {
      set.add(key.slice(0, key.indexOf('|')))
    }
    return set
  }, [activeParticipants])

  const updates = useMemo<DeskUpdate[]>(() => {
    if (!user) return []
    const list: DeskUpdate[] = []
    candidates.forEach((c) => {
      const entries = latestData?.entries[c.projectId]
      const latest = newestMessage(entries)
      const files = filesForMessage(entries, latest)
      const hasActive = projectHasActiveWork.has(c.projectId)
      const lastSeen = lastSeenMessages[deskRoomKey(c.projectId)]
      // This card's messages have resolved at least once: the response on
      // screen was requested for this project (a placeholder from the previous
      // id set only counts for the cards it covered). Until then `latest` is
      // unknown, so a read/unread decision would compare against the wrong cursor.
      const msgSettled = latestIds.has(c.projectId)
      // A card is dismissed once its seen-cursor reaches the newest message
      // (or the no-message sentinel). Progress is exempt — it's still running.
      const dismissCursor = latest?.id ?? DISMISS_SENTINEL
      const dismissed = lastSeen != null && lastSeen === dismissCursor

      let lane: DeskLane | null = null
      if (hasActive) {
        // Progress is driven by the active-work store, not by read-state, so it
        // emits immediately — no gate, same as before.
        lane = 'progress'
      } else if (ready && msgSettled) {
        // Only decide reply/report once the data both lanes read is complete:
        // server watermarks hydrated AND this card's messages settled. Skipping
        // the candidate this render lets it fade in when ready but never flash
        // out — the fix for the reload flicker.
        // Report lane gates PURELY on the shipped field: present iff a real
        // completion report exists. completed-no-report ⇒ null ⇒ absent (D2a).
        if (c.reportPublishedAt != null && !dismissed) {
          lane = 'report'
        } else if (
          latest &&
          latest.from_participant_id !== user.id &&
          latest.id !== lastSeen
        ) {
          lane = 'reply'
        }
      }
      if (!lane) return

      const agent = c.hub ? null : agentById.get(c.coordinatorId) ?? null
      const agentName = c.hub?.label || agent?.name || c.coordinatorId || 'agent'
      list.push({
        projectId: c.projectId,
        lane,
        kind: c.kind,
        agent,
        agentName,
        sourceName: c.title,
        roomLabel:
          c.kind === 'dm' ? 'direct message' : `# ${getChatroomDisplayName('user-communication')}`,
        title: c.title,
        quote:
          latest?.content?.trim() ||
          (lane === 'progress' ? 'Your team is on it.' : ''),
        quoteIsYours: !!latest?.content?.trim() && latest.from_participant_id === user.id,
        quoteFromContact:
          latest && isContactId(latest.from_participant_id) ? storedSenderName(latest) : undefined,
        quoteAuthorId: latest?.from_participant_id ?? null,
        quoteOutsideIsolated: !!latest?.outside_isolated,
        ts: latest?.ts || c.lastModified,
        latestMessageId: latest?.id ?? null,
        files,
        navTo:
          c.kind === 'project'
            ? `/projects/${c.projectId}`
            : c.hub
              ? hubThreadPath(c.hub.hubAgentId, c.projectId)
              : `/dm/${encodeURIComponent(agentName)}/${c.projectId}`,
        hubThread: !!c.hub,
        plan: c.plan,
        reportPublishedAt: c.reportPublishedAt,
      })
    })
    return list
  }, [user, ready, candidates, latestData, latestIds, projectHasActiveWork, lastSeenMessages, agentById])

  const counts = useMemo<DeskCounts>(() => {
    const c: DeskCounts = { reply: 0, report: 0, progress: 0 }
    // useDeskUpdates only emits the three live lanes; `read` is a presentational
    // lane owned by useDeskRecentlyDone, so it never reaches this feed. Guard
    // anyway to keep the DeskCounts index total.
    for (const u of updates) if (u.lane !== 'read') c[u.lane] += 1
    return c
  }, [updates])

  return { updates, counts, isLoading: projectsLoading || !ready, ready }
}
