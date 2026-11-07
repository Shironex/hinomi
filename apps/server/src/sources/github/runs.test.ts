import { describe, expect, it } from 'vitest'
import {
  combineChecks,
  fetchCheckRunsStatus,
  fetchCombinedStatus,
  summarizeCheckRuns,
  summarizeCombinedStatus,
} from './checks.js'
import { createGithubClient } from './client.js'
import { fetchPull } from './pulls.js'
import {
  downloadArtifact,
  fetchBranchHead,
  fetchWorkflowRun,
  listRunArtifacts,
  listWorkflowRuns,
} from './runs.js'
import { scriptedFetch, type CannedResponse } from './testing.js'

// GitHub reads of the fix run tracker against canned answers. Repos and URLs are fictional.

const BASE = 'https://github.example.dev'
const REPO = { owner: 'kestrel-co', name: 'harbor' }

function client(responses: (CannedResponse | Error)[]) {
  const scripted = scriptedFetch(responses)
  return {
    ...scripted,
    client: createGithubClient({
      token: 'test-token',
      baseUrl: BASE,
      fetch: scripted.fetch,
      maxRetries: 0,
    }),
  }
}

const RUN = {
  id: 9001,
  run_attempt: 2,
  display_title: 'hinomi fix 0c1d',
  status: 'in_progress',
  conclusion: null,
  created_at: '2026-11-07T10:00:00Z',
  updated_at: '2026-11-07T10:01:00Z',
}

describe('workflow runs', () => {
  it('reads a run with its ETag, and a 304 without a body', async () => {
    const { client: c, requests } = client([
      { body: RUN, headers: { etag: 'W/"r1"' } },
      { status: 304, headers: { etag: 'W/"r1"' } },
    ])
    const first = await fetchWorkflowRun(c, REPO.owner, REPO.name, 9001)
    expect(first).toEqual({
      modified: true,
      etag: 'W/"r1"',
      value: {
        id: 9001,
        attempt: 2,
        title: 'hinomi fix 0c1d',
        status: 'in_progress',
        conclusion: null,
        createdAt: '2026-11-07T10:00:00Z',
        updatedAt: '2026-11-07T10:01:00Z',
      },
    })
    expect(requests[0]).toMatchObject({
      url: `${BASE}/repos/kestrel-co/harbor/actions/runs/9001`,
      ifNoneMatch: null,
    })
    const second = await fetchWorkflowRun(c, REPO.owner, REPO.name, 9001, 'W/"r1"')
    expect(second).toEqual({ modified: false, etag: 'W/"r1"' })
    expect(requests[1]?.ifNoneMatch).toBe('W/"r1"')
  })

  it('answers null for a run that is gone', async () => {
    const { client: c } = client([{ status: 404, body: { message: 'Not Found' } }])
    expect(await fetchWorkflowRun(c, REPO.owner, REPO.name, 9001, 'W/"r1"')).toBeNull()
  })

  it('lists workflow_dispatch runs created since a time', async () => {
    const { client: c, requests } = client([{ body: { total_count: 1, workflow_runs: [RUN] } }])
    const runs = await listWorkflowRuns(c, {
      ...REPO,
      workflow: 'hinomi-fix.yml',
      createdSince: new Date('2026-11-07T09:59:00Z'),
    })
    expect(runs.map((r) => r.title)).toEqual(['hinomi fix 0c1d'])
    const url = new URL(requests[0]?.url ?? '')
    expect(url.pathname).toBe('/repos/kestrel-co/harbor/actions/workflows/hinomi-fix.yml/runs')
    expect(url.searchParams.get('event')).toBe('workflow_dispatch')
    expect(url.searchParams.get('created')).toBe('>=2026-11-07T09:59:00.000Z')
  })
})

describe('artifacts', () => {
  it('lists a run artifacts', async () => {
    const { client: c } = client([
      {
        body: {
          artifacts: [
            {
              id: 5,
              name: 'hinomi-fix-0c1d',
              size_in_bytes: 1200,
              expired: false,
              created_at: '2026-11-07T10:04:00Z',
            },
          ],
        },
      },
    ])
    expect(await listRunArtifacts(c, REPO.owner, REPO.name, 9001)).toEqual([
      {
        id: 5,
        name: 'hinomi-fix-0c1d',
        sizeInBytes: 1200,
        expired: false,
        createdAt: '2026-11-07T10:04:00Z',
      },
    ])
  })

  it('follows the redirect to blob storage without the credential', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06])
    const blob: string[] = []
    const { client: c, requests } = client([
      { status: 302, headers: { location: 'https://blob.example.dev/a.zip?sig=x' } },
    ])
    const fetchBlob = (input: string | URL | Request, init?: RequestInit) => {
      blob.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      return Promise.resolve(new Response(zip, { status: 200 }))
    }
    const bytes = await downloadArtifact(
      c,
      { ...REPO, artifactId: 5 },
      { fetch: fetchBlob, maxBytes: 1024 },
    )
    expect([...bytes]).toEqual([...zip])
    expect(requests[0]).toMatchObject({
      url: `${BASE}/repos/kestrel-co/harbor/actions/artifacts/5/zip`,
      redirect: 'manual',
    })
    expect(blob).toEqual(['https://blob.example.dev/a.zip?sig=x'])
  })

  it('refuses an artifact over the cap, an expired one, and a redirect without a location', async () => {
    const big = () => Promise.resolve(new Response(new Uint8Array(2048), { status: 200 }))
    const redirect = { status: 302, headers: { location: 'https://blob.example.dev/a.zip' } }
    await expect(
      downloadArtifact(
        client([redirect]).client,
        { ...REPO, artifactId: 5 },
        {
          fetch: big,
          maxBytes: 1024,
        },
      ),
    ).rejects.toThrow(/larger than 1024 bytes/)
    await expect(
      downloadArtifact(
        client([{ status: 410, body: { message: 'Artifact has expired' } }]).client,
        { ...REPO, artifactId: 5 },
        { maxBytes: 1024 },
      ),
    ).rejects.toMatchObject({ kind: 'not_found', status: 410 })
    await expect(
      downloadArtifact(
        client([{ status: 302 }]).client,
        { ...REPO, artifactId: 5 },
        {
          maxBytes: 1024,
        },
      ),
    ).rejects.toMatchObject({ kind: 'parse' })
    const failing = () => Promise.resolve(new Response('denied', { status: 403 }))
    await expect(
      downloadArtifact(
        client([redirect]).client,
        { ...REPO, artifactId: 5 },
        {
          fetch: failing,
          maxBytes: 1024,
        },
      ),
    ).rejects.toMatchObject({ kind: 'http', status: 403 })
  })
})

describe('branches and pulls', () => {
  it('reads a branch head, null when the branch is missing', async () => {
    const { client: c, requests } = client([
      { body: { name: 'hinomi/fix-plan', commit: { sha: 'c'.repeat(40) } } },
      { status: 404, body: { message: 'Branch not found' } },
    ])
    expect(await fetchBranchHead(c, REPO.owner, REPO.name, 'hinomi/fix-plan')).toBe('c'.repeat(40))
    expect(requests[0]?.url).toBe(`${BASE}/repos/kestrel-co/harbor/branches/hinomi%2Ffix-plan`)
    expect(await fetchBranchHead(c, REPO.owner, REPO.name, 'hinomi/fix-plan')).toBeNull()
  })

  it('reads a merged PR with its merge commit', async () => {
    const { client: c } = client([
      {
        headers: { etag: '"p1"' },
        body: {
          number: 41,
          node_id: 'PR_41',
          html_url: 'https://github.com/kestrel-co/harbor/pull/41',
          state: 'closed',
          draft: false,
          title: 'fix(deps): clear 2 findings in 2 packages',
          body: null,
          merged_at: '2026-11-07T12:00:00Z',
          merge_commit_sha: 'e'.repeat(40),
          closed_at: '2026-11-07T12:00:00Z',
          head: { ref: 'hinomi/fix-plan', sha: 'c'.repeat(40) },
          base: { ref: 'main' },
        },
      },
      { status: 404, body: { message: 'Not Found' } },
    ])
    const read = await fetchPull(c, { ...REPO, number: 41 })
    expect(read).toMatchObject({
      modified: true,
      etag: '"p1"',
      value: { merged: true, mergeSha: 'e'.repeat(40), headSha: 'c'.repeat(40) },
    })
    expect(await fetchPull(c, { ...REPO, number: 41 }, '"p1"')).toBeNull()
  })
})

describe('checks', () => {
  it('summarizes check runs: failing wins, then pending, then passing', () => {
    expect(summarizeCheckRuns([])).toBe('none')
    expect(
      summarizeCheckRuns([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'skipped' },
        { status: 'completed', conclusion: 'neutral' },
      ]),
    ).toBe('passing')
    expect(
      summarizeCheckRuns([
        { status: 'completed', conclusion: 'success' },
        { status: 'in_progress', conclusion: null },
      ]),
    ).toBe('pending')
    expect(summarizeCheckRuns([{ status: 'completed', conclusion: 'stale' }])).toBe('pending')
    for (const conclusion of [
      'failure',
      'timed_out',
      'action_required',
      'startup_failure',
      'cancelled',
    ]) {
      expect(
        summarizeCheckRuns([
          { status: 'queued', conclusion: null },
          { status: 'completed', conclusion },
        ]),
      ).toBe('failing')
    }
  })

  it('summarizes the combined status and combines both', () => {
    expect(summarizeCombinedStatus('pending', 0)).toBe('none')
    expect(summarizeCombinedStatus('pending', 2)).toBe('pending')
    expect(summarizeCombinedStatus('success', 1)).toBe('passing')
    expect(summarizeCombinedStatus('failure', 1)).toBe('failing')
    expect(summarizeCombinedStatus('error', 1)).toBe('failing')
    expect(combineChecks('none', 'none')).toBe('none')
    expect(combineChecks('passing', 'none')).toBe('passing')
    expect(combineChecks('passing', 'pending')).toBe('pending')
    expect(combineChecks('pending', 'failing')).toBe('failing')
  })

  it('reads both sources with their ETags', async () => {
    const sha = 'c'.repeat(40)
    const { client: c, requests } = client([
      {
        headers: { etag: '"cr1"' },
        body: { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'failure' }] },
      },
      { status: 304 },
    ])
    expect(await fetchCheckRunsStatus(c, { ...REPO, sha })).toEqual({
      modified: true,
      etag: '"cr1"',
      value: 'failing',
    })
    expect(await fetchCombinedStatus(c, { ...REPO, sha }, '"st1"')).toEqual({
      modified: false,
      etag: '"st1"',
    })
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      `/repos/kestrel-co/harbor/commits/${sha}/check-runs`,
      `/repos/kestrel-co/harbor/commits/${sha}/status`,
    ])
    expect(requests[1]?.ifNoneMatch).toBe('"st1"')
  })
})
