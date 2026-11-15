import type { RepoDetail } from '@hinomi/shared'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeFor } from '@/fixtures/repo-runtime'
import { mockViews, repoDetail } from '@/test/fixtures'
import { renderApp } from '@/test/render-app'

afterEach(() => vi.unstubAllGlobals())

// Fixture repos: 8 ingest (Node 18 ended), 1 storefront (Node 22 ending, Bun behind but fine),
// 10 cli (Rust nine releases behind), 2 auth (Node pin the support data does not know).
const withRuntime = (id: number, over: Partial<RepoDetail> = {}): RepoDetail => ({
  ...repoDetail({ id }),
  ...runtimeFor(id),
  ...over,
})

async function panel() {
  const heading = await screen.findByRole('heading', { name: 'Runtime' })
  return within(heading.closest('section') as HTMLElement)
}

describe('runtime panel', () => {
  it('lists every pin with its file and line and the end of life date of a Node line', async () => {
    mockViews({ 'GET /repos/8': withRuntime(8) })
    await renderApp('/repos/8')
    const p = await panel()
    expect(p.getByText('Node 18 ended 30 Apr 2025')).toBeInTheDocument()
    expect(p.getByText('Dockerfile:1')).toBeInTheDocument()
    expect(p.getByText('.github/workflows/ci.yml:22')).toBeInTheDocument()
    expect(p.getByText('Production')).toBeInTheDocument()
    expect(p.getByText('CI')).toBeInTheDocument()
    expect(p.getByText(/Judged by the end of security support/)).toBeInTheDocument()
  })

  it('shows the fix hints as a checklist with a copy button per edit', async () => {
    mockViews({ 'GET /repos/8': withRuntime(8) })
    await renderApp('/repos/8')
    const p = await panel()
    const edits = within(p.getByRole('list', { name: 'Node edits' }))
    expect(edits.getAllByRole('checkbox')).toHaveLength(3)
    expect(edits.getByRole('button', { name: 'Copy node:24-alpine' })).toBeInTheDocument()
    expect(edits.getByRole('button', { name: 'Copy node-version: 24' })).toBeInTheDocument()
  })

  it('copies the new value of an edit', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    mockViews({ 'GET /repos/8': withRuntime(8) })
    await renderApp('/repos/8')
    const p = await panel()
    await userEvent.click(p.getByRole('button', { name: 'Copy node:24-alpine' }))
    expect(writeText).toHaveBeenCalledWith('node:24-alpine')
  })

  it('marks the pin that names another line than the rest', async () => {
    mockViews({ 'GET /repos/1': withRuntime(1) })
    await renderApp('/repos/1')
    const p = await panel()
    const nvmrc = p.getByText('.nvmrc:1').closest('li') as HTMLElement
    expect(within(nvmrc).getByText('Disagrees')).toBeInTheDocument()
    const docker = p.getByText('Dockerfile:1').closest('li') as HTMLElement
    expect(within(docker).queryByText('Disagrees')).not.toBeInTheDocument()
  })

  it('judges Rust by releases behind the latest, with no end date, and says it never fails', async () => {
    mockViews({ 'GET /repos/10': withRuntime(10) })
    await renderApp('/repos/10')
    const p = await panel()
    expect(p.getByText('Rust 1.82 is 9 stable releases behind (latest 1.91.1)')).toBeInTheDocument()
    expect(p.getByText(/It warns, it never fails\. Warns past 4 releases\./)).toBeInTheDocument()
    expect(p.queryByText(/ends|ended/)).not.toBeInTheDocument()
    // Cargo rust-version is a minimum, and a floating action never counts.
    expect(p.getByText(/A minimum, not the version that runs/)).toBeInTheDocument()
    expect(p.getByText(/Floating, resolves to 1\.91 today/)).toBeInTheDocument()
  })

  it('judges Bun by minor releases behind and passes inside the allowance', async () => {
    mockViews({ 'GET /repos/1': withRuntime(1) })
    await renderApp('/repos/1')
    const p = await panel()
    const bun = within(p.getByRole('region', { name: 'Bun' }))
    expect(bun.getByText('Bun 1.1 is 2 minor releases behind (latest 1.3.2)')).toBeInTheDocument()
    expect(bun.getByText('Pass')).toBeInTheDocument()
    expect(bun.getByText(/Bun publishes no end of life dates/)).toBeInTheDocument()
  })

  it('lists the pins of a runtime the support data does not know without judging it', async () => {
    mockViews({ 'GET /repos/2': withRuntime(2) })
    await renderApp('/repos/2')
    const p = await panel()
    expect(p.getByText(/Node 25\.9 is not in the support data yet/)).toBeInTheDocument()
    expect(p.getByText('.node-version:1')).toBeInTheDocument()
    expect(p.queryByText(/Edits to make/)).not.toBeInTheDocument()
  })

  it('lists the pins and says the dates are missing before the first endoflife.date copy', async () => {
    const detail = withRuntime(8, { supportLines: { available: false, runtimes: [] } })
    mockViews({ 'GET /repos/8': detail })
    await renderApp('/repos/8')
    const p = await panel()
    expect(p.getByText('No support dates yet')).toBeInTheDocument()
    expect(p.getByText('Dockerfile:1')).toBeInTheDocument()
    expect(p.queryByRole('list', { name: 'Node edits' })).not.toBeInTheDocument()
  })

  it('says when no pin was found', async () => {
    mockViews({ 'GET /repos/24': repoDetail() })
    await renderApp('/repos/24')
    const p = await panel()
    expect(p.getByText(/No Node, Bun or Rust pin found/)).toBeInTheDocument()
  })
})
