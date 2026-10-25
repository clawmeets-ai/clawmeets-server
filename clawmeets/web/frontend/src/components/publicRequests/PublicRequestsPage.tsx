import { useCallback, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useRetainedAgents } from '../../hooks/useAgentAccess'
import { usePublicRequest } from '../../hooks/usePublicRequests'
import Loading from '../common/Loading'
import AgentDrawer from './AgentDrawer'
import RequestHome from './RequestHome'
import RequestRoom from './RequestRoom'
import { AGENT_PARAM, fromMatch, fromRetained, type DrawerAgent } from './agentView'
import './publicRequests.css'

/** /requests (ask) and /requests/:requestId (the room). */
export default function PublicRequestsPage() {
  const { requestId } = useParams()
  const [params, setParams] = useSearchParams()
  const { data: request, isLoading, isError } = usePublicRequest(requestId)
  const { data: retained } = useRetainedAgents()

  const drawerRef = params.get(AGENT_PARAM)
  const drawerAgent: DrawerAgent | null = useMemo(() => {
    if (!drawerRef) return null
    const match = request?.matches.find((m) => m.agent_ref === drawerRef)
    if (match) return fromMatch(match)
    const row = retained?.find((r) => r.hub_agent_id === drawerRef)
    return row ? fromRetained(row) : null
  }, [drawerRef, request, retained])

  const openAgent = useCallback((ref: string) => {
    setParams((p) => { p.set(AGENT_PARAM, ref); return p })
  }, [setParams])
  const closeAgent = useCallback(() => {
    setParams((p) => { p.delete(AGENT_PARAM); return p }, { replace: true })
  }, [setParams])

  let body: React.ReactNode
  if (!requestId) body = <RequestHome />
  else if (isLoading) body = <Loading />
  else if (isError || !request) body = <div className="pr-room"><p className="pr-empty">This request is not available.</p></div>
  else body = <RequestRoom request={request} onOpenAgent={openAgent} drawerOpen={!!drawerAgent} />

  return (
    <div className="pr-page" data-testid="public-requests-page">
      {body}
      {drawerAgent && <AgentDrawer agent={drawerAgent} onClose={closeAgent} />}
    </div>
  )
}
