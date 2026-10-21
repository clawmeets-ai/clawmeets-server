import { describe, expect, it } from 'vitest'
import { QueryClient, type InfiniteData } from '@tanstack/react-query'
import type { HubAgentDetail, HubAgentPage } from '../api/endpoints/hub'
import { hubAgent, hubAgentDetail } from '../test/hubFixtures'
import { setRetainedInCaches } from './useAgentAccess'
import { hubAgentKey } from './useHub'

describe('retain writes the flag into the cached directory and detail', () => {
  it('flips retained on every page, query and the detail, for that id only', () => {
    const qc = new QueryClient()
    const a = hubAgent({ name: 'a' })
    const b = hubAgent({ name: 'b' })
    const pages = (agents: typeof a[]): InfiniteData<HubAgentPage> => ({
      pageParams: [undefined],
      pages: [{ agents, next_cursor: null, served_from: 'live', cache_age_s: null, cached_at: null }],
    })
    qc.setQueryData(['hub-directory', '', [], false], pages([a, b]))
    qc.setQueryData(['hub-directory', 'x', [], true], pages([a]))
    qc.setQueryData(hubAgentKey(a.hub_agent_id), hubAgentDetail({ name: 'a' }))

    setRetainedInCaches(qc, a.hub_agent_id, true)
    const first = qc.getQueryData<InfiniteData<HubAgentPage>>(['hub-directory', '', [], false])!
    expect(first.pages[0].agents.map((x) => x.retained)).toEqual([true, undefined])
    expect(qc.getQueryData<InfiniteData<HubAgentPage>>(['hub-directory', 'x', [], true])!.pages[0].agents[0].retained).toBe(true)
    expect(qc.getQueryData<HubAgentDetail>(hubAgentKey(a.hub_agent_id))!.retained).toBe(true)

    setRetainedInCaches(qc, a.hub_agent_id, false)
    expect(qc.getQueryData<HubAgentDetail>(hubAgentKey(a.hub_agent_id))!.retained).toBe(false)
  })
})
