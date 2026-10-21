import { BASE } from './api'

/**
 * The public pages run chats in the web chat widget
 * (`server/channels/webchat_widget.js`) — the same script customer sites
 * embed — and drive it through `window.ClawMeetsChat`. Calls made before the
 * script loads are queued (the widget drains the array when it boots).
 */

type Command = [string, ...unknown[]]
interface ChatApi {
  push: (cmd: Command) => void
}

declare global {
  interface Window {
    ClawMeetsChat?: ChatApi | Command[]
  }
}

function chatApi(): ChatApi {
  if (!window.ClawMeetsChat) window.ClawMeetsChat = []
  return window.ClawMeetsChat as ChatApi
}

/** Load the widget once. `fullpage` mounts one chat filling the page; `dock`
 * starts an empty dock that `addChat` / `openChat` fill. */
export function loadWidget(mode: 'dock' | 'fullpage', key?: string) {
  if (document.querySelector('script[data-clawmeets-widget]')) return
  const s = document.createElement('script')
  s.src = `${BASE}/api/channels/widget.js`
  s.async = true
  s.setAttribute('data-clawmeets-widget', '')
  s.setAttribute('data-mode', mode)
  if (key) s.setAttribute('data-key', key)
  document.body.appendChild(s)
}

export const addChat = (key: string) => chatApi().push(['add', key])
export const openChat = (key: string) => chatApi().push(['open', key])
