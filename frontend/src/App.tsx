import { Routes, Route } from 'react-router-dom'
import { AppProvider } from './app/AppContext'
import Landing from './pages/Landing'
import SignupPage from './pages/SignupPage'
import WalletPage from './pages/WalletPage'
import SendPage from './pages/SendPage'
import VerifyPage from './pages/VerifyPage'
import FundPage from './pages/FundPage'
import OperatorPage from './pages/OperatorPage'

export default function App() {
  return (
    <AppProvider>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<SignupPage />} />
        <Route path="/app/home" element={<WalletPage />} />
        <Route path="/app/send" element={<SendPage />} />
        <Route path="/app/verify" element={<VerifyPage />} />
        <Route path="/app/fund" element={<FundPage />} />
        <Route path="/operator" element={<OperatorPage />} />
      </Routes>
    </AppProvider>
  )
}
