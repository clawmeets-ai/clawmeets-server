import { ApiError, del, get, getFile, post, putFile } from '../client'

/** An agent's home folder (its AGENT_DIR), carried out by the agent's OWN runner.
 *
 *  The server authorizes each call and relays it to the runner, which owns
 *  every path and tier rule (`runner/home_fs.py`); this module only shapes the
 *  wire. Paths are home-relative: `''` (or `'/'`) is the home folder itself.
 *  `writable` / `readable` are what the SIGNED-IN caller may do, so the UI
 *  hides a control the runner would refuse. */
export type FsTier = 'secret' | 'system' | 'personal_skills' | 'open'

export interface FsEntry {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mtime: number
  tier: FsTier
  writable: boolean
  readable: boolean
}

export interface FsListing {
  path: string
  tier: FsTier
  writable: boolean
  truncated: boolean
  entries: FsEntry[]
}

export interface FsFile {
  path: string
  tier: FsTier
  writable: boolean
  size: number
  mtime: number
  is_text: boolean
  text: string | null
  content_b64: string | null
}

/** Whole-file cap, the same on every surface (`fs_protocol.FS_MAX_CONTENT_BYTES`). */
export const FS_MAX_CONTENT_BYTES = 8 * 1024 * 1024

/** The `{error: {code, message, result_unknown}}` envelope every fs route answers
 *  a failure with, read off an ApiError. `code` is null when the body is not the
 *  server's envelope (a proxy page, a dropped connection). */
export interface FsFailure {
  code: string | null
  message: string
  resultUnknown: boolean
}

export function fsFailure(err: unknown): FsFailure {
  if (err instanceof ApiError) {
    const envelope = (err.data as { error?: { code?: unknown; message?: unknown; result_unknown?: unknown } } | undefined)?.error
    if (envelope && typeof envelope.code === 'string') {
      return {
        code: envelope.code,
        message: typeof envelope.message === 'string' ? envelope.message : err.message,
        resultUnknown: envelope.result_unknown === true,
      }
    }
    return { code: null, message: err.message, resultUnknown: false }
  }
  return { code: null, message: err instanceof Error ? err.message : String(err), resultUnknown: false }
}

/** Did a write / mkdir / delete fail in a way that says nothing about whether it
 *  happened? True for the server's own `result_unknown` flag, and for any answer
 *  that is not the server's (a network error, a proxy 502/503/504 page): the
 *  request may have reached the runner. The caller refreshes instead of saying
 *  "failed". */
export function mutationResultUnknown(err: unknown): boolean {
  const f = fsFailure(err)
  if (f.resultUnknown) return true
  if (f.code !== null) return false
  if (err instanceof ApiError) return err.status >= 500
  return true // fetch rejected: the connection dropped, maybe after sending
}

/** Offline or a runner too old to browse: say so, never an empty folder. */
export function isRunnerUnavailable(err: unknown): boolean {
  const code = fsFailure(err).code
  return code === 'agent_offline' || code === 'runner_too_old'
}

function fsPath(agentId: string, route: string, path: string): string {
  return `/agents/${encodeURIComponent(agentId)}/fs/${route}?path=${encodeURIComponent(path)}`
}

export async function listAgentFolder(agentId: string, path: string): Promise<FsListing> {
  return get<FsListing>(fsPath(agentId, 'list', path))
}

export async function readAgentFile(agentId: string, path: string): Promise<FsFile> {
  return get<FsFile>(fsPath(agentId, 'file', path))
}

export async function downloadAgentFile(agentId: string, path: string): Promise<Blob> {
  return getFile(fsPath(agentId, 'download', path))
}

export async function writeAgentFile(agentId: string, path: string, content: Blob | ArrayBuffer): Promise<FsEntry> {
  const response = await putFile(fsPath(agentId, 'file', path), content)
  return ((await response.json()) as { entry: FsEntry }).entry
}

export async function makeAgentFolder(agentId: string, path: string): Promise<FsEntry> {
  return (await post<{ entry: FsEntry }>(fsPath(agentId, 'folder', path))).entry
}

export async function deleteAgentEntry(agentId: string, path: string): Promise<void> {
  await del<{ deleted: string }>(fsPath(agentId, 'entry', path))
}

/** `a/b` + `c` → `a/b/c`; `''` is the home folder. */
export function joinFsPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** `a/b/c` → `a/b`; `a` → `''`. */
export function parentFsPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}
