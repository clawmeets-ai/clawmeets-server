import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Cpu, Check, ChevronDown, Star, Settings2, RotateCcw } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useModelConfigs } from '../../hooks/useModelConfigs'
import { useModelSelectionStore } from '../../stores/modelSelectionStore'
import { getLlmProvider } from '../../config/llmProviders'
import type { AgentCard } from '../../types'
import { agentSettingsHref } from '../settings/agent/sections'

/**
 * Compact model picker for the single-agent composers (DMs + My Desk).
 *
 * Bound to the agent's NAMED model configs (model-config-selection-revamp,
 * spec #2/#3/#6) — it no longer mutates the agent. Picking a config sets a
 * TRANSIENT per-agent selection (`modelSelectionStore`) that the composer ships
 * as `model_config_name` for that one message; it resets to the agent's backend
 * `default` on reload. The default config is preselected and starred.
 *
 * When the agent has NO configs (`default === null`) it isn't "unset" — every
 * agent has a working built-in default (the server's Claude Code CLI fallback).
 * So the chip reads "Claude Code CLI" and the menu shows that as a real, active,
 * non-removable selection plus an "Add your own model…" link into Agent Settings
 * — instead of a scary "Setup Model" prompt. CRITICAL: the virtual default is
 * NOT a real config name, so the composer keeps sending `model_config_name =
 * undefined` while it's active, and the server applies its own CLI fallback. We
 * never ship the label on the wire. Owner-only: renders nothing for foreign
 * agents or before the agent resolves (same gate as before).
 */
// Frontend-only virtual default: mirrors the server's built-in CLI fallback so a
// brand-new agent with no named configs still shows a working, labelled model.
const CLI_DEFAULT_LABEL = 'Claude Code CLI'

export default function ModelSelector({ agent }: { agent: AgentCard | null | undefined }) {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // Fixed viewport coords for the portalled menu, anchored to the trigger's
  // rect (right-aligned, opens upward). `maxHeight` caps the menu to the space
  // above the trigger so a tall list scrolls instead of spilling off-screen.
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number; maxHeight: number } | null>(null)

  const owned = !!user && !!agent && agent.registered_by === user.id

  const { data } = useModelConfigs(owned ? agent?.id : undefined)
  const configs = data?.configs ?? []
  const defaultName = data?.default ?? null

  const selectedName = useModelSelectionStore((s) => (agent ? s.byAgent[agent.id] : undefined))
  const setSelection = useModelSelectionStore((s) => s.setSelection)
  const clearSelection = useModelSelectionStore((s) => s.clearSelection)

  // Close on outside-click / Escape. The menu is portalled outside wrapRef, so
  // its own ref is excluded from the outside test too.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Anchor the fixed menu to the trigger's rect while open; recompute on
  // scroll/resize so it tracks the composer. `position: fixed` on document.body
  // escapes every `overflow-hidden` ancestor of the composer.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = btnRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPos({
        bottom: window.innerHeight - rect.top + 8,
        right: window.innerWidth - rect.right,
        maxHeight: Math.max(160, rect.top - 16),
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  if (!agent || !owned) return null

  const hasConfigs = configs.length > 0
  // Effective selection: transient pick, else the backend default. The active
  // config is what the composer will send as `model_config_name`.
  const activeName = selectedName ?? defaultName
  const activeConfig = configs.find((c) => c.name === activeName)
  const chipLabel = hasConfigs ? activeConfig?.name ?? 'Model' : CLI_DEFAULT_LABEL

  const goToSettings = () => {
    setOpen(false)
    navigate(agentSettingsHref(agent.id, 'model'))
  }

  const pick = (name: string) => {
    // Picking the default is the same as clearing the transient override.
    if (name === defaultName) clearSelection(agent.id)
    else setSelection(agent.id, name)
    setOpen(false)
  }

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Model for this message"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
          open
            ? 'border-purple-300 bg-purple-50 text-accent'
            : 'border-gray-200 text-gray-600 hover:border-purple-200 hover:bg-purple-50 hover:text-accent'
        }`}
      >
        <Cpu className="w-3.5 h-3.5" />
        <span className="max-w-[120px] truncate">{chipLabel}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', bottom: menuPos.bottom, right: menuPos.right, maxHeight: menuPos.maxHeight }}
            className="z-50 w-64 max-w-[80vw] overflow-y-auto overflow-x-hidden rounded-xl border border-gray-200 bg-white shadow-lg"
          >
            {!hasConfigs ? (
              // No named configs → the built-in CLI default IS the working model.
              // Present it as a real, active, non-removable row (never sends a
              // config name on the wire), then a friendly link to add your own.
              <>
                <div className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                  Model for this message
                </div>
                <div className="py-0.5">
                  <div className="flex w-full items-center gap-2.5 px-3 py-2 text-left bg-purple-50/60">
                    <span className="min-w-0 flex-1">
                      <span className="truncate text-[13px] font-medium text-gray-800">
                        {CLI_DEFAULT_LABEL}
                      </span>
                      <span className="block text-[10.5px] text-gray-400">
                        Built-in default — no setup needed
                      </span>
                    </span>
                    <Check className="w-3.5 h-3.5 text-accent shrink-0" />
                  </div>
                </div>
                <div className="mx-3 my-1 border-t border-gray-100" />
                <button
                  type="button"
                  onClick={goToSettings}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-gray-500 transition-colors hover:bg-gray-50"
                >
                  <Settings2 className="w-3.5 h-3.5 shrink-0" />
                  Add your own model…
                </button>
              </>
            ) : (
              <>
                <div className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-gray-400">
                  Model for this message
                </div>
                <div className="py-0.5">
                  {configs.map((c) => {
                    const isActive = c.name === activeName
                    const isDefault = c.name === defaultName
                    const providerLabel = getLlmProvider(c.provider)?.label ?? c.provider
                    return (
                      <button
                        key={c.name}
                        type="button"
                        onClick={() => pick(c.name)}
                        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-purple-50 ${
                          isActive ? 'bg-purple-50/60' : ''
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium text-gray-800">{c.name}</span>
                            {isDefault && <Star className="w-3 h-3 text-amber-400 shrink-0" fill="currentColor" />}
                          </span>
                          <span className="block text-[10.5px] text-gray-400 truncate">
                            {providerLabel}
                            {c.model ? ` · ${c.model}` : ''}
                          </span>
                        </span>
                        {isActive && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
                      </button>
                    )
                  })}
                </div>
                {/* Reset the transient pick back to the agent default. */}
                {selectedName != null && selectedName !== defaultName && (
                  <>
                    <div className="mx-3 my-1 border-t border-gray-100" />
                    <button
                      type="button"
                      onClick={() => {
                        clearSelection(agent.id)
                        setOpen(false)
                      }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-gray-500 transition-colors hover:bg-gray-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                      Use agent default{defaultName ? ` (${defaultName})` : ''}
                    </button>
                  </>
                )}
                <div className="mx-3 my-1 border-t border-gray-100" />
                <button
                  type="button"
                  onClick={goToSettings}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-gray-500 transition-colors hover:bg-gray-50"
                >
                  <Settings2 className="w-3.5 h-3.5 shrink-0" />
                  Manage models…
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
