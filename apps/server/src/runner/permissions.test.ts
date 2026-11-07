import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createGithubAppSource, createGithubSource } from '../sources/github/index.js'
import { probeRunnerPermissions } from './permissions.js'
import { fakeGithub, type FakeRoute } from './testing.js'

// The runner permission probe for a GitHub App and both token kinds, on a fictional repo. The
// app key is generated for this run and never committed.

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const TARGET = {
  owner: 'kestrel-co',
  name: 'harbor',
  workflow: 'hinomi-fix.yml',
  visibility: 'private' as const,
}
const USER: FakeRoute = { path: '/user', reply: { body: { login: 'kestrel-bot' } } }

function statuses(result: Awaited<ReturnType<typeof probeRunnerPermissions>>) {
  return Object.fromEntries(result.items.map((i) => [i.name, i.status]))
}

function appSource(permissions: Record<string, string>) {
  const github = fakeGithub([
    {
      method: 'POST',
      path: '/app/installations/4242/access_tokens',
      reply: { status: 201, body: { token: 'ghs_fictional', expires_at: '2099-01-01T00:00:00Z' } },
    },
    {
      path: '/app/installations/4242',
      reply: {
        body: { account: { login: 'kestrel-co' }, repository_selection: 'selected', permissions },
      },
    },
  ])
  return createGithubAppSource({
    appId: '1234',
    installationId: '4242',
    privateKey,
    fetch: github.fetch,
  })
}

describe('probeRunnerPermissions: GitHub App', () => {
  it('passes with actions and pull requests write and contents read', async () => {
    const result = await probeRunnerPermissions(
      appSource({ actions: 'write', contents: 'read', pull_requests: 'write', metadata: 'read' }),
      TARGET,
    )
    expect(result).toMatchObject({ auth: 'github_app', ok: true, canOpenSetupPr: false })
    expect(statuses(result)).toEqual({
      actions: 'granted',
      contents: 'granted',
      pull_requests: 'granted',
      checks: 'missing',
      statuses: 'missing',
      workflows: 'missing',
    })
  })

  it('names what is missing, and allows the setup PR with workflows and contents write', async () => {
    const readOnly = await probeRunnerPermissions(
      appSource({ actions: 'read', contents: 'read', dependabot_alerts: 'read' }),
      TARGET,
    )
    expect(readOnly.ok).toBe(false)
    expect(readOnly.message).toBe('Missing Actions: write, Pull requests: write.')

    const full = await probeRunnerPermissions(
      appSource({
        actions: 'write',
        contents: 'write',
        pull_requests: 'write',
        workflows: 'write',
        checks: 'read',
        statuses: 'read',
      }),
      TARGET,
    )
    expect(full).toMatchObject({ ok: true, canOpenSetupPr: true })
    expect(full.items.every((i) => i.status === 'granted')).toBe(true)
  })
})

describe('probeRunnerPermissions: classic token', () => {
  const classic = (scopes: string) =>
    createGithubSource({
      token: 'ghp_fictionalClassic000000000000000000',
      fetch: fakeGithub([
        { ...USER, reply: { ...USER.reply, headers: { 'x-oauth-scopes': scopes } } },
      ]).fetch,
    })

  it('reads repo and workflow from X-OAuth-Scopes', async () => {
    const both = await probeRunnerPermissions(classic('repo, workflow, security_events'), TARGET)
    expect(both).toMatchObject({ auth: 'classic_token', ok: true, canOpenSetupPr: true })

    const repoOnly = await probeRunnerPermissions(classic('repo'), TARGET)
    expect(repoOnly).toMatchObject({ ok: true, canOpenSetupPr: false })
    expect(statuses(repoOnly)).toEqual({ repo: 'granted', workflow: 'missing' })
  })

  it('needs repo on a private repo, public_repo is enough on a public one', async () => {
    const narrow = classic('public_repo, security_events')
    expect((await probeRunnerPermissions(narrow, TARGET)).ok).toBe(false)
    expect((await probeRunnerPermissions(narrow, { ...TARGET, visibility: 'public' })).ok).toBe(
      true,
    )
  })
})

describe('probeRunnerPermissions: fine grained token', () => {
  const fineGrained = (routes: FakeRoute[]) => {
    const github = fakeGithub([USER, ...routes])
    return {
      requests: github.requests,
      source: createGithubSource({
        token: 'github_pat_fictional0000000000000000',
        fetch: github.fetch,
        maxRetries: 0,
      }),
    }
  }
  const WORKFLOW = '/repos/kestrel-co/harbor/actions/workflows/hinomi-fix.yml'
  const PULLS = '/repos/kestrel-co/harbor/pulls?state=all&per_page=1'
  const COMMITS = '/repos/kestrel-co/harbor/commits?per_page=1'

  it('leaves writes unverified when the reads work, using only GET requests', async () => {
    const { source, requests } = fineGrained([
      { path: WORKFLOW, reply: { body: { id: 1, path: '.github/workflows/hinomi-fix.yml' } } },
      { path: PULLS, reply: { body: [] } },
      { path: COMMITS, reply: { body: [] } },
    ])
    const result = await probeRunnerPermissions(source, TARGET)
    expect(result).toMatchObject({ auth: 'fine_grained_token', ok: true, canOpenSetupPr: false })
    expect(statuses(result)).toEqual({
      actions: 'unverified',
      contents: 'granted',
      pull_requests: 'unverified',
      workflows: 'unverified',
    })
    expect(result.message).toContain('cannot be checked without a write')
    expect(requests.every((r) => r.method === 'GET')).toBe(true)
  })

  it('reports a refused read as missing', async () => {
    const denied = {
      status: 403,
      body: { message: 'Resource not accessible by personal access token' },
    }
    const { source } = fineGrained([
      { path: WORKFLOW, reply: denied },
      { path: PULLS, reply: denied },
      { path: COMMITS, reply: { body: [] } },
    ])
    const result = await probeRunnerPermissions(source, TARGET)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Missing Actions: write, Pull requests: write.')
  })

  it('keeps Actions unverified when only the workflow file is missing', async () => {
    const { source } = fineGrained([
      { path: PULLS, reply: { body: [] } },
      { path: COMMITS, reply: { status: 409, body: { message: 'Git Repository is empty.' } } },
    ])
    const result = await probeRunnerPermissions(source, TARGET)
    expect(statuses(result)).toMatchObject({ actions: 'unverified', contents: 'granted' })
    expect(result.ok).toBe(true)
  })
})
