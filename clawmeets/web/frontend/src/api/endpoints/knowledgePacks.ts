import { get, post, put, del } from '../client'

/** A single file inside a knowledge pack. Content is the file's raw bytes,
 *  base64-encoded for transport. The frontend decides per-file (by extension)
 *  whether to UTF-8-decode for display. */
export interface PackFile {
  content_b64: string
  /** Optional one-line "consult when ..." hint. Surfaces per-file in the
   *  installed-pack index (memory/KNOWLEDGE_PACKS.md) so the agent can pick
   *  the right file inside a multi-file pack. */
  description?: string
}

export interface KnowledgePack {
  slug: string
  name: string
  description: string
  /** Keys are forward-slash relative paths (may be nested). */
  files: Record<string, PackFile>
  created_at: string
  updated_at: string
}

export interface KnowledgePackInput {
  slug: string
  name: string
  description?: string
  /** Optional seed files. Keys may contain `/` for nested layout. */
  files?: Record<string, PackFile>
}

export interface KnowledgePackPatch {
  name?: string
  description?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Text ↔ base64 helpers
// ─────────────────────────────────────────────────────────────────────────────

/** UTF-8 text → base64 (uses TextEncoder so multi-byte characters survive). */
export function encodeTextToB64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  // btoa expects a binary string; build it in chunks to avoid stack overflow
  // on large inputs (apply has an argument limit ~ 65k on most engines).
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** base64 → UTF-8 text. Throws if the bytes aren't valid UTF-8. */
export function decodeB64ToText(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** Approximate base64 → byte length without decoding. Off by 0–2 bytes for
 *  trailing padding; cheap enough to call per-row for size display. */
export function b64ByteLength(b64: string): number {
  if (!b64) return 0
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(b64.length * 3 / 4) - padding)
}

/** ArrayBuffer → base64. Used after FileReader.readAsArrayBuffer. */
export function bytesToB64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** URL-encode each segment of a forward-slash relative path while preserving
 *  the slashes. FastAPI's `{filepath:path}` converter accepts the slashes. */
function encodeFilepath(filepath: string): string {
  return filepath.split('/').map(encodeURIComponent).join('/')
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────────────

export async function getKnowledgePacks(): Promise<KnowledgePack[]> {
  return get<KnowledgePack[]>('/knowledge-packs')
}

export async function getKnowledgePack(slug: string): Promise<KnowledgePack> {
  return get<KnowledgePack>(`/knowledge-packs/${slug}`)
}

export async function createKnowledgePack(pack: KnowledgePackInput): Promise<KnowledgePack> {
  // Server wants `files: dict[str, str]` (path → base64 string), not the
  // wrapped PackFile shape. Unwrap on the way out.
  const body: {
    slug: string
    name: string
    description?: string
    files?: Record<string, string>
    file_descriptions?: Record<string, string>
  } = {
    slug: pack.slug,
    name: pack.name,
    description: pack.description,
  }
  if (pack.files) {
    body.files = Object.fromEntries(
      Object.entries(pack.files).map(([path, f]) => [path, f.content_b64]),
    )
    const fdesc = Object.fromEntries(
      Object.entries(pack.files)
        .filter(([, f]) => (f.description ?? '').trim())
        .map(([path, f]) => [path, f.description as string]),
    )
    if (Object.keys(fdesc).length > 0) body.file_descriptions = fdesc
  }
  return post<KnowledgePack>('/knowledge-packs', body)
}

export async function updateKnowledgePack(slug: string, patch: KnowledgePackPatch): Promise<KnowledgePack> {
  return put<KnowledgePack>(`/knowledge-packs/${slug}`, patch)
}

export async function deleteKnowledgePack(slug: string): Promise<{ status: string; slug: string; uninstalled_from: string[] }> {
  return del(`/knowledge-packs/${slug}`)
}

/** Add or replace a single file inside a pack. `filepath` may be nested
 *  (forward-slash separated). `contentB64` is the file's raw bytes
 *  base64-encoded. */
export async function upsertKnowledgePackFile(
  slug: string,
  filepath: string,
  contentB64: string,
  description?: string,
): Promise<KnowledgePack> {
  const body: { content_b64: string; description?: string } = { content_b64: contentB64 }
  if (description !== undefined) body.description = description
  return put<KnowledgePack>(
    `/knowledge-packs/${slug}/files/${encodeFilepath(filepath)}`,
    body,
  )
}

/** Delete a single file from a pack. `filepath` may be nested. */
export async function deleteKnowledgePackFile(
  slug: string,
  filepath: string,
): Promise<KnowledgePack> {
  return del<KnowledgePack>(
    `/knowledge-packs/${slug}/files/${encodeFilepath(filepath)}`,
  )
}

export async function getAgentKnowledgePacks(agentId: string): Promise<KnowledgePack[]> {
  const data = await get<{ installed_packs: KnowledgePack[] }>(`/agents/${agentId}/knowledge-packs`)
  return data.installed_packs
}

export async function installKnowledgePacks(
  agentId: string,
  packs: string[],
): Promise<{ installed_packs: string[]; added: string[] }> {
  return post(`/agents/${agentId}/knowledge-packs`, { packs })
}

export async function uninstallKnowledgePack(
  agentId: string,
  slug: string,
): Promise<{ installed_packs: string[]; removed: string }> {
  return del(`/agents/${agentId}/knowledge-packs/${slug}`)
}
