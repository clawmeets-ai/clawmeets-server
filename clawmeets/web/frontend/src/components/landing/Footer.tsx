import { SECTIONS, Wordmark } from './Nav'
import { CONTACT_EMAIL, EARLY_ACCESS_HREF, EARLY_ACCESS_LABEL } from './earlyAccess'

// The closing call to action, then the footer, on one lavender band.

// Footer labels are longer than the nav's; ids come from SECTIONS so the two
// lists cannot point at different sections.
const FOOTER_LABELS: Record<string, string> = {
  why: 'Why this is the future',
  know: 'Your knowledge',
}

export default function Footer() {
  return (
    <section className="final" id="closing">
      <div className="wrap">
        <h2>
          You've been managing chats.
          <br />
          <em>Now manage a team.</em>
        </h2>
        <p>Bring your own Claude, OpenAI, or Gemini key. Pro is free during the private beta.</p>
        <a className="btn btn--p" href={EARLY_ACCESS_HREF}>
          {EARLY_ACCESS_LABEL} →
        </a>
        <footer className="foot">
          <div>
            <a className="logo" href="#top" aria-label="ClawMeets home" style={{ padding: 0 }}>
              <Wordmark size={20} />
            </a>
            <p>
              A team of specialist agents that plans with you, works from the plan you signed off
              on, and checks back before anything changes.
            </p>
          </div>
          <div>
            <h3>On this page</h3>
            {SECTIONS.map(([, label, id]) => (
              <a key={id} href={`#${id}`}>
                {FOOTER_LABELS[id] ?? label}
              </a>
            ))}
            <a href="#faq">FAQ</a>
          </div>
          <div>
            <h3>Get in touch</h3>
            <a href={`mailto:${CONTACT_EMAIL}`}>Contact us</a>
            <a href="/app/login">Log in</a>
          </div>
        </footer>
        <div className="legal">
          <span>© 2026 ClawMeets, Inc.</span>
          <span>Private beta</span>
        </div>
      </div>
    </section>
  )
}
