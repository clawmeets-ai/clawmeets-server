import Section, { Compare } from './Section'

// 02 — Why a team: keep the generalist as the front door, add specialists
// behind it.

export default function WhyTeamSection() {
  return (
    <Section
      id="team"
      tint
      n="02"
      label="Why not one universal assistant"
      headline="Your brilliant assistant needs a team."
      accent="You want both."
      description="Keep the generalist you already love as your front door. Behind it, add specialists for the work that matters: they already have the context for simple tasks, and on complex ones no agent marks its own homework."
    >
      <Compare
        old={{
          title: 'One assistant, every role',
          lede: 'You re-explain your situation every time, and the same agent that wrote the work grades it — so its mistakes get through.',
          children: (
            <>
              <div className="msg">
                <small>to: general assistant</small>"I'm a sole proprietor in CA with an S-corp
                election, two 1099 clients, and a home office. Here are last year's numbers… what
                should my Q3 estimated payment be?"
              </div>
              <div className="loop">
                <span className="chip">assistant · writes the code</span>→
                <span className="chip">assistant · checks it</span>
              </div>
              <span className="ping">"Looks good to me." — the same agent</span>
            </>
          ),
        }}
        new={{
          title: 'Your assistant, plus a team behind it',
          lede: 'Ask your assistant for general tasks and a specialist for domain-specific ones. Complex work that needs collaboration goes to a team of experts, not one universal agent switching hats all day.',
          limit: { label: 'Result:', text: 'the ease of one assistant, with results you can trust.' },
          children: (
            <>
              <div className="hub">
                <span className="av">A</span>
                <div>
                  <b>assistant</b> · your generalist
                  <small>quick questions, routing, and planning with you</small>
                </div>
              </div>
              <div className="hub__split">
                <span>routes to</span>
              </div>
              <div className="spec">
                <div className="spec__c">
                  <b>@cpa</b>
                  <small>already knows your books</small>
                  <span className="msg__q">"What's my Q3 estimate?"</span>
                </div>
                <div className="spec__c">
                  <b>@backend</b> → <b className="rv">@code_reviewer</b>
                  <small>writes it · a different agent checks it</small>
                </div>
                <div className="spec__c">
                  <b>@product</b> → <b className="rv">@investor</b>
                  <small>drafts the pitch · pokes holes in it</small>
                </div>
              </div>
            </>
          ),
        }}
      />
    </Section>
  )
}
