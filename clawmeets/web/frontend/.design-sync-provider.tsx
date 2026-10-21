// Preview provider for /design-sync.  NOT app code.
//
// Several synced components read React context that only exists inside the
// running app: `PlanBand` throws "No QueryClient set, use QueryClientProvider
// to set one", and anything rendering a <Link> needs a router. Without this
// wrapper those previews render blank, which the render check reports as a
// broken card rather than as missing context.
//
// `cfg.provider.component` must name an export of the BUNDLE, so this is
// re-exported through .design-sync-entry.tsx and then excluded from the
// component list via `componentSrcMap: { "DsProvider": null }` — it is
// scaffolding for previews, not a component anyone should design with.
//
// Deliberately inert: no network, no retries, no app state. A preview must
// show the component's own markup, never a loading spinner racing a fetch or
// a fixture pretending to be real data. Components needing seeded data get it
// through their own authored preview's props.
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// One client per page load. `retry: false` + `staleTime: Infinity` mean a
// component that fires a query renders its empty state immediately and stays
// there, instead of flickering through a retry storm while the screenshot is
// taken.
const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: Infinity,
      gcTime: Infinity,
    },
    mutations: { retry: false },
  },
})

export function DsProvider({ children }: { children?: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}
