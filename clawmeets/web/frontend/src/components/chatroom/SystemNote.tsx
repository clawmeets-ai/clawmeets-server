import type { ChatMessage } from '../../types'
import Timestamp from '../common/Timestamp'

/** A note the server wrote into the room (author 'system'): an agent that can
 *  no longer take part, a relay that failed. Free text with no machine-readable
 *  kind, so it is shown as written, as one quiet plain-text line. */
export default function SystemNote({ message }: { message: ChatMessage }) {
  return (
    <p
      className="mx-auto max-w-xl text-center text-xs text-gray-500 whitespace-pre-wrap"
      data-message-id={message.id}
      data-testid="system-note"
    >
      {message.content}
      <span className="ml-2 text-gray-400"><Timestamp date={message.ts} format="time" /></span>
    </p>
  )
}
