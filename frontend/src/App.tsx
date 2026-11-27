import { Routes, Route } from 'react-router-dom'
import Landing from './pages/Landing'
import WalletPage from './pages/WalletPage'
import OperatorPage from './pages/OperatorPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/app" element={<WalletPage />} />
      <Route path="/operator" element={<OperatorPage />} />
    </Routes>
  )
}
