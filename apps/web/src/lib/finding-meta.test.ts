import { describe, expect, it } from 'vitest'
import { coverageNoteItem } from '@/fixtures/builders'
import { coverageNoteLabel } from './finding-meta'

describe('coverageNoteLabel', () => {
  it('names an image only note by its deployment', () => {
    const item = coverageNoteItem({ coverageNote: 'image_only' })
    expect(coverageNoteLabel(item)).toBe(`image only note on ${item.deployments[0]!.name}`)
  })

  it('names a repo note by its own type, not as an image only note', () => {
    const item = coverageNoteItem({ coverageNote: 'requirements_unpinned' })
    const label = coverageNoteLabel(item)
    expect(label).toMatch(/^unpinned requirements note on /)
    expect(label).not.toContain('image only')
  })
})
