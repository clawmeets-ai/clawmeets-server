import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Loader2,
  Lock,
  Pencil,
  Trash2,
  Upload,
  WifiOff,
} from 'lucide-react'
import MarkdownBody from '../shared/MarkdownBody'
import { BlobFilePreview, TextFilePreview, hasRenderedView, mimeForFilename } from '../files/FilePreview'
import { isBinaryFile } from '../../hooks/useFiles'
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
  parentFsPath,
  readAgentFile,
  writeAgentFile,
  type FsEntry,
  type FsFile,
  type FsTier,
} from '../../api/endpoints/agentFs'
import { ACCESS_ERROR_COPY } from '../../utils/agentAccessCopy'

/**
 * The agent's home folder, browsed on the agent's own runner: a tree on the
 * left, the selected folder's README or the selected file on the right.
 *
 * Every rule lives on the runner; this view only mirrors what the listing
 * says the signed-in caller may do — a read-only entry (`writable: false`)
 * gets a lock on its icon and no write controls, so the owner is never
 * offered a button the runner would refuse. A write, folder or delete that
 * gets no answer may still have happened, so it is reported as "result
 * unknown" and the folder is re-read, never reported as failed.
 */

/** The runner's link to the computer-wide shared folder. It opens as a folder,
 *  but the link itself can't be deleted (the runner refuses; we hide the button). */
const SHARED_STORAGE_PATH = 'shared_storage'

/** Text past this is not previewed (it can still be downloaded, up to the cap). */
export const PREVIEW_MAX_BYTES = 1024 * 1024

type Selection = { path: string; kind: 'dir' | 'file' }
type Notice = { tone: 'info' | 'error'; text: string }

const listKey = (agentId: string, path: string) => ['agent-fs', agentId, 'list', path]
const fileKey = (agentId: string, path: string) => ['agent-fs', agentId, 'file', path]
const blobKey = (agentId: string, path: string) => ['agent-fs', agentId, 'blob', path]

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** One name inside the current folder — separators, `.`/`..` and control
 *  characters are refused here so the owner gets a plain answer; the runner
 *  refuses them (and much more) regardless. */
function invalidName(name: string): string | null {
  if (!name) return 'A name is required.'
  if (name === '.' || name === '..') return `"${name}" is not a valid name.`
  if (/[/\\]/.test(name)) return 'A name cannot contain / or \\.'
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A name cannot contain control characters.'
  return null
}

function readOnlyLabel(tier: FsTier): string {
  switch (tier) {
    case 'secret':
      return 'Secret · read-only here (edit in Agent settings)'
    case 'system':
      return 'System-managed · read-only'
    case 'personal_skills':
      return 'Owner-editable · read-only for agents'
    default:
      return 'Read-only'
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function unavailableMessage(err: unknown, agentLabel: string): string {
  const f = fsFailure(err)
  if (f.code === 'remote_agent') return ACCESS_ERROR_COPY.remote_agent as string
  if (f.code === 'runner_too_old') {
    return `@${agentLabel}'s runner is too old to browse its home folder. Upgrade clawmeets on that machine and restart the runner.`
  }
  return `@${agentLabel} is offline, so its home folder can't be shown. Start its runner and try again.`
}

/** Re-read every cached listing at or under `path` (and the folder holding it). */
function refreshAround(queryClient: QueryClient, agentId: string, path: string) {
  return queryClient.invalidateQueries({
    predicate: (q) => {
      const [scope, id, kind, p] = q.queryKey as [string, string, string, string]
      if (scope !== 'agent-fs' || id !== agentId) return false
      if (kind === 'list') return p === parentFsPath(path) || p === path || p.startsWith(`${path}/`) || path === ''
      return p === path
    },
  })
}

/** An entry's icon, with the lock overlay when the caller can't change it. */
export function EntryIcon({ type, open, locked }: { type: FsEntry['type']; open?: boolean; locked: boolean }) {
  const Icon = type === 'dir' ? (open ? FolderOpen : Folder) : type === 'symlink' ? Link2 : FileIcon
  return (
    <span className="relative inline-flex shrink-0">
      <Icon className={`w-4 h-4 ${type === 'dir' ? 'text-amber-500' : 'text-gray-500'}`} aria-hidden />
      {locked && (
        <Lock
          className="absolute -bottom-1 -right-1 w-2.5 h-2.5 text-gray-700 bg-white rounded-sm"
          aria-label="read-only"
          data-testid="lock-overlay"
        />
      )}
    </span>
  )
}

function useListing(agentId: string, path: string, enabled = true) {
  return useQuery({
    queryKey: listKey(agentId, path),
    queryFn: () => listAgentFolder(agentId, path),
    enabled,
    staleTime: 0,
    retry: false,
  })
}

interface TreeFolderProps {
  agentId: string
  path: string
  depth: number
  expanded: Set<string>
  selected: Selection
  onSelect: (sel: Selection) => void
  onToggle: (path: string) => void
}

function TreeFolder({ agentId, path, depth, expanded, selected, onSelect, onToggle }: TreeFolderProps) {
  const { data, error, isLoading } = useListing(agentId, path)
  const indent = { paddingLeft: `${depth * 14 + 8}px` }
  if (isLoading) {
    return (
      <div className="py-1 text-xs text-gray-400" style={indent}>
        <Loader2 className="inline w-3 h-3 animate-spin" /> Loading…
      </div>
    )
  }
  if (error) {
    // The root's unavailability is shown once, above the tree.
    if (path === '' && (isRunnerUnavailable(error) || fsFailure(error).code === 'remote_agent')) return null
    return (
      <div className="py-1 text-xs text-red-600" style={indent}>
        {fsFailure(error).message}
      </div>
    )
  }
  if (!data) return null
  return (
    <ul role="group">
      {data.entries.map((entry) => {
        // A name that is not a single path component (the runner lists it
        // locked) would join into a different path — show it, never open it.
        if (invalidName(entry.name)) {
          return (
            <li key={entry.name} role="treeitem" aria-disabled="true">
              <div className="flex items-center gap-1.5 py-1 pr-2 text-sm text-gray-400 truncate" style={indent}>
                <span className="w-3 shrink-0" />
                <EntryIcon type={entry.type} open={false} locked />
                <span className="truncate">{entry.name}</span>
              </div>
            </li>
          )
        }
        const childPath = joinFsPath(path, entry.name)
        const isDir = entry.type === 'dir'
        const isOpen = isDir && expanded.has(childPath)
        const isSelected = selected.path === childPath
        return (
          <li key={entry.name} role="treeitem" aria-expanded={isDir ? isOpen : undefined} aria-selected={isSelected}>
            <button
              type="button"
              onClick={() => {
                if (isDir) {
                  onSelect({ path: childPath, kind: 'dir' })
                  onToggle(childPath)
                } else {
                  onSelect({ path: childPath, kind: 'file' })
                }
              }}
              className={`w-full flex items-center gap-1.5 py-1 pr-2 text-left text-sm truncate hover:bg-sidebar-hover ${
                isSelected ? 'bg-purple-50 text-accent-deep' : 'text-gray-800'
              }`}
              style={indent}
              title={childPath}
            >
              {isDir ? (
                isOpen ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <EntryIcon type={entry.type} open={isOpen} locked={!entry.writable} />
              <span className="truncate">{entry.name}</span>
            </button>
            {isOpen && (
              <TreeFolder
                agentId={agentId}
                path={childPath}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            )}
          </li>
        )
      })}
      {data.truncated && (
        <li className="py-1 text-xs text-gray-400" style={indent}>
          Too many entries — only the first {data.entries.length} are shown.
        </li>
      )}
      {data.entries.length === 0 && (
        <li className="py-1 text-xs text-gray-400" style={indent}>
          Empty folder
        </li>
      )}
    </ul>
  )
}

function HeaderButton({
  onClick,
  icon,
  label,
  danger,
  disabled,
}: {
  onClick: () => void
  icon: ReactNode
  label: string
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-sm border border-gray-200 disabled:opacity-50 ${
        danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-sidebar-hover'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

interface PaneProps {
  agentId: string
  path: string
  busy: boolean
  mutate: (work: () => Promise<unknown>, around: string, onDone?: () => void) => Promise<boolean>
  onSelect: (sel: Selection) => void
}

function FolderPane({ agentId, path, busy, mutate, onSelect, onExpand }: PaneProps & { onExpand: (path: string) => void }) {
  const { data: listing, error } = useListing(agentId, path)
  const uploadRef = useRef<HTMLInputElement>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const readme = listing?.entries.find((e) => e.type === 'file' && e.name.toLowerCase() === 'readme.md')
  const readmePath = readme ? joinFsPath(path, readme.name) : ''
  const readmeQuery = useQuery({
    queryKey: fileKey(agentId, readmePath),
    queryFn: () => readAgentFile(agentId, readmePath),
    enabled: !!readme && readme.readable && readme.size <= PREVIEW_MAX_BYTES,
    staleTime: 0,
    retry: false,
  })
  const writable = !!listing?.writable
  const title = path ? `/${path}` : '/ (home folder)'

  const askName = (what: string): string | null => {
    const name = window.prompt(`Name of the new ${what} in ${title}:`)?.trim() ?? ''
    if (!name) return null
    const problem = invalidName(name)
    if (problem) {
      window.alert(problem)
      return null
    }
    if (listing?.entries.some((e) => e.name === name)) {
      window.alert(`"${name}" already exists in this folder.`)
      return null
    }
    return name
  }

  const newFile = () => {
    setAddMenuOpen(false)
    const name = askName('file')
    if (!name) return
    const target = joinFsPath(path, name)
    void mutate(() => writeAgentFile(agentId, target, new Blob([])), target, () =>
      onSelect({ path: target, kind: 'file' }),
    )
  }

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    const tooBig = files.filter((f) => f.size > FS_MAX_CONTENT_BYTES)
    if (tooBig.length > 0) {
      window.alert(`Files over ${formatSize(FS_MAX_CONTENT_BYTES)} can't be uploaded: ${tooBig.map((f) => f.name).join(', ')}`)
      return
    }
    const bad = files.map((f) => invalidName(f.name)).find(Boolean)
    if (bad) {
      window.alert(bad)
      return
    }
    const existing = files.filter((f) => listing?.entries.some((x) => x.name === f.name)).map((f) => f.name)
    if (existing.length > 0 && !window.confirm(`Replace ${existing.join(', ')} in ${title}?`)) return
    // One file per call; stop at the first one that doesn't land, so the owner
    // is never told N files arrived when some did not.
    await mutate(async () => {
      for (const f of files) await writeAgentFile(agentId, joinFsPath(path, f.name), f)
    }, joinFsPath(path, files[0].name))
  }

  const newFolder = () => {
    const name = askName('folder')
    if (!name) return
    const target = joinFsPath(path, name)
    void mutate(() => makeAgentFolder(agentId, target), target, () => onExpand(path))
  }

  const remove = () => {
    if (!window.confirm(`Delete the folder ${title} and everything in it? This cannot be undone.`)) return
    void mutate(() => deleteAgentEntry(agentId, path), path, () => onSelect({ path: parentFsPath(path), kind: 'dir' }))
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <EntryIcon type="dir" open locked={!!listing && !writable} />
        <h3 className="font-mono text-sm truncate flex-1" title={title}>
          {title}
        </h3>
        {listing && !writable && <span className="text-xs text-gray-500">{readOnlyLabel(listing.tier)}</span>}
        {writable && (
          <div className="flex items-center gap-1">
            <div className="relative">
              <HeaderButton
                onClick={() => setAddMenuOpen((v) => !v)}
                icon={<FilePlus className="w-4 h-4" />}
                label="Add file"
                disabled={busy}
              />
              {addMenuOpen && (
                <div className="absolute right-0 mt-1 w-44 rounded-md border border-gray-200 bg-white shadow-md z-10" role="menu">
                  <button type="button" role="menuitem" onClick={newFile} className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-sidebar-hover">
                    <FilePlus className="w-4 h-4" /> New file
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAddMenuOpen(false)
                      uploadRef.current?.click()
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-sidebar-hover"
                  >
                    <Upload className="w-4 h-4" /> Upload files…
                  </button>
                </div>
              )}
              <input ref={uploadRef} type="file" multiple className="hidden" onChange={upload} data-testid="fs-upload-input" />
            </div>
            <HeaderButton onClick={newFolder} icon={<FolderPlus className="w-4 h-4" />} label="Add folder" disabled={busy} />
            {path !== '' && path !== SHARED_STORAGE_PATH && (
              <HeaderButton onClick={remove} icon={<Trash2 className="w-4 h-4" />} label="Delete" danger disabled={busy} />
            )}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto px-6 py-4">
        {error ? (
          <p className="text-sm text-red-600">{fsFailure(error).message}</p>
        ) : !listing ? (
          <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
        ) : !readme ? (
          <p className="text-sm text-gray-500">This folder has no README.md.</p>
        ) : readmeQuery.error ? (
          <p className="text-sm text-red-600">{fsFailure(readmeQuery.error).message}</p>
        ) : !readme.readable || readme.size > PREVIEW_MAX_BYTES ? (
          <p className="text-sm text-gray-500">This folder's README.md can't be shown here.</p>
        ) : readmeQuery.data ? (
          readmeQuery.data.is_text ? (
            <MarkdownBody content={readmeQuery.data.text ?? ''} />
          ) : (
            <p className="text-sm text-gray-500">This folder's README.md is not text.</p>
          )
        ) : (
          <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
        )}
      </div>
    </div>
  )
}

/** One home-folder file as an object URL, for the renderers that need the
 *  bytes (images, PDF, HTML, media). The download route always answers
 *  octet-stream + nosniff, so the bytes are re-typed from the extension —
 *  otherwise the browser won't show an SVG, open a PDF or render HTML. The
 *  query key sits under the file's path, so refreshAround() re-reads it after
 *  a save or upload. */
function useAgentFileBlobUrl(agentId: string, path: string, enabled: boolean) {
  const query = useQuery({
    queryKey: blobKey(agentId, path),
    queryFn: async () => new Blob([await downloadAgentFile(agentId, path)], { type: mimeForFilename(path) }),
    enabled,
    staleTime: 0,
    retry: false,
  })
  const [blobUrl, setBlobUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!query.data) {
      setBlobUrl(null)
      return
    }
    const url = URL.createObjectURL(query.data)
    setBlobUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [query.data])

  return { blobUrl, error: query.error }
}

function FilePane({ agentId, path, busy, mutate, onSelect }: PaneProps) {
  const parent = parentFsPath(path)
  const name = baseName(path)
  const { data: parentListing } = useListing(agentId, parent)
  const entry = parentListing?.entries.find((e) => e.name === name)
  // Images, PDF, HTML and media render from the bytes; everything else from the
  // text read. .md / .html / .svg also offer their source behind a Raw toggle.
  const blobKind = isBinaryFile(name)
  const toggleable = hasRenderedView(name)
  const [raw, setRaw] = useState(false)
  const canDownload = !!entry && entry.readable && entry.type === 'file'
  const previewable = canDownload && entry.size <= PREVIEW_MAX_BYTES
  const queryClient = useQueryClient()
  const fileQuery = useQuery({
    queryKey: fileKey(agentId, path),
    queryFn: () => readAgentFile(agentId, path),
    enabled: previewable && (!blobKind || raw),
    staleTime: 0,
    retry: false,
  })
  const blob = useAgentFileBlobUrl(agentId, path, canDownload && blobKind && entry.size <= FS_MAX_CONTENT_BYTES)
  const [draft, setDraft] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const file = fileQuery.data
  const writable = !!entry?.writable
  // An .html / .svg is only read as text once Edit or Raw asks for it.
  const canEdit = writable && (blobKind ? toggleable && previewable : !!file?.is_text)
  const title = `/${path}`

  const startEdit = async () => {
    setActionError(null)
    try {
      const f = file ?? (await queryClient.fetchQuery<FsFile>({ queryKey: fileKey(agentId, path), queryFn: () => readAgentFile(agentId, path) }))
      if (f.is_text) setDraft(f.text ?? '')
      else setActionError("This file isn't text, so it can't be edited here.")
    } catch (err) {
      setActionError(fsFailure(err).message)
    }
  }

  const download = async () => {
    setDownloading(true)
    setActionError(null)
    try {
      const blob = await downloadAgentFile(agentId, path)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setActionError(fsFailure(err).message)
    } finally {
      setDownloading(false)
    }
  }

  const save = () => {
    if (draft === null) return
    const text = draft
    void mutate(() => writeAgentFile(agentId, path, new Blob([text])), path, () => setDraft(null))
  }

  const remove = () => {
    if (!window.confirm(`Delete ${title}? This cannot be undone.`)) return
    void mutate(() => deleteAgentEntry(agentId, path), path, () => onSelect({ path: parent, kind: 'dir' }))
  }

  let body: ReactNode
  if (!parentListing) {
    body = <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
  } else if (!entry) {
    body = <p className="text-sm text-gray-500">This entry is no longer here.</p>
  } else if (entry.type === 'symlink') {
    body = <p className="text-sm text-gray-500">This is a link. Links are never followed, so it can't be opened; it can only be deleted.</p>
  } else if (entry.type !== 'file') {
    body = <p className="text-sm text-gray-500">This entry is not a regular file and can't be opened.</p>
  } else if (!entry.readable) {
    body = <p className="text-sm text-gray-500">You can't open this file.</p>
  } else if (draft !== null) {
    body = (
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="w-full h-full min-h-[300px] font-mono text-sm border border-gray-200 rounded-md p-3 focus:outline-none focus:border-purple-300"
        aria-label={`Edit ${name}`}
        spellCheck={false}
      />
    )
  } else if (blobKind && !raw) {
    if (entry.size > FS_MAX_CONTENT_BYTES) {
      body = (
        <p className="text-sm text-gray-500">
          This file is too large to preview ({formatSize(entry.size)}). Files over {formatSize(FS_MAX_CONTENT_BYTES)} can't be downloaded here.
        </p>
      )
    } else if (blob.error) {
      body = <p className="text-sm text-red-600">{fsFailure(blob.error).message}</p>
    } else if (!blob.blobUrl) {
      body = <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
    } else {
      body = (
        <div className="h-full min-h-[400px]">
          <BlobFilePreview filename={name} blobUrl={blob.blobUrl} />
        </div>
      )
    }
  } else if (entry.size > PREVIEW_MAX_BYTES) {
    body = (
      <p className="text-sm text-gray-500">
        This file is too large to preview ({formatSize(entry.size)}).
        {entry.size <= FS_MAX_CONTENT_BYTES ? ' Use Download to get it.' : ` Files over ${formatSize(FS_MAX_CONTENT_BYTES)} can't be downloaded here.`}
      </p>
    )
  } else if (fileQuery.error) {
    const f = fsFailure(fileQuery.error)
    body = (
      <p className="text-sm text-red-600">
        {f.code === 'too_large' ? 'This file is too large to preview.' : f.message}
      </p>
    )
  } else if (!file) {
    body = <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
  } else if (!file.is_text) {
    body = (
      <p className="text-sm text-gray-500">
        This file isn't text ({formatSize(file.size)}), so it can't be shown here. Use Download to get it intact.
      </p>
    )
  } else if (raw) {
    body = <pre className="font-mono text-sm whitespace-pre-wrap break-words text-gray-800">{file.text}</pre>
  } else {
    body = <TextFilePreview filename={name} content={file.text ?? ''} />
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <EntryIcon type={entry?.type ?? 'file'} locked={!!entry && !writable} />
        <h3 className="font-mono text-sm truncate flex-1" title={title}>
          {title}
        </h3>
        {entry && !writable && <span className="text-xs text-gray-500">{readOnlyLabel(entry.tier)}</span>}
        <div className="flex items-center gap-1">
          {draft !== null ? (
            <>
              <HeaderButton onClick={() => setDraft(null)} icon={null} label="Cancel" disabled={busy} />
              <HeaderButton onClick={save} icon={busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} label="Save" disabled={busy} />
            </>
          ) : (
            <>
              {toggleable && canDownload && (
                <div className="inline-flex rounded-md border border-gray-200 overflow-hidden text-sm" role="group" aria-label="View">
                  {(['Rendered', 'Raw'] as const).map((label) => {
                    const pressed = raw === (label === 'Raw')
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() => setRaw(label === 'Raw')}
                        className={`px-2 py-1 ${pressed ? 'bg-sidebar-hover text-gray-900' : 'text-gray-600 hover:bg-sidebar-hover'}`}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              )}
              {writable && (
                <HeaderButton onClick={remove} icon={<Trash2 className="w-4 h-4" />} label="Delete" danger disabled={busy} />
              )}
              {canDownload && (
                <HeaderButton
                  onClick={download}
                  icon={downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  label="Download"
                  disabled={downloading}
                />
              )}
              {canEdit && (
                <HeaderButton onClick={() => void startEdit()} icon={<Pencil className="w-4 h-4" />} label="Edit" disabled={busy} />
              )}
            </>
          )}
        </div>
      </div>
      {actionError && <div className="px-4 py-1 text-sm text-red-600">{actionError}</div>}
      <div className="flex-1 overflow-auto px-6 py-4">{body}</div>
    </div>
  )
}

/** `initialPath` opens the browser at that folder, its ancestors expanded. */
export default function HomeFolderBrowser({
  agentId,
  agentLabel,
  initialPath = '',
}: {
  agentId: string
  agentLabel: string
  initialPath?: string
}) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Selection>({ path: initialPath, kind: 'dir' })
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set([''])
    for (let p = initialPath; p; p = parentFsPath(p)) open.add(p)
    return open
  })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const root = useListing(agentId, '')

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const expand = (path: string) => setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)))

  const select = (sel: Selection) => {
    setNotice(null)
    setSelected(sel)
  }

  /** Run one change, then re-read the folders it touched so the tree shows it.
   *  No answer is not a failure: the change may have landed, so say so and show
   *  the folder as it is now. */
  const mutate = async (work: () => Promise<unknown>, around: string, onDone?: () => void): Promise<boolean> => {
    setBusy(true)
    setNotice(null)
    try {
      await work()
      onDone?.()
      return true
    } catch (err) {
      if (mutationResultUnknown(err)) {
        setNotice({
          tone: 'info',
          text: `No answer from @${agentLabel} — the change may or may not have happened. Refreshing to show the folder as it is now.`,
        })
      } else if (isRunnerUnavailable(err)) {
        setNotice({ tone: 'error', text: unavailableMessage(err, agentLabel) })
      } else {
        setNotice({ tone: 'error', text: fsFailure(err).message })
      }
      return false
    } finally {
      await refreshAround(queryClient, agentId, around)
      setBusy(false)
    }
  }

  // A stand-in of an agent on another server has no folder here at all.
  const rootRemote = !!root.error && fsFailure(root.error).code === 'remote_agent'
  const rootUnavailable = root.error && (rootRemote || isRunnerUnavailable(root.error))

  return (
    <div className="flex-1 flex overflow-hidden" data-testid="home-folder-browser">
      <nav className="w-72 shrink-0 border-r border-border overflow-auto py-2" aria-label={`@${agentLabel} home folder`}>
        <button
          type="button"
          onClick={() => select({ path: '', kind: 'dir' })}
          className={`w-full flex items-center gap-1.5 px-2 py-1 text-left text-sm font-medium hover:bg-sidebar-hover ${
            selected.path === '' ? 'bg-purple-50 text-accent-deep' : 'text-gray-800'
          }`}
        >
          <EntryIcon type="dir" open locked={!!root.data && !root.data.writable} />
          Home folder
        </button>
        <div role="tree">
          <TreeFolder
            agentId={agentId}
            path=""
            depth={1}
            expanded={expanded}
            selected={selected}
            onSelect={select}
            onToggle={toggle}
          />
        </div>
      </nav>
      <div className="flex-1 flex flex-col overflow-hidden">
        {notice && (
          <div
            role="status"
            className={`px-4 py-2 text-sm border-b ${
              notice.tone === 'info' ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-red-50 text-red-700 border-red-200'
            }`}
          >
            {notice.text}
          </div>
        )}
        {rootUnavailable ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6" role="alert">
            <WifiOff className="w-6 h-6 text-gray-400" />
            <p className="text-sm text-gray-600 max-w-md">{unavailableMessage(root.error, agentLabel)}</p>
            {!rootRemote && (
              <button type="button" onClick={() => void root.refetch()} className="text-sm text-accent-deep hover:underline">
                Try again
              </button>
            )}
          </div>
        ) : selected.kind === 'dir' ? (
          <FolderPane
            key={selected.path}
            agentId={agentId}
            path={selected.path}
            busy={busy}
            mutate={mutate}
            onSelect={select}
            onExpand={expand}
          />
        ) : (
          <FilePane key={selected.path} agentId={agentId} path={selected.path} busy={busy} mutate={mutate} onSelect={select} />
        )}
      </div>
    </div>
  )
}

