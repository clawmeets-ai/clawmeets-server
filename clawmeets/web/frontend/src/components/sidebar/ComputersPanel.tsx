import { useState } from 'react'
import { useMatch, useNavigate } from 'react-router-dom'
import { Laptop } from 'lucide-react'
import { useComputers } from '../../hooks/useComputers'
import { confirmLeaveIfDirty } from '../../stores/unsavedGuard'
import type { Computer } from '../../api/endpoints/computers'
import { rowSummary, statusPill } from '../computer/computerCopy'
import ConnectComputerModal from '../computer/ConnectComputerModal'
import Loading from '../common/Loading'
import PanelShell from './PanelShell'

/**
 * The Computers rail panel: one row per machine the user has connected.
 *
 * Same structure as the Agents panel — a title with a `+`, then rows — because a
 * computer is a thing you select to see a page about, exactly like an agent. The
 * `+` opens the pairing dialog rather than a form: there is nothing to fill in,
 * because a machine's record is created BY its first connection, so a
 * listed-but-unconnected computer cannot exist and there is no "draft" state to
 * design for.
 *
 * Each row carries a live dot and the one-line summary from `computerCopy`, the
 * same module the page's banner is derived from — so the row and the page can
 * never end up disagreeing about whether a machine is up.
 */
export default function ComputersPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { data: computers, isLoading } = useComputers()
  const navigate = useNavigate()
  const match = useMatch('/computers/:computerId')
  const activeId = match?.params.computerId ?? null
  const [connectOpen, setConnectOpen] = useState(false)

  const select = (computer: Computer) => {
    if (!confirmLeaveIfDirty()) return
    navigate(`/computers/${computer.id}`)
    onNavigate?.()
  }

  return (
    <>
      <PanelShell
        title="Computers"
        onAdd={() => setConnectOpen(true)}
        addLabel="Connect a computer"
        onNavigate={onNavigate}
      >
        {isLoading && (
          <div className="px-3 py-2">
            <Loading size="sm" />
          </div>
        )}

        {!isLoading && (computers?.length ?? 0) === 0 && (
          <div className="px-3.5 pt-3 pb-2">
            <p className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
              No computers connected yet. Connect the one your agents live on to
              see and control them from here.
            </p>
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              className="mt-2.5 px-2.5 py-1.5 rounded-lg text-[11.5px] font-bold text-white"
              style={{ background: 'var(--accent)', border: '1px solid var(--accent)' }}
            >
              Connect a computer
            </button>
          </div>
        )}

        {(computers?.length ?? 0) > 0 && (
          <>
            <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-channel">
              Your computers
              <span className="font-mono text-[10.5px] text-ink-4 tabular-nums normal-case tracking-normal">
                · {computers?.length}
              </span>
            </div>
            <div className="px-1.5 space-y-0.5">
              {computers?.map((computer) => (
                <ComputerRow
                  key={computer.id}
                  computer={computer}
                  isSelected={activeId === computer.id}
                  onClick={() => select(computer)}
                />
              ))}
            </div>
          </>
        )}
      </PanelShell>

      <ConnectComputerModal open={connectOpen} onClose={() => setConnectOpen(false)} />
    </>
  )
}

function ComputerRow({
  computer,
  isSelected,
  onClick,
}: {
  computer: Computer
  isSelected: boolean
  onClick: () => void
}) {
  const pill = statusPill(computer.status)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isSelected ? 'page' : undefined}
      className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors"
      style={{
        background: isSelected ? 'var(--bg-card-selected)' : 'transparent',
        color: 'var(--ink-1)',
      }}
    >
      <span className="relative shrink-0 grid place-items-center" style={{ color: 'var(--ink-3)' }}>
        <Laptop size={15} />
        {/* The presence dot rides on the icon rather than sitting beside the
            text, so "which of my machines is up" is answerable by scanning one
            column. Ringed outward against the sidebar fill so the whole
            diameter stays coloured, matching SidebarAvatar. */}
        <span
          className="absolute rounded-full"
          style={{
            width: 7,
            height: 7,
            right: -3,
            bottom: -2,
            background: pill.dot,
            boxShadow: '0 0 0 2px var(--bg-sidebar)',
          }}
        />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] font-bold truncate">{computer.name}</span>
        <span className="block text-[11.5px] truncate" style={{ color: 'var(--ink-3)' }}>
          {rowSummary(computer)}
        </span>
      </span>
    </button>
  )
}
