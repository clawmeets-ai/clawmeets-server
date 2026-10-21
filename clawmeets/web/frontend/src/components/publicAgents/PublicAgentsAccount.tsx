import { MouseEvent, useEffect, useMemo, useState } from 'react'
import { PublicAgent, PublicDirectory, chatUrl, fetchDirectory } from './api'
import { Avatar, Icon, PoweredBy, Unavailable } from './parts'
import { addChat, loadWidget, openChat } from './widget'

/** An account's public agents: /users/:account/agents/. Chats open in the web
 * chat widget's dock (several side by side, Messenger-style); each card still
 * links to the agent's full-page chat for a new tab or no JavaScript. */

type Filter = 'all' | 'direct'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function matches(agent: PublicAgent, query: string, filter: Filter): boolean {
  if (filter === 'direct' && !agent.takes_direct_requests) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [agent.display_name, agent.id, agent.description, ...agent.skills]
    .join(' ').toLowerCase().includes(q)
}

export default function PublicAgentsAccount({ username }: { username: string }) {
  const [dir, setDir] = useState<PublicDirectory | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    fetchDirectory(username).then(setDir).catch(() => setMissing(true))
  }, [username])

  useEffect(() => {
    if (!dir) return
    document.title = `${dir.account.display_name} — Public agents · ClawMeets`
    loadWidget('dock')
    // Every public agent goes in the dock's picker; heads appear as they're opened.
    dir.agents.forEach((a) => addChat(a.chat_key))
  }, [dir])

  if (missing) return <Unavailable text="This account has no public agents." />
  if (!dir) return <div className="pa2-page" aria-busy />
  return <AccountView dir={dir} />
}

function AccountView({ dir }: { dir: PublicDirectory }) {
  const { account, teams, agents } = dir
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const defaultAgent = agents.find((a) => a.id === dir.default_agent)

  const groups = useMemo(() => {
    const hits = agents.filter((a) => matches(a, query, filter))
    if (teams.length === 0) return hits.length ? [{ id: '', name: '', description: '', agents: hits }] : []
    const known = new Set(teams.map((t) => t.id))
    return [
      ...teams.map((t) => ({ ...t, agents: hits.filter((a) => a.team_id === t.id) })),
      {
        id: '', name: 'Other agents', description: '',
        agents: hits.filter((a) => !a.team_id || !known.has(a.team_id)),
      },
    ].filter((g) => g.agents.length > 0)
  }, [agents, teams, query, filter])

  return (
    <>
      <div className="pa2-page">
        <section className="pa2-prof">
          <Avatar name={account.display_name} seed={account.handle} size="xl" src={account.avatar_url} />
          <div className="info">
            <h1>{account.display_name}</h1>
            <div className="pc-mono pa2-handle">@{account.handle}</div>
            {account.bio && <p>{account.bio}</p>}
            <div className="pa2-meta">
              <span>{plural(agents.length, 'public agent')}</span>
              {teams.length > 0 && <span>{plural(teams.length, 'team')}</span>}
              {account.website && (
                <a href={account.website} target="_blank" rel="noopener noreferrer nofollow">
                  {account.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </a>
              )}
            </div>
          </div>
          {defaultAgent && (
            <a
              className="pc-btn pri"
              href={chatUrl(account.handle, defaultAgent.id)}
              onClick={(e) => openInDock(e, defaultAgent.chat_key)}
            >
              Ask {account.display_name}
            </a>
          )}
        </section>

        <div className="pa2-bar">
          <label className="pa2-search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents by name or skill"
              aria-label="Search agents"
            />
          </label>
          <div className="pa2-tabs" role="tablist" aria-label="Filter agents">
            {(['all', 'direct'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={filter === f ? 'on' : ''}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : 'Takes requests'}
              </button>
            ))}
          </div>
        </div>

        {groups.length === 0 && <div className="pa2-empty">No agents match.</div>}
        {groups.map((g) => (
          <section className="pa2-team" key={g.id || '_other'}>
            {g.name && <h2>{g.name}</h2>}
            {g.description && <div className="d">{g.description}</div>}
            <div className="pa2-grid">
              {g.agents.map((a) => <AgentCard key={a.id} username={account.handle} agent={a} />)}
            </div>
          </section>
        ))}
      </div>
      <PoweredBy />
    </>
  )
}

/** A plain click opens the chat in the dock; a modified click (new tab or
 * window) follows the link to the full-page chat. */
export function openInDock(e: MouseEvent, key: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  openChat(key)
}

function AgentCard({ username, agent }: { username: string; agent: PublicAgent }) {
  return (
    <a className="pa2-card" href={chatUrl(username, agent.id)} onClick={(e) => openInDock(e, agent.chat_key)}>
      <div className="top">
        <Avatar name={agent.display_name} seed={agent.id} />
        <div className="t">
          <b>{agent.display_name}</b>
          <span className="pc-mono">{agent.id}</span>
        </div>
      </div>
      {agent.description && <p className="desc">{agent.description}</p>}
      {agent.skills.length > 0 && <div className="pa2-sk">{agent.skills.join(' · ')}</div>}
      <div className="pa2-cf">
        {agent.takes_direct_requests
          ? <span className="pc-badge go"><i />Takes requests</span>
          : <span className="pc-badge">Answers questions</span>}
        <span className="go">Chat<Icon name="arrow" size={14} stroke={2.4} /></span>
      </div>
    </a>
  )
}
