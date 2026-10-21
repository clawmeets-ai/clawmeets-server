import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ContextGuide from './ContextGuide'

afterEach(cleanup)

describe('ContextGuide: the Front Desk zero state', () => {
  it('walks through publishing on the hub and explains both sides of the safety model', () => {
    render(<MemoryRouter><ContextGuide context="frontdesk" /></MemoryRouter>)
    expect(screen.getByTestId('guide-steps').textContent).toContain('Channels → Hub')
    expect(screen.getByTestId('guide-steps').textContent).toContain('Make public')
    const titles = screen.getAllByTestId('guide-section').map((s) => s.querySelector('h3')?.textContent)
    expect(titles).toEqual([
      'How the sandbox works',
      'How your public agent stays safe from outside requests',
      'How your coordinator stays safe from public agents’ replies',
    ])
  })

  it('other tabs keep the short guide', () => {
    render(<MemoryRouter><ContextGuide context="dms" /></MemoryRouter>)
    expect(screen.queryByTestId('guide-steps')).toBeNull()
    expect(screen.queryByTestId('guide-section')).toBeNull()
  })
})
