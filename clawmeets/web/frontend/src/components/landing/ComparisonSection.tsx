import Section, { Compare } from './Section'

// 04 — How it's different from other multi-agent platforms: four long reports
// with a buried change vs the signed contract shown as a redline.

export default function ComparisonSection() {
  return (
    <Section
      id="diff"
      tint
      n="04"
      label="How it's different"
      headline="Other multi-agent platforms give you experts."
      accent="We keep you in the loop."
      description="Plenty of multi-agent platforms give you a team of specialists. The difference is how you're involved once they start working. In ClawMeets, the agents first agree on a plan together, and you sign it as the contract. Any deviation comes back to you as a redline to sign off. You review the diff instead of re-reading every agent's output, and no agent can quietly make a big change."
    >
      <Compare
        old={{
          title: 'Typical multi-agent platform',
          lede: 'An orchestrator hands the task to experts. They all report back at the end, and you read everything to find out what changed.',
          limit: { label: 'You review:', text: 'everything, every time.' },
          children: (
            <>
              <div className="rpt">
                <b>@research</b> · 1,840 words
                <i />
                <i />
                <i style={{ width: '70%' }} />
              </div>
              <div className="rpt">
                <b>@marketing</b> · 2,310 words
                <i />
                <i className="rpt__hid">…also moved launch to annual-only pricing…</i>
                <i style={{ width: '60%' }} />
              </div>
              <div className="rpt thread--tilt">
                <b>@designer</b> · 14 slides + notes
                <i />
                <i style={{ width: '80%' }} />
              </div>
              <div className="rpt">
                <b>@frontend</b> · 3,020 words
                <i />
                <i style={{ width: '50%' }} />
              </div>
              <span className="ping">You find the pricing change on page 3, after it shipped</span>
            </>
          ),
        }}
        new={{
          title: 'A contract, then only the redlines',
          lede: 'Agents agree on the plan before they start. Anything that would change it comes to you as a diff to sign.',
          limit: { label: 'You review:', text: 'two lines, not four reports.' },
          children: (
            <div className="redl">
              <div className="redl__h">
                <b>CONTRACT · Q3 beta launch</b>
                <span>2 changes awaiting you</span>
              </div>
              <div className="redl__l">
                <em>Pricing</em>
              </div>
              <div className="redl__l redl__l--del">− Monthly and annual plans at launch</div>
              <div className="redl__l redl__l--add">
                + Annual-only plans at launch<small>proposed by @marketing</small>
              </div>
              <div className="redl__l">
                <em>Budget</em>
              </div>
              <div className="redl__l redl__l--add">
                + $2k paid LinkedIn test, week 2<small>proposed by @marketing</small>
              </div>
              <div className="redl__same">14 other clauses unchanged · all agents on contract</div>
              <div className="redl__f">
                <span className="btn btn--p">Sign changes</span>
                <span className="btn btn--g">Reply with notes</span>
              </div>
            </div>
          ),
        }}
      />
      <div className="analogy">
        <span className="analogy__k">Why this works</span>
        <p>
          It's the same habit that keeps remote teams productive. A design doc everyone has
          signed means nobody needs a meeting to stay aligned and nobody gets surprised. ClawMeets
          gives your agents that doc and keeps you as the person who signs it.
        </p>
      </div>
    </Section>
  )
}
