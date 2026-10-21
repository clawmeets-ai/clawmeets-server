import type { ReactNode } from 'react'
import EnvVarsCard from './EnvVarsCard'
import ExtraDirsList from './ExtraDirsList'
import type { AgentSettingsDraft, AgentSettingsDraftApi } from './useAgentSettingsDraft'
import { Code, Field, HelpDisclosure, SectionTitle, inputClass } from './fields'

function Guide({ title, blurb, children }: { title: string; blurb: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-gray-200 bg-white">
      <summary className="cursor-pointer select-none list-none px-4 py-3 flex items-center gap-2 text-sm">
        <span className="inline-block text-gray-400 transition-transform group-open:rotate-90" aria-hidden>▸</span>
        <span className="font-semibold text-gray-800">{title}</span>
        <span className="text-xs text-gray-400">— {blurb}</span>
      </summary>
      <div className="px-4 pb-4 space-y-2 text-xs text-gray-500 leading-relaxed">{children}</div>
    </details>
  )
}

/**
 * Git binding and extra directories (on the shared draft), the agent's env
 * vars, and the browser-automation setup guide folded into a closed disclosure.
 */
export default function RuntimeSection({
  agentId,
  agentName,
  draft,
  set,
}: {
  agentId: string
  agentName: string
  draft: AgentSettingsDraft
  set: AgentSettingsDraftApi['set']
}) {
  return (
    <>
      <SectionTitle title="Code & runtime" subtitle="Repo binding and setup that happens on the agent's computer" />
      <div className="space-y-6">
        <Field
          label="Git repository"
          htmlFor="gitUrl"
          hint={
            <>
              Leave empty for a non-coding agent. Changes apply on the next project.
              <HelpDisclosure summary="How it works">
                <p>
                  When set, the agent runs its git workflow for code changes — cloning into its sandbox, joining the
                  shared project branch (every agent on a project shares one branch per repo), committing and pushing
                  for review. It never auto-merges. The computer it runs on must have push access (SSH key or git
                  credential helper).
                </p>
              </HelpDisclosure>
            </>
          }
        >
          <input
            id="gitUrl"
            type="text"
            value={draft.gitUrl}
            onChange={(e) => set('gitUrl', e.target.value)}
            placeholder="git@github.com:org/backend.git"
            className={`${inputClass} font-mono`}
          />
          <input
            id="gitBaseBranch"
            type="text"
            aria-label="Base branch"
            value={draft.gitBaseBranch}
            onChange={(e) => set('gitBaseBranch', e.target.value)}
            placeholder="base branch (optional, defaults to repo default)"
            className={`${inputClass} font-mono mt-2`}
          />
        </Field>

        <Field
          label="Extra directories"
          htmlFor="extraDirs"
          hint={
            <>
              Existing folders this agent also works in — e.g. a tool checkout like{' '}
              <Code>~/OpenMontage</Code>. Changes apply on the agent's next turn.
              <HelpDisclosure summary="What the agent gets">
                <p>
                  The agent still runs in its own project sandbox. Each folder here is added on top, the same way for
                  every model provider: the agent can read and write it, the folder's own skills (
                  <Code>.agents/skills/</Code>, <Code>.claude/skills/</Code>) are installed alongside the agent's (its
                  own skill wins on a name clash), and its instruction file (<Code>AGENTS.md</Code>, else{' '}
                  <Code>CLAUDE.md</Code>, else <Code>GEMINI.md</Code>) is named in the agent's prompt.
                </p>
                <p>
                  Nothing is written into the folder, so several agents can share one. It must already exist on the
                  computer this agent runs on; a missing one is skipped. Relative paths resolve against the agent's
                  own folder; <Code>~</Code> expands to your home.
                </p>
              </HelpDisclosure>
            </>
          }
        >
          <ExtraDirsList id="extraDirs" dirs={draft.extraDirs} onChange={(dirs) => set('extraDirs', dirs)} />
        </Field>

        <EnvVarsCard agentId={agentId} agentName={agentName} />

        <div className="space-y-2">
          <Guide title="Browser automation" blurb="setup guide">
            <p>
              To let this agent drive a real browser, install the <Code>playwright-browser</Code> skill (Skills
              section), then run <Code>clawmeets bootstrap browser</Code> once on that computer to install Chromium
              (~150 MB). Successful runs can be saved as replayable workflows, callable as{' '}
              <Code>/personal:&lt;name&gt;</Code>.
            </p>
          </Guide>

        </div>
      </div>
    </>
  )
}
