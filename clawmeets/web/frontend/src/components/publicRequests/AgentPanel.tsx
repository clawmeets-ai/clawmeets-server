import { useMemo, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import type { RequestMatch } from '../../api/endpoints/publicRequests'
import { useMessages } from '../../hooks/useProjects'
import { useReplyToMatch } from '../../hooks/usePublicRequests'
import { useAutoResizeTextarea } from '../../hooks/useAutoResizeTextarea'
import { useAuthStore } from '../../stores/authStore'
import { isChatMessage, type ChatMessage } from '../../types'
import MarkdownBody from '../shared/MarkdownBody'
import SidebarAvatar from '../sidebar/SidebarAvatar'
import MatchRetainButton from './MatchRetainButton'
import { fromMatch } from './agentView'
import { COPY } from './requestCopy'

const UC = 'user-communication'

/**
 * One matched agent: its card, its answer and the thread below it, and the
 * reply box, which is always there once the request went out. The answer is
 * the agent's first message on the request's thread; it is another account's
 * text, so it renders as untrusted Markdown.
 */
export default function AgentPanel({ match, onOpenAgent, onDismiss, onUse, using }: {
  match: RequestMatch
  onOpenAgent: () => void
  onDismiss: (dismissed: boolean) => void
  /** "Use this answer": what the hub's ranking learns from. */
  onUse?: () => void
  using?: boolean
}) {
  const a = fromMatch(match)
  return (
    <section className="pr-panel" data-testid="agent-panel">
      <div className="pr-card">
        <div className="pr-ctop">
          <SidebarAvatar name={a.display_name} size={32} ringColor="var(--bg-rail)" />
          <div className="who">
            <button type="button" onClick={onOpenAgent} data-testid="open-agent">
              <h3>{a.display_name}</h3>
            </button>
            <div className="pr-cmetaline">{COPY.meta(match)}</div>
          </div>
          <div className="pr-cacts">
            <MatchRetainButton agent={a} />
            {match.status === 'responded' && !match.dismissed && onUse && (
              match.used ? (
                <span className="pr-used" data-testid="used-answer">{COPY.usedAnswer}</span>
              ) : (
                <button type="button" className="pr-btn pri" onClick={onUse} disabled={using} data-testid="use-answer">
                  {COPY.useAnswer}
                </button>
              )
            )}
            {match.status === 'responded' && !match.dismissed && (
              <button type="button" className="pr-btn ghost" onClick={() => onDismiss(true)} data-testid="dismiss">
                {COPY.dismiss}
              </button>
            )}
          </div>
        </div>
        {a.description && <p className="pr-cdesc">{a.description}</p>}
        {!!a.retained_count && (
          <div className="pr-cmeta"><span>{COPY.retainedBy(a.retained_count)}</span></div>
        )}
        {a.expertise.length > 0 && (
          <div className="pr-tags">{a.expertise.map((e) => <span key={e}>{e}</span>)}</div>
        )}
      </div>
      {match.dismissed ? (
        <div className="pr-ans">
          <div className="pr-notice">
            <p>{COPY.dismissedBody}</p>
            <button type="button" className="pr-btn" onClick={() => onDismiss(false)} data-testid="show-again">
              {COPY.showAgain}
            </button>
          </div>
        </div>
      ) : match.project_id ? (
        <Conversation match={match} name={a.display_name} />
      ) : (
        <div className="pr-ans">
          <div className="pr-notice" data-testid="not-sent">
            <p>{match.send_error ? COPY.sendFailed : COPY.notSentBody(a.display_name)}</p>
          </div>
        </div>
      )}
    </section>
  )
}

function Conversation({ match, name }: { match: RequestMatch; name: string }) {
  const userId = useAuthStore((s) => s.user?.id)
  const { data: log } = useMessages(match.project_id!, UC)
  const messages = useMemo(
    () => (log ?? []).filter((e): e is ChatMessage => isChatMessage(e) && !e.is_ack),
    [log],
  )
  const answerIndex = messages.findIndex((m) => m.from_participant_id !== userId)
  const answer = answerIndex >= 0 ? messages[answerIndex] : null
  // Everything after the request itself, except the answer: the replies.
  const thread = messages.slice(1).filter((m) => m !== answer)
  const reply = useReplyToMatch(match)
  const last = messages[messages.length - 1]
  const typing = !!answer && (reply.isPending || (!!last && last.from_participant_id === userId))

  return (
    <>
      <div className="pr-ans" aria-live="polite">
        {answer ? (
          <div className="pr-answer" data-testid="agent-answer">
            <MarkdownBody content={answer.content} untrusted />
          </div>
        ) : (
          <>
            <div className="pr-drafting">
              <span className="pr-dots" aria-hidden><i /><i /><i /></span>
              {COPY.working(name)}
            </div>
            <div className="pr-skel" aria-hidden>
              {['45%', '92%', '80%', '60%'].map((w) => <i key={w} style={{ width: w }} />)}
            </div>
          </>
        )}
      </div>
      {(thread.length > 0 || typing) && answer && (
        <div className="pr-thread" data-testid="agent-thread">
          {thread.map((m) => (m.from_participant_id === userId
            ? <div key={m.id} className="pr-msg me">{m.content}</div>
            : <div key={m.id} className="pr-msg"><MarkdownBody content={m.content} untrusted /></div>))}
          {typing && <div className="pr-msg typing">{COPY.typing(name)}</div>}
        </div>
      )}
      <ReplyBox name={name} pending={reply.isPending} failed={reply.isError} onSend={(t) => reply.mutateAsync(t)} />
    </>
  )
}

function ReplyBox({ name, pending, failed, onSend }: {
  name: string
  pending: boolean
  failed: boolean
  onSend: (text: string) => Promise<unknown>
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useAutoResizeTextarea(ref, text, 140)
  const send = () => {
    const t = text.trim()
    if (!t || pending) return
    onSend(t).then(() => setText(''), () => undefined)
  }
  return (
    <>
      <div className="pr-compose">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={COPY.replyPlaceholder(name)}
          aria-label={COPY.replyPlaceholder(name)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          data-testid="reply-input"
        />
        <button type="button" className="pr-btn pri" onClick={send} disabled={!text.trim() || pending} aria-label={COPY.send}>
          <Send size={15} />
        </button>
      </div>
      {failed && <div className="pr-compose-error" role="alert">{COPY.replyFailed}</div>}
    </>
  )
}
