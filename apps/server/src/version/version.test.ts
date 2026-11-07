import { versionResponseSchema } from '@hinomi/shared'
import { describe, expect, it, vi } from 'vitest'
import { createTestApi } from '../api/testing.js'
import { createApp } from '../app.js'
import { createTestRepositories } from '../db/test-db.js'
import {
  createUpdateChecker,
  describeBuild,
  readBuildInfo,
  UPDATE_CHECK_KEY,
  type BuildInfo,
} from './index.js'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

describe('readBuildInfo', () => {
  it('reads the build args', () => {
    expect(
      readBuildInfo({
        HINOMI_BUILD_VERSION: 'v0.3.0',
        HINOMI_BUILD_COMMIT: SHA,
        HINOMI_BUILD_DATE: '2026-11-07T10:00:00Z',
      }),
    ).toEqual({ version: '0.3.0', commit: SHA, buildDate: '2026-11-07T10:00:00.000Z' })
  })

  it('says dev for a build without args or with a malformed one', () => {
    const dev = { version: 'dev', commit: null, buildDate: null }
    expect(readBuildInfo({})).toEqual(dev)
    expect(
      readBuildInfo({
        HINOMI_BUILD_VERSION: 'dev',
        HINOMI_BUILD_COMMIT: 'not a sha',
        HINOMI_BUILD_DATE: 'yesterday',
      }),
    ).toEqual(dev)
  })

  it('keeps the sha of a dev build', () => {
    expect(readBuildInfo({ HINOMI_BUILD_COMMIT: SHA })).toMatchObject({
      version: 'dev',
      commit: SHA,
    })
  })
})

describe('GET /api/version', () => {
  it('describes a release build', async () => {
    const build: BuildInfo = {
      version: '0.3.0',
      commit: SHA,
      buildDate: '2026-11-07T10:00:00.000Z',
    }
    const res = await createApp({ build }).request('/api/version')
    expect(res.status).toBe(200)
    expect(versionResponseSchema.parse(await res.json())).toEqual({
      version: '0.3.0',
      commit: SHA,
      buildDate: '2026-11-07T10:00:00.000Z',
      isDev: false,
      prerelease: false,
      imageTag: 'ghcr.io/shironex/hinomi:0.3.0',
      releaseNotesUrl: 'https://github.com/Shironex/hinomi/releases/tag/v0.3.0',
      update: null,
    })
    const health = await createApp({ build }).request('/api/health')
    expect(await health.json()).toEqual({ status: 'ok', version: '0.3.0' })
  })

  it('describes a build without args as dev, with no image tag or notes link', async () => {
    const res = await createApp().request('/api/version')
    expect(await res.json()).toEqual({
      version: 'dev',
      commit: null,
      buildDate: null,
      isDev: true,
      prerelease: false,
      imageTag: null,
      releaseNotesUrl: null,
      update: null,
    })
  })

  it('marks a pre-release build', () => {
    expect(describeBuild({ version: '0.4.0-rc.1', commit: null, buildDate: null }).prerelease).toBe(
      true,
    )
  })

  it('reports the update the checker found', async () => {
    const update = {
      version: '0.3.1',
      url: 'https://github.com/Shironex/hinomi/releases/tag/v0.3.1',
      imageTag: 'ghcr.io/shironex/hinomi:0.3.1',
    }
    const app = createApp({
      build: { version: '0.3.0', commit: null, buildDate: null },
      updates: { available: () => update, check: () => Promise.resolve() },
    })
    expect(
      ((await (await app.request('/api/version')).json()) as { update: unknown }).update,
    ).toEqual(update)
  })
})

function release(tag: string, over: { prerelease?: boolean; draft?: boolean } = {}) {
  return { tag_name: tag, prerelease: false, draft: false, ...over }
}

function setup(
  version: string,
  answer: () => Response | Promise<Response>,
  settingsValue?: boolean,
) {
  const { repos } = createTestRepositories()
  if (settingsValue !== undefined) repos.settings.set(UPDATE_CHECK_KEY, settingsValue)
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    void url
    void init
    return Promise.resolve(answer())
  })
  const checker = createUpdateChecker({
    settings: repos.settings,
    build: { version, commit: null, buildDate: null },
    fetch: fetchMock as typeof fetch,
  })
  return { checker, fetchMock, repos }
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers })

describe('update check', () => {
  it('finds a newer release', async () => {
    const { checker, fetchMock } = setup('0.3.0', () => json(release('v0.3.1')))
    await checker.check()
    expect(checker.available()).toEqual({
      version: '0.3.1',
      url: 'https://github.com/Shironex/hinomi/releases/tag/v0.3.1',
      imageTag: 'ghcr.io/shironex/hinomi:0.3.1',
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/Shironex/hinomi/releases/latest')
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
    expect(Object.keys(headers).sort()).toEqual(['accept', 'user-agent', 'x-github-api-version'])
  })

  it('reports nothing for the same release', async () => {
    const { checker } = setup('0.3.0', () => json(release('v0.3.0')))
    await checker.check()
    expect(checker.available()).toBeNull()
  })

  it('reports nothing when the latest release is older', async () => {
    const { checker } = setup('0.3.0', () => json(release('v0.2.9')))
    await checker.check()
    expect(checker.available()).toBeNull()
  })

  it('ignores a pre-release for a final build', async () => {
    const { checker } = setup('0.3.0', () => json(release('v0.4.0-rc.1', { prerelease: true })))
    await checker.check()
    expect(checker.available()).toBeNull()
    const tagOnly = setup('0.3.0', () => json(release('v0.4.0-rc.1')))
    await tagOnly.checker.check()
    expect(tagOnly.checker.available()).toBeNull()
  })

  it('lets a pre-release build see the newest pre-release or final release', async () => {
    const { checker, fetchMock } = setup('0.4.0-rc.1', () =>
      json([
        release('v0.4.0-rc.3', { prerelease: true }),
        release('v0.4.0-rc.2', { prerelease: true }),
        release('v0.5.0', { draft: true }),
        release('v0.3.0'),
      ]),
    )
    await checker.check()
    expect(checker.available()?.version).toBe('0.4.0-rc.3')
    expect(fetchMock.mock.calls[0]![0]).toContain('/releases?per_page=')
  })

  it('stays quiet when offline or when GitHub answers badly', async () => {
    const offline = setup('0.3.0', () => {
      throw new Error('fetch failed')
    })
    await expect(offline.checker.check()).resolves.toBeUndefined()
    expect(offline.checker.available()).toBeNull()

    const limited = setup('0.3.0', () => new Response('rate limited', { status: 403 }))
    await expect(limited.checker.check()).resolves.toBeUndefined()
    expect(limited.checker.available()).toBeNull()

    const garbage = setup('0.3.0', () => json({ unexpected: true }))
    await expect(garbage.checker.check()).resolves.toBeUndefined()
    expect(garbage.checker.available()).toBeNull()
  })

  it('keeps the last result when a later check fails', async () => {
    let fail = false
    const { checker } = setup('0.3.0', () => {
      if (fail) throw new Error('fetch failed')
      return json(release('v0.3.1'))
    })
    await checker.check()
    fail = true
    await checker.check()
    expect(checker.available()?.version).toBe('0.3.1')
  })

  it('sends the ETag back and keeps the result on a 304', async () => {
    let calls = 0
    const { checker, fetchMock } = setup('0.3.0', () =>
      ++calls === 1
        ? json(release('v0.3.1'), { etag: 'W/"abc"' })
        : new Response(null, { status: 304 }),
    )
    await checker.check()
    await checker.check()
    const second = fetchMock.mock.calls[1]![1]?.headers as Record<string, string>
    expect(second['if-none-match']).toBe('W/"abc"')
    expect(checker.available()?.version).toBe('0.3.1')
  })

  it('makes no request while the switch is off, and hides a result found before', async () => {
    const off = setup('0.3.0', () => json(release('v0.3.1')), false)
    await off.checker.check()
    expect(off.fetchMock).not.toHaveBeenCalled()
    expect(off.checker.available()).toBeNull()

    const { checker, repos } = setup('0.3.0', () => json(release('v0.3.1')))
    await checker.check()
    expect(checker.available()).not.toBeNull()
    repos.settings.set(UPDATE_CHECK_KEY, false)
    expect(checker.available()).toBeNull()
  })

  it('makes no request for a dev build', async () => {
    const { checker, fetchMock } = setup('dev', () => json(release('v9.9.9')))
    await checker.check()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(checker.available()).toBeNull()
  })

  it('checks after a delay, then daily, and stops on stop()', async () => {
    const { repos } = createTestRepositories()
    const timers: { fn: () => void; ms: number }[] = []
    const fetchMock = vi.fn(() => Promise.resolve(json(release('v0.3.0'))))
    const checker = createUpdateChecker({
      settings: repos.settings,
      build: { version: '0.3.0', commit: null, buildDate: null },
      fetch: fetchMock,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
    })
    checker.start()
    expect(timers.map((t) => t.ms)).toEqual([60_000])
    timers[0]!.fn()
    await vi.waitFor(() => expect(timers).toHaveLength(2))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(timers[1]!.ms).toBe(24 * 60 * 60 * 1000)
    checker.stop()
  })
})

describe('PATCH /api/settings and the update check', () => {
  it('stores the switch and checks at once when it is turned on', async () => {
    const check = vi.fn(() => Promise.resolve())
    const api = createTestApi({ updates: { check } })
    const off = await api.call('PATCH', '/settings', { updateCheckEnabled: false })
    expect((off.json as { updateCheckEnabled: boolean }).updateCheckEnabled).toBe(false)
    expect(check).not.toHaveBeenCalled()
    const on = await api.call('PATCH', '/settings', { updateCheckEnabled: true })
    expect((on.json as { updateCheckEnabled: boolean }).updateCheckEnabled).toBe(true)
    expect(check).toHaveBeenCalledTimes(1)
  })
})
