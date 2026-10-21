import { get, post, put, del } from '../client'

export interface ScheduledMessage {
  id: string
  user_id: string
  username: string
  project_id: string
  chatroom_name: string
  content: string
  cron_expression: string
  timezone: string
  end_at: string | null
  created_at: string
  last_fired_at: string | null
  next_fire_at: string
  is_active: boolean
}

export interface CreateScheduledMessagePayload {
  project_id: string
  chatroom_name: string
  content: string
  cron_expression: string
  timezone: string
  start_at?: string
  end_at?: string
}

export async function createScheduledMessage(
  payload: CreateScheduledMessagePayload
): Promise<ScheduledMessage> {
  return post<ScheduledMessage>('/scheduled-messages', payload)
}

export interface UpdateScheduledMessagePayload {
  project_id: string
  chatroom_name: string
  content: string
  cron_expression: string
  timezone: string
  end_at?: string
}

export async function updateScheduledMessage(
  id: string,
  payload: UpdateScheduledMessagePayload
): Promise<ScheduledMessage> {
  return put<ScheduledMessage>(`/scheduled-messages/${id}`, payload)
}

export async function getScheduledMessages(
  activeOnly: boolean = true
): Promise<ScheduledMessage[]> {
  const params = activeOnly ? '' : '?active_only=false'
  return get<ScheduledMessage[]>(`/scheduled-messages${params}`)
}

export async function cancelScheduledMessage(id: string): Promise<void> {
  await del(`/scheduled-messages/${id}`)
}
