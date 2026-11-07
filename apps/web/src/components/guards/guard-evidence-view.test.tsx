import { GUARD_CHECKS } from '@hinomi/shared'
import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detailFor, FINDINGS } from '@/fixtures/dataset'
import { mockViews } from '@/test/fixtures'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

const GUARDS = FINDINGS.filter((f) => f.kind === 'guard')

const byId = (id: number) => {
  const item = GUARDS.find((f) => f.id === id)
  if (!item) throw new Error(`no guard fixture ${id}`)
  return item
}

/** Opens a guard finding of the fixture dataset and returns its "What Hinomi read" section. */
async function openEvidence(id: number) {
  const item = byId(id)
  mockViews({ [`GET /findings/${id}`]: detailFor(item) })
  await renderApp(`/finding/${id}`)
  const heading = await screen.findByRole('heading', { name: 'What Hinomi read' })
  return heading.closest('section') as HTMLElement
}

/** One fixture per check with the list it should render, so each renderer is exercised. */
const PER_CHECK: { id: number; check: string; list: string }[] = [
  { id: 101, check: 'docker_socket', list: 'Socket mounts' },
  { id: 103, check: 'shared_network', list: 'Other projects on the network' },
  { id: 106, check: 'watch_paths_skip', list: 'Files checked' },
  { id: 109, check: 'framework_support', list: 'Frameworks' },
  { id: 112, check: 'runtime_support', list: 'Runtimes' },
  { id: 115, check: 'runtime_pins_disagree', list: 'Node pins' },
  { id: 116, check: 'action_runtime', list: 'Actions' },
]

describe('guard evidence', () => {
  it('the fixture dataset covers every check', () => {
    expect(new Set(GUARDS.map((f) => f.guard?.check))).toEqual(new Set(GUARD_CHECKS))
  })

  it.each(PER_CHECK)('renders $check evidence as a readable list', async ({ id, list }) => {
    const section = await openEvidence(id)
    expect(within(section).getByRole('list', { name: list })).toBeInTheDocument()
    expect(section.textContent).not.toMatch(/[{}]|"check"/)
  })

  it('reads a root user finding as source, user and base image', async () => {
    const section = await openEvidence(102)
    expect(within(section).getByText('Read from')).toBeInTheDocument()
    expect(within(section).getByText('User')).toBeInTheDocument()
    expect(within(section).getByText('Base image')).toBeInTheDocument()
  })

  it('marks a database peer on a shared network', async () => {
    const section = await openEvidence(103)
    expect(within(section).getByText('Database')).toBeInTheDocument()
  })

  it('tells which files a push skips and which trigger a deploy', async () => {
    const section = await openEvidence(106)
    expect(within(section).getAllByText('Skipped, no deploy').length).toBeGreaterThan(0)
    expect(within(section).getAllByText('Triggers a deploy').length).toBeGreaterThan(0)
  })

  it('lists the edits to make for a runtime past its support', async () => {
    const section = await openEvidence(112)
    expect(within(section).getByRole('list', { name: 'Edits to make' })).toBeInTheDocument()
  })

  it.each(
    GUARDS.filter((f) => f.guard?.level === 'unknown').map((f) => ({
      id: f.id,
      check: f.guard!.check,
    })),
  )('leads an unknown $check with why it is unknown', async ({ id }) => {
    const section = await openEvidence(id)
    const reason = byId(id).guard!.evidence.reason
    expect(reason).toBeTruthy()
    expect(within(section).getByText('Why the result is unknown')).toBeInTheDocument()
    expect(within(section).getByText(reason!)).toBeInTheDocument()
  })
})
