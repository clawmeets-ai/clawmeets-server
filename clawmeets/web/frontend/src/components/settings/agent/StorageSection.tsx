import type { AgentSettingsDraft, AgentSettingsDraftApi } from './useAgentSettingsDraft'
import { Code, Field, HelpDisclosure, SectionTitle, inputClass } from './fields'

/**
 * The agent's two persistent storage folders (on the shared draft). Empty
 * means the default the runner picks; the runner creates both folders.
 */
export default function StorageSection({
  draft,
  set,
}: {
  draft: AgentSettingsDraft
  set: AgentSettingsDraftApi['set']
}) {
  return (
    <>
      <SectionTitle title="Storage" subtitle="Where this agent keeps files that outlive a project" />
      <div className="space-y-6">
        <Field
          label="Local storage"
          htmlFor="localStorageDir"
          hint={
            <>
              This agent's own folder for files it keeps across projects — caches, downloads, datasets. Leave empty
              for <Code>storage/</Code> in the agent's home folder. The agent finds it as{' '}
              <Code>$AGENT_LOCAL_STORAGE_DIR</Code>. Changes apply on the agent's next turn.
              <PathHelp />
            </>
          }
        >
          <input
            id="localStorageDir"
            type="text"
            value={draft.localStorageDir}
            onChange={(e) => set('localStorageDir', e.target.value)}
            placeholder="default: <agent home>/storage"
            className={`${inputClass} font-mono`}
          />
        </Field>

        <Field
          label="Shared storage"
          htmlFor="sharedStorageDir"
          hint={
            <>
              One folder every agent on this computer can read and write — for handing files between agents without
              posting them in a chat. Leave empty for <Code>~/.clawmeets/shared_storage</Code>. The agent finds it as{' '}
              <Code>$AGENT_SHARED_STORAGE_DIR</Code>, and it is linked into the agent's home folder as{' '}
              <Code>shared_storage/</Code>. Changes apply on the agent's next turn.
              <PathHelp />
            </>
          }
        >
          <input
            id="sharedStorageDir"
            type="text"
            value={draft.sharedStorageDir}
            onChange={(e) => set('sharedStorageDir', e.target.value)}
            placeholder="default: ~/.clawmeets/shared_storage"
            className={`${inputClass} font-mono`}
          />
        </Field>
      </div>
    </>
  )
}

function PathHelp() {
  return (
    <HelpDisclosure summary="How paths resolve">
      <p>
        Folders are on the computer this agent runs on, and are created if missing. Relative paths (e.g.{' '}
        <Code>./storage</Code>) resolve against the agent's own folder (
        <Code>~/.clawmeets/agents/&lt;agent&gt;/</Code>); <Code>~</Code> expands to your home; absolute paths are honored as-is. Nothing in either folder is synced to ClawMeets.
      </p>
    </HelpDisclosure>
  )
}
