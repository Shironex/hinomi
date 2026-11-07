import {
  FIX_WORKFLOW,
  SETUP_PR_BRANCH,
  renderCallerWorkflow,
  runnerStatusSchema,
  setupPrResponseSchema,
} from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createTestApi } from '../api/testing.js'
import { appPermissions, classicTokenPermissions, fineGrainedPermissions } from './permissions.js'
import { setupPrCapability } from './setup-pr.js'
import { connectGithubToken, fakeGithub, fileReply, repoReply, type FakeRoute } from './testing.js'

// The setup PR on fictional repos, against a fake GitHub that records every write.

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const VERSION = 'v0.2.0'
const REPO = '/repos/kestrel-co/harbor'
const FILE = `${REPO}/contents/.github/workflows/hinomi-fix.yml`
const BRANCH = `${REPO}/branches/${encodeURIComponent(SETUP_PR_BRANCH)}`
const WANTED = renderCallerWorkflow({ sha: NEW, version: VERSION })
const PR = { number: 21, url: 'https://github.com/kestrel-co/harbor/pull/21' }
const CLASSIC = 'ghp_fictionalClassic000000000000000000'

/** The latest Hinomi release as GitHub answers it. */
const RELEASE: FakeRoute[] = [
  { path: '/repos/Shironex/hinomi/releases/latest', reply: { body: { tag_name: VERSION } } },
  { path: `/repos/Shironex/hinomi/commits/${VERSION}`, reply: { body: { sha: NEW } } },
  {
    path: `/repos/Shironex/hinomi/contents/.github/workflows/fix.yml?ref=${NEW}`,
    reply: { body: { type: 'file' } },
  },
]

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: PR.number,
    node_id: 'PR_1',
    html_url: PR.url,
    state: 'open',
    title: 'ci(hinomi): add the hinomi fix runner',
    body: '',
    head: { ref: SETUP_PR_BRANCH, sha: HEAD },
    base: { ref: 'main' },
    ...overrides,
  }
}

function titleBody(body: unknown) {
  const { title, body: text } = body as { title: string; body: string }
  return { title, body: text }
}

function fileOn(text: string, sha: string) {
  return {
    body: {
      type: 'file',
      sha,
      encoding: 'base64',
      content: Buffer.from(text).toString('base64'),
    },
  }
}

interface Scenario {
  release?: boolean
  /** The caller on the default branch (absent: 404). */
  onMain?: string
  /** The setup branch exists, with this file on it. */
  branch?: { file: string | null }
  openPr?: boolean
  scopes?: string
  putStatus?: number
}

function setup(scenario: Scenario = {}) {
  const writes: string[] = []
  const gh = fakeGithub([
    ...(scenario.release === false ? [] : RELEASE),
    { path: REPO, reply: repoReply('kestrel-co', 'harbor', 'public') },
    {
      path: '/user',
      reply: {
        body: { login: 'kestrel-bot' },
        ...(scenario.scopes && { headers: { 'x-oauth-scopes': scenario.scopes } }),
      },
    },
    { path: /\/actions\/workflows\/hinomi-fix\.yml$/, reply: { body: { id: 1 } } },
    { path: /\/pulls\?per_page=1/, reply: { body: [] } },
    { path: /\/commits\?/, reply: { body: [] } },
    ...(scenario.onMain === undefined
      ? []
      : [{ path: `${FILE}?ref=main`, reply: fileReply(scenario.onMain) }]),
    { path: `${REPO}/branches/main`, reply: { body: { commit: { sha: HEAD } } } },
    ...(scenario.branch
      ? [
          { path: BRANCH, reply: { body: { commit: { sha: HEAD } } } },
          ...(scenario.branch.file === null
            ? []
            : [
                {
                  path: `${FILE}?ref=${encodeURIComponent(SETUP_PR_BRANCH)}`,
                  reply: fileOn(scenario.branch.file, 'blob-1'),
                },
              ]),
        ]
      : []),
    {
      method: 'POST',
      path: `${REPO}/git/refs`,
      reply: (r) => (writes.push(`ref ${JSON.stringify(r.body)}`), { status: 201, body: {} }),
    },
    {
      method: 'PUT',
      path: FILE,
      reply: () => (
        writes.push('put'),
        scenario.putStatus
          ? { status: scenario.putStatus, body: { message: 'Resource not accessible' } }
          : { status: 200, body: {} }
      ),
    },
    {
      path: new RegExp(`${REPO}/pulls\\?.*state=open`),
      reply: { body: scenario.openPr ? [pull()] : [] },
    },
    {
      method: 'POST',
      path: `${REPO}/pulls`,
      reply: (r) => (writes.push('pr'), { status: 201, body: pull(titleBody(r.body)) }),
    },
    {
      method: 'PATCH',
      path: `${REPO}/pulls/${PR.number}`,
      reply: (r) => (writes.push('patch'), { body: pull(titleBody(r.body)) }),
    },
  ])
  const api = createTestApi({ sourceFetch: gh.fetch })
  const harbor = api.repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
  if (scenario.scopes) connectGithubToken(api.repos, CLASSIC)
  else connectGithubToken(api.repos)
  return { ...api, harbor, writes, requests: gh.requests }
}

describe('setupPrCapability', () => {
  const meta = {
    owner: 'kestrel-co',
    name: 'harbor',
    fullName: 'kestrel-co/harbor',
    defaultBranch: 'main',
    visibility: 'public' as const,
  }

  it('reads a GitHub App from its installation permissions', () => {
    const full = appPermissions({
      actions: 'write',
      contents: 'write',
      pull_requests: 'write',
      workflows: 'write',
    })
    expect(setupPrCapability(full, meta)).toMatchObject({ available: true })
    const noWorkflows = appPermissions({
      actions: 'write',
      contents: 'write',
      pull_requests: 'write',
    })
    const refused = setupPrCapability(noWorkflows, meta)
    expect(refused.available).toBe(false)
    expect(refused.reason).toContain('Workflows: write')
  })

  it('reads a classic token from its scopes', () => {
    expect(
      setupPrCapability(classicTokenPermissions(['repo', 'workflow'], 'public'), meta),
    ).toEqual({ available: true, reason: 'The credential may write workflow files.' })
    const repoOnly = setupPrCapability(classicTokenPermissions(['repo'], 'public'), meta)
    expect(repoOnly.available).toBe(false)
    expect(repoOnly.reason).toContain('workflow scope')
    expect(
      setupPrCapability(classicTokenPermissions(['read:user'], 'private'), meta),
    ).toMatchObject({ available: false, reason: expect.stringContaining('repo') as string })
  })

  it('tries a fine grained token and names what it cannot verify', () => {
    const result = setupPrCapability(
      fineGrainedPermissions({ workflow: 'ok', pulls: 'ok', contents: 'ok' }),
      meta,
    )
    expect(result.available).toBe(true)
    expect(result.reason).toContain('cannot be checked in advance')
    const denied = setupPrCapability(
      fineGrainedPermissions({ workflow: 'ok', pulls: 'denied', contents: 'ok' }),
      meta,
    )
    expect(denied.available).toBe(false)
  })

  it('is unavailable without a GitHub connection', () => {
    expect(
      setupPrCapability(
        { auth: null, ok: false, canOpenSetupPr: false, items: [], message: 'Connect it.' },
        null,
      ),
    ).toEqual({ available: false, reason: 'Connect it.' })
  })
})

describe('GET /api/repos/:id/runner caller and setupPr', () => {
  it('reports an outdated pin and an available setup PR', async () => {
    const { call, harbor } = setup({ onMain: renderCallerWorkflow({ sha: OLD }) })
    const status = runnerStatusSchema.parse((await call('GET', `/repos/${harbor.id}/runner`)).json)
    expect(status.caller).toMatchObject({
      present: true,
      pinnedSha: OLD,
      latestSha: NEW,
      outdated: true,
      state: 'outdated',
    })
    expect(status.setupPr.available).toBe(true)
  })

  it('reports a missing caller as not present', async () => {
    const { call, harbor } = setup()
    const status = runnerStatusSchema.parse((await call('GET', `/repos/${harbor.id}/runner`)).json)
    expect(status.caller).toMatchObject({ present: false, pinnedSha: null, outdated: false })
  })

  it('reports an unparseable caller as present but not pinned', async () => {
    const { call, harbor } = setup({ onMain: 'jobs: [unclosed' })
    const status = runnerStatusSchema.parse((await call('GET', `/repos/${harbor.id}/runner`)).json)
    expect(status.caller).toMatchObject({
      state: 'invalid',
      present: true,
      pinnedSha: null,
      outdated: false,
    })
  })

  it('says why the setup PR is unavailable for a classic token without workflow', async () => {
    const { call, harbor } = setup({ scopes: 'repo' })
    const status = runnerStatusSchema.parse((await call('GET', `/repos/${harbor.id}/runner`)).json)
    expect(status.setupPr).toMatchObject({ available: false })
    expect(status.setupPr.reason).toContain('workflow scope')
  })
})

describe('POST /api/repos/:id/runner/setup-pr', () => {
  const post = (call: ReturnType<typeof setup>['call'], id: number) =>
    call('POST', `/repos/${id}/runner/setup-pr`)

  it('refuses with 409 when no release SHA is known', async () => {
    const { call, harbor, writes } = setup({ release: false })
    const res = await post(call, harbor.id)
    expect(res.status).toBe(409)
    expect(res.text).toContain('No Hinomi release SHA')
    expect(writes).toEqual([])
  })

  it('404s for an unknown repo', async () => {
    const { call } = setup()
    expect((await post(call, 9999)).status).toBe(404)
  })

  it('creates the branch, the file and the PR', async () => {
    const { call, harbor, writes, requests } = setup()
    const res = await post(call, harbor.id)
    expect(res.status).toBe(201)
    expect(setupPrResponseSchema.parse(res.json)).toEqual({
      outcome: 'created',
      pr: PR,
      path: '.github/workflows/hinomi-fix.yml',
      sha: NEW,
      version: VERSION,
    })
    expect(writes).toEqual([
      `ref ${JSON.stringify({ ref: `refs/heads/${SETUP_PR_BRANCH}`, sha: HEAD })}`,
      'put',
      'pr',
    ])
    const put = requests.find((r) => r.method === 'PUT')
    const body = put?.body as { content: string; branch: string; sha?: string }
    expect(Buffer.from(body.content, 'base64').toString()).toBe(WANTED)
    expect(body).toMatchObject({ branch: SETUP_PR_BRANCH })
    expect(body.sha).toBeUndefined()
    const pr = requests.find((r) => r.method === 'POST' && r.path === `${REPO}/pulls`)
    expect(pr?.body).toMatchObject({
      title: 'ci(hinomi): add the hinomi fix runner',
      head: SETUP_PR_BRANCH,
      base: 'main',
    })
    const text = (pr?.body as { body: string }).body
    expect(text).toContain(NEW)
    expect(text).toContain(FIX_WORKFLOW)
    expect(text).toContain('https://github.com/Shironex/hinomi/blob/main/docs/github.md')
    expect(text).not.toMatch(/[\u2013\u2014]/)
  })

  it('reuses the branch and the open PR on a rerun', async () => {
    const { call, harbor, writes } = setup({ branch: { file: WANTED }, openPr: true })
    const first = await post(call, harbor.id)
    expect(first.status).toBe(200)
    expect(setupPrResponseSchema.parse(first.json)).toMatchObject({ outcome: 'updated', pr: PR })
    // Same file on the branch: no ref, no put. Only the PR text catches up.
    expect(writes).toEqual(['patch'])
  })

  it('updates a stale file on the existing branch with its blob sha', async () => {
    const { call, harbor, writes, requests } = setup({
      branch: { file: renderCallerWorkflow({ sha: OLD }) },
      openPr: true,
    })
    const res = await post(call, harbor.id)
    expect(res.status).toBe(200)
    expect(writes).toContain('put')
    expect(writes.filter((w) => w.startsWith('ref'))).toEqual([])
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ sha: 'blob-1' })
  })

  it('opens a new PR on a branch left over from an earlier one', async () => {
    const { call, harbor, writes } = setup({ branch: { file: null } })
    const res = await post(call, harbor.id)
    expect(res.status).toBe(201)
    expect(writes).toEqual(['put', 'pr'])
  })

  it('returns already_set_up when the default branch has this exact caller', async () => {
    const { call, harbor, writes } = setup({ onMain: WANTED })
    const res = await post(call, harbor.id)
    expect(res.status).toBe(200)
    expect(setupPrResponseSchema.parse(res.json)).toMatchObject({
      outcome: 'already_set_up',
      pr: null,
    })
    expect(writes).toEqual([])
  })

  it('opens an update the pin PR when the pin is outdated', async () => {
    const { call, harbor, requests } = setup({ onMain: renderCallerWorkflow({ sha: OLD }) })
    const res = await post(call, harbor.id)
    expect(res.status).toBe(201)
    const pr = requests.find((r) => r.method === 'POST' && r.path === `${REPO}/pulls`)
    expect(pr?.body).toMatchObject({ title: 'ci(hinomi): update the pin of the hinomi fix runner' })
    expect((pr?.body as { body: string }).body).toContain(OLD)
  })

  it('replaces a caller that is not valid YAML', async () => {
    const { call, harbor, writes } = setup({ onMain: 'jobs: [unclosed' })
    expect((await post(call, harbor.id)).status).toBe(201)
    expect(writes).toContain('put')
  })

  it('refuses a classic token without the workflow scope before writing', async () => {
    const { call, harbor, writes } = setup({ scopes: 'repo' })
    const res = await post(call, harbor.id)
    expect(res.status).toBe(409)
    expect(res.text).toContain('workflow scope')
    expect(writes).toEqual([])
  })

  it('explains a refused write when the permission could not be checked', async () => {
    const { call, harbor } = setup({ putStatus: 404 })
    const res = await post(call, harbor.id)
    expect(res.status).toBe(409)
    expect(res.text).toContain('Workflows: write')
  })
})
