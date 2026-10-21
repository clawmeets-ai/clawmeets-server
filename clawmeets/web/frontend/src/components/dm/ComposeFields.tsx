import type { ComposeForm, ComposeMode } from '../../hooks/useComposeForm'
import type { AgentDraftValues, ProjectDraftValues } from '../sidebar/dmPrefill'
import TagPillInput from '../common/TagPillInput'

const LABEL_CLASS = 'block text-sm font-medium text-gray-700 mb-1'
const INPUT_CLASS =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-400 disabled:bg-gray-50 disabled:text-gray-400'
const ERROR_CLASS = 'mt-1 text-xs text-red-600'

function ErrorText({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className={ERROR_CLASS}>
      {children}
    </p>
  )
}

// Renders the mode-selected field set. Presentational only — all state and
// setters come from the useComposeForm instance owned by the modal.
//   mode==='agent'   → AgentFields:   <name> text, <expertise> text, <other> textarea
//   mode==='project' → ProjectFields: agents via TagPillInput (chip cloud +
//                      roster autocomplete), <task> textarea
// Required fields show inline errors only after a blocked submit (`showErrors`).
export default function ComposeFields(props: {
  mode: ComposeMode
  form: ComposeForm
  showErrors: boolean
  disabled: boolean // true while phase === 'sending'
  autoFocus: boolean // focus the first field when the modal opens
  agentSuggestions: string[] // project mode: roster names for autocomplete
}) {
  const { mode, form, showErrors, disabled, autoFocus, agentSuggestions } = props

  if (mode === 'agent') {
    const v = form.values as AgentDraftValues
    const nameError = showErrors && !v.name.trim()
    const expertiseError = showErrors && !v.expertise.trim()
    return (
      <div className="space-y-4">
        <div>
          <label htmlFor="compose-name" className={LABEL_CLASS}>
            Agent name <span className="text-red-500">*</span>
          </label>
          <input
            id="compose-name"
            type="text"
            value={v.name}
            onChange={(e) => form.setField('name', e.target.value)}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-required="true"
            aria-invalid={nameError}
            aria-describedby={nameError ? 'compose-name-error' : undefined}
            placeholder="e.g. research-analyst"
            className={INPUT_CLASS}
          />
          {nameError && <ErrorText id="compose-name-error">Enter an agent name.</ErrorText>}
        </div>

        <div>
          <label htmlFor="compose-expertise" className={LABEL_CLASS}>
            Expertise <span className="text-red-500">*</span>
          </label>
          <input
            id="compose-expertise"
            type="text"
            value={v.expertise}
            onChange={(e) => form.setField('expertise', e.target.value)}
            disabled={disabled}
            aria-required="true"
            aria-invalid={expertiseError}
            aria-describedby={expertiseError ? 'compose-expertise-error' : undefined}
            placeholder="e.g. competitive market research"
            className={INPUT_CLASS}
          />
          {expertiseError && (
            <ErrorText id="compose-expertise-error">Enter an area of expertise.</ErrorText>
          )}
        </div>

        <div>
          <label htmlFor="compose-other" className={LABEL_CLASS}>
            Anything else? <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            id="compose-other"
            value={v.other}
            onChange={(e) => form.setField('other', e.target.value)}
            disabled={disabled}
            rows={2}
            placeholder="Any extra context for the assistant"
            className={`${INPUT_CLASS} resize-none`}
          />
        </div>
      </div>
    )
  }

  const v = form.values as ProjectDraftValues
  const agentsError = showErrors && !v.agents.some((a) => a.trim())
  const taskError = showErrors && !v.task.trim()
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="compose-agents" className={LABEL_CLASS}>
          Agents <span className="text-red-500">*</span>
        </label>
        <TagPillInput
          id="compose-agents"
          value={v.agents}
          onChange={form.setAgents}
          suggestions={agentSuggestions}
          autoFocus={autoFocus}
          placeholder="Add agents by name…"
        />
        {agentsError ? (
          <ErrorText id="compose-agents-error">Add at least one agent.</ErrorText>
        ) : (
          <p className="mt-1 text-xs text-gray-500">
            Pick from your roster or type a new name. Press Enter or comma to add.
          </p>
        )}
      </div>

      <div>
        <label htmlFor="compose-task" className={LABEL_CLASS}>
          Task / goal <span className="text-red-500">*</span>
        </label>
        <textarea
          id="compose-task"
          value={v.task}
          onChange={(e) => form.setField('task', e.target.value)}
          disabled={disabled}
          rows={3}
          aria-required="true"
          aria-invalid={taskError}
          aria-describedby={taskError ? 'compose-task-error' : undefined}
          placeholder="What should this project accomplish?"
          className={`${INPUT_CLASS} resize-none`}
        />
        {taskError && <ErrorText id="compose-task-error">Describe the task or goal.</ErrorText>}
      </div>
    </div>
  )
}
