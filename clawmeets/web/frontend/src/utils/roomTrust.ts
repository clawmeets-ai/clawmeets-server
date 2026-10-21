import type { ParticipantInfo } from '../api/endpoints/hub'
import type { ChatFileEvent, ChatMessage, Chatroom, Project } from '../types'

/**
 * Who in a room is outside, decided in one place. Every room surface asks
 * here; none decides for itself. Pure, so the rule is tested on its own.
 *
 * The contract's fail-closed rule (models/chatroom.py ParticipantInfo): an
 * author is INSIDE only when it is the server ('system'), the project's
 * created_by, or listed in participant_info with `outside: false`. Anyone
 * else is outside: `outside: true`, or a sender missing from the list. `kind`
 * is never read for trust ('user' means any person, not "you"); it only picks
 * the stand-in chip.
 *
 * A room with no participant_info (still loading, failed, or a partial
 * Chatroom from some other payload) is treated as an empty list: everyone but
 * the server and created_by is outside. The server always sends the field, so
 * there is no older-server case to allow for. Hub threads are fenced whole by
 * useUntrustedBodies either way; hooks/useRoomTrust joins the two.
 */

/** The server's own note authors (provenance.SYSTEM_AUTHORS). */
export const SYSTEM_AUTHORS: ReadonlySet<string> = new Set(['system', ''])

export const isSystemAuthor = (authorId: string): boolean => SYSTEM_AUTHORS.has(authorId)

type TrustRoom = Pick<Chatroom, 'participant_info'>

function infoById(room: TrustRoom | undefined): Map<string, ParticipantInfo> {
  return new Map((room?.participant_info ?? []).map((p) => [p.id, p]))
}

/** Builds the per-room predicate once (MessageList calls it per group). */
export function outsideAuthorRule(
  room: TrustRoom | undefined,
  ownerId: string | undefined,
): (authorId: string) => boolean {
  const info = infoById(room)
  return (authorId) => {
    if (isSystemAuthor(authorId)) return false
    if (ownerId && authorId === ownerId) return false
    return info.get(authorId)?.outside !== false
  }
}

/** Is this author outside? See the module comment for the rule. */
export function isOutsideAuthor(room: TrustRoom | undefined, ownerId: string | undefined, authorId: string): boolean {
  return outsideAuthorRule(room, ownerId)(authorId)
}

/** The room's hub stand-ins (retained agents bridged in). */
export function standIns(room: TrustRoom | undefined): ParticipantInfo[] {
  return (room?.participant_info ?? []).filter((p) => p.kind === 'hub_stand_in')
}

/**
 * Does this room take outside messages, so its owner may stop them? Any
 * outside participant (a stand-in, another account's agent or person, a
 * requester), a hub DM thread, or a room already stopped (so it can be
 * reopened).
 */
export function roomTakesOutsideMessages(
  room: Pick<Chatroom, 'participant_info' | 'flow'> | undefined,
  project: Pick<Project, 'hub_target'> | undefined,
): boolean {
  if (!room) return false
  if (room.flow?.inbound_flow === 'stopped') return true
  if (project?.hub_target) return true
  return (room.participant_info ?? []).some((p) => p.outside)
}

/**
 * Could content of unknown authorship in this room be from outside? Yes when
 * any participant is outside, and also when the room or its participant list
 * is missing: an unknown list fails closed, as outsideAuthorRule does.
 */
export function anyOutsideParticipant(room: TrustRoom | undefined): boolean {
  if (!room?.participant_info) return true
  return room.participant_info.some((p) => p.outside)
}

/**
 * The names of the room's files whose content came from outside: a file is
 * outside when its newest file event's author is outside. A file with no event
 * in the loaded log is outside when anyOutsideParticipant says so (fail
 * closed: its author is unknown).
 */
export function outsideFileNames(
  room: TrustRoom | undefined,
  ownerId: string | undefined,
  fileNames: readonly string[],
  fileEvents: readonly ChatFileEvent[],
): Set<string> {
  const outside = outsideAuthorRule(room, ownerId)
  const lastEvent = new Map<string, ChatFileEvent>()
  for (const e of fileEvents) lastEvent.set(e.filename, e)
  const anyOutside = anyOutsideParticipant(room)
  const out = new Set<string>()
  for (const name of fileNames) {
    const e = lastEvent.get(name)
    // A write stamped outside_isolated stays outside for good.
    if (e === undefined ? anyOutside : e.outside_isolated || outside(e.from_participant_id)) out.add(name)
  }
  return out
}

/** The stand-in ids a message addresses (expects_response_from ∩ stand-ins). */
export function addressedStandIns(msg: Pick<ChatMessage, 'expects_response_from'>, room: TrustRoom | undefined): string[] {
  const ids = new Set(standIns(room).map((p) => p.id))
  return (msg.expects_response_from ?? []).filter((id) => ids.has(id))
}
