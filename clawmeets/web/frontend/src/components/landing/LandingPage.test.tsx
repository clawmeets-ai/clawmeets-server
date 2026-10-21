import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import Page from '../../../app/page'

afterEach(cleanup)

// Top-level landing sections, in the order a visitor scrolls through them.
// The closing band lives inside Footer, last on the page.
const STORY_ORDER = ['top', 'why', 'team', 'how', 'diff', 'know', 'faq', 'closing']

function renderPage() {
  return render(<Page />)
}

describe('landing page', () => {
  it('renders the story sections in order', () => {
    const { container } = renderPage()
    const ids = Array.from(container.querySelectorAll('[id]'))
      .map((el) => el.id)
      .filter((id) => STORY_ORDER.includes(id))
    expect(ids).toEqual(STORY_ORDER)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Stop managing chats.Start managing agents.',
    )
    expect(container.querySelector('#closing h2')?.textContent).toBe(
      "You've been managing chats.Now manage a team.",
    )
  })

  it('renders no Pricing, crew or staffing section', () => {
    const { container } = renderPage()
    for (const id of ['pricing', 'crew', 'staffing']) {
      expect(container.querySelector(`#${id}`)).toBeNull()
    }
  })

  it('asks exactly the three approved FAQ questions', () => {
    const { container } = renderPage()
    const questions = Array.from(container.querySelectorAll('#faq button')).map(
      (b) => b.textContent,
    )
    expect(questions).toEqual([
      'Do I need a separate LLM subscription?',
      'Frontier models already spawn their own subagents. Why do I need ClawMeets?',
      'How is a specialist different from a general agent?',
    ])
    expect(screen.queryByText(/30–50%/)).toBeNull()
  })

  it('points every in-page link at a section that exists', () => {
    const { container } = renderPage()
    const anchors = Array.from(container.querySelectorAll('a[href^="#"]'))
      .map((a) => a.getAttribute('href')!)
    expect(anchors.length).toBeGreaterThan(0)
    // No placeholder links: a bare "#" goes nowhere.
    expect(anchors).not.toContain('#')
    for (const href of anchors) {
      expect(container.querySelector(href), href).not.toBeNull()
    }
  })

  it('sends every "Get early access" CTA to the early-access email', () => {
    renderPage()
    const ctas = screen.getAllByRole('link', { name: /Get early access/ })
    expect(ctas).toHaveLength(3) // nav, hero, closing
    expect(screen.queryByText(/Request invite/)).toBeNull()

    for (const cta of ctas) {
      const href = cta.getAttribute('href')!
      expect(href.startsWith('mailto:info@clawmeets.ai?')).toBe(true)
      expect(href).not.toContain('+')
      const params = new URLSearchParams(href.slice(href.indexOf('?') + 1))
      expect(params.get('subject')).toBe('ClawMeets early access request')
      expect(params.get('body')).toBe(
        [
          'Hi ClawMeets team,',
          "I'd like early access to ClawMeets.",
          'Name:',
          'Company and role:',
          "What I'd like a team of agents to do:",
          'Thanks!',
        ].join('\n'),
      )
      expect(href).toContain('subject=ClawMeets%20early%20access%20request')
      expect(href).toContain('Hi%20ClawMeets%20team%2C%0AI')
    }
  })

  it('sends "See how it works" to the how-it-works section', () => {
    renderPage()
    expect(screen.getByRole('link', { name: 'See how it works' }).getAttribute('href')).toBe(
      '#how',
    )
  })

  it('draws the change-request actions as labels, not controls', () => {
    renderPage()
    const change = screen.getByTestId('sample-change')
    expect(within(change).queryAllByRole('button')).toHaveLength(0)
    expect(within(change).queryAllByRole('link')).toHaveLength(0)
    expect(within(change).getByText('Approve change')).toBeTruthy()
  })

  it('shows six agents on the hero desk: three working, one needing you, two ready', () => {
    const { container } = renderPage()
    const rows = Array.from(container.querySelectorAll('[data-desk-status]'))
    const count = (status: string) =>
      rows.filter((r) => r.getAttribute('data-desk-status') === status).length
    expect(rows).toHaveLength(6)
    expect(count('working')).toBe(3)
    expect(count('needs you')).toBe(1)
    expect(count('ready')).toBe(2)
  })

  it('numbers sections 01–06 with the section-label anatomy', () => {
    const { container } = renderPage()
    const labels = Array.from(container.querySelectorAll('.draw__n')).map((n) => n.textContent)
    expect(labels).toEqual(['01', '02', '03', '04', '05', '06'])
  })

  it('opens the first FAQ answer and lets several stay open', () => {
    const { container } = renderPage()
    const items = Array.from(container.querySelectorAll('#faq .qa'))
    const isOpen = () => items.map((el) => el.classList.contains('open'))
    expect(isOpen()).toEqual([true, false, false])

    fireEvent.click(within(items[1] as HTMLElement).getByRole('button'))
    expect(isOpen()).toEqual([true, true, false])

    fireEvent.click(within(items[0] as HTMLElement).getByRole('button'))
    expect(isOpen()).toEqual([false, true, false])
    expect(items[1].querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
  })
})
