import { describe, expect, it } from 'vitest'
import { coverageNoteItem } from '@/fixtures/builders'
import type { FindingEvent } from '@hinomi/shared'
import { coverageNoteLabel, eventSentence } from './finding-meta'

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

describe('eventSentence', () => {
  const escalated = (reason: string): FindingEvent => ({
    id: 1,
    findingId: 1,
    type: 'escalated',
    fromState: null,
    toState: null,
    reason,
    until: null,
    untilNewAdvisory: false,
    actor: 'system',
    at: '2026-11-08T10:00:00.000Z',
  })

  it('says a level got worse', () => {
    expect(eventSentence(escalated('warn -> fail'))).toBe('The level got worse')
  })

  it('says what got worse at the same level', () => {
    expect(eventSentence(escalated('newly archived: kestrel-co/ledger'))).toBe(
      'It got worse: newly archived: kestrel-co/ledger',
    )
  })
})
