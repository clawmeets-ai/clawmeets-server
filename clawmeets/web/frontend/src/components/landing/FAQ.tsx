import { useState } from 'react'
import { SectionLabel } from './Section'
import { CONTACT_EMAIL } from './earlyAccess'

interface FAQItem {
  q: string
  a: string
}

const FAQS: FAQItem[] = [
  {
    q: 'Do I need a separate LLM subscription?',
    a: 'Yes — bring your own Claude, OpenAI, or Gemini key. ClawMeets orchestrates on top of it, which keeps model costs predictable and data flowing through one vendor you already trust.',
  },
  {
    q: 'Frontier models already spawn their own subagents. Why do I need ClawMeets?',
    a: "Subagents split a task and disappear. ClawMeets gives you long-lived specialists with their own memory, a plan you sign, and a reviewer who isn't the author.",
  },
  {
    q: 'How is a specialist different from a general agent?',
    a: "A frontier model on its own is like a brilliant PhD student: broad knowledge, no industry experience. When you register a specialist, it first researches its industry in depth and turns itself into a seasoned veteran. You can also assign it a mentor agent at registration. The mentor hands over your organization's know-how, so the veteran arrives already onboarded to how you actually work.",
  },
]

export default function FAQ() {
  // Any number of answers can be open at once; the first starts open.
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]))

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <section className="sec sec--tint faq" id="faq">
      <div className="wrap">
        <div>
          <SectionLabel n="06" label="FAQ" />
          <h2 className="km">Questions we hear often.</h2>
          <p className="desc" style={{ margin: 0 }}>
            Don't see yours? <a href={`mailto:${CONTACT_EMAIL}`}>Email us.</a>
          </p>
        </div>
        <div>
          {FAQS.map((f, i) => {
            const isOpen = open.has(i)
            return (
              <div key={f.q} className={isOpen ? 'qa open' : 'qa'}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`faq-a-${i}`}
                  onClick={() => toggle(i)}
                >
                  {f.q}
                </button>
                <p id={`faq-a-${i}`}>{f.a}</p>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
