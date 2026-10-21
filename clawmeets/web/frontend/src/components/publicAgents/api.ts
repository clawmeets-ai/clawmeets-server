/**
 * The account page's server calls: the account's public directory
 * (`/api/public/users/…`, served by `server/routes/public_agents.py`). Chats
 * themselves run in the web chat widget (`widget.ts`). No auth, no cookies.
 */

export const BASE = import.meta.env.DEV ? '/api' : ''

export interface PublicAccount {
  handle: string
  display_name: string
  bio: string
  website: string | null
  avatar_url: string | null
}

export interface PublicTeam {
  id: string
  name: string
  description: string
}

export interface PublicAgent {
  id: string
  display_name: string
  team_id: string | null
  description: string
  skills: string[]
  takes_direct_requests: boolean
  online: boolean
  starter_questions: string[]
  /** The widget key this page chats with (it lists this server; public by design). */
  chat_key: string
}

export interface PublicDirectory {
  account: PublicAccount
  teams: PublicTeam[]
  agents: PublicAgent[]
  default_agent: string | null
}

export async function fetchDirectory(username: string): Promise<PublicDirectory> {
  const r = await fetch(`${BASE}/api/public/users/${encodeURIComponent(username)}/agents`, {
    credentials: 'omit',
  })
  if (!r.ok) throw new Error(`http_${r.status}`)
  return r.json()
}

/** Account page and chat URLs — root-relative, outside the `/app` SPA. */
const enc = encodeURIComponent
export const accountUrl = (username: string) => `/users/${enc(username)}/agents/`
export const chatUrl = (username: string, agent: string) =>
  `/users/${enc(username)}/agents/${enc(agent)}/chat`
