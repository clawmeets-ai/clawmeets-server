import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createDMThread, createFDThread, sendDMMessage } from '../api/endpoints/dm'
import { startHubConversation } from '../api/endpoints/hub'
import { sendHubDraft } from './useHub'
import { isHubRecipient, recipientLabel, type DeskRecipient } from '../utils/deskRecipient'
import { parseLabelError } from '../utils/labelErrors'
import { useAuthStore } from '../stores/authStore'
import { useModelSelectionStore } from '../stores/modelSelectionStore'
import type { ModelConfigList } from '../api/endpoints/modelConfigs'

/**
 * Dispatch a desk message to an agent. Mirrors "message @agent, their reply
 * lands on your desk": spins up a fresh thread with the recipient and sends
 * the text + staged files atomically. An own agent gets an own-DM thread
 * (`createDMThread`); a retained agent of another account on this server gets
 * a Front Desk thread (`createFDThread`), the same split DMChatView makes; a
 * retained agent of another server gets a hub thread (`startHubConversation`,
 * then the hub send route, the only way a hub thread is written). The reply
 * later re-surfaces in the desk feed via `useDeskUpdates`, which reads the
 * first two through `useDmThreads` and hub threads by their `hub_target`.
 *
 * Returns `{ dispatchToAgent, confirmText }`. The caller flashes `confirmText`
 * and handles any UI side effects (consume a to-do, close the take-over).
 *
 * `dispatchToAgent` RESOLVES WITH THE THREAD it just minted. It always did —
 * what changed is that the caller stopped throwing it away: that id is the
 * project the to-do is linked to, and linking is the whole reason a to-do
 * worked through this box ever leaves `new`.
 */
export function useDeskDispatch() {
  const queryClient = useQueryClient()
  const { user } = useAuthStore()

  const dispatchToAgent = useCallback(
    async (
      recipient: DeskRecipient,
      content: string,
      files: File[],
      clientThreadKey?: string,
    ): Promise<{ id: string }> => {
      if (isHubRecipient(recipient)) {
        // The start is deduped on (user, key) like the DM threads, so the
        // composer's per-draft key keeps a double-press to one thread. No
        // model choice: the agent runs on its owner's models, elsewhere.
        const thread = await startHubConversation(recipient.hub_agent_id, clientThreadKey ?? crypto.randomUUID())
        queryClient.setQueryData(['project', thread.id], thread)
        await sendHubDraft(queryClient, thread.id, content, files)
        queryClient.invalidateQueries({ queryKey: ['user-projects'] })
        return thread
      }
      // The idempotency token. `createDMThread` has ACCEPTED it since threads
      // were introduced (`dm.ts:56`) and this hook simply never passed one,
      // which made a double-press mint two threads — and, now that a thread is
      // linked to the to-do that spawned it, would make it two associations as
      // well. The server keys `(user.id, key)` and returns the first thread for
      // a repeat, so one draft maps to one thread however many times it is sent.
      const owned = !!user && recipient.registered_by === user.id
      const thread = owned
        ? await createDMThread(recipient.name, clientThreadKey)
        : await createFDThread(recipient.name, clientThreadKey)
      // Per-request model override (spec #3): resolve the recipient's active
      // config — the transient selector pick, else the agent's backend default
      // (read from the configs query cache the DeskComposer's ModelSelector
      // already warmed). Absent ⇒ nothing sent ⇒ silent server-side fallback.
      // Another account's agent runs on its owner's models: never send one.
      const selected = useModelSelectionStore.getState().byAgent[recipient.id]
      const cached = queryClient.getQueryData<ModelConfigList>(['model-configs', recipient.id])
      const modelConfigName = owned ? selected ?? cached?.default ?? undefined : undefined
      await sendDMMessage(
        thread.id,
        'user-communication',
        content,
        files.length ? files : undefined,
        modelConfigName,
      )
      // Reveal the new thread on the desk feed + DM rail promptly.
      queryClient.invalidateQueries({ queryKey: ['user-projects'] })
      queryClient.invalidateQueries({ queryKey: ['all-projects'] })
      return thread
    },
    [queryClient, user],
  )

  const confirmText = useCallback(
    (recipient: DeskRecipient, fileCount: number) => {
      const name = recipientLabel(recipient, user)
      const attached = fileCount ? ` with ${fileCount} file${fileCount > 1 ? 's' : ''} attached` : ''
      return `Sent to @${name}${attached} — their reply lands on your desk.`
    },
    [user],
  )

  /**
   * What the owner reads when the MESSAGE WENT OUT but the to-do did not get
   * linked to the thread it spawned. Written here, beside `confirmText`, so the
   * two sentences this path can produce sit next to each other.
   *
   * Three things it has to do, and the third is why it takes `err`:
   *
   *  1. NOT CLAIM THE MESSAGE FAILED. It opens by saying the message went out,
   *     because it did — a resend would post the same text twice into the same
   *     thread.
   *  2. NAME THE REPAIR PATH, with the real ids rather than placeholders:
   *     `clawmeets todo associate <to-do id> <project id>`, TO-DO FIRST. That
   *     verb ships ahead of this sentence, so it exists before this names it.
   *     This milestone ships no browser affordance for linking by hand, so the
   *     terminal is the only way back and a sentence that did not name it would
   *     leave the owner with a to-do they can see is wrong and cannot fix.
   *  3. CARRY THE SERVER'S OWN SENTENCE when there is one. Refusals on this
   *     surface are BARE — a plain `detail` with no `labels.` prefix — so it is
   *     rendered verbatim. `parseLabelError` is safe to run it through
   *     anyway: `CODED` is anchored on `^labels\.`, so an unprefixed detail
   *     falls through with a null code and the whole string as the sentence,
   *     and a network throw with no body falls through to that path's generic
   *     line. This reads the message and IGNORES the code; it does not branch
   *     on 404-vs-403 either, because both sentences are already written for
   *     the owner and a split would only let the client say something worse.
   */
  const linkFailedText = useCallback(
    (recipient: DeskRecipient, todoId: string, projectId: string, err: unknown) => {
      const name = recipientLabel(recipient, user)
      const { sentence } = parseLabelError(err)
      return (
        `Sent to @${name} — the message went out, but this to-do didn't get ` +
        `linked to the new thread, so it still reads New. ${sentence} ` +
        `It's still on your plate — link it from the terminal with: ` +
        `clawmeets todo associate ${todoId} ${projectId}`
      )
    },
    [user],
  )

  return { dispatchToAgent, confirmText, linkFailedText }
}
