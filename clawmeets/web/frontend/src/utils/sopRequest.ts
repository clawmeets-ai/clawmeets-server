import type { DeskUpdate } from '../hooks/useDeskUpdates'
import type { DeskSop } from '../api/endpoints/deskSops'
import { placeholderBlanks } from '../components/composer/placeholders'

// The blank grammar the SOP runner parses, spelled out inline rather than left
// as "use the SOP parameter syntax". The assistant's `desk-sop` skill carries
// the full table, but naming the five forms costs one line and removes any
// chance of it inventing `[Client]`-style placeholders nothing can fill.
const PARAM_CLAUSE =
  "For the information I'd need to provide at SOP execution time, parametrize it " +
  'through the SOP blank syntax — {{Client}}, {{Threshold|text:$50}}, ' +
  '{{Count|number:6}}, {{Voice|select:warm,punchy}}, {{Deadline|date}}.'

/**
 * The body of the "turn this finished work into a reusable SOP" request the
 * Save-as-SOP CTA drafts into the desk composer, addressed to the owner's
 * assistant (the only principal `POST /me/desk/sops` accepts).
 *
 * Carries the card's project identity — name, uuid, and coordinator handle —
 * because the assistant is NOT a participant in that project and has nothing
 * else to look it up by. Names aren't unique, so the uuid is what it actually
 * fetches the room with; it reads that room through its owner-scoped bearer.
 * The SOP is asked to be addressed to the card's own coordinator, so firing it
 * later re-dispatches to the agent that did the original work.
 *
 * Wording adapts to `item.kind`: "the project X" vs. "my DM thread with @agent".
 * Returned as PLAIN TEXT: the `{{…}}` examples are instructions ABOUT the blank
 * grammar, so the composer must load this via `prefill`/`setPlain`, not
 * `loadTemplate` — the latter would parse them into chips the USER has to fill
 * before Send unblocks.
 */
export function buildSopRequestMessage(item: DeskUpdate): string {
  const agent = `@${item.agentName}`
  const subject =
    item.kind === 'project'
      ? `the project "${item.sourceName}" (project id: ${item.projectId}, coordinator ${agent})`
      : `my DM thread with ${agent} (project id: ${item.projectId})`
  const work = item.kind === 'project' ? 'the work from that project' : 'that work'
  return (
    `Can you review ${subject}, produce a prompt I can send to ${agent} to repeat ` +
    `and reproduce ${work}, and then save that as an SOP in my library, addressed ` +
    `to ${agent}?\n\n${PARAM_CLAUSE}`
  )
}

/**
 * The body of the "put this SOP on a cadence" request the schedule button
 * drafts into the desk composer, addressed to the owner's assistant (the only
 * principal that can read the SOP library and call `sop trigger`).
 *
 * Returned as a TEMPLATE, not plain text: it re-emits each of the SOP's own
 * blanks verbatim (`chip.raw`), so the composer loads them as chips and the
 * USER fills them here — once, at schedule time. A schedule fires unattended,
 * so a value the assistant had to guess would be wrong every day rather than
 * once. `nudgeEmpty` blocking Send on an empty chip is what enforces that.
 *
 * The SOP id travels in the text because the assistant looks the SOP up by it;
 * the title is there for the human reading their own outbox. `placeholderBlanks`
 * is what makes the same blank used twice in a body one question, not two —
 * the same rule `parse_blanks` applies on the Python side.
 */
export function buildSopScheduleMessage(sop: Pick<DeskSop, 'id' | 'title' | 'body'>): string {
  const lines = placeholderBlanks(sop.body).map((c) => `- ${c.label}: ${c.raw}`)
  const head =
    `Please schedule my SOP "${sop.title}" (${sop.id}) to run ` +
    `{{Cadence|text:every day at 9:00 AM}}.`
  return lines.length ? `${head}\n\nRun it with these values:\n${lines.join('\n')}` : head
}
