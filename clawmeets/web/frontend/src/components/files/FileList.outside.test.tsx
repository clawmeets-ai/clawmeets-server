import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { withQueryClient } from '../../test/queryWrapper'
import type { FileInfo } from '../../types'
import { OUTSIDE_COPY } from '../../utils/agentAccessCopy'
import FileList from './FileList'

afterEach(cleanup)

const file = (name: string) => ({ name, size: 10 }) as FileInfo

describe('the outside-content file badge', () => {
  it('marks only the files the room says came from outside', () => {
    render(
      <FileList
        files={[file('theirs.md'), file('ours.md')]}
        projectId="p1"
        chatroomName="work"
        isOutsideFile={(n) => n === 'theirs.md'}
      />,
      { wrapper: withQueryClient },
    )
    const badges = screen.getAllByTestId('outside-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toBe(OUTSIDE_COPY.fileBadge)
    const row = screen.getByText('theirs.md').parentElement as HTMLElement
    expect(within(row).getByTestId('outside-badge')).toBeTruthy()
  })
})
