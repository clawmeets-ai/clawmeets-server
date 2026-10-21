import { describe, expect, it } from 'vitest'
import { HUB_CARD_COPY, hubChannelView, hubToggleState, turnOffDialogText } from './hubChannelView'
import { NOW_S, hubChannel, hubConfig } from '../test/hubFixtures'

const display = 'alice-researcher@acme.dev'
const view = (ch = hubChannel(), cfg = hubConfig()) => hubChannelView(ch, cfg, display, NOW_S * 1000)

describe('hubToggleState', () => {
  it('turning on needs eligible, full mode, active registration', () => {
    expect(hubToggleState(hubChannel(), hubConfig())).toEqual({ on: false, clickable: true, opens: 'enable' })
    expect(hubToggleState(hubChannel({ eligible: false }), hubConfig()).clickable).toBe(false)
    expect(hubToggleState(hubChannel(), hubConfig({ mode: 'discover_only' })).clickable).toBe(false)
    expect(hubToggleState(hubChannel(), hubConfig({ registration: 'pending_email' })).clickable).toBe(false)
    expect(hubToggleState(hubChannel({ status: 'hub_not_registered' }), hubConfig()).clickable).toBe(false)
  })

  it('mode auto: turning on needs no registration yet (the dialog does it), but not a suspended server or a hub not there yet', () => {
    const auto = (o = {}) => hubConfig({ mode: 'auto', registration: 'none', ...o })
    expect(hubToggleState(hubChannel(), auto()).clickable).toBe(true)
    expect(hubToggleState(hubChannel({ status: 'hub_not_registered' }), auto()).clickable).toBe(true)
    expect(hubToggleState(hubChannel(), auto({ registration: 'active' })).clickable).toBe(true)
    expect(hubToggleState(hubChannel(), auto({ registration: 'suspended' })).clickable).toBe(false)
    expect(hubToggleState(hubChannel(), auto({ hub_link: 'untrusted' })).clickable).toBe(false)
    expect(hubToggleState(hubChannel({ eligible: false }), auto()).clickable).toBe(false)
  })

  it.each(['connected', 'rejected', 'key_revoked', 'hub_off_on_server', 'mystery'])(
    'turning off is always allowed (status %s, mode off)', (status) => {
      expect(hubToggleState(hubChannel({ enabled: true, status }), hubConfig({ mode: 'off', registration: 'none' })))
        .toEqual({ on: true, clickable: true, opens: 'dialog' })
    })
})

describe('hubChannelView: every status', () => {
  it('off', () => {
    expect(view()).toMatchObject({ heading: 'List this agent on the ClawMeets Hub', title: expect.stringContaining(display) })
  })
  it('enabling', () => {
    expect(view(hubChannel({ enabled: true, status: 'enabling' })).title).toBe('Asking the hub to list this agent…')
  })
  it('connected, with last contact, key and runs', () => {
    const v = view(hubChannel({ enabled: true, status: 'connected', listed_as: display, key_last4: '9f2c', last_success_at: NOW_S - 120, runs_today: 37 }))
    expect(v.heading).toBe('Listed on the ClawMeets Hub')
    expect(v.title).toBe(`Listed as ${display}`)
    expect(v.lines).toEqual(['Last contact 2 min ago · Key ····9f2c', 'Runs started by hub messages today: 37 / 200 (read-only)'])
    expect(v.chips).toEqual([])
  })
  it('connected at the daily cap', () => {
    const v = view(hubChannel({ enabled: true, status: 'connected', runs_today: 200 }))
    expect(v.chips).toEqual(['Daily limit reached'])
    expect(v.lines.at(-1)).toMatch(/^Daily limit reached\. New hub messages are refused until /)
  })
  it('hub unreachable with last success and next try', () => {
    const v = view(hubChannel({ enabled: true, status: 'hub_unreachable', last_success_at: NOW_S - 600, next_retry_at: NOW_S + 60 }))
    expect(v.title).toBe("Can't reach the hub — retrying")
    expect(v.lines[0]).toMatch(/^Last success .* · next try /)
  })
  it('key revoked offers turn off and on', () => {
    expect(view(hubChannel({ enabled: true, status: 'key_revoked' }))).toMatchObject({ title: "This agent's hub key was revoked", action: 'turn_off_on' })
  })
  it('key rotation pending offers reconnect', () => {
    const v = view(hubChannel({ enabled: true, status: 'key_rotation_pending', rotate_by: NOW_S + 86400, key_last4: '9f2c' }))
    expect(v).toMatchObject({ title: 'Automatic key renewal failed — reconnect', action: 'reconnect' })
    expect(v.lines[0]).toMatch(/^Current key expires .* · Key ····9f2c$/)
  })
  it('hub cannot reach this deployment quotes status_detail as safe text', () => {
    const v = view(hubChannel({ enabled: true, status: 'hub_cannot_reach_deployment', status_detail: 'challenge‮ signature failed' }))
    expect(v).toMatchObject({ title: "The hub couldn't confirm this server", quoted: 'challenge signature failed' })
  })
  it.each([
    ['name_conflict', 'Another agent already uses this name on the hub', 'turn_off_on'],
    ['deployment_suspended', 'The hub has suspended this server', null],
    ['over_quota', 'This server has listed as many agents as the hub allows', 'turn_off_on'],
    ['client_too_old', 'This server is too old for the hub', null],
    ['invalid_listing', "The hub refused this agent's listing details", 'turn_off_on'],
    ['invalid_name', "This agent's name can't be used on the hub", 'turn_off_on'],
    ['delisted_by_hub', "The hub's moderators removed this listing", null],
    ['brand_new_reason', 'The hub refused this listing', null],
  ])('rejected %s', (reject_reason, title, action) => {
    const v = view(hubChannel({ enabled: true, status: 'rejected', reject_reason, status_detail: 'hub words' }))
    expect(v).toMatchObject({ heading: 'Not listed', title, action, quoted: 'hub words' })
  })
  it('rejected with a null reason (an unknown one the server mapped away)', () => {
    expect(view(hubChannel({ enabled: true, status: 'rejected' })).title).toBe('The hub refused this listing')
  })
  it('hub off on this server, from the status or the mode', () => {
    expect(view(hubChannel({ status: 'hub_off_on_server' })).title).toBe('Sharing is turned off on this server.')
    expect(view(hubChannel({ enabled: true, status: 'connected' }), hubConfig({ mode: 'off' })).title).toBe('Sharing is turned off on this server.')
  })
  it('agent not public offers Make public', () => {
    const v = view(hubChannel({ status: 'agent_not_public', eligible: false, ineligible_reason: null }))
    expect(v).toMatchObject({ makePublic: true, title: 'Only public agents can be listed. Make this agent public, then turn on the switch.' })
  })
  it('agent not public: the server\'s bare code is never shown', () => {
    const v = view(hubChannel({ status: 'agent_not_public', eligible: false, ineligible_reason: 'agent_not_public' }))
    expect(v.title).toBe('Only public agents can be listed. Make this agent public, then turn on the switch.')
  })
  it('mode auto, not registered yet: a private agent gets Make public, not the plain offer', () => {
    const auto = hubConfig({ mode: 'auto', registration: 'none' })
    const v = view(hubChannel({ status: 'hub_not_registered', eligible: false, ineligible_reason: 'agent_not_public' }), auto)
    expect(v).toMatchObject({ makePublic: true, title: 'Only public agents can be listed. Make this agent public, then turn on the switch.' })
    expect(view(hubChannel({ eligible: false }), auto).makePublic).toBe(true)
    expect(view(hubChannel(), auto)).toMatchObject({ makePublic: false, title: expect.stringContaining(display) })
    expect(view(hubChannel({ eligible: false }), hubConfig({ mode: 'auto', registration: 'none', hub_link: 'untrusted' })).title)
      .toBe("The ClawMeets Hub isn't available yet.")
  })
  it('not registered, with the pending-email line', () => {
    const v = view(hubChannel({ status: 'hub_not_registered' }), hubConfig({ registration: 'pending_email' }))
    expect(v.title).toBe("This server isn't registered with the hub yet. Ask its operator.")
    expect(v.lines).toEqual(['Registration is waiting for the operator to confirm an email code.'])
    expect(view(hubChannel(), hubConfig({ registration: 'something_new' })).title).toContain("isn't registered")
  })
  it('not registered and not public never shows the bare code', () => {
    const ch = hubChannel({ status: 'hub_not_registered', eligible: false, ineligible_reason: 'agent_not_public' })
    expect(view(ch, hubConfig({ registration: 'none' })).title).toBe("This server isn't registered with the hub yet. Ask its operator.")
  })
  it('untrusted, suspended, browse-only', () => {
    expect(view(hubChannel({ status: 'hub_untrusted' })).title).toBe("The hub's identity doesn't match the one saved for this URL")
    expect(view(hubChannel(), hubConfig({ registration: 'suspended' })).title).toBe('The hub has suspended this server')
    expect(view(hubChannel({ enabled: true, status: 'connected' }), hubConfig({ mode: 'discover_only' })).title).toBe('Browse-only: not accepting messages')
  })
  it('an unknown status reads "Status unknown"', () => {
    expect(view(hubChannel({ enabled: true, status: 'quantum' })).title).toBe('Status unknown')
  })
})

describe('hubChannelView: mode auto and owner rejects', () => {
  const auto = (o = {}) => hubConfig({ mode: 'auto', registration: 'none', ...o })
  it('not registered yet: the plain offer, never "ask its operator"', () => {
    expect(view(hubChannel(), auto()).title).toContain(display)
    expect(view(hubChannel({ status: 'hub_not_registered' }), auto()).title).toContain(display)
  })
  it('the default hub not launched yet reads as not available', () => {
    expect(view(hubChannel(), auto({ hub_link: 'untrusted' })).title).toBe("The ClawMeets Hub isn't available yet.")
  })
  it('owner_unverified offers turn off and on; owner_banned does not', () => {
    const unverified = view(hubChannel({ enabled: true, status: 'rejected', reject_reason: 'owner_unverified' }))
    expect(unverified.title).toBe('The hub needs to confirm your email address first')
    expect(unverified.action).toBe('turn_off_on')
    const banned = view(hubChannel({ enabled: true, status: 'rejected', reject_reason: 'owner_banned' }))
    expect(banned.title).toBe("This email address can't list agents on the hub")
    expect(banned.action).toBeNull()
  })
})

describe('turnOffDialogText', () => {
  it('leaves out sentences with a 0 count', () => {
    expect(turnOffDialogText(hubChannel(), 'alice-researcher').body).toHaveLength(1)
  })
  it('states both counts', () => {
    const t = turnOffDialogText(hubChannel({ open_conversations: 3, in_flight_messages: 2 }), 'alice-researcher')
    expect(t.title).toBe('Stop sharing alice-researcher?')
    expect(t.body[0]).toMatch(/made private: nobody else can find it or message it/)
    expect(t.body[1]).toBe('Your 3 open conversations with other servers stay in Front Desk as history.')
    expect(t.body[2]).toMatch(/^2 replies are still on their way/)
  })
  it('says who on this server stops getting replies, and that owner isolation ends', () => {
    const t = turnOffDialogText(hubChannel({ local_conversations: 2, owner_isolated: true }), 'alice-researcher')
    expect(t.body[1]).toBe('2 people on this server have open conversations with it. They will stop getting replies.')
    expect(t.body[2]).toMatch(/^Owner isolation will turn off/)
    expect(turnOffDialogText(hubChannel({ local_conversations: 1 }), 'a').body[1]).toMatch(/^1 person on this server has/)
  })
})

describe('hubChannelView: shared on this server but not listed', () => {
  it('an off card of a public agent says so and offers Make private, in every mode', () => {
    const on = view(hubChannel({ status: 'off', public: true }))
    expect(on.lines).toContain(HUB_CARD_COPY.sharedNotListed)
    expect(on.makePrivate).toBe(true)
    const off = view(hubChannel({ status: 'hub_off_on_server', public: true }), hubConfig({ mode: 'off' }))
    expect(off.title).toBe(HUB_CARD_COPY.sharingOff)
    expect(off.makePrivate).toBe(true)
  })
  it('an enabled channel, or a private agent, is not', () => {
    expect(view(hubChannel({ enabled: true, status: 'connected', public: true })).makePrivate).toBe(false)
    expect(view(hubChannel({ status: 'off', public: false })).makePrivate).toBe(false)
  })
})
