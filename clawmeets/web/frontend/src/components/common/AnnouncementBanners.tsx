// One banner per announcement ENTRY, headlining how many of the user's runners
// are affected — never one banner per runner. The grouping is derived on the
// client (useAnnouncements); this component renders it and subtracts local
// dismissals. No version parsing lives here.

import { useEffect, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Info, X } from 'lucide-react'
import { useAnnouncements } from '../../hooks/useAnnouncements'
import type { AnnouncementEntry } from '../../hooks/useAnnouncements'
import {
  isVisible,
  remainingRunners,
  useAnnouncementStore,
} from '../../stores/announcementStore'
import { useAuthStore } from '../../stores/authStore'
import { useMyAgents } from '../../hooks/useMyAgents'

/** Severity presentation. COLOR IS NEVER THE ONLY SIGNAL — each severity also
 *  carries a distinct icon and an uppercase TEXT LABEL, so the banner still
 *  reads for a colorblind user, in a high-contrast theme, or in a screenshot
 *  printed in grayscale.
 *
 *  `severity` is a free-form string by contract (§2.2 — the server validates
 *  nothing), so the unknown branch is genuinely reachable: a typo'd or
 *  newly-invented severity in announcements.json. It degrades to neutral styling
 *  and STILL RENDERS — a value we don't recognize must never swallow the
 *  message. */
const SEVERITY_STYLES: Record<string, { label: string; className: string; Icon: typeof Info }> = {
  warning: {
    label: 'Warning',
    className: 'border-amber-200 bg-amber-50 text-amber-900',
    Icon: AlertTriangle,
  },
  info: {
    label: 'Notice',
    className: 'border-slate-200 bg-slate-50 text-slate-800',
    Icon: Info,
  },
}

const NEUTRAL = { label: 'Notice', className: 'border-slate-200 bg-slate-50 text-slate-800', Icon: Info }

/** OWN KEYS ONLY. A plain object literal inherits `Object.prototype`, so a plain
 *  `SEVERITY_STYLES[severity] ?? NEUTRAL` resolves `severity === "constructor"`
 *  (or `toString`, `valueOf`, `__proto__`, `hasOwnProperty`, …) to an inherited
 *  FUNCTION — truthy, so `??` never fires — and the destructured `Icon` comes
 *  back `undefined`, which throws at render. `severity` is config-controlled
 *  end to end (§2.2: the server serves the file verbatim; `validateRecords`
 *  deliberately requires only a non-blank string, not a whitelist), and there is
 *  no error boundary in this app, so that throw unmounts the whole shell for
 *  every route. A prototype key must land in the SAME neutral branch as an
 *  ordinary typo. */
function styleFor(severity: string) {
  return Object.prototype.hasOwnProperty.call(SEVERITY_STYLES, severity)
    ? SEVERITY_STYLES[severity]
    : NEUTRAL
}

function AnnouncementBanner({
  entry,
  onDismiss,
}: {
  entry: AnnouncementEntry
  onDismiss: (entry: AnnouncementEntry) => void
}) {
  // Collapsed by default: the count is the headline, the names are the detail.
  const [expanded, setExpanded] = useState(false)
  const dismissed = useAnnouncementStore(s => s.dismissed)

  const { label, className, Icon } = styleFor(entry.severity)
  // The headline number IS the length of the very list the disclosure expands.
  // They cannot disagree, because they are the same array. (The deleted
  // visibleCount() derived the headline from a server-owned affected_count
  // instead, which is the drift this removes.)
  const runners = remainingRunners(entry, dismissed)
  const listId = `announcement-runners-${entry.id}`

  return (
    <div role="status" className={`border-b px-4 py-2.5 text-[13px] ${className}`}>
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {/* The text label is the accessible carrier of severity; the icon
                and background merely reinforce it. */}
            <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
            <span className="font-semibold">{entry.title}</span>
          </div>
          <p className="mt-0.5">{entry.body}</p>

          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            aria-controls={listId}
            className="mt-1 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
          >
            {expanded
              ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
            {runners.length === 1 ? '1 runner affected' : `${runners.length} runners affected`}
          </button>

          {expanded && (
            <ul id={listId} className="mt-1.5 space-y-0.5 pl-4">
              {runners.map(runner => (
                // The per-runner VERSION is new and now free: the old design
                // could not show it because no version was on the wire. It turns
                // "3 runners affected" into something actionable.
                <li key={runner.id} className="list-disc font-mono text-xs">
                  {runner.name} — {runner.version ?? 'version unknown'}
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          onClick={() => onDismiss(entry)}
          aria-label={`Dismiss ${entry.title}`}
          className="flex-shrink-0 opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export default function AnnouncementBanners() {
  const userId = useAuthStore(s => s.user?.id ?? null)
  const { entries, pending } = useAnnouncements()
  const dismissed = useAnnouncementStore(s => s.dismissed)
  const dismiss = useAnnouncementStore(s => s.dismiss)
  const hydrate = useAnnouncementStore(s => s.hydrate)
  const pruneDeletedAgents = useAnnouncementStore(s => s.pruneDeletedAgents)
  const { data: myAgents } = useMyAgents()

  // Load this user's dismissed set, and reload it if the session changes user.
  useEffect(() => { hydrate(userId) }, [hydrate, userId])

  // Prune dismissals for deleted agents — but only off a roster that actually
  // arrived. `useMyAgents` returns [] while loading and on failure, and the
  // store's own guard refuses to prune on an empty list, so a failed fetch
  // cannot wipe the user's dismissals from either side. Announcements are
  // deliberately NOT pruned the same way (see the store).
  useEffect(() => {
    if (myAgents.length) pruneDeletedAgents(myAgents.map(a => a.id))
  }, [myAgents, pruneDeletedAgents])

  // §7 ACCEPTED LIMITATION 4 — DOCUMENTED, NOT FIXED: `affected` can briefly
  // disagree with the sidebar while react-query's agent roster and the socket
  // snapshot are out of step. Transient only, and the PAYLOAD CARRIES THE NAMES,
  // so the banner itself is never wrong — only pruneDeletedAgents consults the
  // roster and it is already guarded against an empty one. Do NOT "fix" this by
  // intersecting `affected` with the roster: that would let an in-flight roster
  // hide a true banner.

  // Nothing to say either way while the snapshot has never arrived (runners ===
  // null) or the config query has not resolved.
  if (pending) return null

  return (
    <>
      {entries
        .filter(entry => isVisible(entry, dismissed))
        .map(entry => (
          // Keyed on the announcement id: one banner per announcement entry.
          <AnnouncementBanner
            key={entry.id}
            entry={entry}
            // The caller passes the exact list it rendered, so what the user saw
            // and what gets dismissed cannot drift.
            onDismiss={e => dismiss(e.id, remainingRunners(e, dismissed))}
          />
        ))}
    </>
  )
}
