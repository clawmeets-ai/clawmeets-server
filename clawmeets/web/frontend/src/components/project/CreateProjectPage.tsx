import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent as ReactFormEvent,
} from 'react'
import { ImagePlus, X } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import SampleRequestBody, {
  collapsePlaceholders,
} from '../sample-request/SampleRequestBody'
import { useAuthStore } from '../../stores/authStore'
import { useCreateProject } from '../../hooks/useCreateProject'
import { useUserProjects } from '../../hooks/useProjects'
import { useMyAgents } from '../../hooks/useMyAgents'
import { useUnsavedGuard } from '../../stores/unsavedGuard'
import { useAutoResizeTextarea } from '../../hooks/useAutoResizeTextarea'
import { displayName as agentDisplayName } from '../../utils/agentDisplay'
import TeamAndAgentPicker from '../common/TeamAndAgentPicker'
import { PageShell, PageHeader, SectionCard, SectionHeader, Alert } from '../settings/primitives'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_EXTENSIONS = ['.txt', '.md', '.json', '.csv', '.py', '.js', '.ts', '.tsx', '.jsx', '.yaml', '.yml', '.xml', '.html', '.css', '.png', '.jpg', '.jpeg', '.pdf']

const inputClasses = "w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500/20 focus:border-purple-400 transition-colors bg-gray-50/50 placeholder-gray-400"
const inputErrorClasses = "w-full px-3 py-2 text-sm border border-red-300 rounded-lg focus:ring-2 focus:ring-red-500/20 focus:border-red-400 transition-colors bg-red-50/30 placeholder-gray-400"
const labelClasses = "block text-sm font-semibold text-gray-800 mb-1.5"
const helperClasses = "mt-1.5 text-xs text-gray-500"

export default function CreateProjectPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user } = useAuthStore()
  const { data: existingProjects } = useUserProjects()
  const createProject = useCreateProject()
  const setGuardDirty = useUnsavedGuard((s) => s.setDirty)

  const [name, setName] = useState(searchParams.get('name') || '')
  const [request, setRequest] = useState(searchParams.get('request') || '')
  const requestTextareaRef = useRef<HTMLTextAreaElement>(null)
  useAutoResizeTextarea(requestTextareaRef, request, 800)
  // Prefilled requests (e.g. from a sample) start in Preview so chips are
  // visible right away; blank requests start in Edit for composition.
  const [requestMode, setRequestMode] = useState<'edit' | 'preview'>(
    searchParams.get('request') ? 'preview' : 'edit',
  )

  const contextFileHints = searchParams.get('context_files')?.split(',').filter(Boolean) || []
  const [files, setFiles] = useState<File[]>([])
  const [agentPool, setAgentPool] = useState<'owned' | 'verified' | 'all'>(() => {
    const v = searchParams.get('agent_pool')
    return v === 'owned' || v === 'all' ? v : 'verified'
  })
  const initialTeams = (searchParams.get('team') || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const initialAgents = (searchParams.get('agent') || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const [agentTeams, setAgentTeams] = useState<string[]>(initialTeams)
  const [agentNames, setAgentNames] = useState<string[]>(initialAgents)
  const { data: ownedAgents = [] } = useMyAgents()
  const knownTeamSuggestions = useMemo(() => {
    const set = new Set<string>()
    for (const a of ownedAgents) {
      for (const t of a.user_teams || []) set.add(t)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [ownedAgents])
  const knownAgentSuggestions = useMemo(
    () => ownedAgents.map((a) => agentDisplayName(a, user)).sort((a, b) => a.localeCompare(b)),
    [ownedAgents, user],
  )
  // Coordinator override. Empty string = use the user's assistant (the default).
  const [coordinatorId, setCoordinatorId] = useState<string>('')
  const nonAssistantOwnedAgents = useMemo(
    () =>
      ownedAgents
        .filter((a) => a.id !== user?.assistant_agent_id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [ownedAgents, user?.assistant_agent_id],
  )
  const selectedCoordinator = useMemo(
    () => (coordinatorId ? ownedAgents.find((a) => a.id === coordinatorId) ?? null : null),
    [ownedAgents, coordinatorId],
  )
  const [dragActive, setDragActive] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Validation
  const nameError = validateName(name, existingProjects?.map((p) => p.name) || [])
  const requestError = request.length > 0 && request.length < 10 ? 'Request must be at least 10 characters' : null
  const hasAssistant = !!user?.assistant_agent_id

  const canSubmit =
    hasAssistant &&
    name.length > 0 &&
    !nameError &&
    request.length >= 10 &&
    !createProject.isPending

  // Dirty state — powers beforeunload + sidebar-link click guard below.
  const isDirty =
    !createProject.isPending &&
    (name.length > 0 ||
      request.length > 0 ||
      files.length > 0 ||
      agentTeams.length > 0 ||
      agentNames.length > 0 ||
      coordinatorId.length > 0)

  // Register dirty state with the global guard so sidebar onClick handlers
  // (e.g., DM agent clicks) can consult it via confirmLeaveIfDirty().
  useEffect(() => {
    setGuardDirty(isDirty, 'Discard unsaved project details?')
    return () => setGuardDirty(false)
  }, [isDirty, setGuardDirty])

  // Browser refresh / tab close prompt.
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  // Intercept in-app <Link>/<a> navigations to any path other than this one.
  // Capture-phase listener runs before react-router's click handler so we can
  // preventDefault and stop it from navigating when the user cancels.
  useEffect(() => {
    if (!isDirty) return
    const handler = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
      if (!anchor) return
      const href = anchor.getAttribute('href')
      if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return
      if (href === '/projects/new') return
      if (!window.confirm('Discard unsaved project details?')) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [isDirty])

  function validateName(value: string, existingNames: string[]): string | null {
    if (value.length === 0) return null
    if (value.length > 50) return 'Name must be 50 characters or less'
    if (!/^[a-zA-Z0-9]/.test(value)) return 'Name must start with alphanumeric character'
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) return 'Name can only contain letters, numbers, hyphens, and underscores'
    if (existingNames.some((n) => n.toLowerCase() === value.toLowerCase())) {
      return 'A project with this name already exists'
    }
    return null
  }

  function validateFile(file: File): string | null {
    if (file.size > MAX_FILE_SIZE) {
      return `${file.name} exceeds 10MB limit`
    }
    const ext = '.' + file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return `${file.name} has unsupported extension`
    }
    return null
  }

  const handleFiles = useCallback((newFiles: FileList | null) => {
    if (!newFiles) return
    setValidationError(null)

    const validFiles: File[] = []
    for (const file of Array.from(newFiles)) {
      const error = validateFile(file)
      if (error) {
        setValidationError(error)
        return
      }
      // Check for duplicates
      if (!files.some((f) => f.name === file.name)) {
        validFiles.push(file)
      }
    }
    setFiles((prev) => [...prev, ...validFiles])
  }, [files])

  const handleDrag = useCallback((e: ReactDragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }, [])

  const handleDrop = useCallback((e: ReactDragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    handleFiles(e.dataTransfer.files)
  }, [handleFiles])

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleCancel = () => {
    if (isDirty && !window.confirm('Discard unsaved project details?')) return
    setGuardDirty(false)
    navigate('/projects')
  }

  const handleSubmit = async (e: ReactFormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    createProject.mutate({
      name,
      request: collapsePlaceholders(request),
      files,
      agentPool,
      agentTeams: agentTeams.length > 0 ? agentTeams : undefined,
      agentNames: agentNames.length > 0 ? agentNames : undefined,
      coordinatorId: selectedCoordinator?.id,
      coordinatorName: selectedCoordinator?.name,
    })
  }

  if (!hasAssistant) {
    return (
      <PageShell>
        <PageHeader title="Create New Project" />
        <SectionCard>
          <div className="px-5 py-6 text-center">
            <h2 className="text-base font-semibold text-gray-900 mb-2">No Assistant Linked</h2>
            <p className="text-sm text-gray-500 mb-5">
              Your account does not have an assistant agent linked. Register one first.
            </p>
            <button
              onClick={() => navigate('/projects')}
              className="px-4 py-2 text-xs font-medium bg-sidebar text-white rounded-lg hover:bg-sidebar-hover transition-colors"
            >
              Go Back
            </button>
          </div>
        </SectionCard>
      </PageShell>
    )
  }

  return (
    <PageShell>
      <PageHeader
        title="Create New Project"
        subtitle="Start a new collaboration with AI agents"
      />

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Project Basics */}
        <SectionCard>
          <SectionHeader title="Project Basics" />
          <div className="px-6 py-5 space-y-5">
            <div>
              <label htmlFor="name" className={labelClasses}>
                Project Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., trip-research"
                className={nameError ? inputErrorClasses : inputClasses}
                autoFocus
              />
              {nameError && (
                <p className="mt-1 text-xs text-red-600">{nameError}</p>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="request" className="block text-sm font-semibold text-gray-800">
                  Request Description
                </label>
                <div className="flex gap-1 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setRequestMode('edit')}
                    className={`px-2 py-0.5 rounded ${
                      requestMode === 'edit'
                        ? 'bg-gray-100 text-gray-800 font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setRequestMode('preview')}
                    disabled={request.length === 0}
                    className={`px-2 py-0.5 rounded disabled:opacity-40 ${
                      requestMode === 'preview'
                        ? 'bg-gray-100 text-gray-800 font-medium'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    Preview
                  </button>
                </div>
              </div>
              {requestMode === 'edit' ? (
                <textarea
                  ref={requestTextareaRef}
                  id="request"
                  value={request}
                  onChange={(e) => setRequest(e.target.value)}
                  placeholder="Describe what you want the agents to help you with..."
                  style={{ minHeight: '12rem' }}
                  className={`${requestError ? inputErrorClasses : inputClasses} resize-none`}
                />
              ) : (
                <SampleRequestBody
                  request={request}
                  interactive
                  onRequestChange={setRequest}
                  className="w-full min-h-[12rem] px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50/50 prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-headings:my-2 prose-headings:text-gray-900 prose-p:text-gray-700 prose-li:text-gray-700 prose-code:text-gray-700 break-words"
                />
              )}
              {requestError && (
                <p className="mt-1 text-xs text-red-600">{requestError}</p>
              )}
              <p className={helperClasses}>
                {request.length}/10 minimum characters
              </p>
            </div>
          </div>
        </SectionCard>

        {/* Context Files */}
        <SectionCard>
          <SectionHeader title="Context Files" subtitle="Optional. Shared with agents on this project." />
          <div className="px-6 py-5">
            <div
              className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                dragActive
                  ? 'border-purple-400 bg-purple-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={(e) => handleFiles(e.target.files)}
                className="hidden"
                accept={ALLOWED_EXTENSIONS.join(',')}
              />
              <div className="space-y-2">
                <ImagePlus className="mx-auto h-10 w-10 text-gray-300" strokeWidth={1.5} />
                <div className="text-sm text-gray-600">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-purple-600 hover:text-purple-500 font-medium"
                  >
                    Upload files
                  </button>
                  {' '}or drag and drop
                </div>
                <p className="text-xs text-gray-500">
                  Text, images, and PDF files (max 10MB each)
                </p>
              </div>
            </div>

            {contextFileHints.length > 0 && files.length === 0 && (
              <p className="text-xs text-purple-600 mt-2">
                Suggested files from your project config: {contextFileHints.join(', ')}
              </p>
            )}

            {files.length > 0 && (
              <ul className="mt-3 space-y-2">
                {files.map((file, index) => (
                  <li
                    key={file.name}
                    className="flex items-center justify-between px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg"
                  >
                    <span className="text-sm text-gray-700 truncate">
                      {file.name}
                      <span className="text-gray-400 ml-2">
                        ({(file.size / 1024).toFixed(1)} KB)
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>

        {/* Agents */}
        <SectionCard>
          <SectionHeader title="Agents" subtitle="Who coordinates and who can be invited." />
          <div className="px-6 py-5 space-y-5">
            <div>
              <label htmlFor="coordinator" className={labelClasses}>
                Coordinator
              </label>
              <select
                id="coordinator"
                value={coordinatorId}
                onChange={(e) => setCoordinatorId(e.target.value)}
                className={`${inputClasses} bg-white`}
              >
                <option value="">
                  My assistant — default
                </option>
                {nonAssistantOwnedAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {agentDisplayName(a, user)}
                  </option>
                ))}
              </select>
              <p className={helperClasses}>
                Drives project planning and is your default replier in #coordinator.
              </p>
              {selectedCoordinator && (
                <p className="mt-1 text-[11px] text-amber-700">
                  In this project, <span className="font-medium">{agentDisplayName(selectedCoordinator, user)}</span> will
                  respond in #coordinator. Your assistant can still be @mentioned.
                </p>
              )}
            </div>

            <div>
              <label htmlFor="agentPool" className={labelClasses}>
                Agent Pool
              </label>
              <select
                id="agentPool"
                value={agentPool}
                onChange={(e) => setAgentPool(e.target.value as 'owned' | 'verified' | 'all')}
                className={`${inputClasses} bg-white`}
              >
                <option value="verified">Verified agents (own + verified public)</option>
                <option value="owned">My agents only</option>
                <option value="all">All agents (own + all public)</option>
              </select>
              <p className={helperClasses}>
                Controls which agents can be assigned to work on this project.
              </p>
            </div>

            <div>
              <label className={labelClasses}>
                Invitable allowlist <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <TeamAndAgentPicker
                teams={agentTeams}
                agents={agentNames}
                onChange={({ teams, agents }) => {
                  setAgentTeams(teams)
                  setAgentNames(agents)
                }}
                teamSuggestions={knownTeamSuggestions}
                agentSuggestions={knownAgentSuggestions}
                teamsId="agentTeams"
                agentsId="agentNames"
                teamPlaceholder="Marketing, Outbound…"
                agentPlaceholder="researcher, designer…"
              />
              <p className={helperClasses}>
                Hard allowlist — only agents matching at least one team or named explicitly may be invited (composes via OR). The server rejects invites outside this list at chatroom-create. Leave both empty to allow any agent in the pool above.
              </p>
            </div>
          </div>
        </SectionCard>

        {/* Errors */}
        {(createProject.error || validationError) && (
          <Alert
            type="error"
            message={
              validationError ||
              (createProject.error instanceof Error ? createProject.error.message : 'Failed to create project')
            }
          />
        )}

        {/* Buttons */}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={handleCancel}
            className="flex-1 py-2 px-4 text-sm font-medium border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex-1 py-2 px-5 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {createProject.isPending ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Creating...
              </span>
            ) : (
              'Create Project'
            )}
          </button>
        </div>
      </form>
    </PageShell>
  )
}
