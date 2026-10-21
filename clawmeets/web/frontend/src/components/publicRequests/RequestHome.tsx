import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Send } from 'lucide-react'
import { useCreatePublicRequest } from '../../hooks/usePublicRequests'
import { useAutoResizeTextarea } from '../../hooks/useAutoResizeTextarea'
import ProgressBoard from './ProgressBoard'
import { requestPath } from './agentView'
import { RequestHeader } from './RequestRoom'
import { COPY, DEFAULT_SEND, EXAMPLES } from './requestCopy'

/** "What do you need done?": one box, example chips, and how it works.
 *  Sending ranks and dispatches on the server; the room opens with the
 *  ranked list already in hand. */
export default function RequestHome() {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const navigate = useNavigate()
  const create = useCreatePublicRequest()
  useAutoResizeTextarea(ref, text, 320)

  const empty = !text.trim()
  const send = () => {
    if (empty || create.isPending) return
    create.mutate({ text: text.trim(), sendCount: DEFAULT_SEND }, {
      onSuccess: (request) => navigate(requestPath(request.id)),
    })
  }

  // The server ranks and sends in one call: the room's header and board
  // stand in for it, searching, until the matches arrive in one batch.
  if (create.isPending) {
    return (
      <div className="pr-room">
        <RequestHeader text={create.variables.text} createdAt={null}>
          <ProgressBoard searching matched={0} sent={0} working={0} responded={0} />
        </RequestHeader>
      </div>
    )
  }

  return (
    <div className="pr-home">
      <h1 className="pr-h1">{COPY.homeTitle}</h1>
      <p className="pr-sub">{COPY.homeSub(DEFAULT_SEND)}</p>
      <div className="pr-ask">
        <textarea
          ref={ref}
          rows={3}
          value={text}
          placeholder={COPY.placeholder}
          aria-label={COPY.homeTitle}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          data-testid="request-input"
        />
        <div className="pr-askbar">
          <div className="pr-hint">
            {empty ? (
              <>
                <kbd className="pr-kbd">{COPY.hintEmpty.enter}</kbd> {COPY.hintEmpty.send} ·{' '}
                <kbd className="pr-kbd">{COPY.hintEmpty.shift}</kbd>+<kbd className="pr-kbd">{COPY.hintEmpty.enter}</kbd>{' '}
                {COPY.hintEmpty.newline}
              </>
            ) : (
              (() => {
                const [a, b, c] = COPY.hintText(DEFAULT_SEND)
                return <>{a}<b>{b}</b>{c}</>
              })()
            )}
          </div>
          <button type="button" className="pr-btn pri lg" onClick={send} disabled={empty || create.isPending} data-testid="request-send">
            <Send size={15} />
            {COPY.send}
          </button>
        </div>
      </div>
      {create.isError && <p className="pr-error" role="alert">{(create.error as Error).message}</p>}
      <div className="pr-examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" onClick={() => { setText(ex); ref.current?.focus() }}>{ex}</button>
        ))}
      </div>
      <div className="pr-how">
        {COPY.how.map((h) => (
          <div key={h.n}>
            <div className="n">{h.n}</div>
            <b>{h.title}</b>
            {h.line}
          </div>
        ))}
      </div>
    </div>
  )
}
