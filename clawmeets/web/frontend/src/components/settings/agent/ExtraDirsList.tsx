import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { inputClass } from './fields'

/** Why a folder cannot be added, or null when it can. Empty is not an error —
 *  the button is simply disabled until something is typed. */
export function extraDirProblem(dir: string, dirs: string[]): string | null {
  if (!dir) return null
  if (dirs.includes(dir)) return 'Already added'
  return null
}

/**
 * The agent's extra directories as an add/remove list, laid out like the env
 * vars card. Unlike env vars these live on the shared settings draft, so an
 * add or remove only edits the draft — the page's Save bar sends it.
 */
export default function ExtraDirsList({
  id,
  dirs,
  onChange,
}: {
  id: string
  dirs: string[]
  onChange: (dirs: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const dir = draft.trim()
  const problem = extraDirProblem(dir, dirs)
  const canAdd = !!dir && !problem

  return (
    <div className="space-y-2">
      {dirs.length > 0 && (
        <ul className="space-y-1" aria-label="Extra directories">
          {dirs.map((d) => (
            <li key={d} className="flex items-center gap-2 rounded-md border border-gray-200 px-2.5 py-1 text-xs">
              <span className="flex-1 font-mono text-gray-800 break-all">{d}</span>
              <button
                type="button"
                aria-label={`Remove ${d}`}
                title={`Remove ${d}`}
                onClick={() => onChange(dirs.filter((x) => x !== d))}
                className="rounded p-0.5 text-gray-500 opacity-60 hover:opacity-100"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canAdd) return
          onChange([...dirs, dir])
          setDraft('')
        }}
      >
        <div className="flex-1">
          <input
            id={id}
            aria-label="Folder path"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="~/OpenMontage"
            autoComplete="off"
            spellCheck={false}
            className={`${inputClass} font-mono ${problem ? 'border-red-400' : ''}`}
          />
          {problem && <div className="text-[11px] mt-0.5 text-red-600">{problem}</div>}
        </div>
        <button
          type="submit"
          aria-label="Add folder"
          disabled={!canAdd}
          className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus size={12} /> Add
        </button>
      </form>
    </div>
  )
}
