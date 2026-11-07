import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseHandle } from '../db/client.js'
import { createTestRepositories } from '../db/test-db.js'
import type { Repositories } from '../repository/index.js'
import { fetchPinFiles } from './fetch.js'
import { scanRuntimePins } from './scan.js'

const API = 'https://api.github.com/repos/kestrel-co/site/contents'

type Entry = { name: string; path: string; type: 'file' | 'dir' }
const file = (path: string): Entry => ({ name: path.split('/').pop()!, path, type: 'file' })
const dir = (path: string): Entry => ({ name: path.split('/').pop()!, path, type: 'dir' })

const TREE: Record<string, Entry[]> = {
  '': [
    file('README.md'),
    file('.nvmrc'),
    file('pnpm-lock.yaml'),
    dir('.github'),
    dir('apps'),
    dir('docs'),
  ],
  '.github/workflows': [file('.github/workflows/ci.yml'), file('.github/workflows/notes.md')],
  apps: [dir('apps/api')],
  'apps/api': [file('apps/api/Dockerfile'), file('apps/api/Cargo.toml'), file('apps/api/main.rs')],
}

const FILES: Record<string, string> = {
  '.nvmrc': '22\n',
  '.github/workflows/ci.yml':
    'jobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version-file: .nvmrc\n',
  'apps/api/Dockerfile': 'FROM node:24-alpine\n',
  'apps/api/Cargo.toml': '[package]\nrust-version = "1.74"\n',
}

function mockGitHub(paths: string[]): typeof fetch {
  return (input, init) => {
    const url = input as string
    const path = decodeURIComponent(url.slice(API.length + 1).split('?')[0]!)
    paths.push(path)
    const raw = new Headers(init?.headers).get('accept') === 'application/vnd.github.raw+json'
    if (raw) {
      const text = FILES[path]
      return Promise.resolve(text ? new Response(text) : new Response('', { status: 404 }))
    }
    const listing = TREE[path]
    return Promise.resolve(
      listing ? Response.json(listing) : Response.json({ message: 'Not Found' }, { status: 404 }),
    )
  }
}

describe('fetchPinFiles', () => {
  it('asks the contents walk for pin files only, plus the workflows folder', async () => {
    const paths: string[] = []
    const files = await fetchPinFiles('kestrel-co', 'site', 'main', 'tok', {
      fetch: mockGitHub(paths),
    })
    expect(files.map((f) => f.path).sort()).toEqual([
      '.github/workflows/ci.yml',
      '.nvmrc',
      'apps/api/Cargo.toml',
      'apps/api/Dockerfile',
    ])
    // Nothing else is downloaded: no README, lockfile, source file or markdown note.
    expect(paths.filter((p) => FILES[p] !== undefined && !files.some((f) => f.path === p))).toEqual(
      [],
    )
    expect(paths).not.toContain('README.md')
    expect(paths).not.toContain('pnpm-lock.yaml')
  })

  it('skips the workflows listing when the repo has no .github folder', async () => {
    const paths: string[] = []
    const noGithub: Record<string, Entry[]> = {
      ...TREE,
      '': TREE['']!.filter((e) => e.path !== '.github'),
    }
    const fetchMock: typeof fetch = (input, init) => {
      const url = input as string
      const path = decodeURIComponent(url.slice(API.length + 1).split('?')[0]!)
      paths.push(path)
      const listing = noGithub[path]
      return Promise.resolve(
        new Headers(init?.headers).get('accept') === 'application/vnd.github.raw+json'
          ? new Response('', { status: 404 })
          : listing
            ? Response.json(listing)
            : Response.json({}, { status: 404 }),
      )
    }
    await fetchPinFiles('kestrel-co', 'site', 'main', null, { fetch: fetchMock })
    expect(paths).not.toContain('.github/workflows')
  })
})

describe('scanRuntimePins', () => {
  let repos: Repositories
  let handle: DatabaseHandle
  beforeEach(() => {
    const test = createTestRepositories()
    repos = test.repos
    handle = test.handle
  })
  afterEach(() => handle.close())

  it('stores the pins of a ref and replaces them on the next scan', async () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'site', defaultBranch: 'main' })
    const now = new Date('2026-11-08T10:00:00Z')
    const pins = await scanRuntimePins(repos.runtimePins, {
      repoId: repo.id,
      owner: 'kestrel-co',
      name: 'site',
      ref: 'main',
      token: 'tok',
      fetch: mockGitHub([]),
      productionDockerfiles: new Set(['apps/api/Dockerfile']),
      now,
    })
    expect(pins).toHaveLength(4)
    const stored = repos.runtimePins.list(repo.id, 'main')
    expect(stored.map((p) => [p.path, p.source, p.kind, p.scope])).toEqual([
      ['.github/workflows/ci.yml', 'setup_node', 'exact', 'ci'],
      ['.nvmrc', 'nvmrc', 'exact', 'dev'],
      ['apps/api/Cargo.toml', 'cargo_rust_version', 'minimum', 'dev'],
      ['apps/api/Dockerfile', 'dockerfile', 'exact', 'production'],
    ])
    expect(stored[3]).toMatchObject({
      repoId: repo.id,
      ref: 'main',
      runtime: 'node',
      line: 1,
      raw: 'node:24-alpine',
      lineName: '24',
      floating: false,
      finalStage: true,
      stage: 0,
      job: null,
      scannedAt: now,
    })
    expect(stored[0]).toMatchObject({ job: 't', finalStage: null, stage: null })

    repos.runtimePins.replace(repo.id, 'v1.0.0', pins.slice(0, 1), now)
    repos.runtimePins.replace(repo.id, 'main', [], now)
    expect(repos.runtimePins.list(repo.id, 'main')).toEqual([])
    expect(repos.runtimePins.list(repo.id)).toHaveLength(1)
  })

  it('keeps the last good pins when GitHub fails', async () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'site', defaultBranch: 'main' })
    const now = new Date('2026-11-08T10:00:00Z')
    repos.runtimePins.replace(repo.id, 'main', [], now)
    await scanRuntimePins(repos.runtimePins, {
      repoId: repo.id,
      owner: 'kestrel-co',
      name: 'site',
      ref: 'main',
      token: null,
      fetch: mockGitHub([]),
      now,
    })
    const before = repos.runtimePins.list(repo.id, 'main').length
    await expect(
      scanRuntimePins(repos.runtimePins, {
        repoId: repo.id,
        owner: 'kestrel-co',
        name: 'site',
        ref: 'main',
        token: null,
        fetch: () => Promise.resolve(new Response('', { status: 500 })),
        now,
      }),
    ).rejects.toThrow()
    expect(repos.runtimePins.list(repo.id, 'main')).toHaveLength(before)
  })

  it('drops the pins with the repo', async () => {
    const repo = repos.repos.upsert({ owner: 'kestrel-co', name: 'site', defaultBranch: 'main' })
    const now = new Date('2026-11-08T10:00:00Z')
    await scanRuntimePins(repos.runtimePins, {
      repoId: repo.id,
      owner: 'kestrel-co',
      name: 'site',
      ref: 'main',
      token: null,
      fetch: mockGitHub([]),
      now,
    })
    handle.sqlite.prepare('delete from repos where id = ?').run(repo.id)
    expect(repos.runtimePins.list(repo.id)).toEqual([])
  })
})
