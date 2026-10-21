import { get, put, del } from '../client'

export interface ReflectionSchedule {
  user_id: string
  username: string
  cron_expression: string
  timezone: string
  is_active: boolean
  created_at: string
  last_fired_at: string | null
  next_fire_at: string
}

export async function getReflectionSchedule(): Promise<ReflectionSchedule | null> {
  return get<ReflectionSchedule | null>('/account/reflection-schedule')
}

export async function setReflectionSchedule(
  cron_expression: string,
  is_active: boolean = true,
  timezone: string = 'UTC',
): Promise<ReflectionSchedule> {
  return put<ReflectionSchedule>('/account/reflection-schedule', {
    cron_expression,
    is_active,
    timezone,
  })
}

export async function deleteReflectionSchedule(): Promise<{ deactivated: boolean }> {
  return del<{ deactivated: boolean }>('/account/reflection-schedule')
}
