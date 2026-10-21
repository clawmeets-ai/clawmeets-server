import type {
  AgentUsage, BlockedDeployment, BridgeDelivery, ChatroomFlowChangedPayload, ConversationTarget, Delivery,
  FileNotFoundDetail, HeldForReview, HubAgent, HubAgentDetail, HubAgentPage, HubBridgeDeliveryPayload, HubChannel,
  HubChannelStatusPayload, HubConfig, HubContactFields, HubEnrollment, HubDeliveryStatePayload, HubMessage, HubMessagePage,
  HubTarget, LocalAgentDetail, ParticipantHub, ParticipantInfo, PayloadTooLarge, RateLimitedDetail, RetainedAgent,
  RoomFlow, SendMessageResponse, SendUnreachableDetail, TargetOfflineDetail, UsageWindowOut,
} from './hub'

/**
 * The key lists of every hub type that mirrors a model of the frozen browser
 * contract. Read only by `hub.contract.test.ts`, which compares them with
 * `tests/server/hub_contract_snapshot.json`; nothing in the app imports this
 * file, so it never reaches the bundle.
 *
 * `tsc` keeps each list honest against its TypeScript type: `Exactly` fails to
 * compile when a key is added to the interface but not to the list, and
 * `satisfies` when the list names a key the interface lacks. The test then
 * keeps the lists honest against the snapshot. Together a field added on
 * either side fails CI.
 */

/** Keys that may be absent from the JSON (`?:` in TypeScript). */
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T]
/** Keys whose value may be null. */
type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T]

type Exactly<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : { missing: Exclude<All, Listed> }

interface ModelKeys {
  keys: readonly string[]
  optional: readonly string[]
  nullable: readonly string[]
}

function model<T>() {
  return <
    const K extends readonly (keyof T & string)[],
    const O extends readonly (OptionalKeys<T> & string)[],
    const N extends readonly (NullableKeys<T> & string)[],
  >(
    m: { keys: K; optional: O; nullable: N },
    ..._exact: [
      Exactly<keyof T, K[number]>,
      Exactly<OptionalKeys<T>, O[number]>,
      Exactly<NullableKeys<T>, N[number]>,
    ]
  ): ModelKeys => m
}

const HUB_AGENT_KEYS = [
  'hub_agent_id', 'name', 'deployment_name', 'deployment_label', 'deployment_fingerprint',
  'current_fingerprint', 'deployment_url', 'deployment_url_verified', 'first_contact', 'description',
  'capabilities', 'avatar_url', 'agent_online', 'deployment_connected', 'accepting_messages',
  'needs_approval', 'last_seen_at', 'listed_at', 'listing_refreshed_at', 'listing_age_s', 'is_local', 'retained',
] as const
const HUB_AGENT_NULLABLE = ['deployment_url', 'avatar_url', 'last_seen_at'] as const

/** Snapshot model name → the TypeScript type's keys. */
export const HUB_MODEL_KEYS: Record<string, ModelKeys> = {
  HubEnrollment: model<HubEnrollment>()({
    keys: [
      'server', 'owner', 'email_masked', 'becomes_contact', 'contact_is_you', 'tos_version', 'tos_url',
      'code_expires_at',
    ],
    optional: [],
    nullable: ['email_masked', 'code_expires_at'],
  }, true, true, true),
  HubConfigOut: model<HubConfig>()({
    keys: [
      'mode', 'hub_url', 'hub_url_is_default', 'deployment_id', 'deployment_connected', 'last_connected_at',
      'protocol_version', 'deployment_fingerprint', 'deployment_name', 'registration', 'hub_link',
      'channels_enabled', 'sender_label', 'max_file_bytes', 'max_files', 'max_envelope_bytes', 'max_text_bytes',
    ],
    optional: [],
    nullable: ['deployment_id', 'last_connected_at', 'deployment_fingerprint', 'deployment_name'],
  }, true, true, true),
  HubChannel: model<HubChannel>()({
    keys: [
      'enabled', 'status', 'status_detail', 'reject_reason', 'eligible', 'ineligible_reason', 'listed_as',
      'key_last4', 'rotate_by', 'last_success_at', 'next_retry_at', 'hub_url', 'hub_url_is_default',
      'open_conversations', 'in_flight_messages', 'daily_run_cap', 'runs_today', 'runs_reset_at',
      'isolation', 'held_conversations', 'local_conversations', 'owner_isolated', 'public',
    ],
    optional: ['isolation', 'held_conversations', 'local_conversations', 'owner_isolated', 'public'],
    nullable: [
      'status_detail', 'reject_reason', 'ineligible_reason', 'listed_as', 'key_last4', 'rotate_by',
      'last_success_at', 'next_retry_at',
    ],
  }, true, true, true),
  BlockedDeployment: model<BlockedDeployment>()({
    keys: ['deployment_fingerprint', 'current_fingerprint', 'deployment_name', 'created_at'],
    optional: ['current_fingerprint'],
    nullable: [],
  }, true, true, true),
  HubAgent: model<HubAgent>()({
    keys: HUB_AGENT_KEYS, optional: ['current_fingerprint', 'retained'], nullable: HUB_AGENT_NULLABLE,
  }, true, true, true),
  HubAgentDetail: model<HubAgentDetail>()({
    keys: [...HUB_AGENT_KEYS, 'listed', 'served_from'],
    optional: ['current_fingerprint', 'retained'],
    nullable: HUB_AGENT_NULLABLE,
  }, true, true, true),
  HubAgentPage: model<HubAgentPage>()({
    keys: ['agents', 'next_cursor', 'served_from', 'cache_age_s', 'cached_at'],
    optional: [],
    nullable: ['next_cursor', 'cache_age_s', 'cached_at'],
  }, true, true, true),
  HubTarget: model<HubTarget>()({
    keys: [
      'hub_agent_id', 'display', 'name', 'deployment_name', 'deployment_label', 'deployment_fingerprint',
      'current_fingerprint', 'deployment_url', 'deployment_url_verified', 'listed', 'closed_reason', 'closed_at',
    ],
    optional: ['current_fingerprint'],
    nullable: ['deployment_url', 'closed_reason', 'closed_at'],
  }, true, true, true),
  ConversationTarget: model<ConversationTarget>()({
    keys: [
      'agent_online', 'deployment_connected', 'send_warning', 'deployment_name', 'deployment_fingerprint',
      'current_fingerprint', 'deployment_url', 'deployment_url_verified', 'first_contact',
    ],
    optional: ['current_fingerprint'],
    nullable: ['send_warning', 'deployment_url'],
  }, true, true, true),
  Delivery: model<Delivery>()({
    keys: [
      'message_id', 'state', 'waiting_reason', 'failed_reason', 'detail', 'retry_at', 'held_for_approval',
      'delivered_late', 'attempts', 'state_at', 'expires_at',
    ],
    optional: [],
    nullable: ['waiting_reason', 'failed_reason', 'detail', 'retry_at'],
  }, true, true, true),
  SendMessageResponse: model<SendMessageResponse>()({
    keys: ['message_id', 'delivery'], optional: [], nullable: [],
  }, true, true, true),
  PayloadTooLarge: model<PayloadTooLarge>()({
    keys: ['limit', 'max', 'actual', 'file_id'], optional: ['file_id'], nullable: ['file_id'],
  }, true, true, true),
  LocalAgentDetail: model<LocalAgentDetail>()({
    keys: ['use_path', 'agent_name'], optional: [], nullable: [],
  }, true, true, true),
  RateLimitedDetail: model<RateLimitedDetail>()({
    keys: ['retry_after'], optional: [], nullable: [],
  }, true, true, true),
  TargetOfflineDetail: model<TargetOfflineDetail>()({
    keys: ['send_warning'], optional: [], nullable: [],
  }, true, true, true),
  SendUnreachableDetail: model<SendUnreachableDetail>()({
    keys: ['last_connected_at'], optional: [], nullable: ['last_connected_at'],
  }, true, true, true),
  FileNotFoundDetail: model<FileNotFoundDetail>()({
    keys: ['file_id'], optional: [], nullable: [],
  }, true, true, true),
  HubDeliveryStatePayload: model<HubDeliveryStatePayload>()({
    keys: ['project_id', 'delivery'], optional: [], nullable: [],
  }, true, true, true),
  HubChannelStatusPayload: model<HubChannelStatusPayload>()({
    keys: ['agent_full_name', 'channel'], optional: [], nullable: [],
  }, true, true, true),
  // The snapshot marks the first three required: they are, on a Hub row. The
  // same fields are ABSENT on every other channel's rows, which share the
  // TypeScript type, so here they are optional. The test knows this exception.
  HubContactFields: model<HubContactFields>()({
    keys: ['remote_username', 'deployment_name', 'deployment_fingerprint', 'via_agent'],
    optional: ['remote_username', 'deployment_name', 'deployment_fingerprint', 'via_agent'],
    nullable: ['remote_username', 'deployment_name', 'deployment_fingerprint', 'via_agent'],
  }, true, true, true),
  HubBridgeDeliveryPayload: model<HubBridgeDeliveryPayload>()({
    keys: ['project_id', 'chatroom_name', 'delivery'], optional: [], nullable: [],
  }, true, true, true),
  ChatroomFlowChangedPayload: model<ChatroomFlowChangedPayload>()({
    keys: ['project_id', 'chatroom_name', 'flow'], optional: [], nullable: [],
  }, true, true, true),
  RetainedAgent: model<RetainedAgent>()({
    keys: [
      'hub_agent_id', 'name', 'deployment_name', 'deployment_fingerprint', 'description', 'capabilities',
      'retained_at', 'state', 'live_rooms', 'home_folder_browsable', 'is_local', 'agent_id',
    ],
    optional: ['home_folder_browsable', 'is_local', 'agent_id'],
    nullable: ['agent_id'],
  }, true, true, true),
  BridgeDelivery: model<BridgeDelivery>()({
    keys: ['room_message_id', 'hub_agent_id', 'state', 'reason'], optional: ['reason'], nullable: ['reason'],
  }, true, true, true),
  ParticipantHub: model<ParticipantHub>()({
    keys: [
      'hub_agent_id', 'name', 'deployment_name', 'deployment_fingerprint', 'bridge_state', 'inactive_reason',
    ],
    optional: [
      'hub_agent_id', 'name', 'deployment_name', 'deployment_fingerprint', 'bridge_state', 'inactive_reason',
    ],
    nullable: ['hub_agent_id', 'name', 'deployment_name', 'deployment_fingerprint', 'inactive_reason'],
  }, true, true, true),
  ParticipantInfo: model<ParticipantInfo>()({
    keys: ['id', 'kind', 'outside', 'hub'], optional: ['hub'], nullable: ['hub'],
  }, true, true, true),
  RoomFlow: model<RoomFlow>()({
    keys: ['inbound_flow', 'stopped_by', 'stopped_at', 'reason', 'held_count'],
    optional: ['inbound_flow', 'stopped_by', 'stopped_at', 'reason', 'held_count'],
    nullable: ['stopped_by', 'stopped_at', 'reason'],
  }, true, true, true),
  HeldForReview: model<HeldForReview>()({
    keys: ['held', 'reason', 'message'], optional: [], nullable: [],
  }, true, true, true),
  UsageWindowOut: model<UsageWindowOut>()({
    keys: ['name', 'used', 'limit', 'resets_at'], optional: [], nullable: [],
  }, true, true, true),
  AgentUsage: model<AgentUsage>()({
    keys: ['windows'], optional: [], nullable: [],
  }, true, true, true),
  HubMessage: model<HubMessage>()({
    keys: ['id', 'author_kind', 'ts', 'state', 'text'], optional: ['state', 'text'], nullable: ['state', 'text'],
  }, true, true, true),
  HubMessagePage: model<HubMessagePage>()({
    keys: ['messages', 'text_withheld'], optional: [], nullable: [],
  }, true, true, true),
}

/** Models whose TypeScript optionality deliberately differs from the snapshot,
 *  each with the fields the SNAPSHOT itself marks optional (the rest it marks
 *  required, and TypeScript makes every field optional). */
export const OPTIONALITY_EXCEPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['HubContactFields', ['via_agent']],
])

/** `Model.field` for every timestamp: each must be typed EpochSeconds and
 *  converted with epochToDate. Checked against the snapshot's
 *  `format: epoch-seconds` fields. */
export const EPOCH_FIELDS: readonly string[] = [
  'BlockedDeployment.created_at',
  'Delivery.expires_at', 'Delivery.retry_at', 'Delivery.state_at',
  'HubAgent.last_seen_at', 'HubAgent.listed_at', 'HubAgent.listing_refreshed_at',
  'HubAgentDetail.last_seen_at', 'HubAgentDetail.listed_at', 'HubAgentDetail.listing_refreshed_at',
  'HubAgentPage.cached_at',
  'HubChannel.last_success_at', 'HubChannel.next_retry_at', 'HubChannel.rotate_by', 'HubChannel.runs_reset_at',
  'HubConfigOut.last_connected_at',
  'HubEnrollment.code_expires_at',
  'HubMessage.ts',
  'HubTarget.closed_at',
  'RetainedAgent.retained_at',
  'RoomFlow.stopped_at',
  'SendUnreachableDetail.last_connected_at',
  'UsageWindowOut.resets_at',
]

/** Snapshot models with no mirrored response type: request bodies (built by
 *  the call functions), wrappers the call functions unwrap, and the event
 *  envelopes whose payloads are mirrored. A model the snapshot gains that is
 *  in neither list fails the contract test until the browser decides. */
export const UNMIRRORED_MODELS: readonly string[] = [
  'BlockRequest', 'BlockedList', 'DeliveryList', 'DisableRequest', 'EnableRequest', 'HubAgentSearch',
  'HubChannelStatusEvent', 'HubDeliveryStateEvent', 'HubProjectFields', 'ReportAccepted', 'ReportRequest',
  'SendMessageRequest', 'StartConversationRequest', 'StartConversationResponse',
  'RetainedList', 'BridgeDeliveryList', 'HubBridgeDeliveryEvent', 'ChatroomFlowChangedEvent',
  // plan-owner-isolation section 8 (frozen): the "runs in its own environment"
  // switch addendum mirrors these; until then they are deliberately unmirrored.
  'OwnerIsolationRefusal', 'OwnerIsolationConfirm', 'OwnerIsolationStatus', 'OwnerIsolationRequest',
  'ClearHostRequest', 'OwnerIsolationRefusedDetail',
  // hub enrollment: request bodies, built by the call functions
  'EnrollRequest', 'EnrollConfirm',
]
