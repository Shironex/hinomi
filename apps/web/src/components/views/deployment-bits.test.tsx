import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deploymentItem } from '@/fixtures/builders'
import { CoverageCell } from './deployment-bits'

describe('CoverageCell', () => {
  it('says Covered with no blind spot and no archived repo', () => {
    render(<CoverageCell d={deploymentItem()} />)
    expect(screen.getByText('Covered')).toBeInTheDocument()
  })

  it('does not say Covered while an archived repo is still deployed', () => {
    const d = deploymentItem({
      coverage: {
        alerts: 'enabled',
        blindSpots: [],
        covered: false,
        archivedRepo: true,
        imageOnly: false,
      },
    })
    render(<CoverageCell d={d} />)
    expect(screen.queryByText('Covered')).toBeNull()
    expect(screen.getByText('Archived repo')).toBeInTheDocument()
  })

  it('counts the blind spots first when there are some besides the archived repo', () => {
    const d = deploymentItem({
      coverage: {
        alerts: 'enabled',
        blindSpots: ['lockfile_missing'],
        covered: false,
        archivedRepo: true,
        imageOnly: false,
      },
    })
    render(<CoverageCell d={d} />)
    expect(screen.getByText('1 blind spot')).toBeInTheDocument()
  })
})
