import { describe, expect, it } from 'vitest'
import {
  checkHubPayload, closedBanner, hubLinkPausesSending, hubThreadInputState, offlineConfirmText, payloadTooLargeLine, type HubThreadInput,
} from './hubThread'
import { NOW_S, hubConfig, hubTarget } from '../test/hubFixtures'
import type { HubErrorBody } from '../api/endpoints/hub'

const names = { display: 'scout@acme.dev', name: 'scout', deploymentName: 'acme.dev', fingerprint: '3f9a1c2e5b7d9f00' }
const live = { agent_online: true, deployment_connected: true, accepting_messages: true, listed: true }
const base = (o: Partial<HubThreadInput> = {}): HubThreadInput =>
  ({ config: hubConfig(), names, hubTarget: hubTarget(), live, lastError: null, nowMs: NOW_S * 1000, ...o })
const err = (code: string, extra: Record<string, unknown> = {}): HubErrorBody => ({ code, message: '', ...extra })
const reason = (i: HubThreadInput) => {
  const s = hubThreadInputState(i)
  return s.enabled ? (s.confirm ?? 'enabled') : s.reason
}

describe('hubThreadInputState precedence (first match wins)', () => {
  it('enabled when everything is fine', () => {
    expect(hubThreadInputState(base())).toEqual({ enabled: true, confirm: null, notice: null })
  })

  it('mode off beats everything, and reads as history on a thread', () => {
    const s = hubThreadInputState(base({ config: hubConfig({ mode: 'off', registration: 'none' }), hubTarget: hubTarget({ closed_reason: 'key_revoked' }) }))
    expect(s).toMatchObject({ enabled: false, reason: 'hub_off', text: 'The hub is turned off on this server. This conversation is kept as history.' })
  })

  it.each(['none', 'pending_email', 'held_for_reclaim'])('registration %s → not registered', (registration) => {
    expect(reason(base({ config: hubConfig({ registration, mode: 'discover_only' }) }))).toBe('not_registered')
  })

  it('a live hub_not_registered error → not registered', () => {
    expect(reason(base({ lastError: err('hub_not_registered') }))).toBe('not_registered')
  })

  it('suspended, then browse-only, then untrusted', () => {
    expect(reason(base({ config: hubConfig({ registration: 'suspended', mode: 'discover_only' }) }))).toBe('suspended')
    expect(reason(base({ config: hubConfig({ mode: 'discover_only', hub_link: 'untrusted' }) }))).toBe('browse_only')
    expect(reason(base({ config: hubConfig({ hub_link: 'untrusted' }), hubTarget: hubTarget({ closed_reason: 'key_revoked' }) }))).toBe('untrusted')
    expect(reason(base({ lastError: err('hub_untrusted') }))).toBe('untrusted')
  })

  it('a stored closed_reason beats unlisted and unreachable', () => {
    const s = hubThreadInputState(base({
      config: hubConfig({ deployment_connected: false }),
      hubTarget: hubTarget({ closed_reason: 'identity_changed', listed: false }),
    }))
    expect(s).toMatchObject({ enabled: false, reason: 'closed', closedReason: 'identity_changed' })
  })

  it('a live close from the last send error until hub_target catches up', () => {
    expect(hubThreadInputState(base({ lastError: err('agent_unlisted') }))).toMatchObject({ reason: 'closed', closedReason: 'agent_unlisted' })
  })

  it('unlisted from hub_target or from the agent detail', () => {
    expect(reason(base({ hubTarget: hubTarget({ listed: false }) }))).toBe('unlisted')
    expect(reason(base({ live: { ...live, listed: false } }))).toBe('unlisted')
  })

  it('unreachable from the link, the deployment, or a send error, with last_connected_at', () => {
    expect(reason(base({ config: hubConfig({ hub_link: 'unreachable' }) }))).toBe('unreachable')
    expect(reason(base({ config: hubConfig({ deployment_connected: false }) }))).toBe('unreachable')
    const s = hubThreadInputState(base({ lastError: err('hub_unreachable', { last_connected_at: NOW_S - 3600 }) }))
    expect(s).toMatchObject({ reason: 'unreachable' })
    expect(!s.enabled && s.text).toContain('Last connected')
  })

  it("mode auto: an idle or not-yet-connected socket doesn't pause sending (a send connects first)", () => {
    for (const link of ['off', 'unreachable'] as const) {
      const config = hubConfig({ mode: 'auto', hub_link: link, deployment_connected: false })
      expect(hubLinkPausesSending(config)).toBe(false)
      expect(reason(base({ config }))).toBe('enabled')
    }
  })

  it("mode auto: the server's own refusal, untrusted or suspended still block", () => {
    const idle = { mode: 'auto' as const, hub_link: 'off' as const, deployment_connected: false }
    const s = hubThreadInputState(base({ config: hubConfig(idle), lastError: err('hub_unreachable', { last_connected_at: NOW_S - 3600 }) }))
    expect(s).toMatchObject({ enabled: false, reason: 'unreachable' })
    expect(!s.enabled && s.text).toContain('Sending to other servers is paused.')
    expect(reason(base({ config: hubConfig({ ...idle, hub_link: 'untrusted' }) }))).toBe('untrusted')
    expect(reason(base({ config: hubConfig({ ...idle, registration: 'suspended' }) }))).toBe('suspended')
  })

  it('modes full and discover_only: a link that is down still pauses', () => {
    for (const mode of ['full', 'discover_only'] as const) {
      expect(hubLinkPausesSending(hubConfig({ mode, hub_link: 'unreachable' }))).toBe(true)
      expect(hubLinkPausesSending(hubConfig({ mode, deployment_connected: false }))).toBe(true)
      expect(hubLinkPausesSending(hubConfig({ mode }))).toBe(false)
    }
    expect(reason(base({ config: hubConfig({ mode: 'full', hub_link: 'off', deployment_connected: false }) }))).toBe('unreachable')
  })

  it('a running rate-limit wait shows a countdown', () => {
    const s = hubThreadInputState(base({ rateLimitedUntil: NOW_S * 1000 + 42_000 }))
    expect(s).toMatchObject({ reason: 'rate_limited', waitSeconds: 42 })
    expect(!s.enabled && s.text).toBe("You're sending too fast to scout@acme.dev. You can send again in 0:42.")
    expect(reason(base({ rateLimitedUntil: NOW_S * 1000 - 1 }))).toBe('enabled')
  })

  it('not accepting, then offline confirms', () => {
    expect(reason(base({ live: { ...live, accepting_messages: false } }))).toBe('not_accepting')
    expect(reason(base({ live: { ...live, deployment_connected: false, agent_online: false } }))).toBe('deployment_offline')
    expect(reason(base({ live: { ...live, agent_online: false } }))).toBe('agent_offline')
  })

  it('needs approval is a notice, not a block', () => {
    const s = hubThreadInputState(base({ live: { ...live, needs_approval: true } }))
    expect(s).toEqual({ enabled: true, confirm: null, notice: "scout's owner approves new contacts first. Your first message waits until they accept you." })
  })

  it('a draft (no thread) still checks the hub state', () => {
    expect(reason(base({ hubTarget: null, config: hubConfig({ mode: 'off' }) }))).toBe('hub_off')
    expect(reason(base({ hubTarget: null }))).toBe('enabled')
  })

  it('a send refused as conversation_closed takes the real reason from the body\'s closed_reason', () => {
    const err = (closed_reason?: unknown) => ({ code: 'conversation_closed', message: 'closed', ...(closed_reason === undefined ? {} : { closed_reason }) })
    const open = hubTarget({ closed_reason: null })
    expect(hubThreadInputState(base({ hubTarget: open, lastError: err('deployment_suspended') }))).toMatchObject({
      reason: 'closed', closedReason: 'deployment_suspended', canStartNew: false,
    })
    expect(hubThreadInputState(base({ hubTarget: open, lastError: err('hub_off_on_server') }))).toMatchObject({ closedReason: 'hub_off_on_server' })
    // No closed_reason (or not a string): the code stands in, as before.
    expect(hubThreadInputState(base({ hubTarget: open, lastError: err() }))).toMatchObject({ closedReason: 'conversation_closed' })
    expect(hubThreadInputState(base({ hubTarget: open, lastError: err(7) }))).toMatchObject({ closedReason: 'conversation_closed' })
  })

  it('conversation_closed offers a new one only while listed', () => {
    expect(hubThreadInputState(base({ hubTarget: hubTarget({ closed_reason: 'conversation_closed' }) }))).toMatchObject({ canStartNew: true })
    expect(hubThreadInputState(base({ hubTarget: hubTarget({ closed_reason: 'conversation_closed' }), live: { ...live, listed: false } }))).toMatchObject({ canStartNew: false })
  })
})

describe('closedBanner', () => {
  const now = NOW_S * 1000
  it('agent_unlisted adds the drain sentence for 10 minutes', () => {
    expect(closedBanner('agent_unlisted', names, NOW_S - 60, now)).toBe(
      'scout@acme.dev is no longer listed on the hub. This conversation is kept as history. Replies already on their way may still arrive for a few minutes.')
    expect(closedBanner('agent_unlisted', names, NOW_S - 11 * 60, now)).toBe(
      'scout@acme.dev is no longer listed on the hub. This conversation is kept as history.')
  })
  it('identity_changed names the old fingerprint', () => {
    expect(closedBanner('identity_changed', names, null, now)).toContain('(was 3f9a1c2e)')
  })
  it('each reason, and an unknown one', () => {
    expect(closedBanner('key_revoked', names, null, now)).toBe("This agent's hub key was revoked by its owner. This conversation is kept as history.")
    expect(closedBanner('deployment_suspended', names, null, now)).toBe('The hub has suspended acme.dev. This conversation is kept as history.')
    expect(closedBanner('conversation_closed', names, null, now)).toBe('scout@acme.dev closed this conversation. Start a new one to continue.')
    expect(closedBanner('hub_off_on_server', names, null, now)).toBe('The hub is turned off on this server. This conversation is kept as history.')
    expect(closedBanner('martian', names, null, now)).toBe('This conversation is closed.')
  })
})

describe('offline confirms', () => {
  it('two variants', () => {
    expect(offlineConfirmText('agent_offline', names)).toBe(
      "scout@acme.dev is offline. acme.dev will hold your message and the agent answers when it's back. Send anyway?")
    expect(offlineConfirmText('deployment_offline', names)).toBe(
      'acme.dev is offline. Your message waits on this server and is sent when acme.dev reconnects, for up to 72 hours. Send anyway?')
  })
})

describe('payload checks', () => {
  const c = hubConfig()
  const MB = 1024 * 1024
  it('passes within limits', () => {
    expect(checkHubPayload('hi', [{ name: 'a.pdf', size: MB }], c)).toBeNull()
  })
  it('names an oversized file', () => {
    expect(checkHubPayload('hi', [{ name: 'deck.pdf', size: 12.4 * MB }], c)).toMatchObject({ limit: 'file', fileName: 'deck.pdf' })
    expect(checkHubPayload('hi', [{ name: 'deck.pdf', size: 12.4 * MB }], c)?.text).toContain('deck.pdf 12.4 MB — over the 10 MB limit for other servers')
  })
  it('too many files, too much total, text too long', () => {
    expect(checkHubPayload('', Array.from({ length: 6 }, (_, i) => ({ name: `${i}`, size: 1 })), c)?.limit).toBe('files')
    expect(checkHubPayload('', [1, 2, 3].map((i) => ({ name: `${i}`, size: 9 * MB })), c)?.limit).toBe('envelope')
    expect(checkHubPayload('x'.repeat(33 * 1024), [], c)?.limit).toBe('text')
  })
  it('turns the 413 extras into a sentence and the file', () => {
    expect(payloadTooLargeLine({ limit: 'file', max: 10 * MB, actual: 12 * MB, file_id: 'deck.pdf' })).toEqual({
      text: 'A file is 12 MB — over the 10 MB limit for other servers.', fileId: 'deck.pdf' })
    expect(payloadTooLargeLine({ limit: 'weird', max: 1, actual: 2 }).text).toBe('The message is too large for other servers.')
  })
})
