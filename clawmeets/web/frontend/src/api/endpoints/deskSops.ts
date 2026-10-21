import { get, post, patch, del } from '../client'

/**
 * One stored prompt in the user's SOP library. `body` carries typed blanks
 * written `{{Label|kind:config}}` (see `components/composer/placeholders.ts`);
 * they are stored un-substituted and become fillable chips in the composer.
 */
export interface DeskSop {
  id: string
  owner_user_id: string
  title: string
  /** Default recipient. Both are stored so the card still labels correctly
   *  after a rename or removal; the UI re-resolves against the live roster. */
  agent_id?: string | null
  agent_name?: string | null
  body: string
  created_at: string
  updated_at: string
}

/** What the authoring dialog produces. `id` present ⇒ edit in place. */
export interface SopDraft {
  id?: string
  title: string
  body: string
  agent_id: string | null
  agent_name: string | null
}

export async function getDeskSops(): Promise<DeskSop[]> {
  return get<DeskSop[]>('/me/desk/sops')
}

export async function createSop(draft: Omit<SopDraft, 'id'>): Promise<DeskSop> {
  return post<DeskSop>('/me/desk/sops', draft)
}

/**
 * Partial update. `agent_id` / `agent_name` are three-way server-side: omit
 * the key to leave the stored value alone, send `null` to clear it, send a
 * string to overwrite. The dialog always sends both, so an unassigned SOP
 * round-trips as an explicit null.
 */
export async function patchSop(
  id: string,
  fields: Partial<Omit<SopDraft, 'id'>>,
): Promise<DeskSop> {
  return patch<DeskSop>(`/me/desk/sops/${id}`, fields)
}

export async function deleteSop(id: string): Promise<void> {
  await del(`/me/desk/sops/${id}`)
}
