import { get, post, delNoContent } from '../client'
import type { ChatLogEntry, ChatMessage } from '../../types'
import type { HeldForReview } from './hub'
import { filesToAttachments } from '../attachments'

export async function getMessages(
  projectId: string,
  chatroomName: string,
  since?: string
): Promise<ChatLogEntry[]> {
  const path = since
    ? `/projects/${projectId}/chatrooms/${chatroomName}/messages?since=${encodeURIComponent(since)}`
    : `/projects/${projectId}/chatrooms/${chatroomName}/messages`
  return get<ChatLogEntry[]>(path)
}

export async function sendMessage(
  projectId: string,
  chatroomName: string,
  message: Omit<ChatMessage, 'id' | 'ts'>
): Promise<ChatMessage> {
  return post<ChatMessage>(
    `/projects/${projectId}/chatrooms/${chatroomName}/messages`,
    message
  )
}

export interface UserMessagePayload {
  content: string
  // Addressing is now done via @mentions in content
  // The server parses @agent-name mentions and populates expects_response_from
  // Optional staged files delivered atomically with the message.
  files?: File[]
  /**
   * Optional per-request model override (model-config-selection-revamp, spec #3):
   * the NAME of a model config on the responding agent, sent as
   * `model_config_name`. The single-agent composers (DMs / My Desk) set this via
   * `sendDMMessage`; multi-agent project rooms (this path) leave it unset (plan
   * A2 — no single target agent to override), so each agent uses its own default.
   * Unknown/null ⇒ silent server-side fallback, never an error.
   */
  modelConfigName?: string | null
}

export async function sendUserMessage(
  projectId: string,
  chatroomName: string,
  payload: UserMessagePayload
): Promise<ChatMessage | HeldForReview> {
  const { content, files, modelConfigName } = payload
  const body: Record<string, unknown> = { content }
  if (files && files.length > 0) body.files = await filesToAttachments(files)
  if (modelConfigName) body.model_config_name = modelConfigName
  // 202 answers HeldForReview: stored for delivery later. Never resend it.
  return post<ChatMessage | HeldForReview>(
    `/projects/${projectId}/chatrooms/${chatroomName}/user-message`,
    body
  )
}

export interface CancelChatroomResponse {
  delivered: boolean
  message_id: string
}

export async function cancelChatroomInvocation(
  projectId: string,
  chatroomName: string,
  agentId: string
): Promise<CancelChatroomResponse> {
  return post<CancelChatroomResponse>(
    `/projects/${projectId}/chatrooms/${chatroomName}/cancel`,
    { agent_id: agentId }
  )
}

export interface ActiveWorkEntry {
  project_id: string
  project_name: string
  chatroom_name: string
  active_participants: string[]
}

export async function getActiveWork(): Promise<{ active: ActiveWorkEntry[] }> {
  return get<{ active: ActiveWorkEntry[] }>('/me/active-work')
}

export async function clearChatroomHistory(
  projectId: string,
  chatroomName: string
): Promise<void> {
  return delNoContent(
    `/projects/${projectId}/chatrooms/${chatroomName}/messages`
  )
}
