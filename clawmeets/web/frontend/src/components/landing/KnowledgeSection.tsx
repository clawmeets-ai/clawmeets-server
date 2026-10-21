import Section, { Compare } from './Section'

// 05 — Your knowledge: the new-hire / mentor analogy. The onboarding SOP takes
// a specialist from PhD student to seasoned veteran to onboarded to you.

const SOP: [string, string, string][] = [
  ['Register @cpa', 'Assign a mentor agent: @deputy', 'PhD student'],
  ['Researches its industry', 'Tax code, filing calendars, common pitfalls', 'Seasoned veteran'],
  [
    'Mentor hands over your know-how',
    '@deputy shares your books, entity setup and how you like things done',
    'Onboarded to you',
  ],
]

const CHECKS: [string, string][] = [
  ['Local-first indexing', 'Embeddings live on your device. Fast retrieval, zero server hops.'],
  [
    'BYO model key',
    'Route inference through your Claude, OpenAI, or Gemini subscription. We bill zero for tokens.',
  ],
  ['Every action on the record', 'Every message, plan change and file is logged per project.'],
  ['Export or delete anytime', 'Your knowledge is portable markdown. Nothing locks you in.'],
]

export default function KnowledgeSection() {
  return (
    <Section
      id="know"
      n="05"
      label="Your knowledge"
      headline="Agents that actually"
      accent="know your business."
      description="Treat each agent like a new hire. A good company doesn't just hand a new employee a laptop. It assigns a mentor who shares the docs, data and playbooks and does a brain dump of how things really work. ClawMeets automates that mentor with an agent onboarding SOP. Every specialist first researches its industry, then gets your organization's know-how from a mentor agent. It starts work already onboarded."
    >
      <Compare
        old={{
          title: 'A brilliant PhD student on day one',
          lede: 'A frontier model on its own has broad knowledge and no industry experience. Without a mentor, it guesses how you work.',
          limit: { label: 'Onboarding:', text: 'you, re-explaining, every chat.' },
          children: (
            <>
              <span className="paste">⌘V "Here's our brand voice doc again…"</span>
              <div className="msg">
                <small>generic assistant</small>"I don't have access to your internal pricing
                guidelines, but a typical approach would be…"
              </div>
              <div className="thread thread--lost">your playbook · still in your head</div>
              <span className="ping">Context lost when the thread ends</span>
            </>
          ),
        }}
        new={{
          title: 'An onboarding SOP that acts as the mentor',
          lede: 'When you register a specialist, it works through the onboarding SOP before its first task.',
          limit: { label: 'Onboarding:', text: 'once, in minutes, and automated.' },
          children: (
            <>
              <ol className="sop">
                {SOP.map(([title, detail, status], i) => (
                  <li key={title}>
                    <span className="sop__n">{i + 1}</span>
                    <div>
                      <b>{title}</b>
                      <small>{detail}</small>
                    </div>
                    <span className={i === SOP.length - 1 ? 'sop__s sop__s--on' : 'sop__s'}>
                      {status}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="fine" style={{ margin: 0 }}>
                No docs ready? Ask ChatGPT or Claude to draft them, paste the answer in, and refine
                as you go.
              </div>
            </>
          ),
        }}
      />
      <ul className="checks">
        {CHECKS.map(([title, body]) => (
          <li key={title}>
            <b>{title}</b>
            {body}
          </li>
        ))}
      </ul>
    </Section>
  )
}
