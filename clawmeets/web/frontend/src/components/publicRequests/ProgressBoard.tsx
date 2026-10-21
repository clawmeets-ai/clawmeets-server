import { Fragment } from 'react'
import { Check, ChevronRight, Search } from 'lucide-react'
import { COPY } from './requestCopy'

type StepState = 'pending' | 'on' | 'done'

/**
 * Finding agents → Working → Responses. While the server ranks, the board
 * shows the searching block; the matches then arrive in one batch.
 */
export default function ProgressBoard({ searching, matched, sent, working, responded }: {
  searching: boolean
  matched: number
  sent: number
  working: number
  responded: number
}) {
  const s = COPY.steps
  const steps: { name: string; sub: string; state: StepState }[] = [
    {
      name: s.find,
      sub: searching ? s.findOn : s.findDone(matched),
      state: searching ? 'on' : 'done',
    },
    {
      name: s.work,
      sub: searching || sent === 0 ? s.respNone : working > 0 ? s.workOn(working, sent) : s.workDone(sent),
      state: searching || sent === 0 ? 'pending' : working > 0 ? 'on' : 'done',
    },
    {
      name: s.resp,
      sub: responded > 0 ? s.respSome(responded, sent) : s.respNone,
      state: responded === 0 ? 'pending' : responded < sent ? 'on' : 'done',
    },
  ]
  return (
    <div className="pr-board" data-testid="progress-board">
      <div className="pr-flow">
        {steps.map((step, i) => (
          <Fragment key={step.name}>
            {i > 0 && (
              <span className={`pr-arrow${steps[i - 1].state === 'done' ? ' done' : ''}`} aria-hidden>
                <i />
                <ChevronRight size={14} strokeWidth={2.4} />
              </span>
            )}
            <div className={`pr-step ${step.state}`} data-state={step.state}>
              <span className="b">{step.state === 'done' ? <Check size={13} strokeWidth={2.6} /> : i + 1}</span>
              <span>
                <b>{step.name}</b>
                <em>{step.sub}</em>
              </span>
            </div>
          </Fragment>
        ))}
      </div>
      {searching && (
        <div className="pr-searching" role="status">
          <span className="pr-scan"><Search size={16} /></span>
          <b>{COPY.searching}</b>
          <div className="pr-ghosts" aria-hidden>
            {[0, 1, 2].map((n) => (
              <div className="pr-ghost" key={n}>
                <i />
                <span><i style={{ width: `${40 + n * 12}%` }} /><i style={{ width: `${70 - n * 10}%` }} /></span>
              </div>
            ))}
          </div>
        </div>
      )}
      {!searching && matched === 0 && <div className="pr-empty">{COPY.noMatches}</div>}
    </div>
  )
}
