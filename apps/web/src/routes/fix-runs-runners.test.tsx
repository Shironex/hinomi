import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LOCAL_RUNNER_WARNING } from '@hinomi/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planFor, runnerFor } from '@/fixtures/fix-runs'
import { repoDetailFor } from '@/fixtures/repo-sources'
import { fixtureRoute, type FixtureScenario } from '@/fixtures/routes'
import { closeFix } from '@/lib/fix-request'
import { Reply, reply } from '@/test/mock-api'
import { renderApp } from '@/test/render-app'
import { wideScreen } from '@/test/screen'

afterEach(() => {
  vi.unstubAllGlobals()
  closeFix()
})

interface Call {
  method: string
  path: string
  body: unknown
}

/** Answers /api from the fixture dataset in `scenario`, with `overrides` keyed "METHOD /path". */
function fixtureApi(
  overrides: Record<string, unknown> = {},
  scenario: FixtureScenario = 'default',
) {
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
        const answer = fixtureRoute(method, url, scenario, body)
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

async function setup(path: string) {
  wideScreen()
  const user = userEvent.setup()
  await renderApp(path)
  return { user }
}

const picker = async () => within(await screen.findByRole('group', { name: 'Where plans run' }))

describe('runner kind selector', () => {
  it('offers the three kinds with GitHub Actions chosen, and the local warning always shown', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=plan-1')
    const kinds = await picker()
    expect(kinds.getByRole('radio', { name: /GitHub Actions/ })).toBeChecked()
    expect(kinds.getByRole('radio', { name: /Webhook runner/ })).not.toBeChecked()
    expect(kinds.getByRole('radio', { name: /Local runner/ })).toBeEnabled()
    // The warning is text on the page, not a tooltip.
    expect(kinds.getByText(LOCAL_RUNNER_WARNING)).toBeVisible()
    expect(kinds.getByRole('radio', { name: /Local runner/ })).toHaveAccessibleDescription(
      new RegExp(LOCAL_RUNNER_WARNING.slice(0, 40)),
    )
    // The webhook option says where it stands and links to its settings.
    expect(kinds.getByText(/Ready to dispatch to the webhook runner/)).toBeVisible()
    expect(kinds.getByRole('link', { name: 'Webhook runner settings' })).toHaveAttribute(
      'href',
      '/settings?sel=runner',
    )
  })

  it('sends only the kind when another one is picked', async () => {
    const calls = fixtureApi({
      'PATCH /repos/1/runner': (body: unknown) => ({
        ...runnerFor(1),
        settings: { ...runnerFor(1)!.settings, ...(body as object) },
      }),
    })
    const { user } = await setup('/fix-runs?sel=plan-1')
    const kinds = await picker()
    await user.click(kinds.getByRole('radio', { name: /Webhook runner/ }))
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ kind: 'webhook' }),
    )
    // The panel follows the saved kind: the caller workflow parts are gone.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Caller workflow' })).not.toBeInTheDocument(),
    )
  })

  it('disables Local with the host message while it is not offered, warning included', async () => {
    fixtureApi({}, 'local-off')
    await setup('/fix-runs?sel=plan-1')
    const kinds = await picker()
    expect(kinds.getByRole('radio', { name: /Local runner/ })).toBeDisabled()
    expect(kinds.getByText(/The local runner is off\. Set HINOMI_LOCAL_RUNNER=1/)).toBeVisible()
    expect(kinds.getByText('Not available.')).toBeVisible()
    expect(kinds.getByText(LOCAL_RUNNER_WARNING)).toBeVisible()
  })

  it('can be used with the keyboard', async () => {
    const calls = fixtureApi({ 'PATCH /repos/1/runner': runnerFor(1) })
    const { user } = await setup('/fix-runs?sel=plan-1')
    const kinds = await picker()
    kinds.getByRole('radio', { name: /GitHub Actions/ }).focus()
    await user.keyboard('{ArrowDown}')
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ kind: 'webhook' }),
    )
  })
})

describe('runner panel per kind', () => {
  it('keeps the GitHub Actions parts for that kind only', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=plan-1')
    expect(await screen.findByLabelText('Caller workflow file')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Caller workflow' })).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Majors agent' })).toBeVisible()
    expect(screen.getByText('Actions: write')).toBeVisible()
  })

  it('shows a webhook repo without the caller workflow, setup PR or workflow permissions', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=plan-20')
    expect(
      await screen.findByRole('switch', { name: 'Run fixes for this repo on the webhook runner' }),
    ).toBeChecked()
    expect(screen.getByRole('heading', { level: 2, name: 'Webhook runner' })).toBeVisible()
    expect(screen.queryByLabelText('Caller workflow file')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Caller workflow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /setup/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Actions: write')).not.toBeInTheDocument()
    expect(screen.getByText('Pull requests: write')).toBeVisible()
    expect(screen.getByText('Ready to dispatch')).toBeVisible()
  })

  it('says what is missing when the webhook runner is not set up', async () => {
    fixtureApi({}, 'runner-new')
    await setup('/fix-runs?sel=plan-20')
    const kinds = await picker()
    expect(await kinds.findByText('Not set up')).toBeVisible()
    expect(
      kinds.getByText(/Set the webhook runner URL and generate its secret first/),
    ).toBeVisible()
    expect(screen.getByText('Not ready')).toBeVisible()
  })

  it('refuses the majors agent on the local runner and says so', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=plan-23')
    expect(
      await screen.findByRole('switch', { name: 'Run fixes for this repo on this Hinomi host' }),
    ).toBeVisible()
    expect(screen.queryByRole('switch', { name: 'Majors agent' })).not.toBeInTheDocument()
    expect(screen.getByText('No majors agent on this runner')).toBeVisible()
    expect(screen.getByText(/does not run on the local runner/)).toBeVisible()
  })

  it('lists the majors of a local repo as risky steps and promises no second draft PR', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=plan-23')
    await screen.findByRole('switch', { name: 'Run fixes for this repo on this Hinomi host' })
    expect(screen.queryByText(/The majors agent takes/)).not.toBeInTheDocument()
    expect(screen.queryByText('Majors agent, draft PR')).not.toBeInTheDocument()
    expect(screen.getByText('Risky, listed only')).toBeVisible()
  })

  it('still sends the majors of a webhook repo to the agent when it is on', async () => {
    fixtureApi({
      'GET /repos/20/runner': {
        ...runnerFor(20),
        settings: { ...runnerFor(20)!.settings, majorsAgent: 'claude-code' },
      },
      'GET /repos/20/plan': { ...planFor(23)!, repo: planFor(20)!.repo },
    })
    await setup('/fix-runs?sel=plan-20')
    expect(await screen.findByText('Majors agent, draft PR')).toBeVisible()
  })

  it('turns a repo on a runner the host stopped offering into a not ready one', async () => {
    fixtureApi({}, 'local-off')
    await setup('/fix-runs?sel=plan-22')
    expect(await screen.findByText('Not ready')).toBeVisible()
    expect(screen.getAllByText(/The local runner is off/).length).toBeGreaterThan(0)
  })
})

describe('runs on other runners', () => {
  it('shows a webhook run without a workflow run link, labelled with its runner', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=60')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Running on kestrel-co/courier' }),
    ).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Workflow run' })).not.toBeInTheDocument()
    expect(screen.getByText('Webhook runner', { selector: '[data-slot="badge"]' })).toBeVisible()
    expect(
      screen.getByText('The webhook runner applies the safe steps. Waiting for its result.', {
        selector: 'p',
      }),
    ).toBeVisible()
    const timeline = screen.getByRole('list', { name: 'Fix run timeline' })
    expect(within(timeline).getByText('Webhook runner')).toBeVisible()
    expect(within(timeline).queryByText('Workflow run')).not.toBeInTheDocument()
    expect(screen.getByText('Runner')).toBeVisible()
    expect(screen.queryByText('Not known yet')).not.toBeInTheDocument()
    // The rest still works: the repo plan link and the fix button on a finished run.
    expect(screen.getByRole('link', { name: 'Plan and runner' })).toBeVisible()
  })

  it('shows a finished local run with its pull request and the same tracking', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=64')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Checks passing on kestrel-co/forge' }),
    ).toBeVisible()
    expect(screen.getByRole('link', { name: /Open PR #14\d/ })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Workflow run' })).not.toBeInTheDocument()
    expect(screen.getByText('Local runner', { selector: '[data-slot="badge"]' })).toBeVisible()
    expect(await screen.findByText('Last poll')).toBeVisible()
  })

  it('shows why a webhook run failed', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=62')
    expect(
      (
        await screen.findAllByText(/The webhook runner answered 502, so the plan was not accepted/)
      )[0],
    ).toBeVisible()
    // A failed run has ended, so the same plan can be run again.
    expect(screen.getByRole('button', { name: /Fix with Hinomi/ })).toBeVisible()
  })

  it('names the runner of a run in the list, and not for GitHub Actions', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=plan-20')
    const runs = await screen.findByRole('list', { name: 'Runs' }).catch(() => null)
    const text = (runs ?? document.body).textContent ?? ''
    expect(text).toContain('Run 60, webhook runner')
  })
})

describe('Fix with Hinomi on other runners', () => {
  const dispatchError = (message: string) => reply(409, { error: { code: 'conflict', message } })

  async function dispatch(path: string, answer: unknown, scenario: FixtureScenario = 'default') {
    const calls = fixtureApi(
      { 'POST /repos/20/fix-runs': answer, 'POST /repos/22/fix-runs': answer },
      scenario,
    )
    const { user } = await setup(path)
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    await within(dialog).findByText(/1 safe step clears/)
    await user.click(within(dialog).getByRole('button', { name: 'Dispatch the fix' }))
    return { dialog, calls }
  }

  it('says where the plan runs', async () => {
    fixtureApi()
    const { user } = await setup('/fix-runs?sel=plan-20')
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    await within(dialog).findByText(/1 safe step clears/)
    expect(dialog).toHaveTextContent(
      'Runs the latest fix plan of kestrel-co/courier on the webhook runner and opens one pull request',
    )
  })

  it('shows the 409 of a webhook runner that is not set up', async () => {
    const { dialog } = await dispatch(
      '/fix-runs?sel=plan-20',
      dispatchError('Set the webhook runner URL first.'),
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Set the webhook runner URL first.',
    )
    expect(within(dialog).getByRole('alert').textContent).not.toContain('..')
  })

  it('shows the 409 of a local runner the host does not offer', async () => {
    const { dialog } = await dispatch(
      '/fix-runs?sel=plan-22',
      dispatchError('The local runner is off. Set HINOMI_LOCAL_RUNNER=1 and restart Hinomi.'),
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The local runner is off. Set HINOMI_LOCAL_RUNNER=1 and restart Hinomi.',
    )
  })

  it('shows the 409 of a local run already in progress', async () => {
    const { dialog } = await dispatch(
      '/fix-runs?sel=plan-22',
      dispatchError(
        'A local run is already in progress on this host. Dispatch again when it ends.',
      ),
    )
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'A local run is already in progress on this host. Dispatch again when it ends.',
    )
  })

  it('leaves the majors of a local repo out and says so', async () => {
    fixtureApi()
    const { user } = await setup('/fix-runs?sel=plan-23')
    await user.click(await screen.findByRole('button', { name: /Fix with Hinomi/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Fix with Hinomi' })
    expect(await within(dialog).findByText(/does not run on the local runner/)).toBeVisible()
    expect(dialog).toHaveTextContent('on this Hinomi host and opens one pull request')
    expect(within(dialog).getByText(/installs from the lockfile only/)).toBeVisible()
    expect(within(dialog).queryByText(/majors agent takes/)).not.toBeInTheDocument()
  })
})

describe('repo github source', () => {
  const sourceSection = async () =>
    within((await screen.findByRole('heading', { name: 'GitHub source' })).closest('section')!)

  it('shows the source that reads the repo and switches it when several see it', async () => {
    const calls = fixtureApi({
      'PATCH /repos/1': (body: unknown) => {
        const detail = repoDetailFor(1)!
        const id = (body as { sourceId: number | null }).sourceId
        const picked = detail.source.seenBy.find((s) => s.id === id)!
        return {
          ...detail,
          source: {
            ...detail.source,
            current: { id: picked.id, name: picked.name, auth: picked.auth, enabled: true },
            mode: 'override',
            overrideId: id,
          },
        }
      },
    })
    const { user } = await setup('/fix-runs?sel=plan-1')
    const section = await sourceSection()
    expect(await section.findByText('kestrel-co')).toBeVisible()
    expect(section.getByText('Picked by the scan')).toBeVisible()
    expect(section.getByText(/2 GitHub sources see this repo/)).toBeVisible()
    const select = section.getByLabelText('Read and fix through')
    expect(select).toHaveValue('auto')
    expect(
      within(select).getByRole('option', { name: 'mara-kestrel, token, cannot read alerts' }),
    ).toBeInTheDocument()
    await user.selectOptions(select, '3')
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH' && c.path === '/repos/1')?.body).toEqual({
        sourceId: 3,
      }),
    )
    expect(await section.findByText('Picked by hand')).toBeVisible()
    expect(section.getByText('mara-kestrel')).toBeVisible()
  })

  it('goes back to the scan choice with null', async () => {
    const detail = repoDetailFor(1)!
    const calls = fixtureApi({
      'GET /repos/1': {
        ...detail,
        source: { ...detail.source, mode: 'override', overrideId: 2 },
      },
      'PATCH /repos/1': detail,
    })
    const { user } = await setup('/fix-runs?sel=plan-1')
    const section = await sourceSection()
    const select = await section.findByLabelText('Read and fix through')
    expect(select).toHaveValue('2')
    await user.selectOptions(select, 'auto')
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH' && c.path === '/repos/1')?.body).toEqual({
        sourceId: null,
      }),
    )
    expect(await section.findByText('Picked by the scan')).toBeVisible()
  })

  it('offers no switch when only one source sees the repo', async () => {
    fixtureApi()
    await setup('/fix-runs?sel=plan-23')
    const section = await sourceSection()
    expect(await section.findByText('kestrel-co')).toBeVisible()
    expect(section.getByText(/The only GitHub source that sees this repo/)).toBeVisible()
    expect(section.queryByLabelText('Read and fix through')).not.toBeInTheDocument()
  })

  it('says when no source can read the repo and links to the sources', async () => {
    fixtureApi({
      'GET /repos/1': {
        ...repoDetailFor(1)!,
        source: { current: null, mode: 'none', overrideId: null, seenBy: [] },
      },
    })
    await setup('/fix-runs?sel=plan-1')
    const section = await sourceSection()
    expect(await section.findByText('No source can read it')).toBeVisible()
    expect(section.getByRole('link', { name: 'Settings, Sources' })).toHaveAttribute(
      'href',
      '/settings?sel=sources',
    )
  })

  it('shows the refusal of a switched off source', async () => {
    fixtureApi({
      'PATCH /repos/1': reply(409, {
        error: { code: 'conflict', message: 'GitHub source "mara-kestrel" is switched off.' },
      }),
    })
    const { user } = await setup('/fix-runs?sel=plan-1')
    const section = await sourceSection()
    await user.selectOptions(await section.findByLabelText('Read and fix through'), '3')
    expect(await section.findByRole('alert')).toHaveTextContent('is switched off')
  })
})
