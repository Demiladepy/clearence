import Nav from './components/Nav'
import Hero from './components/Hero'
import Problem from './components/Problem'
import HowItWorks from './components/HowItWorks'
import TryIt from './components/TryIt'
import RulePacks from './components/RulePacks'
import WhoFor from './components/WhoFor'
import Developers from './components/Developers'
import Footer from './components/Footer'

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Problem />
        <HowItWorks />
        <TryIt />
        <RulePacks />
        <WhoFor />
        <Developers />
      </main>
      <Footer />
    </>
  )
}