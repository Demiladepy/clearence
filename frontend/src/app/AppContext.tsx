import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk'
import { FreighterModule } from '@creit-tech/stellar-wallets-kit/modules/freighter'
import { AlbedoModule } from '@creit-tech/stellar-wallets-kit/modules/albedo'
import { connectDemoAccount, connectLive, identityForWallet } from '../sdk/clearance'
import type { Client } from '../sdk/clearance'
import type { WalletLike } from '../sdk/types'

interface Session {
  name: string
}

export interface Entry {
  id: number
  kind: 'cleared' | 'not_sent'
  amountNgn: number
  call: string
  at: string
  txHash?: string
  explorerUrl?: string
  provingMs?: number
  code?: string
}

interface AppState {
  session: Session | null
  client: Client | null
  history: Entry[]
  signIn: (name: string) => Promise<void>
  connectWallet: () => Promise<void>
  signOut: () => void
  addEntry: (e: Omit<Entry, 'id' | 'at'>) => void
}

const Ctx = createContext<AppState | null>(null)

let kitReady = false
function ensureKit() {
  if (!kitReady) {
    StellarWalletsKit.init({ modules: [new FreighterModule(), new AlbedoModule()] })
    kitReady = true
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [history, setHistory] = useState<Entry[]>([])

  const signIn = useCallback(async (name: string) => {
    const c = await connectDemoAccount()
    setClient(c)
    setHistory([])
    setSession({ name })
  }, [])

  const connectWallet = useCallback(async () => {
    ensureKit()
    const { address } = await StellarWalletsKit.authModal()
    const wallet: WalletLike = {
      getAddress: () => StellarWalletsKit.getAddress(),
      signTransaction: async (xdr, opts) => {
        const r = await StellarWalletsKit.signTransaction(xdr, {
          networkPassphrase: opts?.networkPassphrase,
        })
        return { signedTxXdr: r.signedTxXdr }
      },
    }
    const c = await connectLive(wallet, identityForWallet())
    setClient(c)
    setHistory([])
    setSession({ name: address.slice(0, 4) + '\u2026' + address.slice(-4) })
  }, [])

  const signOut = useCallback(() => {
    setClient(null)
    setSession(null)
    setHistory([])
  }, [])

  const addEntry = useCallback((e: Omit<Entry, 'id' | 'at'>) => {
    setHistory((h) => [
      { ...e, id: h.length + 1, at: new Date().toISOString() },
      ...h,
    ])
  }, [])

  return (
    <Ctx.Provider
      value={{ session, client, history, signIn, connectWallet, signOut, addEntry }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp must be used inside AppProvider')
  return v
}