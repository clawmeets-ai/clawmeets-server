import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import PublicAgentsAccount from './components/publicAgents/PublicAgentsAccount'
import { fetchDirectory } from './components/publicAgents/api'
import { Unavailable } from './components/publicAgents/parts'
import { loadWidget } from './components/publicAgents/widget'
import './styles/design/tokens.css'
import './components/publicAgents/publicAgents.css'

// The public agent pages, served by server/routes/public_agents.py outside the
// /app SPA: no auth, no router, no app shell.
//   /users/:account/agents/              → the account page (chats in the widget's dock)
//   /users/:account/agents/:agent/chat   → the web chat widget, full page
const match = window.location.pathname.match(/^\/users\/([^/]+)\/agents\/?(?:([^/]+)\/chat\/?)?$/)
const username = match ? decodeURIComponent(match[1]) : ''
const agent = match?.[2] ? decodeURIComponent(match[2]) : ''

/** The hosted chat: this page only finds the agent's key; the widget draws
 * everything (and sets the title). The page loads the self-hosted fonts. */
function HostedChat({ username, agent }: { username: string; agent: string }) {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    fetchDirectory(username)
      .then((dir) => {
        const found = dir.agents.find((a) => a.id === agent)
        if (found) loadWidget('fullpage', found.chat_key)
        else setMissing(true)
      })
      .catch(() => setMissing(true))
  }, [username, agent])
  return missing ? <Unavailable text="This chat is not available." /> : null
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {!username
      ? <Unavailable text="This page is not available." />
      : agent
        ? <HostedChat username={username} agent={agent} />
        : <PublicAgentsAccount username={username} />}
  </React.StrictMode>,
)
