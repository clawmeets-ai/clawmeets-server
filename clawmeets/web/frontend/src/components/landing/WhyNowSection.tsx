import Section, { Compare } from './Section'

// 01 — Why this is the future: managing chats vs agent management.

export default function WhyNowSection() {
  return (
    <Section
      id="why"
      n="01"
      label="Why this is the future"
      headline="Your output is capped by what you can keep in your head."
      accent="It doesn't have to be."
      description="Today most people use AI by running a dozen conversations at once. That's managing chats, not delegating work, and it stops scaling at the number of conversations you can hold in your head. Human managers hit the same wall from the other side. Agents don't — once the plan is written down, adding one more agent doesn't add more meetings."
    >
      <Compare
        old={{
          title: 'Managing chats',
          lede: "You run every thread. You carry the context from one to the next. You're the one who drops the ball.",
          limit: {
            label: 'Your limit:',
            text: 'how many conversations you can keep in your head.',
            bar: true,
          },
          children: (
            <>
              <div className="tabs">
                <span>
                  pricing page…<b />
                </span>
                <span>
                  investor upd…<b />
                </span>
                <span>fix flaky CI</span>
                <span>
                  hiring rubric<b />
                </span>
                <span>Q3 taxes</span>
                <span>competitor…</span>
                <span>+</span>
              </div>
              <div className="thread">
                chat: pricing page rewrite<small>3 unread</small>
              </div>
              <div className="thread thread--tilt">
                chat: investor update draft<small>where was I?</small>
              </div>
              <div className="thread">
                chat: fix flaky CI<small>2d ago</small>
              </div>
              <span className="paste">⌘C ⌘V — pasting the context in again</span>
              <div className="thread thread--tilt2">
                chat: hiring rubric<small>1 unread</small>
              </div>
              <div className="thread thread--lost">chat: Q3 taxes (forgot where I left it)</div>
              <div className="thread thread--lost">chat: competitor teardown (stale)</div>
            </>
          ),
        }}
        new={{
          title: 'Agent management',
          lede: "You set direction, sign off on plans, and review results. Your agents carry the context, because it's written down.",
          limit: {
            label: 'Your limit:',
            text: "how many agents you can manage. That's far more, and it keeps going up.",
            bar: true,
          },
          children: (
            <>
              <div className="row">
                team: Q3 launch · 3 agents<small>✓ plan signed</small>
              </div>
              <div className="row">
                team: Billing v2 · 2 agents<small>✓ plan signed</small>
              </div>
              <div className="row">
                cpa: Q3 taxes<small>ready for review</small>
              </div>
              <div className="row">
                research: competitor watch<small>runs weekly</small>
              </div>
              <div className="row row--add">+ add an agent when the work calls for one</div>
            </>
          ),
        }}
      />
      <p className="verdict">
        From <s>holding every thread yourself</s> to{' '}
        <em>managing a team that holds them for you.</em>
      </p>
    </Section>
  )
}
