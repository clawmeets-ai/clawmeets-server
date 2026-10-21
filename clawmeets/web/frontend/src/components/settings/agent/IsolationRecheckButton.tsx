import { useEffect, useState } from 'react'
import { hubError } from '../../../api/endpoints/hub'
import { getIsolationCheck, startIsolationCheck, type IsolationCheckStatus } from '../../../api/endpoints/isolationCheck'

const POLL_MS = 5000

/** What the owner is told after a re-check, by how it ended. */
export function recheckResultText(status: IsolationCheckStatus): string {
  if (status.state === 'passed') return 'Check passed. Waiting conversations are being delivered.'
  if (status.state !== 'failed') return ''
  const reason = status.failures[0]?.split('\n')[0]?.slice(0, 200) ?? ''
  const next: Record<string, string> = {
    temporary: 'A temporary problem: try again in a few minutes.',
    needs_action: 'Fix what it reports (for a login error, sign the model CLI in again on that computer), then re-run.',
    unsupported: "This model provider can't serve conversations from other people yet.",
    crashed: "The check itself crashed; see the agent's stderr.log.",
  }
  return [`Check failed${reason ? `: ${reason}` : ''}.`, next[status.kind ?? ''] ?? ''].filter(Boolean).join(' ')
}

/**
 * "Re-run check" on the Hub card while the agent can't take conversations
 * from other people. Asks the agent's running process to re-run its
 * isolation check, polls until it reports, then refreshes the card.
 */
export default function IsolationRecheckButton({ agentId, onDone }: { agentId: string; onDone: () => void }) {
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!running) return
    let cancelled = false
    const timer = window.setInterval(async () => {
      try {
        const status = await getIsolationCheck(agentId)
        if (cancelled || status.state === 'running') return
        setRunning(false)
        setMessage(recheckResultText(status))
        onDone()
      } catch {
        /* keep polling; a transient error is not a result */
      }
    }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [running, agentId, onDone])

  const start = async () => {
    setMessage('')
    try {
      await startIsolationCheck(agentId)
      setRunning(true)
    } catch (e) {
      setMessage(hubError(e)?.message || 'Could not start the check.')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-gray-700" data-testid="isolation-recheck">
      <button type="button" onClick={start} disabled={running} className="underline disabled:no-underline disabled:text-gray-400">
        {running ? 'Checking… (a few minutes)' : 'Re-run check'}
      </button>
      {message && <span role="status">{message}</span>}
    </div>
  )
}
