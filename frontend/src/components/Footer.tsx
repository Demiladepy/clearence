import { Link } from 'react-router-dom'
import './Footer.css'

export default function Footer() {
  return (
    <footer className="container footer">
      <div>
        Built for the Stellar Buildathon 2026. Testnet only. Not for real
        funds.
      </div>
      <div>
        <Link to="/operator">For operators</Link> &middot; Team Clearance
      </div>
    </footer>
  )
}
