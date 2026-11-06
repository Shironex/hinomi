import { describe, expect, it } from 'vitest'
import { fetchLockfiles, GitHubContentsError } from './github.js'

const API = 'https://api.github.com/repos/kestrel-co/site/contents'

type Entry = { name: string; path: string; type: 'file' | 'dir' }
const file = (path: string): Entry => ({ name: path.split('/').pop()!, path, type: 'file' })
const dir = (path: string): Entry => ({ name: path.split('/').pop()!, path, type: 'dir' })

const TREE: Record<string, Entry[]> = {
  '': [file('README.md'), file('pnpm-lock.yaml'), dir('apps'), dir('docs')],
  apps: [dir('apps/web'), dir('apps/api'), file('apps/README.md')],
  'apps/web': [file('apps/web/yarn.lock'), file('apps/web/package.json')],
  'apps/api': [file('apps/api/Cargo.lock'), file('apps/api/Cargo.toml')],
}

const FILES: Record<string, string> = {
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'apps/web/yarn.lock': '# yarn lockfile v1\n',
  'apps/web/package.json': '{"name":"web"}',
  'apps/api/Cargo.lock': 'version = 4\n',
}

function mockGitHub(requests: { url: string; headers: Headers }[]): typeof fetch {
  return (input, init) => {
    const url = input as string
    const headers = new Headers(init?.headers)
    requests.push({ url, headers })
    const path = decodeURIComponent(url.slice(API.length + 1).split('?')[0]!)
    if (headers.get('accept') === 'application/vnd.github.raw+json') {
      const text = FILES[path]
      return Promise.resolve(text ? new Response(text) : new Response('', { status: 404 }))
    }
    const listing = TREE[path]
    return Promise.resolve(
      listing ? Response.json(listing) : Response.json({ message: 'Not Found' }, { status: 404 }),
    )
  }
}

describe('fetchLockfiles', () => {
  it('finds lockfiles at the root and one level inside apps and packages', async () => {
    const requests: { url: string; headers: Headers }[] = []
    const files = await fetchLockfiles('kestrel-co', 'site', 'main', 'test-token', {
      fetch: mockGitHub(requests),
    })
    expect(files).toEqual([
      { path: 'pnpm-lock.yaml', text: "lockfileVersion: '9.0'\n" },
      {
        path: 'apps/web/yarn.lock',
        text: '# yarn lockfile v1\n',
        packageJson: '{"name":"web"}',
      },
      { path: 'apps/api/Cargo.lock', text: 'version = 4\n' },
    ])
    expect(requests.every((r) => r.url.endsWith('?ref=main'))).toBe(true)
    expect(requests.every((r) => r.headers.get('authorization') === 'Bearer test-token')).toBe(true)
    // docs/ is not a monorepo folder and is never listed.
    expect(requests.some((r) => r.url.includes('/contents/docs'))).toBe(false)
  })

  it('works without a token for public repos', async () => {
    const requests: { url: string; headers: Headers }[] = []
    await fetchLockfiles('kestrel-co', 'site', 'release/v2', null, { fetch: mockGitHub(requests) })
    expect(requests.some((r) => r.headers.has('authorization'))).toBe(false)
    expect(requests[0]?.url).toBe(`${API}/?ref=release%2Fv2`)
  })

  it('returns nothing for an empty or missing repo', async () => {
    const files = await fetchLockfiles('kestrel-co', 'nope', 'main', null, {
      fetch: () => Promise.resolve(new Response('', { status: 404 })),
    })
    expect(files).toEqual([])
  })

  it('throws on auth or rate limit errors instead of reporting no lockfiles', async () => {
    await expect(
      fetchLockfiles('kestrel-co', 'site', 'main', 'bad', {
        fetch: () => Promise.resolve(new Response('', { status: 403 })),
      }),
    ).rejects.toBeInstanceOf(GitHubContentsError)
  })
})
