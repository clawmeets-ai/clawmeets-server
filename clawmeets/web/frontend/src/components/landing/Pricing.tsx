import { ArrowRight, Check } from 'lucide-react'
import Button from '../hero/Button'

interface Tier {
  name: string
  price: string
  per: string
  blurb: string
  features: string[]
  cta: string
  variant: 'primary' | 'ghost'
  highlight?: boolean
  ribbon?: string
  strike?: string
}

const TIERS: Tier[] = [
  {
    name: 'Starter',
    price: '$0',
    per: 'monthly',
    blurb: 'Everything a solo captain needs to run a crew.',
    features: [
      'Your own deputy-agent',
      'Up to 50 agent actions / day',
      'All 6 specialist agents',
      'Local knowledge & BYO model key',
      'Community support',
    ],
    cta: 'Request invite',
    variant: 'ghost',
  },
  {
    name: 'Pro',
    price: '$0',
    per: 'monthly · limited time',
    blurb: 'For heavy users shipping multiple milestones a day.',
    features: [
      'Up to 500 agent actions / day',
      'Custom specialist agents',
      'Priority agent runtime',
      'Replay + audit history (90 days)',
      'Email support',
    ],
    cta: 'Request invite',
    variant: 'primary',
    highlight: true,
    ribbon: 'FREE DURING PRIVATE BETA',
    strike: '$49',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    per: 'talk to us',
    blurb: 'For teams with shared knowledge, SSO, and compliance needs.',
    features: [
      'Unlimited agent actions',
      'Shared workspace knowledge',
      'SSO, SCIM, audit log export',
      'Custom acceptance-criteria policies',
      'Priority support (SLA)',
    ],
    cta: 'Contact sales',
    variant: 'ghost',
  },
]

export default function Pricing() {
  return (
    <section
      id="pricing"
      className="py-[88px]"
      style={{
        background: 'var(--bg-sidebar)',
        borderTop: '1px solid var(--line-1)',
      }}
    >
      <div className="max-w-6xl mx-auto px-7">
        <div className="text-center mb-9">
          <div
            className="font-mono font-extrabold uppercase text-ink-3 mb-3"
            style={{ fontSize: 10.5, letterSpacing: '.08em' }}
          >
            07 — Pricing
          </div>
          <h2
            className="font-extrabold text-ink-1 m-0"
            style={{
              fontSize: 'clamp(30px, 3.8vw, 46px)',
              lineHeight: 1.1,
              letterSpacing: '-0.015em',
            }}
          >
            Pay for the crew.
            <br />
            Not for the tokens.
          </h2>
          <p
            className="text-ink-2 mx-auto"
            style={{
              maxWidth: 560,
              margin: '14px auto 0',
              fontSize: 14,
              lineHeight: 1.55,
            }}
          >
            ClawMeets runs on your Claude, OpenAI, or Gemini key — so model cost is your
            existing subscription, not ours. Plans scale by agent actions, not channels.
          </p>
          <div
            className="inline-flex items-center gap-2 text-white rounded-full mt-[18px]"
            style={{
              padding: '6px 14px',
              background: 'var(--accent)',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <span
              className="pricing-pulse"
              style={{ width: 7, height: 7, borderRadius: 999, background: '#fff' }}
            />
            <span
              className="font-mono font-extrabold"
              style={{ fontSize: 11.5, letterSpacing: '.06em' }}
            >
              LIMITED TIME · PRO IS FREE DURING PRIVATE BETA
            </span>
          </div>
        </div>

        <div className="pricing-grid grid gap-3">
          {TIERS.map((t) => (
            <div
              key={t.name}
              className="flex flex-col gap-3.5 relative rounded-md"
              style={{
                padding: '26px 22px 22px',
                border: `1px solid ${t.highlight ? 'var(--accent)' : 'var(--line-2)'}`,
                background: t.highlight ? 'var(--bg-proposal)' : 'var(--bg-card)',
                boxShadow: t.highlight ? 'var(--shadow-2)' : 'var(--shadow-1)',
              }}
            >
              {t.ribbon && (
                <div
                  className="font-mono font-extrabold text-white whitespace-nowrap"
                  style={{
                    position: 'absolute',
                    top: -1,
                    left: '50%',
                    transform: 'translateX(-50%) translateY(-50%)',
                    background: 'var(--accent)',
                    fontSize: 10,
                    padding: '4px 12px',
                    borderRadius: 999,
                    letterSpacing: '.08em',
                  }}
                >
                  {t.ribbon}
                </div>
              )}
              <div>
                <div
                  className="font-mono text-ink-3"
                  style={{ fontSize: 10.5, letterSpacing: '.08em' }}
                >
                  PLAN
                </div>
                <h3
                  className="font-extrabold"
                  style={{
                    fontSize: 22,
                    margin: '2px 0 0',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {t.name}
                </h3>
              </div>
              <div className="flex items-baseline gap-2 flex-wrap">
                {t.strike && (
                  <div
                    className="font-bold line-through text-ink-4"
                    style={{
                      fontSize: 28,
                      lineHeight: 1,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {t.strike}
                  </div>
                )}
                <div
                  className="font-extrabold text-ink-1"
                  style={{
                    fontSize: 40,
                    lineHeight: 1,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {t.price}
                </div>
                <div className="font-mono text-ink-3" style={{ fontSize: 11 }}>
                  {t.per}
                </div>
              </div>
              <p className="m-0 text-ink-2" style={{ fontSize: 13, lineHeight: 1.5 }}>
                {t.blurb}
              </p>
              <ul className="list-none p-0 m-0 grid gap-2 flex-1">
                {t.features.map((f) => (
                  <li
                    key={f}
                    className="flex gap-2 items-start"
                    style={{ fontSize: 13 }}
                  >
                    <Check
                      size={13}
                      strokeWidth={2.5}
                      style={{
                        color: 'var(--accent)',
                        marginTop: 3,
                        flexShrink: 0,
                      }}
                    />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Button
                variant={t.variant}
                href="#"
                className="justify-center w-full"
              >
                {t.cta} <ArrowRight size={12} />
              </Button>
            </div>
          ))}
        </div>

        <p
          className="text-center text-ink-3 mt-[22px]"
          style={{ fontSize: 12.5 }}
        >
          One agent action = one specialist-agent milestone or tool call. You bring your own
          model key; we never bill for tokens.
        </p>
      </div>

      <style>{`
        .pricing-grid { grid-template-columns: repeat(3, 1fr); }
        @media (max-width: 900px) { .pricing-grid { grid-template-columns: 1fr; } }
        @keyframes pricingPulse {
          0%, 100% { transform: scale(1); opacity: .9; }
          50%      { transform: scale(1.25); opacity: .5; }
        }
        .pricing-pulse { animation: pricingPulse 2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .pricing-pulse { animation: none !important; }
        }
      `}</style>
    </section>
  )
}
