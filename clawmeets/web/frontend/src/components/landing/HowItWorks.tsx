import Section, { Compare } from './Section'

// 03 — How it works: their plan is a to-do list the agent rewrites; ours is a
// spec the user signs. The change-request buttons are drawn, not controls.

const WHY_SPEC: [string, string][] = [
  [
    'The team drafts, you sign',
    'Agents draft the goal, constraints and "done means." Nothing starts until you sign.',
  ],
  [
    'An outcome, not a checklist',
    'Agents choose the steps. The spec fixes where those steps have to end up.',
  ],
  [
    'No agent can rewrite it',
    'To go off the spec, an agent has to ask. You approve, reply, or reject.',
  ],
  [
    'Work is judged against it',
    "A different specialist checks each deliverable against the spec, not against the author's opinion.",
  ],
]

const SPEC: [string, string, boolean?][] = [
  ['Goal', '500 qualified waitlist signups by Oct 31'],
  ['Must', 'On-brand voice · referral flow at launch'],
  ['Out of scope', 'Paid ads', true],
  ['Done means', 'Copy reviewed against brand voice · flow passes code review'],
]

export default function HowItWorks() {
  return (
    <Section
      id="how"
      n="03"
      label="How it works"
      headline="Their plan is a to-do list."
      accent="Ours is a spec you sign."
      description={`ChatGPT and Claude make plans too. Theirs is a to-do list the agent keeps for itself, and it rewrites that list whenever it sees fit. In ClawMeets, the team drafts a spec: the goal, the constraints, what's out of scope, and what "done" means. Once you sign it, every agent treats it as the north star. They can't change it. They can only propose a change to you.`}
    >
      <Compare
        old={{
          title: 'A to-do list the agent can rewrite',
          lede: 'You approve a list of steps. The agent edits it as it goes, and you find out at the end.',
          limit: { label: 'Who decides what "done" is:', text: 'the agent, as it goes.' },
          children: (
            <>
              <div className="todo">
                <div className="todo__h">Plan · launch the beta</div>
                <div className="todo__i">☑ Research competitors</div>
                <div className="todo__i todo__i--x">☐ Write landing copy in brand voice</div>
                <div className="todo__i todo__i--add">
                  ☐ Run paid ads to boost signups<small>added by agent</small>
                </div>
                <div className="todo__i">☐ Build waitlist page</div>
                <div className="todo__i todo__i--x">☐ Referral flow</div>
              </div>
              <div className="msg">
                <small>assistant</small>"I adjusted the plan to be more efficient: I skipped the
                referral flow and added paid ads."
              </div>
            </>
          ),
        }}
        new={{
          title: 'A signed spec every agent follows',
          lede: "You sign what the outcome must be, not a list of steps. Agents choose how to get there. They can't change the spec.",
          limit: { label: 'Who decides what "done" is:', text: 'you, once, and in writing.' },
          children: (
            <>
              <div className="spec2">
                <div className="spec2__h">
                  <b>SPEC · Q3 beta launch</b>
                  <span>✓ signed by you · Sep 29</span>
                </div>
                <dl>
                  {SPEC.map(([k, v, hit]) => (
                    <div key={k} className={hit ? 'hit' : undefined}>
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="north">
                <span>@marketing</span>
                <span>@designer</span>
                <span>@frontend</span>
                <span>@reviewer</span>
                <em>all work to the spec ↑</em>
              </div>
              <div className="change" data-testid="sample-change">
                <small>PROPOSED CHANGE · from @marketing · conflicts with "Out of scope"</small>
                <b>Add a $2k paid LinkedIn test in week 2</b>
                <div className="btns">
                  <span className="btn btn--p">Approve change</span>
                  <span className="btn btn--g">Reply with notes</span>
                  <span className="btn btn--g">Reject</span>
                </div>
              </div>
            </>
          ),
        }}
      />
      <p className="steps__h">Why the spec matters</p>
      <div className="steps steps--plain">
        {WHY_SPEC.map(([title, body]) => (
          <div key={title} className="step">
            <b>{title}</b>
            <span>{body}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}
