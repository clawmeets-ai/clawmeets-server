import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
      // Live data arrives over the WebSocket, and a reconnect runs a paced
      // catch-up (useWebSocketUpdates). Refetching every stale mounted query
      // on each tab switch duplicated that work as an unpaced burst — dozens
      // of requests at once on My Desk. Queries that genuinely need a focus
      // refresh (desk read-state, recently done, announcements) opt back in.
      refetchOnWindowFocus: false,
    },
  },
})
