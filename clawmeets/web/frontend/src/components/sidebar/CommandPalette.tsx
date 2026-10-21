import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Search, Users, Folder, MessageSquare, Inbox, LayoutDashboard, Clock, Globe, FileText, CheckSquare, UserPlus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAgents } from '../../hooks/useAgents'
import { useRetainedAgents } from '../../hooks/useAgentAccess'
import { useTeamGroups } from '../../hooks/useTeamGroups'
import { useDmThreads } from '../../hooks/useDmThreads'
import { useUserProjects } from '../../hooks/useProjects'
import { useSops } from '../../hooks/useSops'
import { useSopRecents } from '../../hooks/useSopRecents'
import { useTodos } from '../../hooks/useTodos'
import { useUIStore, type RailContext } from '../../stores/uiStore'
import { useSwitchAccount } from '../../hooks/useSwitchAccount'
import { isSessionExpired, useAuthStore } from '../../stores/authStore'
import { useDeskStore, type DeskRailTab } from '../../stores/deskStore'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import { displayName, matchesQuery } from '../../utils/agentDisplay'
import { reachableAgents } from '../../utils/reachableAgents'
import { hubThreadPath, REMOTE_TEXT_CAP, retainedHubLabel, safeRemoteText } from '../../utils/hubDisplay'
import { frontDeskSide, isLegacyFdHost } from '../../utils/frontDesk'
import { useMessageSearch, type MessageSearchState } from '../../hooks/useMessageSearch'
import { useChannelThreads } from '../../hooks/useChannelThreads'
import { channelName, contactLabel } from '../../utils/channelThreads'
import { isThreadProject, type AgentCard, type SearchHit } from '../../types'
import type { DeskSop } from '../../api/endpoints/deskSops'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import SidebarAvatar from './SidebarAvatar'
import MessageHitRow from './MessageHitRow'

interface PaletteItem {
  key: string
  kind: 'agent' | 'todo' | 'sop' | 'team' | 'dm' | 'project' | 'frontdesk' | 'tab' | 'message' | 'account'
  label: string
  sublabel?: string
  agent?: AgentCard
  icon?: LucideIcon // for 'tab' rows
  /** message rows only: `${project_id}::${room_id}` — drives the room subheader. */
  subgroup?: string
  /** message rows only: the hit this row renders. */
  hit?: SearchHit
  run: () => void
}

// The 7 left-rail tabs, mirroring SidebarRail. Nav matches Sidebar's
// handleRailSelect: desk → /desk, scheduled → /scheduled, else /c/<ctx>.
const NAV_TABS: Array<{ context: RailContext; label: string; icon: LucideIcon }> = [
  { context: 'desk', label: 'My Desk', icon: LayoutDashboard },
  { context: 'agents', label: 'Agents', icon: Users },
  { context: 'dms', label: 'DMs', icon: MessageSquare },
  { context: 'projects', label: 'Projects', icon: Folder },
  { context: 'frontdesk', label: 'F-Desk', icon: Inbox },
  { context: 'scheduled', label: 'Sched', icon: Clock },
  { context: 'public', label: 'Public', icon: Globe },
]

// The two My Desk right-rail tabs, reachable directly instead of via "My Desk"
// + a click. Rendered inside the "Go to" group right under their parent tab.
// `aliases` widen the fuzzy match so the qualified name ("desk sop") finds a row
// whose visible label is only the leaf ("SOP").
const DESK_RAIL_TABS: Array<{
  tab: DeskRailTab
  label: string
  icon: LucideIcon
  aliases: string[]
}> = [
  { tab: 'todo', label: 'To-do', icon: CheckSquare, aliases: ['My Desk To-do', 'tasks'] },
  { tab: 'sop', label: 'SOP', icon: FileText, aliases: ['My Desk SOP'] },
]

function tabPath(context: RailContext): string {
  if (context === 'desk') return '/desk'
  if (context === 'scheduled') return '/scheduled'
  return `/c/${context}`
}

// Subsequence + substring match with a coarse quality score (0 = prefix,
// 1 = substring, 2 = subsequence, 3 = no match).
function score(query: string, text: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t.startsWith(q)) return 0
  if (t.includes(q)) return 1
  let i = 0
  for (const ch of t) {
    if (ch === q[i]) i++
    if (i === q.length) return 2
  }
  return 3
}

// Second line of a to-do row: the draft's recipient, the one agent TodoItem's
// meta strip names. Undefined when there is none, so the row collapses to a
// single line the way a bare tab row does.
function todoSublabel(t: DeskTodo): string | undefined {
  return t.draft_recipient_name ? `→ ${t.draft_recipient_name}` : undefined
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

/**
 * Mount gate — the reason the body below is a separate component.
 *
 * Everything the palette accumulates while it is open (the query string, the
 * keyboard cursor, and the 150 ms debounce inside useMessageSearch) is state
 * that belongs to ONE open-close session. Returning null from inside the body
 * kept all of it alive across a close, so reopening rendered the previous
 * query in the input and React Query's cached hits for that same key beside
 * it — the last search's results under a box an on-open effect had not got to
 * yet. Unmounting deletes that state rather than racing it: there is no render
 * in which a stale query can exist, because nothing holds one.
 */
export default function CommandPalette({ open, onClose }: CommandPaletteProps) {
  if (!open) return null
  return <CommandPaletteBody onClose={onClose} />
}

// Fuzzy jump across agents (ranked first), My Desk to-dos and SOPs, teams, DMs,
// projects, and Front Desk projects. The single search surface that replaces
// hunting through the panels. The two My Desk kinds are the ones that *do*
// something rather than navigating: picking a to-do opens its take-over and
// picking an SOP loads it into the desk composer, exactly as clicking either in
// the right rail would.
function CommandPaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  // Un-selected, matching the 27 other subscribers this file already sits among
  // (B17) — deliberately NOT selector-ised here, because doing so would be a
  // restructuring of the palette and AC-4.5 rules that out.
  const { user, sessions, activeUserId } = useAuthStore()
  const switchAccount = useSwitchAccount()
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const { data: allAgents } = useAgents()
  const { data: retained } = useRetainedAgents()
  const { sortedTeamNames, teamBuckets } = useTeamGroups()
  const { groups: dmGroups } = useDmThreads()
  const { data: projects } = useUserProjects()
  // A channel thread is found by its contact's name too (the sidebar's cache).
  const channelThreads = useChannelThreads()
  const { sops } = useSops()
  const { todos } = useTodos()
  const { touch } = useSopRecents()
  const requestSop = useDeskStore((s) => s.requestSop)
  const requestTask = useDeskStore((s) => s.requestTask)
  const requestRailTab = useDeskStore((s) => s.requestRailTab)
  const { expandedAgentTeams, toggleAgentTeam, expandAgentTeam, setRailContext, setProjectExpanded } = useUIStore()

  // Agents rows: the user's own agents and the agents they retained, the set
  // their agents' rosters list (utils/reachableAgents). agentById stays on the
  // full list: it labels thread and message rows, which may be anyone's.
  const { local: agents, hub: hubAgents } = useMemo(
    () => reachableAgents(allAgents, user?.id, retained), [allAgents, user?.id, retained])
  const agentById = useMemo(() => new Map((allAgents ?? []).map((a) => [a.id, a])), [allAgents])

  // Remote message search. A closed palette issues nothing because it is not
  // mounted — see the gate above.
  const search = useMessageSearch(query)
  // For DM hits: room_label is the AGENT's name, identical across that agent's
  // N threads. The already-cached project list recovers the thread's own title
  // as a disambiguator. A miss (e.g. a shared project) just omits it.
  const projectById = useMemo(
    () => new Map((projects ?? []).map((p) => [p.id, p])),
    [projects],
  )

  // Returns false when the unsaved-changes guard kept the user in place, so a
  // caller can skip its side effects instead of acting on a jump that never
  // happened. Every other row ignores the result.
  const go = (path: string, context?: RailContext): boolean => {
    if (!confirmLeaveIfDirty()) return false
    if (context) setRailContext(context)
    navigate(path)
    onClose()
    return true
  }

  // Picking an SOP here == clicking it in SopRail, from anywhere in the app.
  // The composer lives in the router Outlet tree, out of this component's
  // reach, so park the SOP on the desk bus and let DeskPage adopt it. Both
  // updates land in the same batch as the navigate, so the desk mounts with
  // the request already waiting.
  const pickSop = (sop: DeskSop) => {
    if (!go('/desk', 'desk')) return
    touch(sop.id)
    requestSop(sop)
  }

  // Picking a to-do here == clicking its body in TodoRail, from anywhere in the
  // app: it loads the item into the desk message box. That box lives in the
  // router Outlet tree, out of this component's reach, so park the record on the
  // desk bus and let DeskPage adopt it — same shape as pickSop, and the same
  // bail when the unsaved-changes guard kept the user where they were.
  const pickTask = (task: DeskTodo) => {
    if (!go('/desk', 'desk')) return
    requestTask(task)
  }

  const localItems = useMemo<PaletteItem[]>(() => {
    const q = query.trim()

    // Left-rail tabs — a "Go to" group shown by default (empty query) and
    // fuzzy-searchable. Nav mirrors Sidebar.handleRailSelect via tabPath().
    // My Desk additionally expands into its two right-rail tabs, emitted right
    // after their parent so an empty query reads My Desk → To-do → SOP; the sort
    // below is stable, so that order survives an untyped query.
    const tabItems: Array<{ item: PaletteItem; s: number }> = NAV_TABS.flatMap((tab) => [
      {
        s: score(q, tab.label),
        item: {
          key: `tab:${tab.context}`,
          kind: 'tab' as const,
          label: tab.label,
          icon: tab.icon,
          run: () => go(tabPath(tab.context), tab.context),
        } as PaletteItem,
      },
      ...(tab.context === 'desk'
        ? DESK_RAIL_TABS.map((rail) => ({
            s: Math.min(score(q, rail.label), ...rail.aliases.map((a) => score(q, a))),
            item: {
              key: `tab:desk:${rail.tab}`,
              kind: 'tab' as const,
              label: rail.label,
              sublabel: 'My Desk',
              icon: rail.icon,
              // Same jump as the My Desk row, plus the one-shot that tells the
              // rail which side to open on — it defaults to To-do otherwise.
              run: () => {
                if (!go(tabPath('desk'), 'desk')) return
                requestRailTab(rail.tab)
              },
            } as PaletteItem,
          }))
        : []),
    ])
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s)

    // Agents — ranked first. Match against namespace-aware short + full name.
    const agentItems: Array<{ item: PaletteItem; s: number }> = (agents ?? [])
      .map((agent): { item: PaletteItem; s: number } => {
        const label = displayName(agent, user)
        // score() covers the short label; matchesQuery also catches full-name /
        // namespace matches (treated as a substring hit).
        const s = q ? Math.min(score(q, label), matchesQuery(agent, q, user) ? 1 : 3) : 1
        return {
          s,
          item: {
            key: `agent:${agent.id}`,
            kind: 'agent' as const,
            label,
            sublabel: agent.description?.slice(0, 60),
            agent,
            run: () => {
              // Reveal the agent in the Agents roster: expand its team(s) so a
              // teamed row renders (hero / untemmed rows are always visible).
              for (const team of agent.user_teams ?? []) expandAgentTeam(team)
              go(`/dm/${encodeURIComponent(agent.name)}`, 'agents')
            },
          },
        }
      })
      // Retained agents of other servers: Message opens a hub thread.
      .concat(hubAgents.map((r): { item: PaletteItem; s: number } => {
        const label = retainedHubLabel(r)
        return {
          s: q ? score(q, label) : 1,
          item: {
            key: `hub-agent:${r.hub_agent_id}`,
            kind: 'agent' as const,
            label,
            sublabel: safeRemoteText(r.description, REMOTE_TEXT_CAP.description).slice(0, 60),
            icon: Globe,
            run: () => { go(hubThreadPath(r.hub_agent_id), 'public') },
          },
        }
      }))
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s || a.item.label.localeCompare(b.item.label))
      .slice(0, 12)

    // Open to-dos — the actionable half of the To-do rail. Done items live in
    // the rail's collapsed drawer and are deliberately unreachable here: a
    // jump-to surface should only offer rows that still want something.
    // `text` carries the fuzzy score; the draft's recipient and the label slugs
    // fold in as substring hits, mirroring how SOP rows fold in agent_name. Sorted by score ONLY — Array.prototype.sort is stable,
    // so equal scores (which is every row on an empty query) keep the rail's
    // user-defined drag order. Capped at 8, matching SOPs.
    const todoHaystack = q.toLowerCase()
    const todoItems: Array<{ item: PaletteItem; s: number }> = todos
      .filter((t) => !t.archived)
      .map((todo) => {
        const alt = [todo.draft_recipient_name ?? '', ...(todo.labels ?? [])]
          .join(' ')
          .toLowerCase()
        const s = q ? Math.min(score(q, todo.text), alt.includes(todoHaystack) ? 1 : 3) : 1
        return {
          s,
          item: {
            key: `todo:${todo.id}`,
            kind: 'todo' as const,
            label: todo.text,
            sublabel: todoSublabel(todo),
            run: () => pickTask(todo),
          },
        }
      })
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s)
      .slice(0, 8)

    // SOPs — the stored-prompt library, right after Agents because both are
    // "do a thing" rows. Title carries the fuzzy score; the stored
    // default-agent name folds in as a substring hit, mirroring how agent rows
    // fold in matchesQuery(). Capped at 8 so an empty query stays readable.
    const sopHaystack = q.toLowerCase()
    const sopItems: Array<{ item: PaletteItem; s: number }> = sops
      .map((sop) => {
        const alt = (sop.agent_name ?? '').toLowerCase()
        const s = q ? Math.min(score(q, sop.title), alt.includes(sopHaystack) ? 1 : 3) : 1
        return {
          s,
          item: {
            key: `sop:${sop.id}`,
            kind: 'sop' as const,
            label: sop.title,
            sublabel: sop.agent_name ? `→ ${sop.agent_name}` : undefined,
            run: () => pickSop(sop),
          },
        }
      })
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s || a.item.label.localeCompare(b.item.label))
      .slice(0, 8)

    // Teams — selecting expands the group in the roster.
    const teamItems: Array<{ item: PaletteItem; s: number }> = sortedTeamNames
      .map((name) => ({
        s: score(q, name),
        item: {
          key: `team:${name}`,
          kind: 'team' as const,
          label: name,
          sublabel: `${teamBuckets.get(name)?.length ?? 0} agents`,
          run: () => {
            setRailContext('agents')
            if (!expandedAgentTeams.has(name)) toggleAgentTeam(name)
            onClose()
          },
        },
      }))
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s || a.item.label.localeCompare(b.item.label))

    // DMs — own-agent threads, matched on the thread title.
    const dmItems: Array<{ item: PaletteItem; s: number }> = dmGroups
      .flatMap((group) =>
        group.threads.map((thread) => ({
          s: score(q, thread.title),
          item: {
            key: `dm:${thread.projectId}`,
            kind: 'dm' as const,
            label: thread.title,
            sublabel: displayName(group.agent, user),
            run: () =>
              go(`/dm/${encodeURIComponent(group.agent.name)}/${thread.projectId}`, 'dms'),
          },
        })),
      )
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s || a.item.label.localeCompare(b.item.label))
      .slice(0, 10)

    // Projects — regular + shared (own-DM/FD folded into the roster).
    const projectItems: Array<{ item: PaletteItem; s: number }> = (projects ?? [])
      .filter((p) => !isThreadProject(p))
      .map((p) => {
        const label = p.display_name || p.name
        return {
          s: score(q, label),
          item: {
            key: `project:${p.id}`,
            kind: 'project' as const,
            label,
            run: () => {
              // Reveal the project's rooms in the Projects panel, like a sidebar
              // click does.
              setProjectExpanded(p.id, true)
              go(`/projects/${p.id}`, 'projects')
            },
          },
        }
      })
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s || a.item.label.localeCompare(b.item.label))
      .slice(0, 10)

    // Front Desk — host-side inbound projects (same predicate as FrontDeskPanel).
    // Empty for a viewer the surface is gated from, so ⌘K can't reach an FD
    // project by name once the tab and panel are gone.
    const fdItems: Array<{ item: PaletteItem; s: number }> = (projects ?? [])
      .filter(
        (p) =>
          !!user &&
          (frontDeskSide(p, agentById, user.id) === 'host' || isLegacyFdHost(p, user.id)),
      )
      .map((p) => {
        const title = p.display_name || p.name
        const row = channelThreads.byProject.get(p.id)
        // "Ana · Booking (Telegram)": who the person is, never the room name
        // or an identifier.
        const label = row
          ? `${contactLabel(row.contact_name, row.channel)} · ${title} (${channelName(row.channel)})`
          : title
        return {
          s: row ? Math.min(score(q, row.contact_name), score(q, title)) : score(q, label),
          item: {
            key: `frontdesk:${p.id}`,
            kind: 'frontdesk' as const,
            label,
            run: () => {
              setProjectExpanded(p.id, true)
              go(`/projects/${p.id}`, 'frontdesk')
            },
          },
        }
      })
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s || a.item.label.localeCompare(b.item.label))
      .slice(0, 10)

    // AC-4.5 — the 'account' category. Additive: one more array built the same
    // way as the eight above, one more `kind` in the union, one more
    // GROUP_LABEL and one more icon branch. No group is reordered, no row
    // plumbing changes, nothing is factored out. That IS "with no
    // restructuring of the palette".
    //
    // THE ACTIVE ACCOUNT IS NOT LISTED, and that is B21's fix rather than a
    // display choice. `useSwitchAccount()` navigates to `/` unconditionally
    // (AC-3.6), so a row for the account you are already on is a row that
    // throws away the page you are on and gives nothing back. The hook's own
    // comment names the remedy — do not offer it as a target — and the chip
    // and the palette both take it.
    //
    // Cap: none. This list is your own accounts; three is a lot and eight is
    // implausible, so a slice would only ever hide something you have.
    const accountItems: Array<{ item: PaletteItem; s: number }> = (sessions ?? [])
      .filter((session) => session.userId !== activeUserId)
      .map((session) => {
        const name = session.user.username
        const expired = isSessionExpired(session)
        return {
          s: score(q, name),
          item: {
            key: `account:${session.userId}`,
            kind: 'account' as const,
            label: name,
            // AC-4.2's states, in the one place a palette row can carry them.
            // A live background account says nothing extra — "nothing is wrong
            // and you are not on it" is the default this whole group implies.
            sublabel: expired ? 'Session expired — sign in again' : undefined,
            run: () => {
              // An expired session cannot be switched TO: its refresh
              // credential is dead, so the first request after the switch 401s
              // the user straight back out. Re-authorise instead, pre-filled.
              if (expired) {
                if (!confirmLeaveIfDirty()) return
                navigate(`/account/add?username=${encodeURIComponent(name)}`)
                onClose()
                return
              }
              // NOT `go()`. `go` navigates itself, and switching is the one
              // palette action whose navigation is owned elsewhere — by
              // `useSwitchAccount()`, per AC-3.2. The unsaved-changes guard
              // still runs first: a switch clears the query cache and every
              // per-user store, so it destroys a dirty draft at least as
              // thoroughly as a navigation does.
              if (!confirmLeaveIfDirty()) return
              switchAccount(session.userId)
              onClose()
            },
          },
        }
      })
      .filter((x) => x.s < 3)
      .sort((a, b) => a.s - b.s || a.item.label.localeCompare(b.item.label))

    // The one row that is always present, including for a single-account user
    // — which is the case where it is doing the most work, because it is the
    // only discoverable route to a second account besides the chip.
    // `aliases` so "add account" finds it whichever half you type first.
    const addAccount = {
      s: Math.min(score(q, 'Add another account'), score(q, 'account'), score(q, 'sign in')),
      item: {
        key: 'account:add',
        kind: 'account' as const,
        label: 'Add another account',
        run: () => go('/account/add'),
      } as PaletteItem,
    }

    // To-dos before SOPs, mirroring the rail's tab order and the Go-to children.
    // Accounts LAST, after every other local group: a row index that already
    // has the keyboard cursor on it must not move because a session was added
    // or expired, which is the same reason message hits are appended after all
    // of these.
    return [
      ...tabItems,
      ...agentItems,
      ...todoItems,
      ...sopItems,
      ...teamItems,
      ...dmItems,
      ...projectItems,
      ...fdItems,
      ...accountItems,
      ...(addAccount.s < 3 ? [addAccount] : []),
    ].map((x) => x.item)
  }, [query, agents, hubAgents, todos, sops, sortedTeamNames, teamBuckets, dmGroups, projects, channelThreads, agentById, user, sessions, activeUserId, expandedAgentTeams, requestRailTab])

  // Message hits, in the order the server ranked them — never re-sorted (§3.1)
  // and never merged into the local rows' sort. Grouping is by
  // (project_id, room_id) per §3.4; `subgroup` carries that so the renderer can
  // draw one room subheader per run of rows.
  const messageItems = useMemo<PaletteItem[]>(() => {
    if (search.kind !== 'ready') return []
    return search.hits.map((hit) => ({
      key: `message:${hit.project_id}:${hit.room_id}:${hit.message_id}`,
      kind: 'message' as const,
      // `label` stays the room header so the generic row plumbing has something
      // sane; the visible row body is MessageHitRow.
      label: hit.room_label,
      subgroup: `${hit.project_id}::${hit.room_id}`,
      hit,
      // `path` is complete and URL-encoded (§4.1) — no string building, no
      // branch on `kind`. go() brings the unsaved-changes guard and onClose.
      run: () => go(hit.deep_link.path),
    }))
    // `go` is recreated every render and deliberately omitted, matching the
    // local rows above; it closes over nothing that changes between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Appended AFTER every local group so local row indices — and a keyboard
  // cursor already sitting on one — never move when hits land.
  const items = useMemo(() => [...localItems, ...messageItems], [localItems, messageItems])

  // Focus on open. There is nothing to reset: this component mounts on open, so
  // `query` and `selected` are already at their initial values — which is the
  // point, an effect that clears them can only run AFTER a render that showed
  // them.
  useEffect(() => {
    // Defer focus until the input is mounted.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // Clamp selection as the list changes.
  useEffect(() => {
    setSelected((i) => Math.max(0, Math.min(i, items.length - 1)))
  }, [items.length])

  // Keep the highlighted row in view as arrows move the cursor. `block: 'nearest'`
  // is a no-op when the row is already visible, so mouse hover doesn't jump it.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      items[selected]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const GROUP_LABEL: Record<PaletteItem['kind'], string> = {
    tab: 'Go to',
    agent: 'Agents',
    todo: 'My Desk › To-do',
    sop: 'My Desk › SOP',
    team: 'Teams',
    dm: 'DMs',
    project: 'Projects',
    frontdesk: 'Front Desk',
    message: 'Messages',
    account: 'Accounts',
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white rounded-[14px] overflow-hidden"
        style={{ boxShadow: 'var(--shadow-pop)', border: '1px solid var(--line-2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b" style={{ borderColor: 'var(--line-1)' }}>
          <Search className="w-4 h-4 text-ink-4 flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a tab, agent, to-do, SOP, DM, project…"
            className="flex-1 bg-transparent outline-none text-[14px] text-ink-1 placeholder:text-ink-4"
          />
          <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--bg-pill-muted)] text-ink-4">
            esc
          </span>
        </div>

        <div className="max-h-[52vh] overflow-y-auto scrollbar-thin py-1">
          {items.length === 0 && search.kind === 'idle' && (
            <div className="px-4 py-6 text-center text-[13px] text-ink-4">No matches</div>
          )}
          {items.map((item, i) => {
            const prev = items[i - 1]
            const showGroup = !prev || prev.kind !== item.kind
            // Message rows carry a second, finer header: one per room run.
            const showRoom = !!item.hit && (showGroup || prev?.subgroup !== item.subgroup)
            const isSel = i === selected
            return (
              <div key={item.key} ref={isSel ? selectedRef : undefined}>
                {showGroup && (
                  <div className="px-4 pt-2 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-ink-4">
                    {GROUP_LABEL[item.kind]}
                  </div>
                )}
                {showRoom && item.hit && (
                  <div className="px-4 pt-1.5 pb-0.5">
                    <div className="truncate text-[12px] font-bold text-ink-2">
                      {item.hit.room_label}
                    </div>
                    {item.hit.room_type === 'project' && (
                      <div className="truncate text-[11px] text-ink-4">
                        {item.hit.project_name}
                      </div>
                    )}
                  </div>
                )}
                <button
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => item.run()}
                  className={`flex gap-2.5 w-full px-4 py-1.5 text-left transition-colors ${
                    item.hit ? 'items-start' : 'items-center'
                  } ${isSel ? 'bg-[var(--accent-softer)]' : 'hover:bg-[var(--bg-card-hover)]'}`}
                >
                  {item.kind === 'agent' && item.agent ? (
                    <SidebarAvatar name={item.label} size={20} ringColor="#ffffff" />
                  ) : item.kind === 'agent' && item.icon ? (
                    <span className="w-5 h-5 flex items-center justify-center text-ink-3 flex-shrink-0">
                      <item.icon className="w-4 h-4" />
                    </span>
                  ) : item.kind === 'account' && item.key !== 'account:add' ? (
                    /* Fixed `--accent` fill, never the per-name hash the agent
                       rows use: AC-4.1's "no per-account colour", held to in
                       the palette as well as in the chip so one account does
                       not wear two identities across two surfaces. */
                    <SidebarAvatar name={item.label} size={20} color="var(--accent)" ringColor="#ffffff" />
                  ) : (
                    <span className="w-5 h-5 flex items-center justify-center text-ink-3 flex-shrink-0">
                      {item.kind === 'tab' && item.icon ? (
                        <item.icon className="w-4 h-4" />
                      ) : item.kind === 'todo' ? (
                        <CheckSquare className="w-4 h-4" />
                      ) : item.kind === 'sop' ? (
                        <FileText className="w-4 h-4" />
                      ) : item.kind === 'team' ? (
                        <Users className="w-4 h-4" />
                      ) : item.kind === 'dm' || item.kind === 'message' ? (
                        <MessageSquare className="w-4 h-4" />
                      ) : item.kind === 'frontdesk' ? (
                        <Inbox className="w-4 h-4" />
                      ) : item.kind === 'account' ? (
                        <UserPlus className="w-4 h-4" />
                      ) : (
                        <Folder className="w-4 h-4" />
                      )}
                    </span>
                  )}
                  {item.hit ? (
                    <MessageHitRow
                      hit={item.hit}
                      threadTitle={
                        item.hit.room_type === 'dm'
                          ? projectById.get(item.hit.project_id)?.display_name
                          : undefined
                      }
                    />
                  ) : (
                    <span className="flex flex-col min-w-0 flex-1">
                      <span
                        className={`truncate text-[13.5px] ${item.kind === 'agent' ? 'font-mono' : 'font-semibold'} text-ink-1`}
                      >
                        {item.label}
                      </span>
                      {item.sublabel && (
                        <span className="truncate text-[11.5px] text-ink-3">{item.sublabel}</span>
                      )}
                    </span>
                  )}
                  {isSel && <span className="font-mono text-[10.5px] text-ink-4 flex-shrink-0">↵</span>}
                </button>
              </div>
            )
          })}
          <MessageSectionStatus state={search} hasHits={messageItems.length > 0} />
        </div>
      </div>
    </div>,
    document.body,
  )
}

const GROUP_HEADER_CLASS =
  'px-4 pt-2 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-ink-4'

/**
 * The Messages section's status lines. Deliberately NOT part of `items`, so
 * ↑/↓/Enter can never land on one. `role="status"` lets a screen reader hear
 * the transition without a tab stop.
 *
 * `indexing: true` arrives as a 200 with real hits, so its note renders
 * ALONGSIDE them — never as a bare "no results" (contract §3.1 / §6).
 */
function MessageSectionStatus({
  state,
  hasHits,
}: {
  state: MessageSearchState
  hasHits: boolean
}) {
  const notes: string[] = []
  if (state.kind === 'loading') notes.push('Searching messages…')
  else if (state.kind === 'unavailable') notes.push('Message search is unavailable.')
  else if (state.kind === 'error') notes.push("Couldn't search messages.")
  else if (state.kind === 'ready') {
    if (state.indexing) notes.push('Still indexing your history — results may be incomplete.')
    else if (!hasHits) notes.push('No messages match.')
    if (state.hasMore) notes.push('More matches — keep typing to refine.')
  }
  if (notes.length === 0) return null

  return (
    <>
      {/* With hits, the first hit row already drew the group header. */}
      {!hasHits && <div className={GROUP_HEADER_CLASS}>Messages</div>}
      <div role="status" className="px-4 py-1 text-[12px] text-ink-4">
        {notes.map((note) => (
          <div key={note}>{note}</div>
        ))}
      </div>
    </>
  )
}
