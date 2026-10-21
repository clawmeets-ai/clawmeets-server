import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import StagedAttachments from './StagedAttachments'
import type { StagedFile } from '../../hooks/useMessageAttachments'

afterEach(cleanup)

function staged(over: Partial<StagedFile> = {}): StagedFile {
  return {
    id: 's1',
    file: new File(['hello from a staged note'], 'notes.txt', { type: 'text/plain' }),
    origin: 'user',
    ...over,
  }
}

function tray(files: StagedFile[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <StagedAttachments files={files} onRemove={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('clicking a staged chip previews the file', () => {
  it('opens the file viewer on the local bytes, before anything is sent', async () => {
    tray([staged()])
    fireEvent.click(screen.getByRole('button', { name: 'View notes.txt' }))
    expect(await screen.findByText('hello from a staged note')).toBeTruthy()
  })

  it('a chip whose bytes are still loading is not clickable', () => {
    tray([staged({ status: 'loading' })])
    expect(
      (screen.getByRole('button', { name: 'View notes.txt' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

describe('an image the browser cannot decode', () => {
  it('falls back to the file icon instead of a broken-image glyph', () => {
    const { container } = tray([
      staged({
        file: new File(['not really heic'], 'IMG_3689.HEIC', { type: 'image/heic' }),
        previewUrl: 'blob:heic-preview',
      }),
    ])
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    fireEvent.error(img!)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('IMG_3689.HEIC')).toBeTruthy()
  })
})
