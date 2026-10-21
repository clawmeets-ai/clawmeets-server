import type { PlanHistoryEntry, PlanVersion } from '../../../api/endpoints/projectPlans'
import { versionLine } from './planTrayLogic'

/**
 * Two logs, deliberately not merged, because they answer different questions.
 *
 * `GET /plan/versions` is WRITES THAT LANDED — one contiguous revision per row,
 * with the applier, the proposers and the batch comment. It carries no
 * `changes[]` and does not grow one; the sections a revision moved are on the
 * live sync envelope and are a highlight hint, not a stored delta.
 *
 * `PlanIndex.history` is EVERYTHING THAT HAPPENED, including refusals and notes
 * that moved no bytes. It is capped at 200 and trimmed from the FRONT, so it is
 * labelled "recent activity" and nothing here derives a count or a first-event
 * date from it. `seq` is a display counter and never a precondition.
 */
export function PlanHistory({
  versions,
  history,
}: {
  versions: PlanVersion[]
  history: PlanHistoryEntry[]
}) {
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-xs font-extrabold uppercase tracking-wider text-channel mb-2">
          Revisions
        </h3>
        {versions.length === 0 ? (
          <p className="text-sm text-channel">Nothing has been written to this plan yet.</p>
        ) : (
          <ol className="space-y-2">
            {versions.map((v) => (
              <li key={`${v.revision}-${v.sha}`} className="text-sm" data-revision={v.revision}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold">revision {v.revision}</span>
                  <span className="text-channel">{versionLine(v)}</span>
                  <span className="text-xs text-channel">{v.at}</span>
                </div>
                {v.note && <p className="text-xs text-channel mt-0.5">{v.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h3 className="text-xs font-extrabold uppercase tracking-wider text-channel mb-2">
          Recent activity
        </h3>
        {history.length === 0 ? (
          <p className="text-sm text-channel">No recorded activity.</p>
        ) : (
          <ol className="space-y-1">
            {[...history].reverse().map((h) => (
              <li key={h.seq} className="text-xs text-channel">
                <span className="font-semibold text-channel-active">@{h.by || 'server'}</span>{' '}
                {h.verb}
                {h.section ? ` ${h.section}` : ''}
                {h.detail ? ` — ${h.detail}` : ''} · {h.at}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
