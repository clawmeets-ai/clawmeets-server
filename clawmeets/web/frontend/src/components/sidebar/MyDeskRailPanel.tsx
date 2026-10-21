import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, CheckCheck, Inbox, RefreshCw, Folder, Trash2 } from 'lucide-react'
import { useDeskStore } from '../../stores/deskStore'
import { useDeskUpdates, type DeskUpdate } from '../../hooks/useDeskUpdates'
import { useDeskRecentlyDone } from '../../hooks/useDeskRecentlyDone'
import {
  useBriefTabs,
  useDeleteBriefTab,
  usePrefetchBriefTab,
} from '../../hooks/useBriefTabs'
import { useUserProjects } from '../../hooks/useProjects'
import { useTodos } from '../../hooks/useTodos'
import { selectHover, useDeskLinkStore } from '../../stores/deskLinkStore'
import { resolveLinkedPair } from '../../utils/deskLinks'
import { isScheduledDMProject } from '../../types'
import { SAMPLE_BRIEF_SLUG } from '../../api/endpoints/briefTabs'
import PanelShell from './PanelShell'
import DmIcon from './DmIcon'
// The `.mdr-sub` rules live in the desk's stylesheet, with the two other
// surfaces of the cross-highlight they have to stay identical to — splitting
// them across two files is how the three drift. It is the first
// `sidebar/ → desk/` import in the app, and it is the desk's own panel, so the
// edge is honest. The alternative was ~six Tailwind `after:[…]` arbitrary
// variants inline, which express a pseudo-element far less legibly.
import '../desk/desk.css'

// My Desk context panel: nav rows that jump the main pane to each desk section
// (live counts), plus one row per briefing that navigates to its own page. Counts come
// from the same useDeskUpdates cache the main pane reads, so they stay in sync.
// "Recently done" is a peer nav row under ON YOUR DESK, fed by the same
// useDeskRecentlyDone cache as the desk section it jumps to → lock-step,
// including its drop-if-also-live filter and its 5-card cap. The desk section
// renders at 0 too, so a `0` still has somewhere to jump to.
export default function MyDeskRailPanel({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate()
  const { requestScroll, requestCardFocus } = useDeskStore()
  const prefetchBrief = usePrefetchBriefTab()
  const { updates } = useDeskUpdates()
  const { cards: recentlyDone } = useDeskRecentlyDone()
  const { data: briefTabs } = useBriefTabs()
  const deleteBrief = useDeleteBriefTab()
  // ONE message slot for the whole Briefings section, not per-row error
  // state. A failed delete is rare and the rail is narrow; what the owner
  // needs is to know the briefing is still there and why, which one line
  // under the header says as well as a badge on the row would — without
  // giving every row a second state to render, order and clear.
  //
  // It carries the SLUG as well as the sentence, because the sentence claims
  // the briefing is still on the desk and that claim can stop being true
  // without anyone pressing anything: the owner deletes "Wine inventory" in a
  // second tab, deletes it again here before this rail has refetched, gets the
  // ordinary 404 — and then the broadcast lands, the row goes, and a message
  // insisting the row is there would outlive the row itself. Gating the render
  // on the slug still being in `tabs` retires the message at exactly the
  // moment its subject stops existing.
  const [deleteError, setDeleteError] = useState<{ slug: string; message: string } | null>(
    null,
  )
  const { data: userProjects } = useUserProjects()
  const tabs = briefTabs ?? []
  const deleteErrorMessage =
    deleteError && tabs.some((t) => t.slug === deleteError.slug) ? deleteError.message : null

  // Signed-off DM cards carry only a projectId (no project name), so resolve
  // the scheduled-thread flag against the live projects cache by id.
  const scheduledDmIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of userProjects ?? []) if (isScheduledDMProject(p)) ids.add(p.id)
    return ids
  }, [userProjects])

  const jump = (sectionId: string) => {
    navigate('/desk')
    onNavigate?.()
    // Defer so DeskPage is mounted before it reads the scroll target.
    requestScroll(sectionId)
  }
  // A briefing has its own address now, so this is an ordinary navigation
  // rather than a store write the desk picks up. That is what gives the user a
  // URL to copy and makes Back return to the desk.
  const open = (slug: string) => {
    navigate(`/desk/briefings/${encodeURIComponent(slug)}`)
    onNavigate?.()
  }
  // Delete is destructive and unrecoverable, so it asks first — the same plain
  // `window.confirm` the sidebar's own project rows use (ProjectItem), rather
  // than a styled dialog. That is not laziness: the browser's box is modal,
  // focus-trapped, keyboard-operable and announced, which a hand-rolled one in
  // a narrow rail would have to re-earn.
  //
  // The sample row never gets here — it renders no delete control at all —
  // because its slug is a local constant the server has never issued, and
  // `validate_slug` rejects a leading underscore, so a delete for it could
  // only ever come back 400.
  const handleDelete = (slug: string, name: string) => {
    setDeleteError(null)
    if (!window.confirm(`Delete briefing "${name}"? This cannot be undone.`)) return
    deleteBrief.mutate(slug, {
      // The row stays. Dropping it optimistically and restoring it on failure
      // would make the common case a flicker and the failure case a lie, and
      // the list refetch this mutation triggers is what removes it for real.
      onError: () =>
        setDeleteError({
          slug,
          message: `Could not delete "${name}". It is still on your desk.`,
        }),
      onSuccess: () => setDeleteError(null),
    })
  }
  // A sub-row keeps you ON the desk and scrolls its card into view — the rail is
  // a map of the desk, not a second way out of it. Opening the thread stays on
  // the card's own "Open" button (and the o/Enter shortcut). Same shape as
  // `jump`: navigate first, park the request, let DeskPage consume it once the
  // card's handle exists (it may not on a cold /desk mount).
  const focusCard = (card: DeskUpdate) => {
    navigate('/desk')
    onNavigate?.()
    requestCardFocus(card.projectId)
  }

  // Fold the live feed into the two desk sections (feed order preserved).
  // "Review" is replies then reports — the same reply-first order the desk
  // section renders. 'read' never reaches this feed (owned by
  // useDeskRecentlyDone) but is guarded anyway.
  const { toReview, working } = useMemo(() => {
    const reply: DeskUpdate[] = []
    const report: DeskUpdate[] = []
    const progress: DeskUpdate[] = []
    for (const u of updates) {
      if (u.lane === 'reply') reply.push(u)
      else if (u.lane === 'report') report.push(u)
      else if (u.lane === 'progress') progress.push(u)
    }
    return { toReview: [...reply, ...report], working: progress }
  }, [updates])

  // ————————————— the cross-highlight, third view —————————————
  // These sub-rows are a third view of a set the desk already computes, keyed
  // by the same `item.projectId` the join already uses — so hovering one lights
  // its desk card and every to-do that spawned it, and hovering either of those
  // lights the row back. Bidirectional, because "consistent with the other two"
  // is the whole point.
  //
  // It costs no new data: `useTodos` reads the same react-query cache the desk
  // reads (no extra request), and the plated set comes off the three lists this
  // panel is already rendering. Deliberately re-derived from a shared pure
  // function rather than handed down from `DeskPage`: the desk lives in the
  // router Outlet tree and this panel in the Sidebar tree, so there is no prop
  // path between them, and publishing derived state into a store and keeping it
  // fresh with an effect is more to reason about than calling the function.
  //
  // When `DeskPage` is not mounted — the rail stayed on My Desk while the user
  // navigated away — nothing on screen can pair, and these rows simply light
  // nothing. That is the same silence a row full of deleted ids already gets.
  const hover = useDeskLinkStore(selectHover)
  const setHover = useDeskLinkStore((s) => s.setHover)
  const { todos } = useTodos()

  // Every projectId this panel actually draws a sub-row for — the caller's own
  // rendered set, which is what `resolveLinkedPair` asks for. Same three lists
  // the desk plates, arrived at independently.
  const plated = useMemo<ReadonlySet<string>>(
    () => new Set([...toReview, ...working, ...recentlyDone].map((u) => u.projectId)),
    [toReview, working, recentlyDone],
  )

  const { linkedProjectIds: lit } = useMemo(
    () => resolveLinkedPair(hover, todos, plated),
    [hover, todos, plated],
  )

  // A sub-row publishes `{ side: 'card' }`, not a fourth hover variant: the row
  // IS a proxy for its card. Leave clears only its own side of the pair, the
  // same rule the desk's own handlers follow.
  const handleHover = (projectId: string | null) => {
    if (projectId === null) {
      if (hover?.side === 'card') setHover(null)
      return
    }
    setHover({ side: 'card', projectId })
  }

  // Each nav row carries its section's items (sub-rows + count). The Working
  // icon spins (gentle ~2.4s) whenever ≥1 item is running, so the row reads as
  // "working" at a glance; the header click still jumps to the desk section.
  // `muted` rows keep the quiet mono count — a history tally is not a queue
  // badge, so "Recently done" never wears the accent pill.
  const nav: {
    id: string
    icon: React.ReactNode
    label: string
    items: DeskUpdate[]
    muted?: boolean
  }[] = [
    {
      id: 'md-to-signoff',
      icon: <Inbox className="w-3.5 h-3.5" />,
      label: 'Review',
      items: toReview,
    },
    {
      id: 'md-working',
      icon: (
        <RefreshCw
          className={working.length ? 'w-3.5 h-3.5 animate-spin' : 'w-3.5 h-3.5'}
          style={working.length ? { animationDuration: '2.4s' } : undefined}
        />
      ),
      label: 'Working',
      items: working,
    },
    {
      id: 'md-signed-off',
      icon: <CheckCheck className="w-3.5 h-3.5" />,
      label: 'Recently done',
      items: recentlyDone,
      muted: true,
    },
  ]

  return (
    <PanelShell title="My Desk">
      <div className="px-1.5 pt-1">
        <div className="px-3 pt-1 pb-1 text-[11px] font-extrabold uppercase tracking-[0.1em] text-ink-3">
          On your desk
        </div>
        {nav.map((n) => (
          <div key={n.id}>
            <button
              onClick={() => jump(n.id)}
              className="flex items-center gap-2 pl-3 pr-3 py-1.5 w-full text-left rounded hover:bg-sidebar-hover transition-colors text-ink-2"
            >
              <span className="text-channel flex-shrink-0">{n.icon}</span>
              <span className="truncate text-[13px] flex-1">{n.label}</span>
              <span
                className={
                  n.items.length > 0 && !n.muted
                    ? 'flex-shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-accent text-white text-[11px] font-bold leading-none tabular-nums'
                    : 'flex-shrink-0 text-[10.5px] font-mono text-ink-4 tabular-nums'
                }
              >
                {n.items.length}
              </span>
            </button>
            {/* One indented sub-row per DM/project in this section — compact
                (kind icon + truncated title) since the rail is narrow; a click
                scrolls the desk to that card rather than leaving the desk. */}
            {n.items.map((item) => (
              <button
                key={item.projectId}
                onClick={() => focusCard(item)}
                onMouseEnter={() => handleHover(item.projectId)}
                onMouseLeave={() => handleHover(null)}
                title={item.title}
                className={
                  'mdr-sub flex items-center gap-2 pl-6 pr-3 py-1 w-full text-left rounded hover:bg-sidebar-hover transition-colors text-ink-2' +
                  (lit.has(item.projectId) ? ' mdr-sub--linked' : '')
                }
              >
                <span className="text-channel flex-shrink-0">
                  {item.kind === 'project' ? (
                    <Folder className="w-3.5 h-3.5" />
                  ) : (
                    <DmIcon
                      scheduled={scheduledDmIds.has(item.projectId)}
                      size={14}
                      className="text-channel"
                    />
                  )}
                </span>
                <span className="truncate text-[12.5px] flex-1">{item.title}</span>
              </button>
            ))}
          </div>
        ))}

        <div
          className="px-3 pt-2.5 pb-1 mt-1 text-[11px] font-extrabold uppercase tracking-[0.1em] text-ink-3"
          style={{ borderTop: '1px solid var(--line-1)' }}
        >
          Briefings
        </div>
        {deleteErrorMessage && (
          // `role="alert"` so a screen reader hears it without the owner
          // having to go looking: the visible evidence of a failed delete is
          // the row NOT disappearing, which is indistinguishable from nothing
          // having happened.
          <div
            role="alert"
            className="mx-1.5 mb-1 px-2 py-1.5 rounded text-[11.5px] leading-snug text-red-700 bg-red-50"
          >
            {deleteErrorMessage}
          </div>
        )}
        {tabs.length === 0 && (
          // No real briefings yet — offer an onboarding row (styled identically to
          // a real briefing row) pointing at the reserved sample slug, instead of
          // a dead-end "No briefings yet". It needs no prefetch: the sample's
          // document is a local constant and never touches the network.
          <button
            onClick={() => open(SAMPLE_BRIEF_SLUG)}
            className="flex items-center gap-2 pl-3 pr-3 py-1.5 w-full text-left rounded hover:bg-sidebar-hover transition-colors text-ink-2"
          >
            <BarChart3 className="w-3.5 h-3.5 text-channel flex-shrink-0" />
            <span className="truncate text-[13px] flex-1 font-mono">Sample Briefing</span>
          </button>
        )}
        {/* The document is its own request now, so each row warms it on the
            way to the click: the round trip the metadata-list read path costs
            is usually already spent by the time the row is pressed. */}
        {tabs.map((t) => {
          const name = t.title || t.slug
          const deleteLabel = `Delete briefing "${name}"`
          return (
            // `group relative` + an absolutely positioned sibling, the same
            // shape ProjectItem uses for its trash control — and for the same
            // reason it is a SIBLING and not a child: a <button> inside a
            // <button> is invalid HTML, and browsers recover from it by
            // dropping the inner one.
            <div key={t.slug} className="group relative">
              <button
                onClick={() => open(t.slug)}
                onMouseEnter={() => prefetchBrief(t.slug)}
                onFocus={() => prefetchBrief(t.slug)}
                className="flex items-center gap-2 pl-3 pr-8 py-1.5 w-full text-left rounded hover:bg-sidebar-hover transition-colors text-ink-2"
              >
                <BarChart3 className="w-3.5 h-3.5 text-channel flex-shrink-0" />
                <span className="truncate text-[13px] flex-1 font-mono">{name}</span>
              </button>
              <button
                type="button"
                onClick={() => handleDelete(t.slug, name)}
                disabled={deleteBrief.isPending}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-red-100 text-channel hover:text-red-600 transition-all opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 disabled:opacity-50"
                title={deleteLabel}
                aria-label={deleteLabel}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )
        })}

        <div className="px-3 pt-4 pb-2 text-[11px] text-ink-4 leading-relaxed">
          Ask any agent to publish an HTML page as a briefing — it lands here, one click away.
        </div>
      </div>
    </PanelShell>
  )
}
