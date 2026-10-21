import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

// The remedy, verbatim. A module constant so the rendered chip and the
// clipboard write can never drift apart.
const REMEDY_COMMAND = 'clawmeets start'

export interface OfflineRecipient {
  agentId: string
  displayName: string
}

interface OfflineRemedyNoteProps {
  /**
   * Recipients whose status resolved to 'offline': nothing was connected for
   * them at dispatch, so they NEVER RECEIVED the message. Still queued.
   */
  neverReceived: OfflineRecipient[]
  /**
   * AC-3.7. Recipients that timed out with their runner disconnected at the
   * moment the timeout fired: they DID receive the message and were working on
   * it. The reply is lost, and this is the case a resend actually fixes.
   */
  offlineAtTimeout: OfflineRecipient[]
  /** True when the same message also has recipients that are working or done. */
  hasWorkingRecipients: boolean
}

/**
 * Message-level companion to the ● offline and ● offline · timed out chips:
 * names the agents that are down and gives the one command that fixes it.
 * AC-3.3, AC-3.5, AC-3.7.
 *
 * VOCABULARY: user-facing copy here says "your computer" / "its computer", never
 * "runner". The word survives in the comments below, where it names a process
 * for whoever is reading the code — the rule is about what a user reads, and the
 * distinction between the two message groups genuinely IS about a runner
 * process's lifetime.
 *
 * ONE note per message, never one per agent — the incident case is an
 * eleven-agent fleet dropping in the same second, and eleven copies of the
 * same paragraph is what makes that unreadable. The agents are named inside
 * a single note; the `clawmeets start` explanation is given exactly once.
 *
 * The two groups get DIFFERENT remedies, and that is the whole reason they are
 * tracked apart:
 *
 *  - `neverReceived` — the message never reached the runner, so it is still in
 *    the backlog and catch-up replays it on reconnect. Telling this user to
 *    resend manufactures duplicate work on a message already going to be
 *    answered; with 2.5 days of queued messages it double-delivers all of them.
 *    Proven by `tests/test_offline_dispatch.py::
 *    test_a_message_queued_for_a_down_runner_fires_on_reconnect`, which drives
 *    a runner with an EMPTY base_dir — i.e. one that was down the whole window
 *    — through a sync and asserts the turn still starts.
 *  - `offlineAtTimeout` — the runner had already consumed this message before
 *    it died, so its changelog cursor is past it and catch-up will NOT replay
 *    it. That same test does not cover this case and does not claim to. The
 *    work is lost, so here a resend is the correct advice.
 *
 * Both facts are pinned by test. Do not merge the branches, and do not copy
 * one branch's second line onto the other.
 *
 * Scoped to "this message" on purpose. Other surfaces (plan-review rounds)
 * are not covered by this signal, and the copy must not imply they are.
 */
export default function OfflineRemedyNote({
  neverReceived,
  offlineAtTimeout,
  hasWorkingRecipients,
}: OfflineRemedyNoteProps) {
  const [copied, setCopied] = useState(false)

  if (neverReceived.length === 0 && offlineAtTimeout.length === 0) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(REMEDY_COMMAND)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (insecure context / denied) — the chip is still
      // selectable text, so leave the button in its idle state.
    }
  }

  const missedNames = neverReceived.map((r) => `@${r.displayName}`)
  const lostNames = offlineAtTimeout.map((r) => `@${r.displayName}`)
  const totalCount = neverReceived.length + offlineAtTimeout.length
  // Plural of the note as a whole, used only by the shared remedy line.
  const manyOverall = totalCount > 1

  return (
    <div
      className="mt-1.5 px-2.5 py-2 rounded-md text-xs leading-relaxed"
      style={{
        background: 'var(--bg-rail)',
        border: '1px solid #fcd34d',
        color: 'var(--ink-2, #4b5563)',
      }}
    >
      <div className="font-semibold" style={{ color: '#b45309' }}>
        {headline(missedNames, lostNames)}
      </div>

      {neverReceived.length > 0 && (
        <div className="mt-0.5">
          {neverReceived.length > 1
            ? `${joinNames(missedNames)} aren't connected, so they never got this message and nothing is working on it. It's still queued for them and will be delivered when their computers reconnect — you don't need to send it again.`
            : `${missedNames[0]} isn't connected, so it never got this message and nothing is working on it. It's still queued and will be delivered when its computer reconnects — you don't need to send it again.`}
        </div>
      )}

      {offlineAtTimeout.length > 0 && (
        <div className="mt-0.5">
          {offlineAtTimeout.length > 1
            ? `${joinNames(lostNames)} did get this message and started work, but their computers disconnected before they replied, so that work was lost. Reconnecting won't retry it — send this again if you still need it.`
            : `${lostNames[0]} did get this message and started work, but its computer disconnected before it replied, so that work was lost. Reconnecting won't retry it — send this again if you still need it.`}
        </div>
      )}

      {hasWorkingRecipients && (
        <div className="mt-0.5">The other recipients on this message are unaffected.</div>
      )}

      {/* AC-3.3: said once, in both cases, and said explicitly. A user who
          believes the service is down does not run a command on their laptop. */}
      <div className="mt-1">
        {manyOverall
          ? "Those are on your own machine, not a clawmeets outage."
          : "That's on your own machine, not a clawmeets outage."}
      </div>

      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
        <span>To reconnect, run</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied' : `Copy ${REMEDY_COMMAND}`}
          title={`Copy "${REMEDY_COMMAND}"`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono border border-gray-300 bg-white hover:bg-gray-50"
        >
          <span>{REMEDY_COMMAND}</span>
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
        <span>
          {manyOverall
            ? 'where you set those agents up.'
            : 'where you set that agent up.'}
        </span>
      </div>
    </div>
  )
}

/**
 * The one-line summary. Names the agents when there are few enough to read,
 * and falls back to a count when a whole fleet is down — the names are still
 * spelled out in the body lines below either way, which is what AC-3.2 asks
 * for.
 */
function headline(missedNames: string[], lostNames: string[]): string {
  const total = missedNames.length + lostNames.length
  if (total > 2) return `${total} agents aren't connected.`
  if (lostNames.length === 0) {
    return missedNames.length > 1
      ? `${joinNames(missedNames)} didn't receive this message.`
      : `${missedNames[0]} didn't receive this message.`
  }
  if (missedNames.length === 0) {
    return lostNames.length > 1
      ? `${joinNames(lostNames)} stopped before replying.`
      : `${lostNames[0]} stopped before replying.`
  }
  return `${joinNames([...missedNames, ...lostNames])} aren't connected.`
}

/** "@a", "@a and @b", "@a, @b and @c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
