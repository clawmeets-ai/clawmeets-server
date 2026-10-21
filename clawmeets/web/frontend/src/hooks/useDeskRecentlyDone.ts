import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDeskSignOffs, type SignOffCard } from '../api/endpoints/deskSignOffs'
import { useAuthStore } from '../stores/authStore'
import { useAgents } from './useAgents'
import { useProjectsWithChatrooms } from './useProjectsWithChatrooms'
import { getChatroomDisplayName } from '../utils/chatroomDisplay'
import { useDeskUpdates, type DeskUpdate } from './useDeskUpdates'

// Prefix of the query key; the full key is [SIGN_OFFS_KEY, limit] so the
// request shape is part of the cache identity. DESK_READ_STATE_SYNC invalidates
// the bare prefix (useWebSocket.ts), which prefix-matches every variant.
const SIGN_OFFS_KEY = 'desk-sign-offs'

// How many rows we ASK the server for. Deliberately larger than the count we
// show: the server cannot know which of those projects has come back to life (a
// fresh agent reply re-lanes the card to Working), and those are dropped
// client-side — so asking for exactly RECENT_LIMIT would render fewer.
const FETCH_LIMIT = 15

// How many we SHOW.
const RECENT_LIMIT = 5

/**
 * "Recently done" for My Desk: the last {@link RECENT_LIMIT} projects the user
 * hit **Done** on, most-recent-first, ANY date. `Done` is the UI name for what
 * the wire still calls a sign-off — the store, route, and models below keep that
 * word, and only the copy changed. Fetches the backend sign-off snapshot
 * (ordering + message content) and hydrates each row into a `DeskUpdate` so the
 * existing `UpdateCard` renders it verbatim — the same hydration split the live
 * lanes use.
 *
 * There is no day boundary. The section used to window on the viewer's local
 * midnight (the server has never known the viewer's timezone, so the client
 * computed it and sent it as `since`), which meant the section emptied itself
 * every morning. It now asks for a COUNT instead: `limit` is unwindowed, so the
 * cache key carries no date and a desk left open overnight needs no rollover.
 *
 * Every row in the backing store is a sign-off by construction — Send Back no
 * longer writes a watermark (it leaves the card on the desk, re-laned to
 * *Working*) — so there is no filtering by intent to do here, and the section's
 * name is literally what it shows. A card signed off, re-surfaced, and signed
 * off again counts once: the store keeps one row per card and the second write
 * overwrites the first.
 *
 * Three passes turn the fetched rows into the rendered five, and the ORDER of
 * them matters:
 *
 *   1. **Drop live projects.** A project that was signed off can come back to
 *      life (a fresh agent reply, or a dispatch that flips it to `progress`)
 *      while its watermark still stands, so it would render in BOTH a live
 *      section and this one. We drop those here rather than at the callsites:
 *      both consumers (the desk section and the rail row) already read
 *      `useDeskUpdates`, so filtering inside the hook keeps their counts in
 *      lock-step by construction — and it keeps `cardRefs` in DeskPage, keyed by
 *      projectId alone, from having a live card's imperative handle overwritten
 *      by its non-actionable historical twin (which would silently kill R / X on
 *      the selected card).
 *   2. **Dedupe by project.** Watermarks are keyed by (project, chatroom), so a
 *      project with two rooms holds two rows. "The last 5" means five distinct
 *      projects, not five rows — the newest row wins, and one project never
 *      occupies two slots.
 *   3. **Slice to {@link RECENT_LIMIT}.** Last, so a dropped or collapsed row
 *      is backfilled from further down the fetched page instead of costing a
 *      slot.
 *
 * Client-derived (NOT taken from the payload), to stay pixel-identical to the
 * Working / reply / report siblings:
 *   - `agent`     resolved from the live agents cache via `coordinator_id`.
 *   - `agentName` `agent?.name` → `agent_name` fallback → `coordinator_id`.
 *   - `roomLabel` derived via `getChatroomDisplayName(chatroom_name)` (the
 *                 backend stopped shipping a `room_label` — it froze to
 *                 "# user-communication" while sibling cards render
 *                 "# coordinator"; tech-lead ruling AC3).
 *   - `navTo`     pure fn of `kind` + `projectId` + `agentName`, same as today.
 *   - `lane`      neutral presentational `'read'` (backend omits lane).
 *   - `plan` +    looked up by project id in the project list the desk already
 *     `reportPublishedAt`  holds, so a signed-off card carries the SAME three
 *                 bands (Report / Plan / Response) its live sibling carried in
 *                 Review. See `contractByProject` below for why that lookup is
 *                 free and why it is the project list rather than the feed.
 *
 * `ts` is `signed_off_at` — the backend no longer ships a competing message
 * timestamp, so there is nothing left for the "when" to disagree with.
 * `latestMessageId` is the id of the message the card QUOTES (the watermarked
 * one), not the room's newest; nothing consumes it on this lane, since
 * `markRead` is unreachable from a read card.
 *
 * The list is already ordered server-side (updated_at desc) — it is NOT
 * re-sorted, and none of the three passes above reorders it. Rows whose
 * watermark can't resolve arrive title-only (quote "", no message id, no files)
 * and render as such. Live re-order rides the existing DESK_READ_STATE_SYNC
 * handler, which invalidates ['desk-sign-offs'] (see useWebSocket.ts).
 *
 * `lastSignedOffAt` is the all-time newest sign-off (null ⇒ never), unaffected
 * by the limit. It exists so the empty state can say WHEN the last one was, and
 * so DeskPage can tell "new user" apart from "everything you cleared is live
 * again" — the first-run onboarding must not come back for someone who has
 * marked things done before.
 */
export function useDeskRecentlyDone(): {
  cards: DeskUpdate[]
  lastSignedOffAt: string | null
  isLoading: boolean
} {
  const userId = useAuthStore((s) => s.user?.id)
  const { data: agents } = useAgents()
  const { updates } = useDeskUpdates()
  // The SAME project source `useDeskUpdates` builds its live cards from — same
  // query keys, so this mounts no request the desk was not already making.
  const { data: projectViews, isLoading: projectsLoading } = useProjectsWithChatrooms()

  const query = useQuery({
    queryKey: [SIGN_OFFS_KEY, FETCH_LIMIT],
    queryFn: () => getDeskSignOffs({ limit: FETCH_LIMIT }),
    enabled: !!userId,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const agentById = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  )

  const liveProjectIds = useMemo(
    () => new Set(updates.map((u) => u.projectId)),
    [updates],
  )

  /**
   * THE PLAN + REPORT LOOKUP — why the project list and not the feed.
   *
   * The sign-off feed is a WATERMARK read: it knows which message the user
   * cleared and when, and nothing about the project's contract. The project
   * list knows both, for every project the user owns, signed off or not — it is
   * where `useDeskUpdates` reads `plan` and `report_published_at` for the live
   * lanes. Reading it here is what makes a Recently-done card render the same
   * three bands it rendered in Review, and it costs nothing: the desk already
   * holds this list, so the numbers cannot be a staler copy of the live card's
   * — they are literally the same objects.
   *
   * This is the reason the bands were absent before rather than a reason they
   * should stay absent. The old comment argued a signed-off card's plan state
   * is "unknown"; it is not unknown, it just was not being looked up.
   *
   * A DM row misses this map by construction — thread-shaped projects are
   * excluded from the project list — so a DM stays a Response-only card, which
   * is what it was: a DM has no plan and no report to show.
   */
  const contractByProject = useMemo(
    () =>
      new Map(
        (projectViews ?? []).map((pv) => [
          pv.project_id,
          { plan: pv.plan ?? null, reportPublishedAt: pv.report_published_at ?? null },
        ]),
      ),
    [projectViews],
  )

  const cards = useMemo<DeskUpdate[]>(() => {
    const rows = query.data?.cards
    if (!rows) return []
    // HOLD THE CARDS UNTIL THE CONTRACT IS IN. `UpdateCard` seeds which band is
    // open on mount from `defaultOpenBands` — so a card that mounts before the
    // project list resolves would seed `response` with no plan to go on, and
    // only a later report publish re-opens anything. Emitting nothing for the one render the list is still in flight
    // is the fix; `isLoading` below reports it, so the section shows its
    // skeleton rather than an empty state.
    if (projectsLoading) return []
    const seen = new Set<string>()
    const recent: SignOffCard[] = []
    for (const r of rows) {
      if (recent.length >= RECENT_LIMIT) break
      if (liveProjectIds.has(r.project_id)) continue
      if (seen.has(r.project_id)) continue
      seen.add(r.project_id)
      recent.push(r)
    }
    return recent.map((r) => {
      const agent = agentById.get(r.coordinator_id) ?? null
      const agentName = agent?.name || r.agent_name || r.coordinator_id || 'agent'
      const contract = contractByProject.get(r.project_id)
      return {
        projectId: r.project_id,
        lane: 'read',
        kind: r.kind,
        agent,
        agentName,
        sourceName: r.source_name,
        roomLabel:
          r.kind === 'dm'
            ? 'direct message'
            : `# ${getChatroomDisplayName(r.chatroom_name)}`,
        title: r.title,
        quote: r.quote,
        ts: r.signed_off_at,
        latestMessageId: r.quoted_message_id,
        quoteAuthorId: null,
        quoteOutsideIsolated: false,
        files: r.files.map((f) => ({ filename: f.filename, entryType: f.entry_type })),
        navTo:
          r.kind === 'project'
            ? `/projects/${r.project_id}`
            : `/dm/${encodeURIComponent(agentName)}/${r.project_id}`,
        // Both from `contractByProject` — the live project list, not the
        // sign-off feed. `??` rather than `!` because a DM (and any project
        // that has aged out of the list) legitimately misses the map, and a
        // missing entry means the band is OMITTED, never placeheld.
        plan: contract?.plan ?? null,
        reportPublishedAt: contract?.reportPublishedAt ?? null,
      }
    })
  }, [query.data, agentById, liveProjectIds, contractByProject, projectsLoading])

  return {
    cards,
    lastSignedOffAt: query.data?.last_signed_off_at ?? null,
    // Both reads gate the section: the cards are held above until the project
    // list settles, so reporting only the feed's own loading would render an
    // empty section instead of the skeleton in that window.
    isLoading: query.isLoading || projectsLoading,
  }
}
