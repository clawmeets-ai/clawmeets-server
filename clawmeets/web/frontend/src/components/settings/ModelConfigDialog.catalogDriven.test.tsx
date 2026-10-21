// Proves the claim that ModelConfigDialog needs NO edit to support a new
// provider. Without this file that claim is an inspection ("the picker maps over
// LLM_PROVIDERS, so it must work"); the milestone asked for a test. Every
// assertion here reads what the catalog produced through a real render, so the
// test tracks the catalog rather than restating a constant — deleting the
// `antigravity` catalog entry turns these red while the dialog is untouched.
//
// vitest runs with `globals: false`, so RTL's auto-cleanup never registers and
// `cleanup` is called explicitly; and jest-dom is not a dependency, so the
// assertions are plain DOM property reads.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ModelConfigDialog from './ModelConfigDialog'
import { MODEL_PROVIDERS } from '../../config/llmProviders'

afterEach(cleanup)

function renderDialog(): HTMLElement {
  const { container } = render(
    <ModelConfigDialog
      mode="create"
      saving={false}
      error={null}
      onSave={() => {}}
      onCancel={() => {}}
    />,
  )
  return container
}

/** Render, then pick `id` in the provider select. */
function renderWithProvider(id: string): HTMLElement {
  const container = renderDialog()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: id } })
  return container
}

describe('ModelConfigDialog is catalog-driven', () => {
  it('renders one option per catalog entry, unedited', () => {
    renderDialog()
    const options = screen.getAllByRole('option') as HTMLOptionElement[]
    // Order matters: the picker's option order IS the catalog's array order.
    // `soft` throughout this file so one sabotage reports every consequence it
    // has rather than only the first — a hard assert hides the rest, and an
    // assertion never seen failing is indistinguishable from one that asserts
    // nothing.
    expect.soft(options.map((o) => o.value)).toEqual(MODEL_PROVIDERS.map((p) => p.id))
    expect.soft(options.map((o) => o.textContent)).toEqual(
      MODEL_PROVIDERS.map((p) => `${p.label} — ${p.description}`),
    )
  })

  it('treats antigravity as CLI-tier: no key field, server URL inert', () => {
    const container = renderWithProvider('antigravity')
    expect.soft((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('antigravity')

    // Exercises the untouched `kind === 'api'` gating: base_url is effective
    // only for the in-process `-api` providers, and the key block hangs off the
    // same flag. `queryBy*`, not `getBy*`: a `getBy*` miss THROWS, which would
    // abort the test at the first problem and defeat the soft assertions.
    expect.soft((screen.getByLabelText(/Server URL/) as HTMLInputElement).disabled).toBe(true)
    expect
      .soft(screen.queryByText(/Server URL is not yet effective for CLI-tier providers/))
      .not.toBeNull()

    // The key FIELD, not the words "API key" — that phrase legitimately appears
    // in the `-api` option labels and in the CLI-tier note below, so matching on
    // text would assert the opposite of what it looks like it asserts.
    expect.soft(container.querySelector('input[type="password"]')).toBeNull()
    expect.soft(screen.queryByText(/does not use an API key/)).not.toBeNull()
  })

  it('uses the catalog modelPlaceholder for antigravity', () => {
    renderWithProvider('antigravity')
    expect(screen.getByLabelText(/Model slug/).getAttribute('placeholder')).toBe(
      'e.g. gemini-3.1-pro-high',
    )
  })
})
