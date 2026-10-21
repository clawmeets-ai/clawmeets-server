import { post } from '../client'
import type { ChatMessage } from '../../types'
import type { HeldForReview } from './hub'
import { filesToAttachments } from '../attachments'

/**
 * Send a user message to a DM chatroom, optionally with staged attachments
 * delivered atomically with the message.
 * The server will automatically set expects_response_from to the DM agent.
 *
 * `modelConfigName` (model-config-selection-revamp, spec #3) is the name of a
 * model config on the responding agent, sent as `model_config_name` on the
 * UserMessageBody to override that agent's default model for THIS turn only.
 * Omitted/null/unknown ⇒ the server silently falls back to the agent default
 * (it never errors), so we only attach the key when a name is present.
 */
export async function sendDMMessage(
  projectId: string,
  chatroomName: string,
  content: string,
  files?: File[],
  modelConfigName?: string | null
): Promise<ChatMessage | HeldForReview> {
  const body: Record<string, unknown> = { content }
  if (files && files.length > 0) body.files = await filesToAttachments(files)
  if (modelConfigName) body.model_config_name = modelConfigName
  // 202 answers HeldForReview: stored for delivery later. Never resend it.
  return post<ChatMessage | HeldForReview>(
    `/projects/${projectId}/chatrooms/${chatroomName}/user-message`,
    body
  )
}

/**
 * Idempotent ensure of the caller's per-agent DM project for one of their
 * own agents. Returns the `{username}-dm-{agent_short}` project; its
 * `user-communication` chatroom IS the DM thread.
 */
export async function ensureOwnDMProject(
  agentFullName: string,
): Promise<{ id: string; name: string }> {
  return post<{ id: string; name: string }>(
    `/me/dms/${encodeURIComponent(agentFullName)}/ensure`,
    {},
  )
}

/**
 * Create a NEW DM-thread project for one of the caller's own agents
 * (N threads per agent, ChatGPT/Claude model). Distinct from
 * `ensureOwnDMProject` (get-or-create ONE) — this always spins up a fresh
 * thread, materialized on the first message send. The returned project
 * carries `surface`/`display_name`/`last_modified`.
 *
 * `clientThreadKey` is an optional idempotency token: pass a per-draft UUID
 * so a double-send maps to a single thread instead of racing two creates.
 */
export async function createDMThread(
  agentFullName: string,
  clientThreadKey?: string,
): Promise<{ id: string; name: string }> {
  return post<{ id: string; name: string }>(
    `/me/dms/${encodeURIComponent(agentFullName)}/threads`,
    clientThreadKey ? { client_thread_key: clientThreadKey } : {},
  )
}

/**
 * Create a NEW Front Desk thread project for a foreign agent (N threads per
 * agent). Sibling of `createDMThread` — always mints a fresh
 * `{username}-fd-{short}-{uuid8}` project, materialized on the first message
 * send, with TunnelSubscriber lazily wiring a per-thread binding to the
 * responder side. `clientThreadKey` guards the double-send race.
 */
export async function createFDThread(
  agentFullName: string,
  clientThreadKey?: string,
): Promise<{ id: string; name: string }> {
  return post<{ id: string; name: string }>(
    `/me/fd/${encodeURIComponent(agentFullName)}/threads`,
    clientThreadKey ? { client_thread_key: clientThreadKey } : {},
  )
}

/**
 * Idempotent ensure of the caller's per-agent FD project for a foreign
 * agent. Returns the `{username}-fd-{agent_short}` project; its
 * `user-communication` chatroom IS the DM thread, with TunnelSubscriber
 * lazily wiring a binding to the responder side on the first send.
 */
export async function ensureFDProject(
  agentFullName: string,
): Promise<{ id: string; name: string }> {
  return post<{ id: string; name: string }>(
    `/me/fd/${encodeURIComponent(agentFullName)}/ensure`,
    {},
  )
}

/** The message(s) a Forward hands on. Names them only — the server loads the
 *  originals and writes the quote itself, so the text cannot change in transit. */
export interface ForwardSource {
  projectId: string
  chatroomName: string
  messageIds: string[]
  /** Which of the originals' attachments to carry; omitted ⇒ all of them. */
  includeFiles?: string[]
}

/**
 * Forward existing message(s) into a NEW DM thread with one of the caller's
 * own agents, so each hand-off starts clean instead of landing mid-conversation.
 * `note` is the user's own words above the quote (may be empty). The message
 * is posted as the user, so the recipient sees a two-party DM.
 *
 * `clientThreadKey` is the same double-send guard as `createDMThread`: a retry
 * with the same key reuses the thread instead of minting a second one.
 */
export async function forwardToOwnAgent(
  agentFullName: string,
  source: ForwardSource,
  note: string,
  clientThreadKey?: string,
): Promise<{ projectId: string; message: ChatMessage }> {
  const project = await createDMThread(agentFullName, clientThreadKey)
  const forward_of: Record<string, unknown> = {
    project_id: source.projectId,
    chatroom_name: source.chatroomName,
    message_ids: source.messageIds,
  }
  if (source.includeFiles) forward_of.include_files = source.includeFiles
  const message = await post<ChatMessage>(
    `/projects/${project.id}/chatrooms/user-communication/user-message`,
    { content: note, forward_of },
  )
  return { projectId: project.id, message }
}
