import { useEffect, useState } from 'react'
import { CheckSquare, FileText } from 'lucide-react'
import type { AgentCard } from '../../types'
import { useDeskStore } from '../../stores/deskStore'
import { useTodos } from '../../hooks/useTodos'
import type { DeskTodo } from '../../api/endpoints/deskTodos'
import type { DeskSop } from '../../api/endpoints/deskSops'
import SopRail from './SopRail'
import TodoRail from './TodoRail'

interface DeskSideRailProps {
  /** Id of the to-do loaded in the desk message box (badged on its row). */
  activeTodoId: string | null
  /** Ids of the to-dos linked to the desk card under the pointer — forwarded
   *  to `TodoRail` untouched, the same way `activeTodoId` already travels. */
  linkedTodoIds: ReadonlySet<string>
  /** A to-do row was entered (id) / left (`null`) — forwarded to `DeskPage`. */
  onHoverTodo: (todoId: string | null) => void
  /** A to-do row was clicked — DeskPage loads it into the message box. */
  onUseTodo: (t: DeskTodo) => void
  /** An SOP was picked — DeskPage points the composer at it. */
  onUseSop: (sop: DeskSop, recipient: AgentCard | null) => void
  onScheduleSop: (sop: DeskSop) => void
  /** Toast — the plate's label writes surface their failures here. */
  flash: (msg: string) => void
}

/**
 * The My Desk right rail, tabbed **To-do | SOP**. To-do is the manager's
 * plate (`TodoRail`); SOP is their library of stored, reusable prompts
 * (`SopRail`). Opens on To-do so the plate is the resting view.
 *
 * No badge on the SOP tab: the To-do count is an actionable queue, a library
 * count is decoration.
 */
export default function DeskSideRail({
  activeTodoId,
  linkedTodoIds,
  onHoverTodo,
  onUseTodo,
  onUseSop,
  onScheduleSop,
  flash,
}: DeskSideRailProps) {
  const [tab, setTab] = useState<'todo' | 'sop'>('todo')
  // Read-only count for the tab badge (shares the ['desk-todos'] cache).
  const { todos } = useTodos()
  // NOT ARCHIVED — which now includes rows reading Done. A plate whose
  // projects have all finished keeps its badge until the owner files the rows,
  // and that is the accepted behaviour rather than an oversight: this badge
  // sits above a list, and one that disagreed with the length of the list
  // beneath it would be the worse failure.
  const openCount = todos.filter((t) => !t.archived).length

  // ⌘K can land here asking for a specific side: "My Desk › To-do", "My Desk ›
  // SOP", or an SOP pick (which requests the SOP tab too, so the fresh pick is
  // visible under "Recently used"). The rail owns its tab, so it owns consuming
  // the request as well.
  const pendingRailTab = useDeskStore((s) => s.pendingRailTab)
  const clearPendingRailTab = useDeskStore((s) => s.clearPendingRailTab)
  useEffect(() => {
    if (!pendingRailTab) return
    setTab(pendingRailTab)
    clearPendingRailTab()
  }, [pendingRailTab, clearPendingRailTab])

  return (
    <div className="md-rail">
      <div className="side-tabs">
        <button
          className={'side-tab' + (tab === 'todo' ? ' active' : '')}
          onClick={() => setTab('todo')}
        >
          <CheckSquare size={14} />
          To-do
          {openCount > 0 && <span className="side-tab-c">{openCount}</span>}
        </button>
        <button
          className={'side-tab' + (tab === 'sop' ? ' active' : '')}
          onClick={() => setTab('sop')}
        >
          <FileText size={14} />
          SOP
        </button>
      </div>

      {tab === 'todo' ? (
        <TodoRail
          activeTodoId={activeTodoId}
          linkedTodoIds={linkedTodoIds}
          onHoverTodo={onHoverTodo}
          onUseTodo={onUseTodo}
          flash={flash}
        />
      ) : (
        <SopRail onUseSop={onUseSop} onScheduleSop={onScheduleSop} />
      )}
    </div>
  )
}
