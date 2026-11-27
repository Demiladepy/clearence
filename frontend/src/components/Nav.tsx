import { Link } from 'react-router-dom'
import './Nav.css'

export default function Nav() {
  return (
    <header className="container nav">
      <a href="#top" className="nav-brand" aria-label="Clearance home">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
          <rect x="1" y="1" width="24" height="24" rx="5" fill="#15181B" />
          <path
            d="M7 13.5l4 4 8-9"
            fill="none"
            stroke="#F3EFE6"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="nav-wordmark">Clearance</span>
      </a>

      <nav className="nav-links" aria-label="Main">
        <a href="#how" className="nav-link">How it works</a>
        <a href="#packs" className="nav-link">Rule packs</a>
        <a href="#dev" className="nav-link">Developers</a>
        <Link to="/app" className="btn btn-primary">Try the demo</Link>
      </nav>
    </header>
  )
}
