// Display-name mapping for chatrooms.
//
// The system name (the routing key in URLs and changelog payloads) stays as-is;
// only the label we render in the sidebar / chatroom header passes through here.
// `user-communication` reads as "coordinator" because that's what the room is
// for — the user's direct line to the project's coordinator agent.

export function getChatroomDisplayName(name: string): string {
  if (name.startsWith('user-communication')) return 'coordinator'
  return name
}
