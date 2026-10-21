import Nav from '../src/components/landing/Nav'
import Hero from '../src/components/hero/Hero'
import WhyNowSection from '../src/components/landing/WhyNowSection'
import WhyTeamSection from '../src/components/landing/WhyTeamSection'
import HowItWorks from '../src/components/landing/HowItWorks'
import ComparisonSection from '../src/components/landing/ComparisonSection'
import KnowledgeSection from '../src/components/landing/KnowledgeSection'
import FAQ from '../src/components/landing/FAQ'
import Footer from '../src/components/landing/Footer'

// The page tells one story, top to bottom: stop managing chats (Hero) → 01 why
// it's the future → 02 why a team → 03 how it works → 04 how it's different →
// 05 your knowledge → 06 FAQ → the closing band at the top of Footer. Sections
// 01–05 share one anatomy (components/landing/Section.tsx); every style is
// scoped under .hp in styles/homepage.css.
//
// Left out of the page for now; the components are kept in
// src/components/landing/ so they can be dropped back in:
// - CrewSection, StaffingSection — their ground is now covered by the
//   specialists section and step 1 of HowItWorks.
// - Pricing — off the page until its copy is revisited. Nav and Footer no
//   longer link to #crew / #pricing; re-add those links with them.
// - LearningSection, ConsoleSection — the full run made the page too long to skim.

export default function Page() {
  return (
    <div className="hp">
      <Nav />
      <Hero />
      <WhyNowSection />
      <WhyTeamSection />
      <HowItWorks />
      <ComparisonSection />
      <KnowledgeSection />
      <FAQ />
      <Footer />
    </div>
  )
}
