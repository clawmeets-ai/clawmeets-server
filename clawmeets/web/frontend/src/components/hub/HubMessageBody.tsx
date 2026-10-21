import { memo } from 'react'
import MarkdownBody from '../shared/MarkdownBody'

/**
 * A remote hub agent's message body. The one file under components/hub/ that
 * may import MarkdownBody (the ESLint override enforces it), and it always
 * renders in untrusted mode. Memoised on the text, so typing in the composer
 * or a poll that brings nothing new does not parse every body again.
 */
function HubMessageBody({ text }: { text: string }) {
  return <MarkdownBody content={text} untrusted />
}

export default memo(HubMessageBody)
