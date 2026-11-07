import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSourceTesters } from '../../api/source-testers.js'
import { createAppJwt, createGithubAppAuth, readAppPrivateKey } from './app-auth.js'
import { createGithubClient } from './client.js'
import { createGithubAppSource } from './index.js'
import { scriptedFetch, type CannedResponse } from './testing.js'
import { nowMs } from '@hinomi/shared'

// A throwaway key made for this run only; nothing secret is committed.
const { privateKey: PRIVATE_KEY, publicKey: PUBLIC_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const BASE = 'https://github.example.dev/api/v3'
const NOW = Date.parse('2026-01-01T00:00:00Z')
const NOW_S = NOW / 1000
const TOKEN_PATH = `${BASE}/app/installations/4242/access_tokens`

function decode(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
}

function tokenResponse(token: string, expiresInMs = 60 * 60_000): CannedResponse {
  return {
    status: 201,
    body: { token, expires_at: new Date(nowMs() + expiresInMs).toISOString() },
  }
}

function appAuth(responses: Parameters<typeof scriptedFetch>[0], appId = '1234') {
  const { fetch, requests } = scriptedFetch(responses)
  const auth = createGithubAppAuth({
    appId,
    installationId: '4242',
    privateKey: PRIVATE_KEY,
    baseUrl: BASE,
    fetch,
  })
  return { auth, requests }
}

describe('github app auth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('signs an RS256 JWT with iat backdated and exp under ten minutes', () => {
    const jwt = createAppJwt('1234', readAppPrivateKey(PRIVATE_KEY), NOW)
    const [header, payload, signature] = jwt.split('.')
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const claims = decode(payload)
    expect(claims).toEqual({ iat: NOW_S - 60, exp: NOW_S + 540, iss: 1234 })
    expect((claims.exp as number) - NOW_S).toBeLessThanOrEqual(600)
    const valid = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      createPublicKey(PUBLIC_KEY),
      Buffer.from(signature ?? '', 'base64url'),
    )
    expect(valid).toBe(true)
  })

  it('keeps a Client ID issuer as text', () => {
    const jwt = createAppJwt('Iv23liKestrel', readAppPrivateKey(PRIVATE_KEY), NOW)
    expect(decode(jwt.split('.')[1]).iss).toBe('Iv23liKestrel')
  })

  it('refuses a key it cannot read without echoing it', () => {
    const broken = '-----BEGIN RSA PRIVATE KEY-----\nbm90LWEta2V5\n-----END RSA PRIVATE KEY-----'
    expect(() => readAppPrivateKey(broken)).toThrow(/could not be read/)
    try {
      readAppPrivateKey(broken)
    } catch (error) {
      expect(String(error)).not.toContain('bm90LWEta2V5')
    }
  })

  it('exchanges the JWT for an installation token and caches it', async () => {
    const { auth, requests } = appAuth([tokenResponse('ghs_first')])
    expect(await auth.getToken()).toBe('ghs_first')
    expect(await auth.getToken()).toBe('ghs_first')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ url: TOKEN_PATH, method: 'POST' })
    const jwt = requests[0]?.authorization?.replace(/^Bearer /, '') ?? ''
    expect(decode(jwt.split('.')[1]).iss).toBe(1234)
  })

  it('shares one exchange between parallel callers', async () => {
    const { auth, requests } = appAuth([tokenResponse('ghs_once')])
    const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()])
    expect(tokens).toEqual(['ghs_once', 'ghs_once', 'ghs_once'])
    expect(requests).toHaveLength(1)
  })

  it('mints a new token shortly before the old one expires', async () => {
    const { auth, requests } = appAuth([tokenResponse('ghs_old'), tokenResponse('ghs_new')])
    expect(await auth.getToken()).toBe('ghs_old')
    vi.setSystemTime(NOW + 50 * 60_000)
    expect(await auth.getToken()).toBe('ghs_old')
    vi.setSystemTime(NOW + 56 * 60_000)
    expect(await auth.getToken()).toBe('ghs_new')
    expect(requests).toHaveLength(2)
  })

  it('maps a rejected JWT and an unknown installation to clear errors', async () => {
    const rejected = appAuth([
      { status: 401, body: { message: 'A JSON web token could not be decoded' } },
    ])
    const error = await rejected.auth.getToken().catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'auth', status: 401 })
    expect(String(error)).toMatch(/App ID and the private key/)
    expect(String(error)).not.toContain('PRIVATE KEY')

    const missing = appAuth([{ status: 404, body: { message: 'Not Found' } }])
    await expect(missing.auth.getToken()).rejects.toMatchObject({
      kind: 'not_found',
      message: expect.stringContaining('installation 4242') as unknown,
    })
  })

  it('refreshes once when GitHub rejects the cached token, then retries', async () => {
    const { fetch, requests } = scriptedFetch([
      tokenResponse('ghs_revoked'),
      { status: 401, body: { message: 'Bad credentials' } },
      tokenResponse('ghs_fresh'),
      { body: { ok: true } },
    ])
    const auth = createGithubAppAuth({
      appId: '1234',
      installationId: '4242',
      privateKey: PRIVATE_KEY,
      baseUrl: BASE,
      fetch,
    })
    const client = createGithubClient({ auth, baseUrl: BASE, fetch, maxRetries: 0 })
    const result = await client.rest('/repos/kestrel-co/lantern-api')
    expect(result.data).toEqual({ ok: true })
    expect(requests.map((r) => r.authorization)).toEqual([
      expect.stringMatching(/^Bearer ey/),
      'Bearer ghs_revoked',
      expect.stringMatching(/^Bearer ey/),
      'Bearer ghs_fresh',
    ])
  })

  it('gives up after one refresh when the new token is rejected too', async () => {
    const { fetch } = scriptedFetch([
      tokenResponse('ghs_a'),
      { status: 401 },
      tokenResponse('ghs_b'),
      { status: 401 },
    ])
    const auth = createGithubAppAuth({
      appId: '1234',
      installationId: '4242',
      privateKey: PRIVATE_KEY,
      baseUrl: BASE,
      fetch,
    })
    const client = createGithubClient({ auth, baseUrl: BASE, fetch, maxRetries: 0 })
    await expect(client.rest('/repos/kestrel-co/lantern-api')).rejects.toMatchObject({
      kind: 'auth',
    })
  })
})

const REPO = (name: string) => ({
  name,
  owner: { login: 'kestrel-co' },
  archived: false,
  fork: false,
  default_branch: 'main',
  visibility: 'private',
  pushed_at: '2025-12-30T10:00:00Z',
})

describe('github app source', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the installation repos page by page', async () => {
    const { fetch, requests } = scriptedFetch([
      tokenResponse('ghs_list'),
      {
        headers: {
          link: `<${BASE}/installation/repositories?per_page=100&page=2>; rel="next"`,
        },
        body: { total_count: 2, repositories: [REPO('lantern-api')] },
      },
      { body: { total_count: 2, repositories: [REPO('lantern-web')] } },
    ])
    const source = createGithubAppSource({
      appId: '1234',
      installationId: '4242',
      privateKey: PRIVATE_KEY,
      baseUrl: BASE,
      fetch,
    })
    const repos = await source.listAccountRepos()
    expect(repos.map((r) => r.name)).toEqual(['lantern-api', 'lantern-web'])
    expect(requests[1]?.url).toBe(`${BASE}/installation/repositories?per_page=100`)
    expect(requests[2]?.url).toBe(`${BASE}/installation/repositories?per_page=100&page=2`)
    expect(requests.slice(1).every((r) => r.authorization === 'Bearer ghs_list')).toBe(true)
  })

  it('reports the account, repo access and permissions on a test', async () => {
    const { fetch } = scriptedFetch([
      tokenResponse('ghs_test'),
      {
        body: {
          account: { login: 'kestrel-co' },
          repository_selection: 'selected',
          permissions: { dependabot_alerts: 'read', contents: 'read', metadata: 'read' },
        },
      },
      { body: { total_count: 3, repositories: [REPO('lantern-api')] } },
    ])
    const testers = createSourceTesters({ fetch })
    const result = await testers.githubApp({
      baseUrl: BASE,
      appId: '1234',
      installationId: '4242',
      privateKey: PRIVATE_KEY,
    })
    expect(result).toEqual({
      ok: true,
      message:
        'Connected to kestrel-co with 3 selected repos. Without Administration (read) Hinomi cannot tell whether Dependabot alerts are on',
      login: 'kestrel-co',
      account: 'kestrel-co',
      repositorySelection: 'selected',
      repoCount: 3,
      missingPermissions: [],
    })
  })

  it('fails a test when a required permission is missing', async () => {
    const { fetch } = scriptedFetch([
      tokenResponse('ghs_test'),
      {
        body: {
          account: { login: 'kestrel-co' },
          repository_selection: 'all',
          permissions: { metadata: 'read', administration: 'read' },
        },
      },
      { body: { total_count: 12, repositories: [] } },
    ])
    const result = await createSourceTesters({ fetch }).githubApp({
      baseUrl: BASE,
      appId: '1234',
      installationId: '4242',
      privateKey: PRIVATE_KEY,
    })
    expect(result).toMatchObject({ ok: false, code: 'permission' })
    expect(result.message).toContain('Dependabot alerts (read), Contents (read)')
  })

  it('never puts the key in a failed test result', async () => {
    const { fetch } = scriptedFetch([{ status: 401, body: { message: 'bad JWT' } }])
    const result = await createSourceTesters({ fetch }).githubApp({
      baseUrl: BASE,
      appId: '1234',
      installationId: '4242',
      privateKey: PRIVATE_KEY,
    })
    expect(result).toMatchObject({ ok: false, code: 'auth' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
  })
})
