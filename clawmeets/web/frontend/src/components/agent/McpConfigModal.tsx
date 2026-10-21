import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings2, Sparkles, AlertTriangle } from 'lucide-react'
import { getMcpConfig, putMcpConfig } from '../../api/endpoints/mcps'
import { ApiError } from '../../api/client'
import JsonConfigEditor from './JsonConfigEditor'

interface Props {
  agentId: string
  mcpName: string
  /** Used as fallback when GET hasn't returned yet, so the editor isn't blank. */
  fallbackStarter?: Record<string, unknown> | null
  onClose: () => void
}

/** Mirror of `clawmeets/utils/jsonc.py:strip_jsonc`. String-aware so `//` and
 *  `/* … *\/` sequences inside JSON string literals (e.g. an `"https://…"`
 *  URL) survive. Also strips trailing commas before `}` and `]`. */
function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (inString) {
      if (c === '\\' && i + 1 < n) {
        out += text.slice(i, i + 2)
        i += 2
        continue
      }
      out += c
      if (c === '"') inString = false
      i += 1
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i += 1
      continue
    }
    if (c === '/' && i + 1 < n) {
      const nxt = text[i + 1]
      if (nxt === '/') {
        const j = text.indexOf('\n', i + 2)
        i = j === -1 ? n : j
        continue
      }
      if (nxt === '*') {
        const j = text.indexOf('*/', i + 2)
        i = j === -1 ? n : j + 2
        continue
      }
    }
    out += c
    i += 1
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

export default function McpConfigModal({ agentId, mcpName, fallbackStarter, onClose }: Props) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [primed, setPrimed] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['agent-mcp-config', agentId, mcpName],
    queryFn: () => getMcpConfig(agentId, mcpName),
  })

  const starterText = data?.starter_config_text ?? null
  const starterParsed = data?.starter_config ?? fallbackStarter ?? null
  const savedConfig = data?.config ?? null
  const isFreshConfig = !isLoading && savedConfig === null

  useEffect(() => {
    if (primed || isLoading) return
    // Prefer the raw JSONC (carries inline comments). Fall back to a
    // stringified saved config (for re-edit) or the parsed starter (when
    // the server didn't ship a .jsonc sibling for this MCP).
    let seed: string
    if (savedConfig !== null) {
      seed = JSON.stringify(savedConfig, null, 2)
    } else if (starterText) {
      seed = starterText
    } else {
      seed = JSON.stringify(starterParsed ?? {}, null, 2)
    }
    setValue(seed)
    setPrimed(true)
  }, [primed, isLoading, savedConfig, starterText, starterParsed])

  const saveMutation = useMutation({
    mutationFn: (cfg: Record<string, unknown>) => putMcpConfig(agentId, mcpName, cfg),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-mcp-config', agentId, mcpName] })
      onClose()
    },
    onError: (e) => {
      if (e instanceof ApiError) setError(e.message)
      else if (e instanceof Error) setError(e.message)
      else setError('Save failed')
    },
  })

  const handleSave = () => {
    setError(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(stripJsonc(value))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON')
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Top-level JSON must be an object (e.g. { ... }).')
      return
    }
    saveMutation.mutate(parsed as Record<string, unknown>)
  }

  const handleReset = () => {
    setError(null)
    if (starterText) {
      setValue(starterText)
    } else if (starterParsed) {
      setValue(JSON.stringify(starterParsed, null, 2))
    }
  }

  const hasStarter = !!(starterText || starterParsed)

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-purple-600" />
          <h2 className="text-lg font-bold text-gray-900">
            Configure <span className="font-mono text-purple-700">{mcpName}</span>
          </h2>
        </div>

        <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
          <div className="p-3 border border-purple-100 bg-purple-50 rounded-lg text-xs text-purple-900 flex gap-2">
            <Sparkles className="w-4 h-4 text-purple-600 flex-shrink-0 mt-0.5" />
            <p>
              <code className="font-mono">{'//'}</code> and <code className="font-mono">{'/* … */'}</code> comments
              are allowed (stripped on Save). Use <code className="font-mono">${'{VAR}'}</code> for secrets — set the
              env var on that computer before starting the agent (e.g.{' '}
              <code className="font-mono">export MAILBOX_PASSWORD=…</code>).
            </p>
          </div>

          {isFreshConfig && (
            <div className="p-3 border border-amber-200 bg-amber-50 rounded-lg text-xs text-amber-900 flex gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p>
                Saving will replace the entire <code className="font-mono">{mcpName}</code> slice in this agent&rsquo;s{' '}
                <code className="font-mono">config.json</code>. Other MCPs&rsquo; slices and any hand-edited keys
                outside MCP namespaces are left untouched.
              </p>
            </div>
          )}

          {error && (
            <div className="p-3 border border-red-200 bg-red-50 rounded-lg text-xs text-red-700 font-mono whitespace-pre-wrap">
              {error}
            </div>
          )}

          <JsonConfigEditor
            value={value}
            onChange={(next) => {
              setValue(next)
              if (error) setError(null)
            }}
            isLoading={isLoading}
          />
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {hasStarter && (
              <button
                type="button"
                onClick={handleReset}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 bg-white hover:border-gray-300"
              >
                Reset to starter
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg border border-gray-200 text-gray-700 bg-white hover:border-gray-300"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-accent text-white border border-accent hover:bg-accent-deep disabled:opacity-50"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
