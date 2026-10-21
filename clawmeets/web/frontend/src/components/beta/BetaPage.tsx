import Nav from './Nav'
import Hero from './Hero'
import TwoModels from './TwoModels'
import Pillars from './Pillars'
import DayAtMyDesk from './DayAtMyDesk'
import Footer from './Footer'

// Private-beta announcement page (route: /private-beta-announcement).
// Reuses the landing design tokens + Button/Wordmark so it reads as one site.
export default function BetaPage() {
  return (
    <>
      <Nav />
      <Hero />
      <TwoModels />
      <Pillars />
      <DayAtMyDesk />
      <Footer />
    </>
  )
}
