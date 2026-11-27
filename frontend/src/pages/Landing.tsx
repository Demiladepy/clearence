import Nav from '../components/Nav'
import Hero from '../components/Hero'
import Problem from '../components/Problem'
import HowItWorks from '../components/HowItWorks'
import RulePacks from '../components/RulePacks'
import Developers from '../components/Developers'
import Footer from '../components/Footer'

export default function Landing() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Problem />
        <HowItWorks />
        <RulePacks />
        <Developers />
      </main>
      <Footer />
    </>
  )
}
