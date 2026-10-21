import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Package } from 'lucide-react'
import { b64ByteLength, getKnowledgePacks } from '../../api/endpoints/knowledgePacks'

interface Props {
  value: string[]
  onChange: (next: string[]) => void
}

/**
 * Simple install/uninstall list for the user's own knowledge packs.
 *
 * Mirrors the SkillCatalog UX (tile per item, "+ Add" / "✓ Added" toggle) but
 * skips the catalog tabs / search since a user's pack count is small. Packs
 * are owner-scoped — only the agent owner's own packs are available to
 * install on the agent.
 */
export default function KnowledgePackList({ value, onChange }: Props) {
  const { data: packs = [], isLoading } = useQuery({
    queryKey: ['knowledge-packs'],
    queryFn: () => getKnowledgePacks(),
  })

  const isAdded = (slug: string) => value.includes(slug)
  const toggle = (slug: string) => {
    if (isAdded(slug)) onChange(value.filter((s) => s !== slug))
    else onChange([...value, slug])
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-24">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent" />
      </div>
    )
  }

  if (packs.length === 0) {
    return (
      <div className="text-center text-sm text-gray-500 py-6">
        <Package className="mx-auto w-6 h-6 text-gray-300 mb-2" />
        <p>You don't have any knowledge packs yet.</p>
        <p className="mt-1">
          <Link to="/settings" className="text-purple-600 hover:text-purple-700 underline underline-offset-2">
            Create one
          </Link>{' '}
          from a chat message, a learnings page, or by writing markdown directly.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {packs.map((pack) => {
          const added = isAdded(pack.slug)
          return (
            <div
              key={pack.slug}
              className={`relative flex flex-col gap-1.5 p-4 rounded-xl border transition-colors text-left ${
                added ? 'border-purple-300 bg-purple-50/30' : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">{pack.name}</h3>
                  <p className="text-[11px] font-mono text-gray-400">{pack.slug}</p>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(pack.slug)}
                  className={`shrink-0 px-2.5 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
                    added
                      ? 'bg-accent text-white border-accent hover:bg-accent-deep'
                      : 'bg-white text-gray-700 border-gray-200 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700'
                  }`}
                >
                  {added ? '✓ Added' : '+ Add'}
                </button>
              </div>
              {pack.description && (
                <p className="text-xs text-gray-500 leading-snug line-clamp-3">{pack.description}</p>
              )}
              <p className="mt-1 text-[10.5px] font-mono text-gray-400">
                {Object.keys(pack.files).length} file(s) ·{' '}
                {Object.values(pack.files).reduce((acc, f) => acc + b64ByteLength(f.content_b64), 0)}B
              </p>
            </div>
          )
        })}
      </div>
      <p className="text-xs text-gray-500">
        Manage your packs in{' '}
        <Link to="/settings" className="text-purple-600 hover:text-purple-700 underline underline-offset-2">
          knowledge pack settings
        </Link>
        .
      </p>
    </div>
  )
}
