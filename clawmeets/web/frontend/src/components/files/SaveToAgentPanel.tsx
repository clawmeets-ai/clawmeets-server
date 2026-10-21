import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, FolderPlus, Loader2, Search, WifiOff, X } from 'lucide-react'
import { useAgents } from '../../hooks/useAgents'
import { useProject } from '../../hooks/useProjects'
import { useAuthStore } from '../../stores/authStore'
import { downloadFileAsBlob } from '../../api/endpoints/files'
import { ensureOwnDMProject, sendDMMessage } from '../../api/endpoints/dm'
import {
  FS_MAX_CONTENT_BYTES,
  deleteAgentEntry,
  downloadAgentFile,
  fsFailure,
  isRunnerUnavailable,
  joinFsPath,
  listAgentFolder,
  makeAgentFolder,
  mutationResultUnknown,
  writeAgentFile,
} from '../../api/endpoints/agentFs'
import { EntryIcon } from '../homefs/HomeFolderBrowser'
import { agentViewPath } from '../agent/AgentViewActions'
import { displayName } from '../../utils/agentDisplay'
import { AgentStatus, type AgentCard } from '../../types'

/**
 * "Save to agent": copy a chatroom file into one of the owner's agents' home
 * folders, through the same runner-relayed fs routes as the home-folder
 * browser. Every path rule (locked system folders, no writes at the top level)
 * is the runner's; this panel only mirrors what each listing says is writable.
 *
 * The folder is re-listed just before writing, so a file that appeared since
 * the panel last looked still gets the "already exists" choice instead of
 * being silently replaced.
 */

/** The folder a fresh pick of an agent opens at, when it has one. */
const DEFAULT_FOLDER = 'storage'
const LAST_FOLDER_KEY = 'clawmeets.saveToAgent.lastFolder'

type ConflictMode = 'keep-both' | 'replace'

/** What one save did, so Undo can put it back. */
interface SavedResult {
  agent: AgentCard
  path: string
  /** The bytes that were there before a Replace; null when the file was new. */
  previous: Blob | null
}

function readLastFolders(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_FOLDER_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function rememberFolder(agentId: string, path: string) {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, JSON.stringify({ ...readLastFolders(), [agentId]: path }))
  } catch {
    // Private mode / full storage: the panel just opens at the default next time.
  }
}

/** Same refusals as the home-folder browser; the runner checks again regardless. */
export function invalidFileName(name: string): string | null {
  if (!name.trim()) return 'A name is required.'
  if (name === '.' || name === '..') return `"${name}" is not a valid name.`
  if (/[/\\]/.test(name)) return 'A name cannot contain / or \\.'
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A name cannot contain control characters.'
  return null
}

/** `report.csv` → `report (1).csv`, the first `(n)` not in `taken`. */
export function keepBothName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

function isOnline(agent: AgentCard): boolean {
  return agent.status !== AgentStatus.OFFLINE
}

interface Props {
  projectId: string
  chatroomName: string
  filename: string
  onClose: () => void
}

export default function SaveToAgentPanel({ projectId, chatroomName, filename, onClose }: Props) {
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const { data: allAgents } = useAgents()
  const { data: project } = useProject(projectId)

  const [agent, setAgent] = useState<AgentCard | null>(null)
  const [pickerOpen, setPickerOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [path, setPath] = useState('')
  const [name, setName] = useState(() => filename.slice(filename.lastIndexOf('/') + 1))
  const [conflictMode, setConflictMode] = useState<ConflictMode>('keep-both')
  const [tellAgent, setTellAgent] = useState(true)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedResult | null>(null)

  // The owner's own agents, the ones already in this project first.
  const { inProject, others } = useMemo(() => {
    const own = (allAgents ?? []).filter((a) => !!user && a.registered_by === user.id)
    const q = query.trim().toLowerCase()
    const matched = q ? own.filter((a) => displayName(a, user).toLowerCase().includes(q)) : own
    const members = new Set(project?.participating_agents ?? [])
    return {
      inProject: matched.filter((a) => members.has(a.id)),
      others: matched.filter((a) => !members.has(a.id)),
    }
  }, [allAgents, user, query, project])

  const agentOnline = !!agent && isOnline(agent)
  const listing = useQuery({
    queryKey: ['agent-fs', agent?.id ?? '', 'list', path],
    queryFn: () => listAgentFolder(agent!.id, path),
    enabled: agentOnline,
    staleTime: 0,
    retry: false,
  })
  const unavailable = !!agent && (!agentOnline || (listing.error && isRunnerUnavailable(listing.error)))

  const label = agent ? displayName(agent, user) : ''
  const entries = listing.data?.entries ?? []
  const taken = useMemo(() => new Set(entries.map((e) => e.name)), [entries])
  const nameError = invalidFileName(name)
  const clash = !nameError && taken.has(name)
  const finalName = clash && conflictMode === 'keep-both' ? keepBothName(name, taken) : name
  const folderWritable = path !== '' && !!listing.data?.writable

  const pickAgent = async (next: AgentCard) => {
    setAgent(next)
    setPickerOpen(false)
    setError(null)
    setNewFolder(null)
    const last = readLastFolders()[next.id]
    if (last !== undefined) {
      setPath(last)
      return
    }
    // First time for this agent: storage/ when it has one, otherwise the top
    // level, from which the owner picks a folder.
    setPath('')
    if (!isOnline(next)) return
    try {
      const home = await queryClient.fetchQuery({
        queryKey: ['agent-fs', next.id, 'list', ''],
        queryFn: () => listAgentFolder(next.id, ''),
        staleTime: 0,
      })
      if (home.entries.some((e) => e.type === 'dir' && e.name === DEFAULT_FOLDER && e.writable)) setPath(DEFAULT_FOLDER)
    } catch {
      // The listing below shows why.
    }
  }

  const createFolder = async () => {
    if (!agent || newFolder === null) return
    const problem = invalidFileName(newFolder)
    if (problem) {
      setError(problem)
      return
    }
    const target = joinFsPath(path, newFolder.trim())
    setError(null)
    try {
      await makeAgentFolder(agent.id, target)
      setNewFolder(null)
      setPath(target)
    } catch (err) {
      setError(fsFailure(err).message)
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['agent-fs', agent.id, 'list'] })
    }
  }

  const save = async () => {
    if (!agent || nameError || !folderWritable) return
    setSaving(true)
    setError(null)
    try {
      // Re-list: a file of this name may have appeared since the folder was shown.
      const fresh = await listAgentFolder(agent.id, path)
      queryClient.setQueryData(['agent-fs', agent.id, 'list', path], fresh)
      const freshTaken = new Set(fresh.entries.map((e) => e.name))
      if (freshTaken.has(name) && !clash) {
        setError(`"${name}" was just created in this folder. Choose what to do, then save again.`)
        return
      }
      const target = joinFsPath(
        path,
        freshTaken.has(name) && conflictMode === 'keep-both' ? keepBothName(name, freshTaken) : name,
      )
      const content = await downloadFileAsBlob(projectId, chatroomName, filename)
      if (content.size > FS_MAX_CONTENT_BYTES) {
        setError(`This file is larger than ${FS_MAX_CONTENT_BYTES / (1024 * 1024)} MB, the most an agent folder accepts.`)
        return
      }
      const previous = freshTaken.has(name) && conflictMode === 'replace' ? await downloadAgentFile(agent.id, target) : null
      await writeAgentFile(agent.id, target, content)
      rememberFolder(agent.id, path)
      setSaved({ agent, path: target, previous })
      if (tellAgent) {
        // The note is best-effort: the file is saved whether or not it lands.
        void ensureOwnDMProject(agent.name)
          .then((dm) =>
            sendDMMessage(
              dm.id,
              'user-communication',
              `I saved \`${filename}\` into your home folder at \`${target}\`. No action needed — just so you know it's there.`,
            ),
          )
          .catch(() => undefined)
      }
    } catch (err) {
      if (mutationResultUnknown(err)) {
        setError(`No answer from @${label} — the file may or may not have been saved. Check the folder before saving again.`)
      } else {
        setError(fsFailure(err).message)
      }
    } finally {
      setSaving(false)
      await queryClient.invalidateQueries({ queryKey: ['agent-fs', agent.id, 'list'] })
    }
  }

  const undo = async () => {
    if (!saved) return
    setSaving(true)
    try {
      if (saved.previous) await writeAgentFile(saved.agent.id, saved.path, saved.previous)
      else await deleteAgentEntry(saved.agent.id, saved.path)
      setSaved(null)
    } catch (err) {
      setError(`Undo failed: ${fsFailure(err).message}`)
    } finally {
      setSaving(false)
      await queryClient.invalidateQueries({ queryKey: ['agent-fs', saved.agent.id, 'list'] })
    }
  }

  const header = (
    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
      <h3 className="text-sm font-semibold text-gray-900">Save to agent</h3>
      <button
        type="button"
        onClick={onClose}
        className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
        aria-label="Close save panel"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )

  if (saved) {
    const folder = saved.path.slice(0, saved.path.lastIndexOf('/'))
    return (
      <aside className="w-80 shrink-0 border-l border-gray-200 flex flex-col" aria-label="Save to agent">
        {header}
        <div className="p-4 space-y-3 text-sm" role="status">
          <p className="flex items-start gap-2 text-gray-800">
            <Check className="w-4 h-4 mt-0.5 text-green-600 shrink-0" />
            <span>
              Saved to <code className="break-all">@{displayName(saved.agent, user)}/{saved.path}</code>
            </span>
          </p>
          {error && <p className="text-red-600">{error}</p>}
          <div className="flex gap-4">
            <Link
              to={agentViewPath(saved.agent, 'home', folder)}
              className="text-accent-deep hover:underline"
            >
              Open in folder
            </Link>
            <button type="button" onClick={() => void undo()} disabled={saving} className="text-accent-deep hover:underline disabled:opacity-50">
              {saving ? 'Undoing…' : 'Undo'}
            </button>
          </div>
        </div>
      </aside>
    )
  }

  const segments = path ? path.split('/') : []
  const renderAgent = (a: AgentCard) => (
    <li key={a.id}>
      <button
        type="button"
        onClick={() => void pickAgent(a)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-gray-100"
      >
        <span className={`w-2 h-2 rounded-full ${isOnline(a) ? 'bg-green-500' : 'bg-gray-300'}`} aria-hidden />
        <span className="truncate">@{displayName(a, user)}</span>
        {!isOnline(a) && <span className="ml-auto text-xs text-gray-400">offline</span>}
      </button>
    </li>
  )

  return (
    <aside className="w-80 shrink-0 border-l border-gray-200 flex flex-col overflow-hidden" aria-label="Save to agent">
      {header}
      <div className="flex-1 overflow-auto p-4 space-y-5 text-sm">
        {/* Agent */}
        <section>
          <div className="text-xs font-medium text-gray-500 uppercase mb-1">Agent</div>
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-2 py-1.5 border border-gray-300 rounded text-left"
            aria-expanded={pickerOpen}
          >
            {agent ? (
              <>
                <span className={`w-2 h-2 rounded-full ${agentOnline ? 'bg-green-500' : 'bg-gray-300'}`} aria-hidden />
                <span className="truncate">@{label}</span>
              </>
            ) : (
              <span className="text-gray-400">Choose an agent</span>
            )}
            <ChevronDown className="w-4 h-4 ml-auto text-gray-400" />
          </button>
          {pickerOpen && (
            <div className="mt-1 border border-gray-200 rounded p-1">
              <div className="flex items-center gap-1 px-2 py-1">
                <Search className="w-3.5 h-3.5 text-gray-400" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search your agents"
                  className="flex-1 outline-none text-sm"
                  aria-label="Search agents"
                />
              </div>
              <div className="max-h-56 overflow-auto">
                {inProject.length > 0 && (
                  <>
                    <div className="px-2 pt-1 text-xs text-gray-400">In this project</div>
                    <ul>{inProject.map(renderAgent)}</ul>
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <div className="px-2 pt-1 text-xs text-gray-400">Your agents</div>
                    <ul>{others.map(renderAgent)}</ul>
                  </>
                )}
                {inProject.length + others.length === 0 && <p className="px-2 py-1 text-gray-400">No matching agents</p>}
              </div>
            </div>
          )}
        </section>

        {agent && unavailable && (
          <div className="flex items-start gap-2 p-3 rounded bg-gray-50 text-gray-600" role="alert">
            <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
            <p>
              @{label} is offline. Files are saved by the agent's own runner. Start it, or pick another agent.
            </p>
          </div>
        )}

        {agent && !unavailable && (
          <>
            {/* Folder */}
            <section>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-500 uppercase">Folder</span>
                {listing.data?.writable && newFolder === null && (
                  <button
                    type="button"
                    onClick={() => setNewFolder('')}
                    className="flex items-center gap-1 text-xs text-accent-deep hover:underline"
                  >
                    <FolderPlus className="w-3.5 h-3.5" /> New folder
                  </button>
                )}
              </div>
              <nav className="flex flex-wrap items-center gap-0.5 text-xs text-gray-600 mb-1" aria-label="Folder path">
                <button type="button" onClick={() => setPath('')} className="hover:underline">
                  @{label}
                </button>
                {segments.map((seg, i) => (
                  <span key={i} className="flex items-center gap-0.5">
                    <ChevronRight className="w-3 h-3 text-gray-400" />
                    <button type="button" onClick={() => setPath(segments.slice(0, i + 1).join('/'))} className="hover:underline">
                      {seg}
                    </button>
                  </span>
                ))}
              </nav>
              <div className="border border-gray-200 rounded max-h-56 overflow-auto">
                {newFolder !== null && (
                  <div className="flex items-center gap-1 px-2 py-1 border-b border-gray-100">
                    <EntryIcon type="dir" locked={false} />
                    <input
                      autoFocus
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createFolder()
                        if (e.key === 'Escape') {
                          e.stopPropagation()
                          setNewFolder(null)
                        }
                      }}
                      placeholder="Folder name"
                      className="flex-1 outline-none text-sm"
                      aria-label="New folder name"
                    />
                    <button type="button" onClick={() => void createFolder()} className="text-xs text-accent-deep">
                      Create
                    </button>
                  </div>
                )}
                {listing.isLoading ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading…
                  </div>
                ) : listing.error ? (
                  <p className="px-2 py-2 text-red-600">{fsFailure(listing.error).message}</p>
                ) : (
                  <ul>
                    {entries
                      .filter((e) => e.type === 'dir')
                      .map((e) => (
                        <li key={e.name}>
                          <button
                            type="button"
                            disabled={!e.writable}
                            onClick={() => setPath(joinFsPath(path, e.name))}
                            className="w-full flex items-center gap-2 px-2 py-1 text-left hover:bg-gray-100 disabled:hover:bg-transparent disabled:text-gray-400 disabled:cursor-not-allowed"
                            title={e.writable ? undefined : 'Read-only folder'}
                          >
                            <EntryIcon type="dir" locked={!e.writable} />
                            <span className="truncate">{e.name}</span>
                            {!e.writable && <span className="ml-auto text-xs">read-only</span>}
                          </button>
                        </li>
                      ))}
                    {entries
                      .filter((e) => e.type === 'file')
                      .map((e) => (
                        <li key={e.name} className="flex items-center gap-2 px-2 py-1 text-gray-400">
                          <EntryIcon type="file" locked={false} />
                          <span className="truncate">{e.name}</span>
                        </li>
                      ))}
                    {entries.length === 0 && newFolder === null && (
                      <li className="px-2 py-2 text-gray-400">Empty folder — the file will be saved here.</li>
                    )}
                  </ul>
                )}
              </div>
              {path === '' && (
                <p className="mt-1 text-xs text-gray-500">Pick a folder — files can't go directly in the top level.</p>
              )}
            </section>

            {/* Name */}
            <section>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-1" htmlFor="save-to-agent-name">
                File name
              </label>
              <input
                id="save-to-agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`w-full px-2 py-1.5 border rounded outline-none ${nameError ? 'border-red-400' : 'border-gray-300'}`}
              />
              {nameError && <p className="mt-1 text-xs text-red-600">{nameError}</p>}
              {clash && (
                <div className="mt-2 p-2 rounded bg-amber-50 border border-amber-200 text-xs space-y-1" role="group" aria-label="Name clash">
                  <p className="text-amber-800">"{name}" already exists in this folder.</p>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      checked={conflictMode === 'keep-both'}
                      onChange={() => setConflictMode('keep-both')}
                    />
                    Keep both (saves as "{keepBothName(name, taken)}")
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" checked={conflictMode === 'replace'} onChange={() => setConflictMode('replace')} />
                    Replace it
                  </label>
                </div>
              )}
            </section>

            <label className="flex items-start gap-2 text-gray-700">
              <input type="checkbox" checked={tellAgent} onChange={(e) => setTellAgent(e.target.checked)} className="mt-0.5" />
              <span>Tell @{label} in its DM that the file is there</span>
            </label>

            {!nameError && path !== '' && (
              <div className="text-xs text-gray-500">
                Will be saved as
                <code className="block mt-0.5 text-gray-800 break-all">@{label}/{joinFsPath(path, finalName)}</code>
              </div>
            )}
          </>
        )}

        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded hover:bg-gray-100">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!agent || !!unavailable || !!nameError || !folderWritable || saving}
          className="px-3 py-1.5 text-sm rounded bg-accent hover:bg-accent-deep text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {clash && conflictMode === 'replace' ? 'Replace' : 'Save'}
        </button>
      </div>
    </aside>
  )
}
