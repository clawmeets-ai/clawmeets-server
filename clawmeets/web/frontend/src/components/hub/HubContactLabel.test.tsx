import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { FP_ACME } from '../../test/hubFixtures'
import { hubContactText } from '../../utils/hubDisplay'
import HubContactLabel from './HubContactLabel'

/** The host side's view of a Hub requester: built from the structured fields
 *  only, so a hostile username can never pose as a server name. */

afterEach(cleanup)

describe('HubContactLabel', () => {
  it('shows user, "from", server and the genesis fingerprint chip, each in its own span', () => {
    render(<HubContactLabel
      fields={{ remote_username: 'carol', deployment_name: 'clawmeets.ai', deployment_fingerprint: FP_ACME }}
      fallbackName="carol @ clawmeets.ai"
    />)
    expect(screen.getByTestId('hub-contact').textContent).toBe(`carolfromclawmeets.aifp ${FP_ACME.slice(0, 8)}`)
    expect(screen.getByTestId('hub-contact-user').textContent).toBe('carol')
    expect(screen.getByTestId('hub-contact-server').textContent).toBe('clawmeets.ai')
    expect(screen.getByTestId('hub-contact-fp').getAttribute('title')).toBe(FP_ACME)
  })

  it('a null deployment_name falls back to "server" and the fingerprint', () => {
    render(<HubContactLabel
      fields={{ remote_username: 'dave', deployment_name: null, deployment_fingerprint: FP_ACME }}
      fallbackName="dave"
    />)
    expect(screen.getByTestId('hub-contact-server').textContent).toBe('server')
    expect(screen.getByTestId('hub-contact-fp').textContent).toBe(`fp ${FP_ACME.slice(0, 8)}`)
  })

  it('a hostile username stays inside its own bold span; the real server follows "from"', () => {
    render(<HubContactLabel
      fields={{ remote_username: 'carol @ evil.dev‮<b>x</b>', deployment_name: 'acme.dev', deployment_fingerprint: FP_ACME }}
      fallbackName="carol @ evil.dev"
    />)
    const user = screen.getByTestId('hub-contact-user')
    expect(user.textContent).toBe('carol @ evil.dev<b>x</b>')
    expect(user.tagName).toBe('BDI')
    expect(user.querySelector('b')).toBeNull()
    expect(screen.getByTestId('hub-contact-server').textContent).toBe('acme.dev')
  })

  it('a missing username reads "Unnamed contact", never the pre-joined name', () => {
    render(<HubContactLabel
      fields={{ remote_username: null, deployment_name: 'acme.dev', deployment_fingerprint: FP_ACME }}
      fallbackName="mallory @ trusted.example"
    />)
    expect(screen.getByTestId('hub-contact-user').textContent).toBe('Unnamed contact')
    expect(screen.queryByText(/trusted\.example/)).toBeNull()
  })

  it('a non-Hub row keeps contact_name, as text', () => {
    render(<HubContactLabel fields={{}} fallbackName="<i>Sam</i>" />)
    expect(screen.getByTestId('contact-fallback').textContent).toBe('<i>Sam</i>')
    expect(screen.queryByTestId('hub-contact')).toBeNull()
    expect(document.querySelector('i')).toBeNull()
  })

  it('hubContactText is the same label as one line, and null off the Hub', () => {
    expect(hubContactText({ remote_username: 'carol', deployment_name: null, deployment_fingerprint: FP_ACME }))
      .toBe(`carol from server · fp ${FP_ACME.slice(0, 8)}`)
    expect(hubContactText({})).toBeNull()
  })
})

describe('"via their agent X"', () => {
  const base = { remote_username: 'carol', deployment_name: 'clawmeets.ai', deployment_fingerprint: FP_ACME }

  it('shows when via_agent is set, as text, after the server', () => {
    render(<HubContactLabel fields={{ ...base, via_agent: 'carol-scout' }} fallbackName="carol" />)
    expect(screen.getByTestId('hub-contact-via').textContent).toBe('via their agent carol-scout')
  })

  it('is absent when via_agent is null or missing', () => {
    render(<HubContactLabel fields={{ ...base, via_agent: null }} fallbackName="carol" />)
    expect(screen.queryByTestId('hub-contact-via')).toBeNull()
    cleanup()
    render(<HubContactLabel fields={base} fallbackName="carol" />)
    expect(screen.queryByTestId('hub-contact-via')).toBeNull()
  })

  it('strips invisible characters and draws markup as text', () => {
    render(<HubContactLabel fields={{ ...base, via_agent: 'sc\u200bout\u202e<b>x</b>' }} fallbackName="carol" />)
    const via = screen.getByTestId('hub-contact-via')
    expect(via.textContent?.startsWith('via their agent scout<b>x</b>')).toBe(true)
    expect(via.querySelector('b')).toBeNull()
    // The unusual-name check applies to the agent's name too.
    expect(via.textContent).toContain('contains unusual characters')
  })
})
