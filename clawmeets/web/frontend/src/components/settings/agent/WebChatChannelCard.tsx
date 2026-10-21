import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink, Globe } from 'lucide-react'
import {
  connectWebChat,
  createWidgetGrant,
  disableConnection,
  enableConnection,
  getWidget,
  removeConnection,
  revokeWidgetGrant,
  updateWidgetGrant,
} from '../../../api/endpoints/channels'
import type { ChannelConnection, WidgetGrant } from '../../../api/endpoints/channels'
import { SectionCard, SectionHeader } from '../primitives'
import { CONNECTIONS_KEY, errorText, useAction } from './channelsShared'
import ChannelIsolationLine from './ChannelIsolationLine'

/**
 * Agent Settings → Channels → Web chat widget. Unlike the other channels there
 * is no provider and no credential: the owner turns it on, then adds keys
 * (grants) — each one an API key plus the sites allowed to embed it — and
 * pastes a key's one-line snippet into their site. The first key starts with
 * the ClawMeets server as its one site: that is what makes the hosted chat page
 * (and the account's public agents page) work, and taking the server off every
 * key makes the agent private.
 *
 * No allowlist or Requests here: a site visitor has no identity to put on a
 * list, so anyone on an allowed site reaches the agent (the server keeps the
 * connection in "anyone" mode). The protection is the site list, the rate
 * limits and revoking a key.
 */

export const WEBCHAT_COPY = {
  title: 'Web chat widget',
  connectHelp:
    'Put a chat bubble on any website with one line of code. Visitors’ conversations arrive as Front Desk threads you own.',
  turnOn: 'Turn on web chat',
  chatPage: 'Chat page',
  chatPageHelp:
    'A chat page on ClawMeets for trying the agent or sharing it with a link. While it is on, the agent is also listed on your public agents page.',
  chatPageOff: (server: string) =>
    `The chat page is off. Add ${server} to a key’s sites to turn it back on.`,
  serverSite: 'ClawMeets chat page',
  keysTitle: 'Website keys',
  keysHelp:
    'Each key works only on the sites you list. Paste its snippet into your site’s HTML, just before </body>. Pasting several agents’ snippets on one page gives visitors one chat head per agent.',
  noKeys: 'No keys yet. Add one for each website that should show the chat bubble.',
  addKey: 'Add key',
  labelLabel: 'Name (for you)',
  sitesLabel: 'Allowed sites, one per line',
  sitesPlaceholder: 'https://acme.com\nhttps://www.acme.com',
  security:
    'The key is visible in your site’s source. Allowed sites stop other websites from embedding the chat, but a script can still pretend to be your site, so messages are rate-limited. Revoke a key to shut it off at once.',
  removeConfirm: 'Remove the web chat widget? Every key stops working and the chat page goes away. Existing threads stay.',
  revokeConfirm: 'Revoke this key? The chat bubble disappears from every site using it.',
  disabledNote: 'Disabled: the chat bubble and the chat page answer “not available” until you enable it.',
} as const

/** Allowed sites as typed: one per line (commas also accepted). */
export function parseSites(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
}

const widgetKey = (id: string) => ['channel-widget', id]

export default function WebChatChannelCard({ agentName, connection }: {
  agentName: string; connection: ChannelConnection | undefined
}) {
  return connection
    ? <ConnectedWidget connection={connection} />
    : <ConnectWidget agentName={agentName} />
}

function ConnectWidget({ agentName }: { agentName: string }) {
  const queryClient = useQueryClient()
  const action = useAction()
  const connect = async () => {
    const ok = await action.run('connect', () => connectWebChat(agentName))
    if (ok) await queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY })
  }
  return (
    <SectionCard>
      <SectionHeader title={WEBCHAT_COPY.title} icon={<Globe className="w-4 h-4" />} subtitle={WEBCHAT_COPY.connectHelp} />
      <div className="px-6 py-5 flex flex-col gap-3">
        <div>
          <button
            type="button"
            onClick={connect}
            disabled={!!action.busy}
            className="px-4 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep disabled:opacity-50"
          >
            {action.busy ? 'Turning on…' : WEBCHAT_COPY.turnOn}
          </button>
        </div>
        {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
      </div>
    </SectionCard>
  )
}

function ConnectedWidget({ connection }: { connection: ChannelConnection }) {
  const queryClient = useQueryClient()
  const action = useAction()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const { data, error } = useQuery({
    queryKey: widgetKey(connection.id),
    queryFn: () => getWidget(connection.id),
    retry: false,
  })
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY }),
    queryClient.invalidateQueries({ queryKey: widgetKey(connection.id) }),
  ])
  const act = async (name: string, fn: () => Promise<unknown>) => {
    const ok = await action.run(name, fn)
    await refresh()
    return ok
  }

  return (
    <div className="space-y-6">
      <ChannelIsolationLine isolation={connection.isolation} heldConversations={connection.held_conversations} />
      <SectionCard>
        <div className="px-6 py-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <Globe className="w-5 h-5 text-purple-500 flex-shrink-0" />
              <p className="text-sm font-bold text-gray-900">{WEBCHAT_COPY.title}</p>
            </div>
            <span
              data-testid="webchat-status"
              className={`text-xs font-semibold px-2 py-1 rounded-full border ${
                connection.disabled
                  ? 'bg-gray-50 border-gray-200 text-gray-600'
                  : 'bg-green-50 border-green-200 text-green-700'
              }`}
            >
              {connection.disabled ? 'Disabled' : 'On'}
            </span>
          </div>
          {connection.disabled && <p className="text-xs text-gray-600">{WEBCHAT_COPY.disabledNote}</p>}
          <p className="text-xs text-gray-500">{WEBCHAT_COPY.security}</p>
          <div className="flex flex-wrap gap-2">
            {connection.disabled ? (
              <SmallButton busy={action.busy} name="enable" onClick={() => act('enable', () => enableConnection(connection.id))}>
                Enable
              </SmallButton>
            ) : (
              <SmallButton busy={action.busy} name="disable" onClick={() => act('disable', () => disableConnection(connection.id))}>
                Disable
              </SmallButton>
            )}
            {confirmRemove ? (
              <>
                <SmallButton busy={action.busy} name="remove" danger onClick={() => act('remove', () => removeConnection(connection.id))}>
                  Yes, remove
                </SmallButton>
                <SmallButton busy={action.busy} name="cancel" onClick={() => setConfirmRemove(false)}>Cancel</SmallButton>
              </>
            ) : (
              <SmallButton busy={action.busy} name="remove" danger onClick={() => setConfirmRemove(true)}>
                Remove
              </SmallButton>
            )}
          </div>
          {confirmRemove && <p className="text-xs text-red-700">{WEBCHAT_COPY.removeConfirm}</p>}
          {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
        </div>
      </SectionCard>

      {error && <p role="alert" className="text-sm text-red-700">{errorText(error)}</p>}
      {data && (
        <>
          <ChatPageCard url={data.chat_page_url} isPublic={data.chat_page_public} server={serverOrigin(data.script_url)} />
          <KeysCard connectionId={connection.id} grants={data.grants} server={serverOrigin(data.script_url)} onChanged={refresh} />
        </>
      )}
    </div>
  )
}

/** The server's own origin, as the key's site list spells it. */
function serverOrigin(scriptUrl: string): string {
  try {
    return new URL(scriptUrl).origin
  } catch {
    return ''
  }
}

function ChatPageCard({ url, isPublic, server }: { url: string; isPublic: boolean; server: string }) {
  return (
    <SectionCard>
      <SectionHeader title={WEBCHAT_COPY.chatPage} subtitle={WEBCHAT_COPY.chatPageHelp} />
      <div className="px-6 py-5 space-y-3">
        {isPublic ? (
          <div className="flex items-center gap-3 min-w-0">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="chat-page-url"
              className="text-xs font-mono text-purple-700 hover:underline truncate inline-flex items-center gap-1"
            >
              {url}
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </a>
            <CopyButton text={url} label="Copy chat page link" />
          </div>
        ) : (
          <p className="text-xs text-gray-500">{WEBCHAT_COPY.chatPageOff(server)}</p>
        )}
      </div>
    </SectionCard>
  )
}

function KeysCard({ connectionId, grants, server, onChanged }: {
  connectionId: string; grants: WidgetGrant[]; server: string; onChanged: () => Promise<unknown>
}) {
  const action = useAction()
  const [label, setLabel] = useState('')
  const [sites, setSites] = useState('')
  const labelId = useId()
  const sitesId = useId()

  const add = async (e: FormEvent) => {
    e.preventDefault()
    const origins = parseSites(sites)
    if (!origins.length) return
    const ok = await action.run('add', () => createWidgetGrant(connectionId, label.trim(), origins))
    if (ok) {
      setLabel('')
      setSites('')
    }
    await onChanged()
  }

  return (
    <SectionCard>
      <SectionHeader title={WEBCHAT_COPY.keysTitle} subtitle={WEBCHAT_COPY.keysHelp} />
      <div className="px-6 py-5 space-y-5">
        {grants.length === 0 && <p className="text-xs text-gray-500">{WEBCHAT_COPY.noKeys}</p>}
        <ul className="space-y-4">
          {grants.map((grant) => (
            <GrantRow key={grant.id} connectionId={connectionId} grant={grant} server={server} onChanged={onChanged} />
          ))}
        </ul>
        <form onSubmit={add} className="space-y-2 border-t border-gray-100 pt-4">
          <p className="text-xs font-semibold text-gray-700">{WEBCHAT_COPY.addKey}</p>
          <label htmlFor={labelId} className="block text-xs text-gray-600">{WEBCHAT_COPY.labelLabel}</label>
          <input
            id={labelId}
            value={label}
            maxLength={100}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Main site"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <label htmlFor={sitesId} className="block text-xs text-gray-600">{WEBCHAT_COPY.sitesLabel}</label>
          <textarea
            id={sitesId}
            value={sites}
            rows={2}
            spellCheck={false}
            onChange={(e) => setSites(e.target.value)}
            placeholder={WEBCHAT_COPY.sitesPlaceholder}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button
            type="submit"
            disabled={!!action.busy || parseSites(sites).length === 0}
            className="px-4 py-2 text-sm font-bold bg-accent text-white rounded-lg hover:bg-accent-deep disabled:opacity-50"
          >
            {action.busy === 'add' ? 'Adding…' : WEBCHAT_COPY.addKey}
          </button>
          {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
        </form>
      </div>
    </SectionCard>
  )
}

function GrantRow({ connectionId, grant, server, onChanged }: {
  connectionId: string; grant: WidgetGrant; server: string; onChanged: () => Promise<unknown>
}) {
  const action = useAction()
  const [editing, setEditing] = useState(false)
  const [sites, setSites] = useState(grant.origins.join('\n'))
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  const saveSites = async () => {
    const ok = await action.run('save', () => updateWidgetGrant(connectionId, grant.id, { origins: parseSites(sites) }))
    if (ok) setEditing(false)
    await onChanged()
  }
  const revoke = async () => {
    await action.run('revoke', () => revokeWidgetGrant(connectionId, grant.id))
    await onChanged()
  }

  return (
    <li className="space-y-2" data-testid="widget-grant">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-gray-900 truncate">{grant.label || 'Untitled key'}</p>
        <span className="text-[11px] text-gray-400 font-mono">{grant.key.slice(0, 8)}…</span>
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            aria-label={`Allowed sites for ${grant.label || 'this key'}`}
            value={sites}
            rows={Math.max(2, grant.origins.length)}
            spellCheck={false}
            onChange={(e) => setSites(e.target.value)}
            className="w-full px-3 py-2 text-xs border border-gray-200 rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <div className="flex gap-2">
            <SmallButton busy={action.busy} name="save" onClick={saveSites}>Save sites</SmallButton>
            <SmallButton busy={action.busy} name="cancel" onClick={() => { setEditing(false); setSites(grant.origins.join('\n')) }}>
              Cancel
            </SmallButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {grant.origins.map((origin) => (
            origin === server ? (
              <span key={origin} title={origin} className="text-[11px] font-semibold px-2 py-0.5 rounded bg-purple-50 text-purple-700">
                {WEBCHAT_COPY.serverSite}
              </span>
            ) : (
              <span key={origin} className="text-[11px] font-mono px-2 py-0.5 rounded bg-gray-100 text-gray-700">{origin}</span>
            )
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        <code data-testid="widget-snippet" className="flex-1 min-w-0 text-[11px] font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 break-all">
          {grant.snippet}
        </code>
        <CopyButton text={grant.snippet} label="Copy snippet" />
      </div>
      <div className="flex flex-wrap gap-2">
        {!editing && <SmallButton busy={action.busy} name="edit" onClick={() => setEditing(true)}>Edit sites</SmallButton>}
        {confirmRevoke ? (
          <>
            <SmallButton busy={action.busy} name="revoke" danger onClick={revoke}>Yes, revoke</SmallButton>
            <SmallButton busy={action.busy} name="cancel" onClick={() => setConfirmRevoke(false)}>Cancel</SmallButton>
          </>
        ) : (
          <SmallButton busy={action.busy} name="revoke" danger onClick={() => setConfirmRevoke(true)}>Revoke</SmallButton>
        )}
      </div>
      {confirmRevoke && <p className="text-xs text-red-700">{WEBCHAT_COPY.revokeConfirm}</p>}
      {action.error && <p role="alert" className="text-xs text-red-700">{action.error}</p>}
    </li>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 flex-shrink-0"
    >
      <Copy className="w-3.5 h-3.5" />
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function SmallButton({ busy, name, danger, onClick, children }: {
  busy: string | null; name: string; danger?: boolean; onClick: () => void; children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy !== null}
      className={`px-3 py-1.5 text-xs font-semibold border rounded-lg disabled:opacity-50 ${
        danger ? 'border-red-200 text-red-700 hover:bg-red-50' : 'border-gray-200 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {busy === name ? `${children}…` : children}
    </button>
  )
}
