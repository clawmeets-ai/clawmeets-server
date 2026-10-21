import type {
  BridgeDelivery, Delivery, HubAgent, HubAgentDetail, HubChannel, HubConfig, HubEnrollment, HubTarget, ParticipantInfo,
  RetainedAgent, RoomFlow,
} from '../api/endpoints/hub'
import { ProjectStatus, type Project } from '../types'
import { ApiError } from '../api/client'

/**
 * Wire-shaped hub objects for tests, each a complete, valid answer of the
 * frozen contract with sensible defaults. Override only what a test is about.
 */

export const NOW_S = 1_760_000_000
export const FP_ACME = '3f9a1c2e5b7d9f00aa11bb22cc33dd44'
export const FP_OTHER = '9c01d7aa00000000ffffeeeeddddcccc'
export const OWN_FP = '11112222333344445555666677778888'

export function hubConfig(o: Partial<HubConfig> = {}): HubConfig {
  return {
    mode: 'full',
    hub_url: 'https://hub.clawmeets.ai',
    hub_url_is_default: true,
    deployment_id: 'dep-1',
    deployment_connected: true,
    last_connected_at: NOW_S - 30,
    protocol_version: 1,
    deployment_fingerprint: OWN_FP,
    deployment_name: 'clawmeets.ai',
    registration: 'active',
    hub_link: 'connected',
    channels_enabled: true,
    sender_label: 'carol @ clawmeets.ai',
    max_file_bytes: 10 * 1024 * 1024,
    max_files: 5,
    max_envelope_bytes: 25 * 1024 * 1024,
    max_text_bytes: 32 * 1024,
    ...o,
  }
}

export function hubChannel(o: Partial<HubChannel> = {}): HubChannel {
  return {
    enabled: false,
    status: 'off',
    status_detail: null,
    reject_reason: null,
    eligible: true,
    ineligible_reason: null,
    listed_as: null,
    key_last4: null,
    rotate_by: null,
    last_success_at: null,
    next_retry_at: null,
    hub_url: 'https://hub.clawmeets.ai',
    hub_url_is_default: true,
    open_conversations: 0,
    in_flight_messages: 0,
    daily_run_cap: 200,
    runs_today: 0,
    runs_reset_at: NOW_S + 3600,
    ...o,
  }
}

export function hubEnrollment(o: Partial<HubEnrollment> = {}): HubEnrollment {
  return {
    server: 'active',
    owner: 'none',
    email_masked: 'c***@example.com',
    becomes_contact: false,
    contact_is_you: false,
    tos_version: '2026-10',
    tos_url: 'https://hub.clawmeets.ai/terms',
    code_expires_at: null,
    ...o,
  }
}

export function hubAgent(o: Partial<HubAgent> = {}): HubAgent {
  const name = o.name ?? 'scout'
  const fp = o.deployment_fingerprint ?? FP_ACME
  return {
    hub_agent_id: `${fp.slice(0, 16)}~${name}`,
    name,
    deployment_name: 'acme.dev',
    deployment_label: 'Acme',
    deployment_fingerprint: fp,
    deployment_url: 'https://acme.dev',
    deployment_url_verified: true,
    first_contact: true,
    description: 'Finds things.',
    capabilities: ['research'],
    avatar_url: `/api/hub/agents/${fp.slice(0, 16)}~${name}/avatar`,
    agent_online: true,
    deployment_connected: true,
    accepting_messages: true,
    needs_approval: false,
    last_seen_at: NOW_S - 60,
    listed_at: NOW_S - 86400,
    listing_refreshed_at: NOW_S - 600,
    listing_age_s: 600,
    is_local: false,
    ...o,
  }
}

export function hubAgentDetail(o: Partial<HubAgentDetail> = {}): HubAgentDetail {
  return { ...hubAgent(o), listed: true, served_from: 'live', ...o }
}

export function hubTarget(o: Partial<HubTarget> = {}): HubTarget {
  const name = o.name ?? 'scout'
  const fp = o.deployment_fingerprint ?? FP_ACME
  return {
    hub_agent_id: `${fp.slice(0, 16)}~${name}`,
    display: `${name}@${o.deployment_name ?? 'acme.dev'}`,
    name,
    deployment_name: 'acme.dev',
    deployment_label: 'Acme',
    deployment_fingerprint: fp,
    deployment_url: 'https://acme.dev',
    deployment_url_verified: true,
    listed: true,
    closed_reason: null,
    closed_at: null,
    ...o,
  }
}

export function delivery(o: Partial<Delivery> = {}): Delivery {
  return {
    message_id: 'm1',
    state: 'sent_to_hub',
    waiting_reason: null,
    failed_reason: null,
    detail: null,
    retry_at: null,
    held_for_approval: false,
    delivered_late: false,
    attempts: 1,
    state_at: NOW_S,
    expires_at: NOW_S + 72 * 3600,
    ...o,
  }
}

export function hubProject(id: string, target: HubTarget | null, o: Partial<Project> = {}): Project {
  return {
    id,
    name: `carol-hub-${id}`,
    status: ProjectStatus.ACTIVE,
    coordinator_id: 'stand-in',
    request: '',
    chatrooms: ['user-communication'],
    participating_agents: [],
    created_at: '2026-10-01T00:00:00Z',
    surface: 'frontdesk',
    hub_target: target,
    ...o,
  }
}

export function retainedAgent(o: Partial<RetainedAgent> = {}): RetainedAgent {
  const name = o.name ?? 'scout'
  const fp = o.deployment_fingerprint ?? FP_ACME
  return {
    hub_agent_id: `${fp.slice(0, 16)}~${name}`,
    name,
    deployment_name: 'acme.dev',
    deployment_fingerprint: fp,
    description: 'Finds things.',
    capabilities: ['research'],
    retained_at: NOW_S - 3600,
    state: 'active',
    live_rooms: 0,
    home_folder_browsable: false,
    ...o,
  }
}

export function bridgeDelivery(o: Partial<BridgeDelivery> = {}): BridgeDelivery {
  return { room_message_id: 'm1', hub_agent_id: `${FP_ACME.slice(0, 16)}~scout`, state: 'queued', reason: null, ...o }
}

export function roomFlow(o: Partial<RoomFlow> = {}): RoomFlow {
  return { inbound_flow: 'open', stopped_by: null, stopped_at: null, reason: null, held_count: 0, ...o }
}

export function participantInfo(id: string, o: Partial<ParticipantInfo> = {}): ParticipantInfo {
  return { id, kind: 'agent', outside: false, hub: null, ...o }
}

/** A retained agent's stand-in in a workroom (`{fp16}~{name}`). */
export function standIn(name = 'scout', o: Partial<ParticipantInfo> = {}): ParticipantInfo {
  const id = `${FP_ACME.slice(0, 16)}~${name}`
  return {
    id,
    kind: 'hub_stand_in',
    outside: true,
    hub: {
      hub_agent_id: id, name, deployment_name: 'acme.dev', deployment_fingerprint: FP_ACME,
      bridge_state: 'active', inactive_reason: null,
    },
    ...o,
  }
}

/** For suites that render Settings → Channels but are not about the hub: the
 *  server answers /api/hub/config with 404 (an older server), so no Hub tab. */
export function withoutHubConfig<T extends object>(real: T): T {
  return { ...real, getHubConfig: () => Promise.reject(new ApiError(404, 'Not Found')) }
}
