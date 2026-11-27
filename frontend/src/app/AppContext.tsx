import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { connectMock, createDemoWallet, DEMO_ADA } from '../sdk/mock'

type Client = Awaited<ReturnType<typeof connectMock>>

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
  signOut: () => void
  addEntry: (e: Omit<Entry, 'id' | 'at'>) => void
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [client, setClient] = useState<Client | null>(null)
  const [history, setHistory] = useState<Entry[]>([])

  const signIn = useCallback(async (name: string) => {
    const wallet = await createDemoWallet(DEMO_ADA)
    const c = await connectMock({ network: 'testnet', pool: 'CMOCKPOOL', wallet })
    setClient(c)
    setHistory([])
    setSession({ name })
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
    <Ctx.Provider value={{ session, client, history, signIn, signOut, addEntry }}>
      {children}
    </Ctx.Provider>
  )
}

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp must be used inside AppProvider')
  return v
}
