import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Package, Plus, Pencil, Trash2, ChevronDown, FilePlus, FileText, X, Upload, FolderUp } from 'lucide-react'
import {
  createKnowledgePack,
  deleteKnowledgePack,
  deleteKnowledgePackFile,
  getKnowledgePacks,
  updateKnowledgePack,
  upsertKnowledgePackFile,
  encodeTextToB64,
  decodeB64ToText,
  bytesToB64,
  b64ByteLength,
  type KnowledgePack,
  type PackFile,
} from '../../api/endpoints/knowledgePacks'
import { ApiError } from '../../api/client'
import { SectionCard, SectionHeader, Alert } from './primitives'

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const FILEPATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/

// Extensions that should open in the text editor. Anything else is treated
// as binary (preview-only). Files with no extension are treated as text.
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'json', 'jsonl', 'ndjson', 'yaml', 'yml',
  'toml', 'ini', 'csv', 'tsv', 'html', 'htm', 'xml', 'svg',
  'py', 'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sh', 'bash',
  'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
  'log', 'env', 'gitignore', 'editorconfig',
])

const MAX_FILE_BYTES = 5 * 1024 * 1024       // 5 MB per file
const MAX_TOTAL_BYTES = 20 * 1024 * 1024     // 20 MB per upload

function isTextPath(path: string): boolean {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot < 0) return true
  const ext = base.slice(dot + 1).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** Strip the top-level folder from a `webkitRelativePath` so a user-uploaded
 *  folder named "wine/" carrying "notes/intro.md" lands as "notes/intro.md"
 *  in the pack, not "wine/notes/intro.md". */
function stripTopFolder(relPath: string): string {
  const slash = relPath.indexOf('/')
  return slash < 0 ? relPath : relPath.slice(slash + 1)
}

/** Sanitize an input path; returns the cleaned path or an error string. */
function sanitizePath(raw: string): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'empty path' }
  if (trimmed.length > 200) return { ok: false, reason: 'path too long (max 200)' }
  if (trimmed.includes('\\')) return { ok: false, reason: 'backslash not allowed' }
  if (trimmed.startsWith('/')) return { ok: false, reason: 'must be relative' }
  const segments = trimmed.split('/').filter((s) => s !== '')
  if (segments.length === 0) return { ok: false, reason: 'empty path' }
  for (const seg of segments) {
    if (seg === '..') return { ok: false, reason: "'..' not allowed" }
    if (seg.startsWith('.')) return { ok: false, reason: `dotfile segment '${seg}'` }
    if (!SEGMENT_RE.test(seg)) return { ok: false, reason: `invalid segment '${seg}'` }
  }
  return { ok: true, path: segments.join('/') }
}

/**
 * Inlined knowledge-pack registry section for `/settings`. Renders directly
 * under the Assistant Token card.
 */
export default function KnowledgePacksSection() {
  const queryClient = useQueryClient()
  const { data: packs = [], isLoading } = useQuery({
    queryKey: ['knowledge-packs'],
    queryFn: () => getKnowledgePacks(),
  })

  const [creating, setCreating] = useState(false)
  const [editingPackSlug, setEditingPackSlug] = useState<string | null>(null)
  const editingPack = editingPackSlug ? packs.find((p) => p.slug === editingPackSlug) ?? null : null

  const [fileEditor, setFileEditor] = useState<
    | { mode: 'new' | 'edit'; packSlug: string; filepath: string; file: PackFile | null }
    | null
  >(null)

  return (
    <SectionCard>
      <SectionHeader
        title="Knowledge Packs"
        icon={<Package className="w-4 h-4" />}
        subtitle="User-curated bundles of files. Install on any agent to add to its AUTHORITATIVE memory."
        action={
          <button
            type="button"
            onClick={() => {
              setCreating(true)
              setEditingPackSlug(null)
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-accent rounded-full hover:bg-accent-deep transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            New pack
          </button>
        }
      />
      <div className="px-6 py-5">
        {isLoading ? (
          <div className="flex items-center justify-center h-20">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-accent" />
          </div>
        ) : packs.length === 0 ? (
          <p className="text-center text-sm text-gray-500 py-4">
            No knowledge packs yet. Click <span className="font-semibold">New pack</span> to author one,
            or save a chat message into a pack from any chatroom.
          </p>
        ) : (
          <div className="space-y-2">
            {packs.map((pack) => (
              <PackRow
                key={pack.slug}
                pack={pack}
                onEditMeta={() => {
                  setEditingPackSlug(pack.slug)
                  setCreating(false)
                }}
                onAddFile={() => {
                  setFileEditor({
                    mode: 'new',
                    packSlug: pack.slug,
                    filepath: '',
                    file: null,
                  })
                }}
                onEditFile={(filepath, file) => {
                  setFileEditor({
                    mode: 'edit',
                    packSlug: pack.slug,
                    filepath,
                    file,
                  })
                }}
                onDeleted={() => {
                  queryClient.invalidateQueries({ queryKey: ['knowledge-packs'] })
                  queryClient.invalidateQueries({ queryKey: ['agent-knowledge-packs'] })
                }}
              />
            ))}
          </div>
        )}
      </div>

      {(creating || editingPack) && (
        <PackMetaModal
          pack={editingPack}
          onClose={() => {
            setCreating(false)
            setEditingPackSlug(null)
          }}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['knowledge-packs'] })
            queryClient.invalidateQueries({ queryKey: ['agent-knowledge-packs'] })
            setCreating(false)
            setEditingPackSlug(null)
          }}
        />
      )}

      {fileEditor && (
        <FileEditorModal
          packSlug={fileEditor.packSlug}
          mode={fileEditor.mode}
          initialFilepath={fileEditor.filepath}
          initialFile={fileEditor.file}
          onClose={() => setFileEditor(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['knowledge-packs'] })
            queryClient.invalidateQueries({ queryKey: ['agent-knowledge-packs'] })
            setFileEditor(null)
          }}
        />
      )}
    </SectionCard>
  )
}

function PackRow({
  pack,
  onEditMeta,
  onAddFile,
  onEditFile,
  onDeleted,
}: {
  pack: KnowledgePack
  onEditMeta: () => void
  onAddFile: () => void
  onEditFile: (filepath: string, file: PackFile) => void
  onDeleted: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const queryClient = useQueryClient()

  const deletePackMutation = useMutation({
    mutationFn: () => deleteKnowledgePack(pack.slug),
    onSuccess: () => onDeleted(),
  })

  const deleteFileMutation = useMutation({
    mutationFn: (filepath: string) => deleteKnowledgePackFile(pack.slug, filepath),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-packs'] })
      queryClient.invalidateQueries({ queryKey: ['agent-knowledge-packs'] })
    },
  })

  const handleDeletePack = () => {
    if (!window.confirm(`Delete pack "${pack.name}"? This will uninstall it from every agent that has it.`)) return
    deletePackMutation.mutate()
  }

  const handleDeleteFile = (filepath: string) => {
    if (!window.confirm(`Delete file "${filepath}" from pack "${pack.name}"?`)) return
    deleteFileMutation.mutate(filepath)
  }

  const fileCount = Object.keys(pack.files).length
  const totalBytes = Object.values(pack.files).reduce((acc, f) => acc + b64ByteLength(f.content_b64), 0)

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-gray-400 hover:text-gray-700 transition-colors"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-bold text-gray-900 truncate">{pack.name}</h3>
            <span className="text-[11px] font-mono text-gray-400">{pack.slug}</span>
          </div>
          {pack.description && (
            <p className="mt-1 text-xs text-gray-500 leading-snug line-clamp-2">{pack.description}</p>
          )}
          <p className="mt-1 text-[10.5px] font-mono text-gray-400">
            {fileCount} file(s) · {formatBytes(totalBytes)} · updated{' '}
            {pack.updated_at ? new Date(pack.updated_at).toLocaleString() : '—'}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onAddFile}
            className="p-1.5 text-gray-500 hover:text-purple-700 hover:bg-purple-50 rounded transition-colors"
            aria-label="Add file"
            title="Add file"
          >
            <FilePlus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onEditMeta}
            className="p-1.5 text-gray-500 hover:text-purple-700 hover:bg-purple-50 rounded transition-colors"
            aria-label="Edit pack"
            title="Edit name / description"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleDeletePack}
            disabled={deletePackMutation.isPending}
            className="p-1.5 text-gray-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
            aria-label="Delete pack"
            title="Delete pack"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 px-3 pt-2 pb-3 space-y-1">
          {fileCount === 0 ? (
            <p className="text-xs text-gray-500 italic py-1.5">
              No files yet. Click <FilePlus className="inline w-3 h-3 align-text-bottom" /> to add one.
            </p>
          ) : (
            Object.entries(pack.files)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([filepath, file]) => (
                <div
                  key={filepath}
                  className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-gray-50 group"
                >
                  <FileText className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-mono text-gray-700 truncate" title={filepath}>{filepath}</span>
                    {file.description && (
                      <span className="block text-[10.5px] text-gray-400 truncate" title={file.description}>
                        {file.description}
                      </span>
                    )}
                  </span>
                  <span className="text-[10.5px] font-mono text-gray-400 shrink-0">
                    {formatBytes(b64ByteLength(file.content_b64))}
                  </span>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => onEditFile(filepath, file)}
                      className="p-1 text-gray-500 hover:text-purple-700 hover:bg-purple-100 rounded transition-colors"
                      aria-label={`Edit ${filepath}`}
                      title="Edit file"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteFile(filepath)}
                      disabled={deleteFileMutation.isPending}
                      className="p-1 text-gray-500 hover:text-red-700 hover:bg-red-100 rounded transition-colors disabled:opacity-50"
                      aria-label={`Delete ${filepath}`}
                      title="Delete file"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))
          )}
        </div>
      )}
    </div>
  )
}

interface StagedFile {
  path: string
  bytes: number
  contentB64: string
}

interface StagedReject {
  path: string
  reason: string
}

interface PackMetaModalProps {
  pack: KnowledgePack | null
  onClose: () => void
  onSaved: () => void
}

function PackMetaModal({ pack, onClose, onSaved }: PackMetaModalProps) {
  const isEdit = pack !== null

  const [slug, setSlug] = useState(pack?.slug ?? '')
  const [name, setName] = useState(pack?.name ?? '')
  const [description, setDescription] = useState(pack?.description ?? '')
  const [slugTouched, setSlugTouched] = useState(isEdit)
  const [error, setError] = useState('')
  const [staged, setStaged] = useState<StagedFile[]>([])
  const [rejected, setRejected] = useState<StagedReject[]>([])
  const [isReading, setIsReading] = useState(false)

  const filesInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!slugTouched) setSlug(suggestSlug(name))
  }, [name, slugTouched])

  const totalStagedBytes = useMemo(
    () => staged.reduce((acc, f) => acc + f.bytes, 0),
    [staged],
  )

  const createMutation = useMutation({
    mutationFn: () => {
      const files: Record<string, PackFile> = {}
      for (const s of staged) files[s.path] = { content_b64: s.contentB64 }
      return createKnowledgePack({
        slug,
        name,
        description,
        files: staged.length ? files : undefined,
      })
    },
    onSuccess: () => onSaved(),
    onError: (e: Error) => setError(e instanceof ApiError ? e.message : String(e)),
  })

  const updateMutation = useMutation({
    mutationFn: () => updateKnowledgePack(pack!.slug, { name, description }),
    onSuccess: () => onSaved(),
    onError: (e: Error) => setError(e instanceof ApiError ? e.message : String(e)),
  })

  const isPending = createMutation.isPending || updateMutation.isPending || isReading

  const ingestFiles = async (files: FileList | null, isFolder: boolean) => {
    if (!files || files.length === 0) return
    setError('')
    setIsReading(true)
    const newStaged: StagedFile[] = []
    const newRejected: StagedReject[] = []
    let runningBytes = totalStagedBytes
    const existingPaths = new Set(staged.map((s) => s.path))
    try {
      for (const file of Array.from(files)) {
        // webkitRelativePath is empty for plain file-picker selections; use
        // it only when the folder picker fired the event.
        const rawPath = isFolder && (file as any).webkitRelativePath
          ? stripTopFolder((file as any).webkitRelativePath as string)
          : file.name
        const clean = sanitizePath(rawPath)
        if (!clean.ok) {
          newRejected.push({ path: rawPath, reason: clean.reason })
          continue
        }
        if (file.size > MAX_FILE_BYTES) {
          newRejected.push({
            path: clean.path,
            reason: `too large (${formatBytes(file.size)} > ${formatBytes(MAX_FILE_BYTES)})`,
          })
          continue
        }
        if (runningBytes + file.size > MAX_TOTAL_BYTES) {
          newRejected.push({
            path: clean.path,
            reason: `would exceed total cap (${formatBytes(MAX_TOTAL_BYTES)})`,
          })
          continue
        }
        if (existingPaths.has(clean.path)) {
          newRejected.push({ path: clean.path, reason: 'duplicate path; remove the existing one first' })
          continue
        }
        const buf = await file.arrayBuffer()
        newStaged.push({
          path: clean.path,
          bytes: file.size,
          contentB64: bytesToB64(buf),
        })
        existingPaths.add(clean.path)
        runningBytes += file.size
      }
      if (newStaged.length) setStaged((prev) => [...prev, ...newStaged].sort((a, b) => a.path.localeCompare(b.path)))
      if (newRejected.length) setRejected((prev) => [...prev, ...newRejected])
    } finally {
      setIsReading(false)
      if (filesInputRef.current) filesInputRef.current.value = ''
      if (folderInputRef.current) folderInputRef.current.value = ''
    }
  }

  const removeStaged = (path: string) => {
    setStaged((prev) => prev.filter((s) => s.path !== path))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (!isEdit) {
      if (!SLUG_RE.test(slug)) {
        setError('Slug must start with [a-z0-9] and contain only lowercase letters, digits, hyphens, and underscores')
        return
      }
      createMutation.mutate()
    } else {
      updateMutation.mutate()
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">{isEdit ? 'Edit pack' : 'New knowledge pack'}</h2>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {error && <Alert type="error" message={error} />}
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Wine recommendations"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Slug</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value)
                setSlugTouched(true)
              }}
              disabled={isEdit}
              placeholder="wine-recommendations"
              className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 disabled:bg-gray-50 disabled:text-gray-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              {isEdit
                ? 'Slug is immutable — delete and recreate if you need to rename.'
                : 'Lowercase letters, digits, hyphens, underscores. Auto-derived from name; click to override.'}
            </p>
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">
              Description <span className="text-gray-400 font-normal">(one line)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When to consult this pack"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400"
            />
          </div>

          {!isEdit && (
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1.5">
                Initial documents <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <div className="flex items-center gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => filesInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Add files
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  <FolderUp className="w-3.5 h-3.5" />
                  Add folder
                </button>
                <span className="text-[10.5px] font-mono text-gray-400 ml-auto">
                  {staged.length} file(s) · {formatBytes(totalStagedBytes)} / {formatBytes(MAX_TOTAL_BYTES)}
                </span>
              </div>
              <input
                ref={filesInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => ingestFiles(e.target.files, false)}
              />
              <input
                ref={folderInputRef}
                type="file"
                hidden
                /* eslint-disable @typescript-eslint/ban-ts-comment */
                // @ts-expect-error — webkitdirectory is a non-standard but widely supported attribute
                webkitdirectory=""
                directory=""
                onChange={(e) => ingestFiles(e.target.files, true)}
              />
              <p className="text-[11px] text-gray-500">
                Up to {formatBytes(MAX_FILE_BYTES)} per file, {formatBytes(MAX_TOTAL_BYTES)} total. Nested folder
                structure is preserved. Binary files (PDFs, images, etc.) are accepted.
              </p>

              {staged.length > 0 && (
                <div className="mt-2 rounded-lg border border-gray-200 divide-y divide-gray-100 max-h-48 overflow-y-auto">
                  {staged.map((s) => (
                    <div key={s.path} className="flex items-center gap-2 py-1.5 px-2 hover:bg-gray-50">
                      <FileText className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      <span className="flex-1 text-xs font-mono text-gray-700 truncate" title={s.path}>{s.path}</span>
                      <span className="text-[10.5px] font-mono text-gray-400 shrink-0">{formatBytes(s.bytes)}</span>
                      <button
                        type="button"
                        onClick={() => removeStaged(s.path)}
                        className="p-1 text-gray-400 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
                        aria-label={`Remove ${s.path}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {rejected.length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <div className="font-semibold mb-1 flex items-center gap-2">
                    Skipped {rejected.length} file(s)
                    <button
                      type="button"
                      onClick={() => setRejected([])}
                      className="ml-auto text-amber-700 hover:text-amber-900 font-normal underline"
                    >
                      dismiss
                    </button>
                  </div>
                  <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                    {rejected.map((r, i) => (
                      <li key={i} className="font-mono text-[11px]">
                        <span className="truncate">{r.path}</span> — {r.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
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
              {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create pack'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface FileEditorModalProps {
  packSlug: string
  mode: 'new' | 'edit'
  initialFilepath: string
  initialFile: PackFile | null
  onClose: () => void
  onSaved: () => void
}

function FileEditorModal({
  packSlug,
  mode,
  initialFilepath,
  initialFile,
  onClose,
  onSaved,
}: FileEditorModalProps) {
  const initialIsText = mode === 'new' ? true : isTextPath(initialFilepath)
  const initialText = useMemo(() => {
    if (mode === 'new' || !initialFile) return ''
    if (!initialIsText) return ''
    try {
      return decodeB64ToText(initialFile.content_b64)
    } catch {
      return ''
    }
  }, [mode, initialFile, initialIsText])

  const [filepath, setFilepath] = useState(initialFilepath)
  const [content, setContent] = useState(initialText)
  const [fileDescription, setFileDescription] = useState(initialFile?.description ?? '')
  const [error, setError] = useState('')
  const replaceInputRef = useRef<HTMLInputElement | null>(null)
  const [isReplacing, setIsReplacing] = useState(false)

  const textMutation = useMutation({
    mutationFn: () =>
      upsertKnowledgePackFile(packSlug, filepath, encodeTextToB64(content), fileDescription),
    onSuccess: () => onSaved(),
    onError: (e: Error) => setError(e instanceof ApiError ? e.message : String(e)),
  })

  const binaryMutation = useMutation({
    mutationFn: (contentB64: string) =>
      upsertKnowledgePackFile(packSlug, filepath, contentB64, fileDescription),
    onSuccess: () => onSaved(),
    onError: (e: Error) => setError(e instanceof ApiError ? e.message : String(e)),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!FILEPATH_RE.test(filepath) || filepath.length > 200) {
      setError(
        'Path segments must start with a letter or digit and contain only letters, digits, dots, hyphens, and underscores; separate nested segments with /',
      )
      return
    }
    textMutation.mutate()
  }

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    if (file.size > MAX_FILE_BYTES) {
      setError(`File too large (${formatBytes(file.size)} > ${formatBytes(MAX_FILE_BYTES)})`)
      e.target.value = ''
      return
    }
    setIsReplacing(true)
    try {
      const buf = await file.arrayBuffer()
      const b64 = bytesToB64(buf)
      binaryMutation.mutate(b64)
    } finally {
      setIsReplacing(false)
      e.target.value = ''
    }
  }

  const isBinaryEdit = mode === 'edit' && !initialIsText
  const sizeBytes = initialFile ? b64ByteLength(initialFile.content_b64) : 0

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-gray-900">
            {mode === 'edit' ? `Edit ${initialFilepath}` : `Add file to ${packSlug}`}
          </h2>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {error && <Alert type="error" message={error} />}
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-1.5">Path</label>
            <input
              type="text"
              value={filepath}
              onChange={(e) => setFilepath(e.target.value)}
              disabled={mode === 'edit'}
              placeholder="notes/fine-dining-tactics.md"
              className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 disabled:bg-gray-50 disabled:text-gray-500"
            />
            {mode === 'edit' ? (
              <p className="mt-1 text-xs text-gray-500">Path is immutable — delete and re-add to rename.</p>
            ) : (
              <p className="mt-1 text-xs text-gray-500">
                Forward-slash separated relative path. Each segment must start with an alphanumeric character.
              </p>
            )}
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
              Surfaces per-file in the agent's pack index so it knows when to open this file.
            </p>
          </div>

          {isBinaryEdit ? (
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1.5">Binary file</label>
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-700">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-gray-400" />
                  <span className="font-mono">{initialFilepath}</span>
                  <span className="font-mono text-gray-500 ml-auto">{formatBytes(sizeBytes)}</span>
                </div>
                <p className="mt-2 text-gray-500">
                  This file isn't a recognized text format. Use Replace to swap it out, or Delete from the pack row.
                </p>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => replaceInputRef.current?.click()}
                    disabled={isReplacing || binaryMutation.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    {isReplacing || binaryMutation.isPending ? 'Uploading…' : 'Replace file'}
                  </button>
                  <input
                    ref={replaceInputRef}
                    type="file"
                    hidden
                    onChange={handleReplaceFile}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-1.5">Content (text)</label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={14}
                placeholder="# Section&#10;..."
                className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 resize-vertical"
              />
              <p className="mt-1 text-xs text-gray-500">{content.length} characters</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {isBinaryEdit ? 'Close' : 'Cancel'}
            </button>
            {!isBinaryEdit && (
              <button
                type="submit"
                disabled={textMutation.isPending}
                className="px-5 py-2 text-sm font-bold text-white bg-accent rounded-lg hover:bg-accent-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {textMutation.isPending ? 'Saving…' : 'Save file'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
