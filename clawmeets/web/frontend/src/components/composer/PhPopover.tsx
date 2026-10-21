import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import { AgentStatus, type AgentCard, type User } from '../../types'
import { displayName } from '../../utils/agentDisplay'
import Avatar from '../common/Avatar'
import {
  PH_TAGS,
  isMultiKind,
  isRosterKind,
  joinMulti,
  splitMulti,
  toggleMulti,
  type PhChip,
} from './placeholders'

export interface PhPopoverPos {
  x: number
  y: number
  /** Anchor above the chip instead of below (no room underneath). */
  flip: boolean
}

interface PhPopoverProps {
  chip: PhChip
  pos: PhPopoverPos
  /** Roster for the `agent` / `agents` kinds. Absent (e.g. the desk reply box)
   *  simply degrades that chip to free-text entry. */
  agents?: AgentCard[]
  viewer?: User | null
  /** `keepOpen` is the multi-pick path: the value is committed on every tick
   *  so the chip is never out of date, but the menu stays up for the next one. */
  onPick: (value: string, keepOpen?: boolean) => void
  onClose: () => void
}

/**
 * The fill popover: the blank's predefined values on top, a free-text field
 * below. Every kind accepts a typed value, so a set is a shortcut, never a
 * cage — which is why the input is always present.
 *
 * A MULTI kind (`agents`) turns the menu into tick-boxes: each click toggles a
 * name in the comma-separated value and the popover stays open, so picking
 * three mentors is three clicks rather than three round-trips through the chip.
 * It also carries a default the single-pick kinds have no use for — the owner's
 * own assistant, the one agent every owner has — so pressing Done on an
 * untouched list answers the blank rather than blocking send.
 */
export default function PhPopover({
  chip,
  pos,
  agents,
  viewer,
  onPick,
  onClose,
}: PhPopoverProps) {
  const multi = isMultiKind(chip.kind)
  const [q, setQ] = useState(multi ? '' : chip.value || '')
  // The selection lives HERE, not in `chip.value`. PromptEditor keeps chip
  // metadata in a ref and re-renders only when the filled COUNT changes, so a
  // second tick on an already-filled blank would never repaint from the parent.
  const [picked, setPicked] = useState<string[]>(() => splitMulti(chip.value))
  const inRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inRef.current?.focus()
  }, [])

  /** The owner's own assistant, under the name the viewer sees it by. */
  const assistant = useMemo(() => {
    if (!viewer?.username) return ''
    const card = (agents ?? []).find((a) => a.name === `${viewer.username}-assistant`)
    return card ? displayName(card, viewer) : ''
  }, [agents, viewer])

  // A bare `{{X|agent}}` carries no options — the roster is resolved here,
  // not at parse time, because a template can load before the agent list has
  // settled. An explicit `agent:a,b` list wins over the roster.
  const options = useMemo(() => {
    if (!isRosterKind(chip.kind) || chip.options.length > 0) return chip.options
    const names = (agents ?? [])
      .filter((a) => a.status === AgentStatus.ONLINE)
      .map((a) => displayName(a, viewer ?? null))
    // The assistant leads: it is the stated default for a multi blank, and the
    // likeliest pick for a single one. Hoisted BEFORE the cap, so a long roster
    // can't push it off the list.
    return [
      ...names.filter((n) => n === assistant),
      ...names.filter((n) => n !== assistant),
    ].slice(0, 8)
  }, [chip.kind, chip.options, agents, viewer, assistant])

  const cardFor = (name: string) =>
    (agents ?? []).find(
      (a) => displayName(a, viewer ?? null) === name || a.name === name,
    )

  const hasMenu = options.length > 0
  // Only a multi blank has a default worth applying to a roster kind — a
  // single `agent` blank has always committed exactly what was picked.
  const def = chip.def || (multi ? assistant : '')
  const isOn = (o: string) =>
    multi ? picked.some((p) => p.toLowerCase() === o.toLowerCase()) : chip.value === o

  const toggle = (o: string) => {
    const next = toggleMulti(joinMulti(picked), o)
    setPicked(splitMulti(next))
    onPick(next, true)
  }

  const add = (name: string) => {
    const next = toggleMulti(joinMulti(picked), name)
    setPicked(splitMulti(next))
    setQ('')
    onPick(next, true)
    inRef.current?.focus()
  }

  /** Multi only: leave with what is ticked, falling back to the default when
   *  nothing is. Every tick already committed, so this just closes. */
  const done = () => {
    if (picked.length === 0) onPick(def || '')
    else onClose()
  }

  const commit = () => {
    const typed = q.trim()
    if (multi) {
      if (typed) add(typed)
      else done()
      return
    }
    onPick(typed || def || '')
  }

  const clear = () => {
    setPicked([])
    setQ('')
    onPick('', multi)
  }

  // The popover lives inside surfaces that bind window-level Escape
  // (dialogs) and desk-wide single-key hotkeys (DeskPage). Swallow the
  // keys we handle so filling a blank can never close the take-over out from
  // under a half-written draft.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      commit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      className={'ph-pop' + (pos.flip ? ' flip' : '')}
      style={pos.flip ? { left: pos.x, bottom: pos.y } : { left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`Fill ${chip.label}`}
    >
      <div className="ph-pop-h">
        <span className="ph-k">{PH_TAGS[chip.kind]}</span>
        <span className="ph-pop-lb">{chip.label}</span>
        {multi && picked.length > 0 && (
          <span className="ph-pop-n">{picked.length} picked</span>
        )}
        {(multi ? picked.length > 0 : !!chip.value) && (
          <button type="button" className="ph-pop-clr" onClick={clear}>
            clear
          </button>
        )}
      </div>

      {hasMenu && (
        <div className="ph-pop-list">
          {options.map((o) => {
            const card = isRosterKind(chip.kind) ? cardFor(o) : undefined
            return (
              <button
                type="button"
                key={o}
                className={'ph-opt' + (isOn(o) ? ' on' : '')}
                // Don't blur the editable on mousedown — that would collapse
                // the selection before we restore the caret after the chip.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (multi ? toggle(o) : onPick(o))}
              >
                {isRosterKind(chip.kind) && (
                  <Avatar name={o} status={card?.status} size="xs" />
                )}
                <span className="ph-opt-tx">{o}</span>
                {isOn(o) && <Check size={12} />}
              </button>
            )
          })}
        </div>
      )}

      <div className="ph-pop-in">
        <input
          ref={inRef}
          value={q}
          type={chip.kind === 'number' ? 'number' : 'text'}
          placeholder={
            multi ? 'or type a name…' : hasMenu ? 'or type your own…' : def || 'Type a value…'
          }
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="ph-pop-ok"
          onMouseDown={(e) => e.preventDefault()}
          onClick={commit}
        >
          {multi ? 'add' : 'set'}
        </button>
      </div>

      {multi && (
        <button
          type="button"
          className="ph-pop-done"
          onMouseDown={(e) => e.preventDefault()}
          onClick={done}
        >
          {picked.length > 0 ? 'Done' : def ? `Done · ${def}` : 'Done'}
        </button>
      )}

      {!!def && !multi && <div className="ph-pop-def">default · {def}</div>}
    </div>
  )
}
