import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Package, Sparkles } from 'lucide-react'
import {
  createKnowledgePack,
  encodeTextToB64,
  getKnowledgePacks,
  upsertKnowledgePackFile,
} from '../../api/endpoints/knowledgePacks'
import { ApiError } from '../../api/client'

interface Props {
  /** Pre-filled markdown body — typically the chat message text the user is saving. */
  initialContent: string
  onClose: () => void
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function suggestFilename(content: string): string {
  // First non-empty markdown header line, else first non-empty line, else
  // a date-stamped fallback.
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
  const headerLine = lines.find((l) => l.startsWith('#'))
  const seed = (headerLine ?? lines[0] ?? `saved-${new Date().toISOString().slice(0, 10)}`)
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${seed || `saved-${new Date().toISOString().slice(0, 10)}`}.md`
}

/**
 * Modal launched from the message hover affordance.
 *
 * Saves the chat message as a NEW FILE inside an existing or new pack. The
 * user picks the pack and (optionally) the filename — auto-suggested from
 * the first markdown heading or line. No more "append to a single content
 * blob" — packs hold multiple files now.
 */
export default function SaveToPackModal({ initialContent, onClose }: Props) {
  const queryClient = useQueryClient()
  const { data: packs = [] } = useQuery({
    queryKey: ['knowledge-packs'],
    queryFn: () => getKnowledgePacks(),
  })

  const [mode, setMode] = useState<'existing' | 'new'>(packs.length > 0 ? 'existing' : 'new')
  useEffect(() => {
    if (mode === 'existing' && packs.length === 0) setMode('new')
  }, [mode, packs.length])

  const suggestedFilename = useMemo(() => suggestFilename(initialContent), [initialContent])

  // Existing-pack mode
  const [targetSlug, setTargetSlug] = useState<string>('')
  useEffect(() => {
    if (mode === 'existing' && !targetSlug && packs.length > 0) setTargetSlug(packs[0].slug)
  }, [mode, targetSlug, packs])

  // New-pack mode
  const [packName, setPackName] = useState('')
  const [packSlug, setPackSlug] = useState('')
  const [packDescription, setPackDescription] = useState('')
  const [packSlugTouched, setPackSlugTouched] = useState(false)
  useEffect(() => {
    if (!packSlugTouched) setPackSlug(suggestSlug(packName))
  }, [packName, packSlugTouched])

  // Shared
  const [filename, setFilename] = useState(suggestedFilename)
  const [fileDescription, setFileDescription] = useState('')
  const [content, setContent] = useState(initialContent)
  const [error, setError] = useState('')
  const [successInfo, setSuccessInfo] = useState<{ slug: string; mode: 'upsert' | 'create' } | null>(null)

  const upsertMutation = useMutation({
    mutationFn: () =>
      upsertKnowledgePackFile(targetSlug, filename, encodeTextToB64(content), fileDescription),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-packs'] })
      queryClient.invalidateQueries({ queryKey: ['agent-knowledge-packs'] })
      setSuccessInfo({ slug: targetSlug, mode: 'upsert' })
    },
    onError: (e: Error) => setError(e instanceof ApiError ? e.message : String(e)),
  })

  const createAndUpsertMutation = useMutation({
    mutationFn: async () => {
      await createKnowledgePack({
        slug: packSlug,
        name: packName,
        description: packDescription,
        files: {
          [filename]: { content_b64: encodeTextToB64(content), description: fileDescription },
        },
      })
      // Pack created with the file inline — no separate upsert needed.
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-packs'] })
      queryClient.invalidateQueries({ queryKey: ['agent-knowledge-packs'] })
      setSuccessInfo({ slug: packSlug, mode: 'create' })
    },
    onError: (e: Error) => setError(e instanceof ApiError ? e.message : String(e)),
  })

  const isPending = upsertMutation.isPending || createAndUpsertMutation.isPending

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!FILENAME_RE.test(filename)) {
      setError(
        'Filename must start with a letter or digit and contain only letters, digits, dots, hyphens, and underscores',
      )
      return
    }
    if (mode === 'existing') {
      if (!targetSlug) {
        setError('Pick a pack.')
        return
      }
      upsertMutation.mutate()
      return
    }
    if (!packName.trim()) {
      setError('Pack name is required')
      return
    }
    if (!SLUG_RE.test(packSlug)) {
      setError('Pack slug must start with [a-z0-9] and contain only lowercase letters, digits, hyphens, and underscores')
      return
    }
    createAndUpsertMutation.mutate()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2">
          <Package className="w-4 h-4 text-purple-600" />
          <h2 className="text-lg font-bold text-gray-900">Save to knowledge pack</h2>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div className="p-3 border border-purple-100 bg-purple-50 rounded-lg text-xs text-purple-900 flex gap-2">
            <Sparkles className="w-4 h-4 text-purple-600 flex-shrink-0 mt-0.5" />
            <p>
              <span className="font-semibold">Knowledge packs bundle useful notes.</span>{' '}
              Once saved, any of your agents can install a pack instantly and learn from it as authoritative memory.
            </p>
          </div>

          {error && (
            <div className="p-3 border border-red-200 bg-red-50 rounded-lg text-xs text-red-700">{error}</div>
          )}
          {successInfo && (
            <div className="p-3 border border-emerald-200 bg-emerald-50 rounded-lg text-xs text-emerald-800">
              {successInfo.mode === 'create' ? (
                <>Saved to &lsquo;<span className="font-semibold">{successInfo.slug}</span>&rsquo;! Install it on an agent from </>
              ) : (
                <>Saved! Install &lsquo;<span className="font-semibold">{successInfo.slug}</span>&rsquo; on an agent from </>
              )}
              <Link
                to="/settings"
                onClick={onClose}
                className="font-semibold underline decoration-emerald-400 hover:decoration-emerald-700"
              >
                Account Settings → Knowledge Packs
              </Link>
              {' '}to make them learn from it.
            </div>
          )}

          {packs.length > 0 && (
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setMode('existing')}
                className={`px-3 py-1.5 rounded-full border font-semibold transition-colors ${
                  mode === 'existing'
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                }`}
              >
                Add file to existing pack
              </button>
              <button
                type="button"
                onClick={() => setMode('new')}
                className={`px-3 py-1.5 rounded-full border font-semibold transition-colors ${
                  mode === 'new'
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                }`}
              >
                Create new pack
              </button>
            </div>
          )}

          {mode === 'existing' ? (
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1.5">Pack</label>
              <select
                value={targetSlug}
                onChange={(e) => setTargetSlug(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 bg-white"
              >
                {packs.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.name} ({p.slug}) — {Object.keys(p.files).length} file(s)
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1.5">Pack name</label>
                <input
                  type="text"
                  value={packName}
                  onChange={(e) => setPackName(e.target.value)}
                  placeholder="Wine recommendations"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1.5">Pack slug</label>
                <input
                  type="text"
                  value={packSlug}
                  onChange={(e) => {
                    setPackSlug(e.target.value)
                    setPackSlugTouched(true)
                  }}
                  placeholder="wine-recommendations"
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400"
                />
                <p className="mt-1 text-xs text-gray-500">
                  URL-safe id — used as the pack's folder name on each agent. Lowercase letters, digits, hyphens.
                </p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-1.5">
                  Description <span className="text-gray-400 font-normal">(one line)</span>
                </label>
                <input
                  type="text"
                  value={packDescription}
                  onChange={(e) => setPackDescription(e.target.value)}
                  placeholder="When to consult this pack"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Filename</label>
            <input
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="fine-dining-tactics.md"
              className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400"
            />
            <p className="mt-1 text-xs text-gray-500">
              Auto-suggested from the message's first heading or line. If a file with this name already exists in the
              pack, it will be replaced.
            </p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">
              When to consult <span className="text-gray-400 font-normal">(one line, optional)</span>
            </label>
            <input
              type="text"
              value={fileDescription}
              onChange={(e) => setFileDescription(e.target.value)}
              placeholder="e.g. consult before drafting a wine pairing"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400"
            />
            <p className="mt-1 text-xs text-gray-500">
              Shown per-file in the agent's pack index so it knows when to open this file.
            </p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Content (markdown)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={10}
              className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 resize-vertical"
            />
            <p className="mt-1 text-xs text-gray-500">{content.length} characters</p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            {successInfo ? (
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 text-sm font-bold text-white bg-accent rounded-lg hover:bg-accent-deep transition-colors"
              >
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-5 py-2 text-sm font-bold text-white bg-accent rounded-lg hover:bg-accent-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isPending ? 'Saving…' : mode === 'existing' ? 'Save file' : 'Create pack & save'}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
