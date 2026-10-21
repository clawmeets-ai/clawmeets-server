import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/** `render(ui, { wrapper: withQueryClient })` for a component that reads a
 *  query but whose test is not about it: one client per render, no retries. */
export function withQueryClient({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}
