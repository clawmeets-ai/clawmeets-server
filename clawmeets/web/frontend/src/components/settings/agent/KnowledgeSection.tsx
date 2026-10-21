import KnowledgePackList from '../../agent/KnowledgePackList'
import { SectionCard, SectionHeader } from '../primitives'
import type { AgentSettingsDraft, AgentSettingsDraftApi } from './useAgentSettingsDraft'
import { Callout, Code, Field, HelpDisclosure, SectionTitle, inputClass } from './fields'

/**
 * Knowledge packs (install instantly) + the knowledge folder (on the
 * shared draft). Path-resolution help is folded away.
 */
export default function KnowledgeSection({
  draft,
  set,
  packs,
}: {
  draft: AgentSettingsDraft
  set: AgentSettingsDraftApi['set']
  packs: { selection: string[]; onChange: (next: string[]) => void }
}) {
  return (
    <>
      <SectionTitle title="Knowledge" subtitle="What this agent can read about your world" />
      <div className="space-y-6">
        <SectionCard>
          <SectionHeader
            title="Knowledge packs"
            subtitle="Your curated bundles, installed on this agent. Changes apply immediately."
          />
          <div className="px-6 py-5">
            <KnowledgePackList value={packs.selection} onChange={packs.onChange} />
          </div>
        </SectionCard>

        <Field
          label="Knowledge directory"
          htmlFor="knowledgeDir"
          hint={
            <>
              Folder of reference files on the computer this agent runs on. Changes apply on the next project.
              <HelpDisclosure summary="How paths resolve & re-running research">
                <p>
                  Relative paths (e.g. <Code>./knowledge</Code>) resolve against the agent's own folder{' '}
                  (<Code>~/.clawmeets/agents/&lt;agent&gt;/</Code>); <Code>~</Code> expands to your home; absolute
                  paths are honored as-is.
                </p>
                <Callout>
                  <span className="font-semibold">After changing it:</span> the runner rebuilds{' '}
                  <Code>REFERENCES.md</Code> automatically. If you edit files inside the folder, ask the agent to
                  reindex. To redo the agent's deep research so it picks up your new
                  knowledge, <Code>rm -rf</Code> its <Code>learnings/</Code> and click{' '}
                  <span className="font-semibold">Personalize</span> in the agent's DM.
                </Callout>
              </HelpDisclosure>
            </>
          }
        >
          <input
            id="knowledgeDir"
            type="text"
            value={draft.knowledgeDir}
            onChange={(e) => set('knowledgeDir', e.target.value)}
            placeholder="./knowledge"
            className={`${inputClass} font-mono`}
          />
        </Field>
      </div>
    </>
  )
}
