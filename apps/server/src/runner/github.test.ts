import { repoDetailSchema, runnerStatusSchema } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { createTestApi } from '../api/testing.js'
import { createTestRepositories } from '../db/test-db.js'
import { cachedRunnerGithub, openRunnerGithub } from './github.js'
import { fakeGithub, repoReply } from './testing.js'

// The runner talks to GitHub for a repo through that repo's own source. Two fictional sources:
// kestrel-co (a classic token that may do everything) and kestrel-labs (a token that may not).

const CO_TOKEN = 'ghp_fictionalKestrelCo00000000000000000'
const LABS_TOKEN = 'ghp_fictionalKestrelLabs000000000000000'

function twoSources() {
  const test = createTestRepositories()
  const { repos } = test
  const co = repos.sources.create({ kind: 'github', name: 'kestrel-co', token: CO_TOKEN })
  const labs = repos.sources.create({ kind: 'github', name: 'kestrel-labs', token: LABS_TOKEN })
  const harbor = repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
  const lantern = repos.repos.upsert({ owner: 'kestrel-labs', name: 'lantern' })
  repos.repoSources.setOwner(harbor.id, co.id)
  repos.repoSources.setOwner(lantern.id, labs.id)
  return { ...test, co, labs, harbor, lantern }
}

async function tokenOf(github: ReturnType<typeof openRunnerGithub>): Promise<string | null> {
  return github.ok ? github.source.getToken() : null
}

describe('openRunnerGithub', () => {
  it("opens the repo's own source", async () => {
    const { repos, harbor, lantern, handle } = twoSources()
    expect(await tokenOf(openRunnerGithub(repos, harbor.id))).toBe(CO_TOKEN)
    expect(await tokenOf(openRunnerGithub(repos, lantern.id))).toBe(LABS_TOKEN)
    handle.close()
  })

  it('opens a source picked by hand, and the scan choice again once it is switched off', async () => {
    const { repos, harbor, labs, handle } = twoSources()
    repos.repoSources.setOverride(harbor.id, labs.id)
    expect(await tokenOf(openRunnerGithub(repos, harbor.id))).toBe(LABS_TOKEN)
    repos.sources.update(labs.id, { enabled: false })
    // A switched off override does not apply: the scan's choice does.
    expect(await tokenOf(openRunnerGithub(repos, harbor.id))).toBe(CO_TOKEN)
    handle.close()
  })

  it('uses the only source for a repo no scan has placed yet, and none when there are several', async () => {
    const { repos, co, labs, handle } = twoSources()
    const fresh = repos.repos.upsert({ owner: 'kestrel-co', name: 'fresh' })
    expect(openRunnerGithub(repos, fresh.id).ok).toBe(false)
    repos.sources.remove(labs.id)
    expect(repos.sources.get(co.id)).toBeDefined()
    expect(await tokenOf(openRunnerGithub(repos, fresh.id))).toBe(CO_TOKEN)
    repos.sources.remove(co.id)
    expect(openRunnerGithub(repos, fresh.id)).toEqual({
      ok: false,
      message: 'Connect a GitHub source first.',
    })
    handle.close()
  })
})

describe('cachedRunnerGithub', () => {
  it('keeps one opened source per GitHub source, and opens it again after a change', () => {
    const { repos, co, harbor, lantern, handle } = twoSources()
    const other = repos.repos.upsert({ owner: 'kestrel-co', name: 'dock' })
    repos.repoSources.setOwner(other.id, co.id)
    const github = cachedRunnerGithub(repos)
    const first = github(harbor.id)
    expect(github(other.id)).toBe(first)
    expect(github(lantern.id)).not.toBe(first)
    repos.sources.setToken(co.id, 'ghp_fictionalRotated000000000000000000')
    expect(github(harbor.id)).not.toBe(first)
    handle.close()
  })
})

describe("runner status through the repo's source", () => {
  it('checks the permissions of each repo with its own credential', async () => {
    const scopes: Record<string, string> = {
      [`Bearer ${CO_TOKEN}`]: 'repo, workflow',
      [`token ${CO_TOKEN}`]: 'repo, workflow',
      [`Bearer ${LABS_TOKEN}`]: 'read:user',
      [`token ${LABS_TOKEN}`]: 'read:user',
    }
    const gh = fakeGithub([
      { path: '/repos/kestrel-co/harbor', reply: repoReply('kestrel-co', 'harbor', 'private') },
      {
        path: '/repos/kestrel-labs/lantern',
        reply: repoReply('kestrel-labs', 'lantern', 'private'),
      },
      {
        path: '/user',
        reply: (r) => ({
          body: { login: 'kestrel-bot' },
          headers: { 'x-oauth-scopes': scopes[r.authorization ?? ''] ?? '' },
        }),
      },
    ])
    const api = createTestApi({ sourceFetch: gh.fetch })
    const co = api.repos.sources.create({ kind: 'github', name: 'kestrel-co', token: CO_TOKEN })
    const labs = api.repos.sources.create({
      kind: 'github',
      name: 'kestrel-labs',
      token: LABS_TOKEN,
    })
    const harbor = api.repos.repos.upsert({ owner: 'kestrel-co', name: 'harbor' })
    const lantern = api.repos.repos.upsert({ owner: 'kestrel-labs', name: 'lantern' })
    api.repos.repoSources.setOwner(harbor.id, co.id)
    api.repos.repoSources.setOwner(lantern.id, labs.id)

    const status = async (id: number) =>
      runnerStatusSchema.parse((await api.call('GET', `/repos/${id}/runner`)).json)
    const harborStatus = await status(harbor.id)
    const kestrel = () => gh.requests.filter((r) => r.path.startsWith('/repos/kestrel'))
    const harborAuth = new Set(kestrel().map((r) => r.authorization))
    gh.requests.length = 0
    const lanternStatus = await status(lantern.id)
    const lanternAuth = new Set(kestrel().map((r) => r.authorization))

    expect(harborStatus.permissions.ok).toBe(true)
    expect(lanternStatus.permissions.ok).toBe(false)
    expect([...harborAuth]).toEqual([`Bearer ${CO_TOKEN}`])
    expect([...lanternAuth]).toEqual([`Bearer ${LABS_TOKEN}`])

    const detail = repoDetailSchema.parse((await api.call('GET', `/repos/${lantern.id}`)).json)
    expect(detail.source.current).toMatchObject({ id: labs.id, name: 'kestrel-labs' })
    api.handle.close()
  })
})
