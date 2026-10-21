import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Plus, Search, X } from 'lucide-react'
import type { AgentCard } from '../../types'
import type { DeskSop, SopDraft } from '../../api/endpoints/deskSops'
import { useAgents } from '../../hooks/useAgents'
import { useSops } from '../../hooks/useSops'
import { useSopRecents } from '../../hooks/useSopRecents'
import { useAuthStore } from '../../stores/authStore'
import { resolveSopRecipient } from '../../utils/sopRecipient'
import { groupSops } from '../../utils/sopSection'
import { matchesTokens, searchTokens } from '../../utils/textSearch'
import { useSopSchedules } from '../../hooks/useSopSchedules'
import SopEditor from './SopEditor'
import SopItem from './SopItem'

interface SopRailProps {
  /** Hand the chosen SOP up to DeskPage, which points the composer at the
   *  recipient and loads the body as chips. */
  onUseSop: (sop: DeskSop, recipient: AgentCard | null) => void
  /** Same handoff for "put this on a cadence" — DeskPage addresses that one to
   *  the assistant instead, since it is the only agent that can schedule. */
  onScheduleSop: (sop: DeskSop) => void
}

const EMPTY_DRAFT: SopDraft = {
  title: '',
  body: '',
  agent_id: null,
  agent_name: null,
}

/**
 * The SOP library — the right rail's second tab.
 *
 * The same handoffs get typed over and over, so store them once: an SOP is a
 * prompt with typed `{{blanks}}`, and clicking one drops it into the desk
 * message box already addressed to the agent who normally runs it, with the
 * blanks rendered as chips to fill.
 *
 * Sections come from the titles and from nowhere else: `Marketing:product IG
 * content` files itself under Marketing and shows as "product IG content"
 * (`utils/sopSection.ts`), and an unprefixed title lands in "Yours". The rail
 * therefore has no section state to hold, no empty section to render, and no
 * way to disagree with the library about what exists — a rename is the only
 * move. The starter SOPs every account is seeded with carry a `SYSTEM:` prefix
 * and sort to the bottom.
 *
 * ONE BOX, TWO JOBS. What is typed into it narrows the library as you go, and
 * is also the NAME of the SOP the `+` creates — press Enter or hit `+` and the
 * editor opens with the title already filled in. Search-or-create rather than
 * a search box beside an unrelated New button, because the two are the same
 * gesture a beat apart: you type a name, see whether you already wrote it, and
 * write it if you have not. The `+` is disabled while the box is empty, so
 * there is exactly one state in which it does nothing and it says so.
 *
 * Reuses the To-do rail's chrome classes (`.todo-add`, `.todo-add-row`,
 * `.todo-add-new`, `.todo-scroll`, `.todo-plate-h`, `.todo-empty`) so the two
 * tabs read as siblings.
 */
export default function SopRail({ onUseSop, onScheduleSop }: SopRailProps) {
  const { sops, save, remove } = useSops()
  const { recentIds, touch } = useSopRecents()
  const { data: agents } = useAgents()
  const { user } = useAuthStore()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<SopDraft | null>(null)
  const [lastUsed, setLastUsed] = useState<string | null>(null)
  // Sections the owner has opened, by `SopSection.key`. Everything below
  // Recently used starts FOLDED: that list is what you reach for, the rest is
  // a reference you open when you go looking. Held per-mount, not persisted —
  // a fresh desk starts tidy again.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const cadences = useSopSchedules()

  // Every typed word must appear somewhere in the row, in any order, matched
  // as a substring — so `marketing ig` reaches "Marketing:product IG content"
  // and so does `ig mark`. See `utils/textSearch.ts` for why AND, not OR.
  const tokens = useMemo(() => searchTokens(q), [q])
  const searching = tokens.length > 0
  const hits = useMemo(
    () => sops.filter((s) => matchesTokens([s.title, s.agent_name, s.body], tokens)),
    [sops, tokens],
  )

  // Stale ids (deleted here or in another session) simply drop out.
  const recents = useMemo(
    () =>
      searching
        ? []
        : recentIds.map((id) => sops.find((s) => s.id === id)).filter((s): s is DeskSop => !!s),
    [recentIds, sops, searching],
  )

  // Sections are derived from the matches, not from the whole library, so a
  // search narrows the headings too rather than leaving empty ones standing.
  const sections = useMemo(() => groupSops(hits), [hits])

  const pending = q.trim()

  /** Open the editor on a new SOP named by whatever is in the box.
   *
   *  The box is CLEARED here, because its contents have been consumed — the
   *  string now lives in the draft, and leaving a copy behind would mean the
   *  same title existing in two places with nothing keeping them in step. */
  const createSop = () => {
    if (!pending) return
    setEditing({ ...EMPTY_DRAFT, title: pending })
    setQ('')
  }

  const use = (sop: DeskSop) => {
    touch(sop.id)
    setLastUsed(sop.id)
    onUseSop(sop, resolveSopRecipient(sop, agents, user ?? null))
  }

  const wire = (sop: DeskSop) => ({
    sop,
    active: lastUsed === sop.id,
    recipient: resolveSopRecipient(sop, agents, user ?? null),
    onUse: use,
    onEdit: (s: DeskSop) =>
      setEditing({
        id: s.id,
        title: s.title,
        body: s.body,
        agent_id: s.agent_id ?? null,
        agent_name: s.agent_name ?? null,
      }),
    onDelete: (s: DeskSop) => remove(s.id),
    onSchedule: onScheduleSop,
    schedule: cadences.get(sop.id) ?? null,
  })

  return (
    <div className="sop">
      <div className="todo-add">
        <div className="todo-add-row">
          <div className="todo-add-box">
            <Search size={15} />
            <input
              className="todo-add-in"
              value={q}
              placeholder="Search SOPs, or name a new one…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                createSop()
              }}
            />
            {q && (
              <button className="todo-add-info" onClick={() => setQ('')} title="Clear search">
                <X size={13} />
              </button>
            )}
          </div>
          {/* `aria-label="Add SOP"`, NOT "New SOP": the editor dialog this
              button opens already carries `aria-label="New SOP"`, and two
              nodes answering to one accessible name is ambiguous for a screen
              reader and silently satisfiable by the wrong one in a test. */}
          <button
            className="todo-add-new"
            onClick={createSop}
            disabled={!pending}
            aria-label="Add SOP"
            title={pending ? `Create SOP “${pending}”` : 'Type a name to create an SOP'}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="sop-hint">
          Stored prompts with typed blanks. Pick one — it lands in your message box
          addressed to the right agent, with the blanks ready to fill. Type a name and
          press Enter to write a new one.
        </div>
      </div>

      <div className="todo-scroll">
        {recents.length > 0 && (
          <>
            <div className="todo-plate-h">Recently used</div>
            {recents.map((s) => (
              // The only rows shown outside their own section, so they name it
              // themselves — "product IG content" alone loses the Marketing.
              <SopItem key={'r-' + s.id} {...wire(s)} showSection />
            ))}
          </>
        )}

        {/* Fragments, not wrapper divs: the headings and cards stay direct
            children of the scroller, so grouping changes what is listed and
            nothing about how it is laid out. */}
        {sections.map((sec) => {
          // A search shows every hit: a match folded away behind a heading
          // would read as no match at all.
          const expanded = searching || open.has(sec.key)
          return (
            <Fragment key={sec.key}>
              <button
                type="button"
                className="todo-plate-h sop-sec-h"
                aria-expanded={expanded}
                disabled={searching}
                onClick={() => toggle(sec.key)}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {sec.label}
                <span className="todo-plate-c">{sec.sops.length}</span>
              </button>
              {expanded && sec.sops.map((s) => <SopItem key={s.id} {...wire(s)} />)}
            </Fragment>
          )
        })}

        {sops.length > 0 && hits.length === 0 && (
          <div className="todo-empty">
            <span className="todo-empty-ic">
              <FileText size={22} />
            </span>
            <div className="todo-empty-t">No SOP matches “{q}”</div>
            <div className="todo-empty-s">
              Try the agent's name, or a word from the prompt — or press Enter to write
              this one.
            </div>
          </div>
        )}
      </div>

      {editing && (
        <SopEditor
          draft={editing}
          onSave={(d) => {
            save(d)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
