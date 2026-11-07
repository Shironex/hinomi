import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runFor, runnerFor } from '@/fixtures/fix-runs'
import { fixtureRoute } from '@/fixtures/routes'
import { closeFix } from '@/lib/fix-request'
import { Reply, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'
import { wideScreen } from '@/test/screen'

afterEach(() => {
  vi.unstubAllGlobals()
  // The dialog request lives outside React, so one test's open dialog must not leak into the next.
  closeFix()
})

interface Call {
  method: string
  path: string
  body: unknown
}

/**
 * Answers /api from the fixture dataset (the same data fixture mode serves), with `overrides`
 * keyed by "METHOD /path" winning. Returns the calls made.
 */
function fixtureApi(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
        'http://hinomi.test',
      )
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.pathname.replace(/^\/api/, '')
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      calls.push({ method, path, body })
      const key = `${method} ${path}`
      let status = 200
      let payload: unknown
      if (key in overrides) {
        const route = overrides[key]
        const value = typeof route === 'function' ? (route as (b: unknown) => unknown)(body) : route
        if (value instanceof Reply) {
          status = value.status
          payload = value.body
        } else payload = value
      } else {
        const answer = fixtureRoute(method, url, 'default', body)
        status = answer.status
        payload = answer.body
      }
      return Promise.resolve(
        payload === undefined ? new Response(null, { status }) : Response.json(payload, { status }),
      )
    }),
  )
  return calls
}

const dispatched = (id: number) => ({ run: runFor(id), encoding: 'json', omittedStepIds: [] })

describe('fix runs page', () => {
  it('teaches what fix plans are when no scan built one', async () => {
    fixtureApi({ 'GET /plans': { items: [] } })
    await renderApp('/fix-runs')
    expect(await screen.findByRole('heading', { level: 1, name: 'Fix runs' })).toBeVisible()
    expect(await screen.findByRole('heading', { level: 2, name: 'No fix plans yet' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Pick a finding to fix' })).toHaveAttribute('href', '/')
  })

  it('puts the empty state in the detail pane on a wide screen', async () => {
    wideScreen()
    fixtureApi({ 'GET /plans': { items: [] } })
    await renderApp('/fix-runs')
    expect(await screen.findByText('Nothing here yet')).toBeVisible()
    const detail = within(screen.getByRole('region', { name: 'Fix plans and runs' }))
    expect(detail.getByRole('heading', { level: 2, name: 'No fix plans yet' })).toBeVisible()
    expect(screen.queryByText('move')).not.toBeInTheDocument()
  })

  it('lists plans per repo with their runs, the repos that need a person first', async () => {
    wideScreen()
    fixtureApi()
    await renderApp('/fix-runs')
    const list = await screen.findByRole('list', { name: 'Fix plans and runs' })
    await within(list).findAllByText(/Running/)
    const text = list.textContent ?? ''
    const at = (name: string) => text.indexOf(`kestrel-co/${name}`)
    expect(at('storefront')).toBeGreaterThanOrEqual(0)
    expect(at('storefront')).toBeLessThan(at('admin'))
    expect(at('admin')).toBeLessThan(at('auth'))
    expect(screen.getByText('2 need a person')).toBeInTheDocument()
    // Nothing selected on a wide screen: the first repo's plan shows.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fix plan for kestrel-co/storefront' }),
    ).toBeVisible()
  })

  it('shows a run with its timeline, failed checks first, PR and tracking', async () => {
    wideScreen()
    fixtureApi()
    await renderApp('/fix-runs?sel=41')
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Checks failing on kestrel-co/storefront',
      }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open PR #121, draft' })).toHaveAttribute(
      'href',
      'https://github.com/kestrel-co/storefront/pull/121',
    )
    const timeline = screen.getByRole('list', { name: 'Fix run timeline' })
    expect(within(timeline).getByText('Checks')).toHaveTextContent('Checks, failed')
    const checks = within(screen.getByRole('list', { name: 'Runner checks' })).getAllByRole(
      'listitem',
    )
    expect(checks[0]).toHaveTextContent('test')
    expect(checks[0]).toHaveTextContent('AssertionError: expected 41.99 to be 42')
    expect(screen.getByText('Inside the 7 day release age gate', { exact: false })).toBeVisible()
    expect(await screen.findByText('Last poll')).toBeInTheDocument()
    expect(screen.getByText('Next poll')).toBeInTheDocument()
  })

  it('shows the tracker error and the rate limit pause', async () => {
    wideScreen()
    fixtureApi()
    await renderApp('/fix-runs?sel=45')
    expect(
      await screen.findByText('Last error: GitHub answered 502 while reading the workflow run'),
    ).toBeVisible()
    await renderApp('/fix-runs?sel=48')
    expect(await screen.findByText('Paused until')).toBeInTheDocument()
  })

  it('renders the deploys, warnings and verification of merged runs', async () => {
    wideScreen()
    fixtureApi()
    await renderApp('/fix-runs?sel=40')
    const deploys = await screen.findByRole('list', { name: 'Deploys of the fix' })
    expect(within(deploys).getByRole('link', { name: 'ingest-worker' })).toHaveAttribute(
      'href',
      '/deployments/10',
    )
    expect(deploys).toHaveTextContent('Shipped the fix')
    expect(screen.getByText('The rescan is retrying')).toBeVisible()
    expect(
      screen.getByText('Last error: The OSV source timed out while reading the repo'),
    ).toBeVisible()

    cleanup()
    await renderApp('/fix-runs?sel=39')
    expect(await screen.findByText('2 warnings')).toBeVisible()
    expect(screen.getByText(/Watch paths skip the fix on status-page/)).toBeVisible()
    expect(screen.getByRole('list', { name: 'Deploys of the fix' })).toHaveTextContent(
      'Waiting for a deploy',
    )

    cleanup()
    await renderApp('/fix-runs?sel=15')
    expect(await screen.findByText('Deploys another branch')).toBeVisible()
    expect(screen.getByText(/No app deploys the branch the fix merged into/)).toBeVisible()

    cleanup()
    await renderApp('/fix-runs?sel=18')
    expect(await screen.findByText('1 finding of 2 still open')).toBeVisible()
    expect(screen.getByRole('link', { name: 'finding #4' })).toHaveAttribute('href', '/finding/4')
    expect(screen.getByText('2 targeted, 1 cleared, 1 still open, 0 new')).toBeVisible()

    cleanup()
    await renderApp('/fix-runs?sel=20')
    expect(await screen.findByText('The next scheduled scan verifies this run')).toBeVisible()
  })

  it('shows the plan as a diff, its steps and the runner with an outdated pin', async () => {
    wideScreen()
    fixtureApi()
    await renderApp('/fix-runs?sel=plan-1')
    const diff = await screen.findByRole('list', { name: 'What the fix pull request changes' })
    expect(diff).toHaveTextContent('apps/web/package.json')
    expect(diff).toHaveTextContent('added: "tessera": "14.2.9"')
    const steps = within(screen.getByRole('list', { name: 'Plan steps' })).getAllByRole('listitem')
    expect(steps.at(-1)).toHaveTextContent('Risky, listed only')
    expect(await screen.findByText('Outdated pin', { selector: 'b' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy the workflow' })).toBeVisible()
    expect(screen.getByLabelText('Caller workflow to paste')).toHaveTextContent(
      'uses: Shironex/hinomi/.github/workflows/fix.yml@4f1c2a9e8b7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a',
    )
  })

  it('opens the pin PR from the runner panel and links to it', async () => {
    wideScreen()
    const calls = fixtureApi({
      'POST /repos/1/runner/setup-pr': {
        outcome: 'created',
        pr: { number: 130, url: 'https://github.com/kestrel-co/storefront/pull/130' },
        path: '.github/workflows/hinomi-fix.yml',
        sha: '4f1c2a9e8b7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a',
        version: 'v0.2.0',
      },
    })
    const { user } = await setup('/fix-runs?sel=plan-1')
    await user.click(await screen.findByRole('button', { name: 'Update pin PR' }))
    const link = await screen.findByRole('link', { name: /Opened setup PR #130/ })
    expect(link).toHaveAttribute('href', 'https://github.com/kestrel-co/storefront/pull/130')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('says why the setup PR is not offered, and shows a refusal', async () => {
    wideScreen()
    fixtureApi({
      'POST /repos/10/runner/setup-pr': reply(409, {
        error: { code: 'conflict', message: 'The token cannot write workflow files' },
      }),
    })
    const { user } = await setup('/fix-runs?sel=plan-3')
    expect(await screen.findByText(/cannot write workflow files\. Grant it/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /setup PR|pin PR/ })).toBeNull()
    cleanup()
    await renderApp('/fix-runs?sel=plan-10')
    await user.click(await screen.findByRole('button', { name: 'Open setup PR' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The token cannot write workflow files',
    )
  })

  it('turns the runner off and saves the workflow file', async () => {
    wideScreen()
    const calls = fixtureApi({
      'PATCH /repos/1/runner': (body: unknown) => ({
        ...runnerFor(1),
        settings: { ...runnerFor(1)!.settings, ...(body as object) },
      }),
    })
    const { user } = await setup('/fix-runs?sel=plan-1')
    await user.click(
      await screen.findByRole('switch', { name: 'Run fixes for this repo in GitHub Actions' }),
    )
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH')[0]?.body).toEqual({ enabled: false }),
    )
    const input = screen.getByLabelText('Caller workflow file')
    await user.clear(input)
    await user.type(input, 'bad name')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Must be a workflow file name ending in .yml')).toBeVisible()
    await user.clear(input)
    await user.type(input, 'fix-deps.yml')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({
        workflow: 'fix-deps.yml',
      }),
    )
  })
})

async function setup(path: string) {
  const user = userEvent.setup()
  await renderApp(path)
  return { user }
}

describe('Fix with Hinomi', () => {
  it('asks before a fresh PR when the last one was closed unmerged, then opens the run', async () => {
    wideScreen()
    const calls = fixtureApi({ 'POST /repos/7/fix-runs': reply(201, dispatched(38)) })
    const { user } = await setup('/fix-runs?sel=plan-7')
    await screen.findByRole('heading', { level: 1, name: 'Fix plan for kestrel-co/admin' })
    await user.keyboard('f')
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    expect(
      await within(dialog).findByText('The last Hinomi PR #118 was closed without merging'),
    ).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Open a fresh PR' }))
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ confirmReopen: true }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Closed unmerged on kestrel-co/admin' }),
    ).toBeVisible()
  })

  it('switches to the confirmation when the server answers that the PR was closed', async () => {
    wideScreen()
    const previous = runnerFor(7)!.closedUnmerged
    const calls = fixtureApi({
      'POST /repos/1/fix-runs': (body: unknown) =>
        (body as { confirmReopen?: boolean }).confirmReopen
          ? reply(201, dispatched(41))
          : reply(409, { error: { code: 'conflict', message: 'Closed' }, previous }),
    })
    const { user } = await setup('/fix-runs?sel=plan-1')
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    expect(await within(dialog).findByText(/3 safe steps clear 5 of 7 open findings/)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the fix' }))
    expect(
      await within(dialog).findByText('The last Hinomi PR #118 was closed without merging'),
    ).toBeVisible()
    expect(calls.filter((c) => c.method === 'POST')[0]?.body).toEqual({})
    await user.click(within(dialog).getByRole('button', { name: 'Open a fresh PR' }))
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST')[1]?.body).toEqual({ confirmReopen: true }),
    )
  })

  it('will not dispatch while the runner is not ready, and links to its setup', async () => {
    wideScreen()
    fixtureApi()
    const { user } = await setup('/fix-runs?sel=plan-3')
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    expect(await within(dialog).findByText('The runner is not ready')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Dispatch the fix' })).toBeDisabled()
    expect(within(dialog).getByRole('link', { name: 'Set up the runner' })).toHaveAttribute(
      'href',
      '/fix-runs?sel=plan-3',
    )
  })

  it('runs from a finding and says which step clears it', async () => {
    fixtureApi()
    const { user } = await setup('/finding/1')
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getAllByRole('button', { name: 'Fix with Hinomi' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    expect(
      await within(dialog).findByText('This finding is cleared by step 1, tessera 14.2.9.'),
    ).toBeVisible()
  })

  it('lets the By fix view pick among the repos the bump touches', async () => {
    wideScreen()
    fixtureApi()
    const { user } = await setup('/?tab=fixes')
    await screen.findByRole('heading', { level: 1, name: /Upgrade tessera/ })
    await user.keyboard('f')
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    const admin = within(dialog).getByRole('radio', { name: /kestrel-co\/admin/ })
    expect(within(dialog).getByRole('radio', { name: /kestrel-co\/storefront/ })).toBeChecked()
    await user.click(admin)
    expect(await within(dialog).findByText(/2 safe steps clear 4 of 4 open findings/)).toBeVisible()
  })
})

describe('the majors agent', () => {
  const agentSwitch = () => screen.findByRole('switch', { name: 'Majors agent' })

  it('is off by default, says what it does and turns on through the runner settings', async () => {
    wideScreen()
    const calls = fixtureApi({
      'PATCH /repos/1/runner': (body: unknown) => ({
        ...runnerFor(1),
        settings: { ...runnerFor(1)!.settings, ...(body as object) },
      }),
    })
    const { user } = await setup('/fix-runs?sel=plan-1')
    const toggle = await agentSwitch()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle).toHaveAccessibleDescription(/draft\s+pull request on hinomi\/majors/)
    expect(toggle).toHaveAccessibleDescription(/costs money/)
    expect(screen.getByRole('link', { name: /How it works/ })).toHaveAttribute(
      'href',
      expect.stringContaining('docs/github.md#the-optional-majors-agent'),
    )
    expect(screen.queryByText('The caller does not pass the agent key')).toBeNull()
    await user.click(toggle)
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ majorsAgent: 'claude-code' }),
    )
    // The plan now says which steps the agent takes.
    expect(await screen.findByText('Majors agent, draft PR')).toBeVisible()
  })

  it('warns when it is on and the caller passes no key, and not when it does', async () => {
    wideScreen()
    const calls = fixtureApi({
      'PATCH /repos/18/runner': (body: unknown) => ({
        ...runnerFor(18),
        settings: { ...runnerFor(18)!.settings, ...(body as object) },
      }),
    })
    const { user } = await setup('/fix-runs?sel=plan-17')
    expect(await screen.findByText('The caller does not pass the agent key')).toBeVisible()
    expect(await agentSwitch()).toHaveAttribute('aria-checked', 'true')
    cleanup()
    await renderApp('/fix-runs?sel=plan-18')
    const toggle = await agentSwitch()
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByText('The caller does not pass the agent key')).toBeNull()
    await user.click(toggle)
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ majorsAgent: 'off' }),
    )
  })

  it('works from the keyboard', async () => {
    wideScreen()
    fixtureApi()
    const { user } = await setup('/fix-runs?sel=plan-18')
    const toggle = await agentSwitch()
    toggle.focus()
    expect(toggle).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('alert')).toBeVisible()
  })

  it('says a second draft PR will be made, then shows both runs after the dispatch', async () => {
    wideScreen()
    const calls = fixtureApi({
      'POST /repos/18/fix-runs': reply(201, { ...dispatched(52), majorsRun: runFor(51) }),
    })
    const { user } = await setup('/fix-runs?sel=plan-18')
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    expect(
      await within(dialog).findByText(/takes 2 major upgrades into a second draft pull request/),
    ).toBeVisible()
    expect(within(dialog).queryByText('The majors run cannot start')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the fix' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true))
    const list = await within(dialog).findByRole('list', { name: 'Dispatched runs' })
    expect(within(list).getByRole('link', { name: 'Fix run 52' })).toBeVisible()
    expect(within(list).getByRole('link', { name: 'Majors run 51' })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Dispatch the fix' })).toBeDisabled()
    await user.click(within(list).getByRole('link', { name: 'Majors run 51' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('Majors run', { selector: 'span' })).toBeVisible()
  })

  it('dispatches the agent alone for a plan with only major upgrades', async () => {
    wideScreen()
    fixtureApi({ 'POST /repos/16/fix-runs': reply(201, { ...dispatched(50), majorsRun: null }) })
    const { user } = await setup('/fix-runs?sel=plan-16')
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    expect(
      await within(dialog).findByText(/The latest plan has no safe step.*one draft pull request/),
    ).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the majors agent' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Running on kestrel-co/exporter' }),
    ).toBeVisible()
  })

  it('warns in the dialog when the caller passes no key', async () => {
    wideScreen()
    fixtureApi()
    const { user } = await setup('/fix-runs?sel=plan-17')
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    expect(await within(dialog).findByText('The majors run cannot start')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Dispatch the fix' })).toBeEnabled()
  })

  it('does not mention a second PR while the agent is off', async () => {
    wideScreen()
    fixtureApi()
    const { user } = await setup('/fix-runs?sel=plan-1')
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    await within(dialog).findByText(/3 safe steps clear/)
    expect(dialog).not.toHaveTextContent('majors agent')
  })

  it('marks majors runs in the list and shows the draft PR, outcome, turns and cost', async () => {
    wideScreen()
    fixtureApi()
    await renderApp('/fix-runs?sel=51')
    const list = await screen.findByRole('list', { name: 'Fix plans and runs' })
    expect(within(list).getByText(/Majors run 51, PR #\d+ draft/)).toBeVisible()
    expect(within(list).getByText('Majors run 50')).toBeVisible()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'PR open on kestrel-co/gateway' }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: /Open PR #\d+, draft/ })).toBeVisible()
    const agent = screen
      .getByRole('heading', { level: 2, name: 'Agent' })
      .closest('div')!.parentElement!
    expect(within(agent).getByText('Changed the code')).toBeVisible()
    expect(agent).toHaveTextContent('Turns37')
    expect(agent).toHaveTextContent('Cost$3.42 estimated')
    expect(
      within(agent).getByRole('list', { name: 'Paths left out of the patch' }),
    ).toHaveTextContent('.github/workflows/ci.yml')
    expect(screen.getByRole('heading', { level: 2, name: 'Major upgrades' })).toBeVisible()
    expect(screen.getByText(/The runner runs no checks for a majors run/)).toBeVisible()
    expect(screen.getByText('hinomi/majors')).toBeVisible()
  })

  it('shows a running majors run alone, with no agent result yet', async () => {
    wideScreen()
    fixtureApi()
    await renderApp('/fix-runs?sel=50')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Running on kestrel-co/exporter' }),
    ).toBeVisible()
    expect(screen.getByText(/The coding agent edits the code for the major upgrades/)).toBeVisible()
    expect(screen.getByText(/The agent is working/)).toBeVisible()
    expect(screen.getByText('The agent is editing the code for the major upgrades')).toBeVisible()
  })

  it('shows why a majors run failed, from the agent', async () => {
    wideScreen()
    fixtureApi()
    await renderApp('/fix-runs?sel=53')
    // The reason shows in the callout and again at the stage of the timeline that failed.
    expect(
      (await screen.findAllByText(/The agent timed out: the runner stopped it after 40 minutes/))
        .length,
    ).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('list', { name: 'Fix run timeline' })).toHaveTextContent(
      'Workflow run, failed',
    )
    expect(screen.getByText('Timed out', { selector: 'span' })).toBeVisible()
    expect(screen.getByText('The runner stopped the agent after 40 minutes')).toBeVisible()
    expect(screen.getByText(/Turns/).parentElement).toHaveTextContent('80')
  })
})
