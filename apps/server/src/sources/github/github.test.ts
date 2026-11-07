import { describe, expect, it } from 'vitest'
import { fetchDependabotAlerts } from './alerts.js'
import { createGithubClient } from './client.js'
import { GithubError } from './errors.js'
import { testGithubConnection } from './connection.js'
import { fetchRepoHealth, listAccountRepos } from './repos.js'
import { scriptedFetch, type CannedResponse } from './testing.js'

const BASE = 'https://github.example.dev'

function setup(responses: (CannedResponse | Error)[]) {
  const { fetch, requests } = scriptedFetch(responses)
  return {
    requests,
    client: createGithubClient({ token: 'test-token', baseUrl: BASE, fetch, maxRetries: 0 }),
  }
}

const repoBody = {
  name: 'harbor-web',
  owner: { login: 'kestrel-co' },
  archived: false,
  default_branch: 'main',
  visibility: 'private',
  private: true,
  pushed_at: '2026-01-02T03:04:05Z',
}

describe('fetchRepoHealth', () => {
  it('reports alerts enabled on 204', async () => {
    const { client } = setup([{ body: repoBody }, { status: 204 }])
    expect(await fetchRepoHealth(client, 'kestrel-co', 'harbor-web')).toEqual({
      owner: 'kestrel-co',
      name: 'harbor-web',
      archived: false,
      defaultBranch: 'main',
      visibility: 'private',
      alertsEnabled: true,
      pushedAt: '2026-01-02T03:04:05Z',
    })
  })

  it('reports alerts disabled on 404', async () => {
    const { client } = setup([{ body: repoBody }, { status: 404, body: { message: 'Not Found' } }])
    expect((await fetchRepoHealth(client, 'kestrel-co', 'harbor-web')).alertsEnabled).toBe(false)
  })

  it('reports unknown (null) on 403, distinct from disabled', async () => {
    const { client } = setup([
      { body: repoBody },
      { status: 403, body: { message: 'Resource not accessible' } },
    ])
    expect((await fetchRepoHealth(client, 'kestrel-co', 'harbor-web')).alertsEnabled).toBeNull()
  })

  it('falls back to the private flag when visibility is missing', async () => {
    const { client } = setup([
      { body: { ...repoBody, visibility: undefined, private: false } },
      { status: 204 },
    ])
    expect((await fetchRepoHealth(client, 'kestrel-co', 'harbor-web')).visibility).toBe('public')
  })

  it('throws not_found when the repo itself is missing', async () => {
    const { client } = setup([{ status: 404 }, { status: 404 }])
    await expect(fetchRepoHealth(client, 'kestrel-co', 'ghost')).rejects.toMatchObject({
      kind: 'not_found',
    })
  })
})

function alertNode(
  n: number,
  overrides: Record<string, unknown> = {},
  vuln: Record<string, unknown> = {},
) {
  return {
    number: n,
    createdAt: '2026-01-03T00:00:00Z',
    dismissedAt: null,
    vulnerableManifestPath: 'pnpm-lock.yaml',
    dependencyScope: 'RUNTIME',
    securityVulnerability: {
      severity: 'HIGH',
      vulnerableVersionRange: '< 2.1.0',
      firstPatchedVersion: { identifier: '2.1.0' },
      package: { name: 'example-lib', ecosystem: 'NPM' },
      advisory: {
        ghsaId: 'GHSA-aaaa-bbbb-cccc',
        summary: 'Example prototype pollution',
        publishedAt: '2025-12-01T10:00:00Z',
        identifiers: [
          { type: 'GHSA', value: 'GHSA-aaaa-bbbb-cccc' },
          { type: 'CVE', value: 'CVE-2025-00001' },
        ],
        cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
      },
      ...vuln,
    },
    ...overrides,
  }
}

function alertsPage(nodes: unknown[], next: string | null) {
  return {
    body: {
      data: {
        repository: {
          vulnerabilityAlerts: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes },
        },
      },
    },
  }
}

const noDismissed = alertsPage([], null)

describe('fetchDependabotAlerts', () => {
  it('normalises an alert into advisory and repo records', async () => {
    const { client } = setup([alertsPage([alertNode(1)], null), noDismissed])
    const result = await fetchDependabotAlerts(client, 'kestrel-co', 'harbor-web')
    expect(result.advisories).toEqual([
      {
        ghsaId: 'GHSA-aaaa-bbbb-cccc',
        cveIds: ['CVE-2025-00001'],
        package: 'example-lib',
        ecosystem: 'npm',
        severity: 'high',
        cvss: 7.5,
        summary: 'Example prototype pollution',
        description: null,
        vulnerableRange: '< 2.1.0',
        firstPatched: '2.1.0',
        publishedAt: '2025-12-01T10:00:00Z',
      },
    ])
    expect(result.alerts).toEqual([
      {
        owner: 'kestrel-co',
        repo: 'harbor-web',
        alertNumber: 1,
        ghsaId: 'GHSA-aaaa-bbbb-cccc',
        package: 'example-lib',
        ecosystem: 'npm',
        scope: 'runtime',
        manifestPath: 'pnpm-lock.yaml',
        createdAt: '2026-01-03T00:00:00Z',
        dismissedAt: null,
      },
    ])
  })

  it('maps dependency scope', async () => {
    const { client } = setup([
      alertsPage(
        [
          alertNode(1, { dependencyScope: 'RUNTIME' }),
          alertNode(2, { dependencyScope: 'DEVELOPMENT' }),
          alertNode(3, { dependencyScope: null }),
        ],
        null,
      ),
      noDismissed,
    ])
    const { alerts } = await fetchDependabotAlerts(client, 'kestrel-co', 'harbor-web')
    expect(alerts.map((a) => a.scope)).toEqual(['runtime', 'dev', null])
  })

  it('follows pagination cursors and deduplicates advisories', async () => {
    const { client, requests } = setup([
      alertsPage([alertNode(1), alertNode(2)], 'cursor-1'),
      alertsPage([alertNode(3, {}, { package: { name: 'other-lib', ecosystem: 'PIP' } })], null),
      noDismissed,
    ])
    const result = await fetchDependabotAlerts(client, 'kestrel-co', 'harbor-web')
    expect(requests).toHaveLength(3)
    expect((requests[0]?.body as { variables: { cursor: unknown } }).variables.cursor).toBeNull()
    expect((requests[1]?.body as { variables: { cursor: unknown } }).variables.cursor).toBe(
      'cursor-1',
    )
    expect(result.alerts.map((a) => a.alertNumber)).toEqual([1, 2, 3])
    expect(result.advisories.map((a) => `${a.ecosystem}:${a.package}`)).toEqual([
      'npm:example-lib',
      'pip:other-lib',
    ])
  })

  it('treats a zero score without a vector as no CVSS and unknown ecosystems as other', async () => {
    const { client } = setup([
      alertsPage(
        [
          alertNode(
            1,
            {},
            {
              package: { name: 'thing', ecosystem: 'HEX' },
              advisory: {
                ghsaId: 'GHSA-dddd-eeee-ffff',
                summary: 's',
                publishedAt: null,
                identifiers: [],
                cvss: { score: 0, vectorString: null },
              },
            },
          ),
        ],
        null,
      ),
      noDismissed,
    ])
    const { advisories } = await fetchDependabotAlerts(client, 'kestrel-co', 'harbor-web')
    expect(advisories[0]).toMatchObject({
      cvss: null,
      ecosystem: 'other',
      cveIds: [],
      publishedAt: null,
    })
  })

  it('fetches dismissed alerts as a separate list with the reason and comment', async () => {
    const dismissed = alertNode(
      7,
      {
        dismissedAt: '2026-10-20T08:00:00Z',
        dismissReason: 'tolerable_risk',
        dismissComment: 'only used in tests',
      },
      {
        package: { name: 'other-lib', ecosystem: 'NPM' },
        advisory: {
          ghsaId: 'GHSA-gggg-hhhh-iiii',
          summary: 'Another example',
          publishedAt: null,
          identifiers: [],
          cvss: null,
        },
      },
    )
    const { client, requests } = setup([
      alertsPage([alertNode(1)], null),
      alertsPage([dismissed], null),
    ])
    const result = await fetchDependabotAlerts(client, 'kestrel-co', 'harbor-web')
    expect(
      requests.map((r) => (r.body as { query: string }).query.match(/states: (\w+)/)?.[1]),
    ).toEqual(['OPEN', 'DISMISSED'])
    expect(result.alerts.map((a) => a.alertNumber)).toEqual([1])
    expect(result.dismissed).toEqual([
      expect.objectContaining({
        alertNumber: 7,
        ghsaId: 'GHSA-gggg-hhhh-iiii',
        dismissedAt: '2026-10-20T08:00:00Z',
        dismissReason: 'tolerable_risk',
        dismissComment: 'only used in tests',
      }),
    ])
    expect(result.advisories.map((a) => a.ghsaId)).toEqual([
      'GHSA-aaaa-bbbb-cccc',
      'GHSA-gggg-hhhh-iiii',
    ])
  })

  it('fails the whole fetch when the dismissed alerts cannot be read', async () => {
    const { client } = setup([alertsPage([alertNode(1)], null), { status: 502, body: {} }])
    await expect(fetchDependabotAlerts(client, 'kestrel-co', 'harbor-web')).rejects.toThrow(
      GithubError,
    )
  })

  it('throws not_found when the repository is null', async () => {
    const { client } = setup([{ body: { data: { repository: null } } }])
    await expect(fetchDependabotAlerts(client, 'kestrel-co', 'ghost')).rejects.toMatchObject({
      kind: 'not_found',
    })
  })

  it('throws a parse error on an unexpected payload', async () => {
    const { client } = setup([{ body: { data: { repository: { vulnerabilityAlerts: {} } } } }])
    await expect(fetchDependabotAlerts(client, 'kestrel-co', 'harbor-web')).rejects.toMatchObject({
      kind: 'parse',
    })
  })
})

describe('listAccountRepos', () => {
  it('follows the Link header across pages', async () => {
    const second = {
      ...repoBody,
      name: 'harbor-api',
      owner: { login: 'kestrel-labs' },
      fork: true,
      visibility: 'public',
    }
    const { client, requests } = setup([
      {
        body: [repoBody],
        headers: {
          link: `<${BASE}/user/repos?per_page=100&page=2>; rel="next", <${BASE}/user/repos?page=2>; rel="last"`,
        },
      },
      { body: [second] },
    ])
    const repos = await listAccountRepos(client)
    expect(requests[1]?.url).toBe(`${BASE}/user/repos?per_page=100&page=2`)
    expect(repos.map((r) => `${r.owner}/${r.name}`)).toEqual([
      'kestrel-co/harbor-web',
      'kestrel-labs/harbor-api',
    ])
    expect(repos[1]).toMatchObject({ fork: true, visibility: 'public' })
  })

  it('keeps the GitHub Enterprise API prefix when following pages', async () => {
    const api = `${BASE}/api/v3`
    const { fetch, requests } = scriptedFetch([
      {
        body: [repoBody],
        headers: { link: `<${api}/user/repos?per_page=100&page=2>; rel="next"` },
      },
      { body: [] },
    ])
    const client = createGithubClient({ token: 'test-token', baseUrl: api, fetch, maxRetries: 0 })
    await listAccountRepos(client)
    expect(requests[1]?.url).toBe(`${api}/user/repos?per_page=100&page=2`)
  })
})

describe('testGithubConnection', () => {
  it('returns the login and the classic token scopes', async () => {
    const { client } = setup([
      { body: { login: 'octo-kestrel' }, headers: { 'x-oauth-scopes': 'repo, read:org' } },
    ])
    expect(await testGithubConnection(client)).toEqual({
      login: 'octo-kestrel',
      scopes: ['repo', 'read:org'],
    })
  })

  it('reports null scopes for a fine-grained token', async () => {
    const { client } = setup([{ body: { login: 'octo-kestrel' } }])
    expect((await testGithubConnection(client)).scopes).toBeNull()
  })

  it('throws an auth error for a bad token', async () => {
    const { client } = setup([{ status: 401, body: { message: 'Bad credentials' } }])
    await expect(testGithubConnection(client)).rejects.toMatchObject({ kind: 'auth' })
  })
})
