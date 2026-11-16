import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceIsPypi } from './appliers/uv.js'
import { readUvProject } from './appliers/uv-project.js'
import { nodeRepoFs } from './repo-fs.js'

const STATIC = '[project]\nname = "kestrel-api"\nversion = "0.1.0"\n'
const member = (name: string, extra = '') =>
  `[project]\nname = "${name}"\nversion = "1.0.0"\n${extra}`

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'hinomi-uv-project-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return nodeRepoFs(root)
}

async function problemOf(files: Record<string, string>, root = '.') {
  const project = await readUvProject(repo(files), root)
  return project.ok ? null : project.problem
}

describe('readUvProject: whether uv lock would run project code', () => {
  it('reads a static root, its workspace members and its path sources', async () => {
    const project = await readUvProject(
      repo({
        'pyproject.toml': `${STATIC}dynamic = []\n[tool.uv.workspace]\nmembers = ["packages/*"]\nexclude = ["packages/old"]\n[tool.uv.sources]\nheron = { path = "vendor/heron" }\nwren = { path = "wheels/wren-1.0-py3-none-any.whl" }\n`,
        'packages/a/pyproject.toml': member(
          'a',
          '[tool.uv.sources]\nb = { path = "../../libs/b", editable = true }\n',
        ),
        'packages/old/pyproject.toml': '[project]\nname = "old"\ndynamic = ["version"]\n',
        'packages/notes/README.md': 'no project here',
        'libs/b/pyproject.toml': member('b'),
        'vendor/heron/pyproject.toml': member('heron'),
      }),
      '.',
    )
    expect(project.ok && project.files.map((f) => f.path).sort()).toEqual([
      'libs/b/pyproject.toml',
      'packages/a/pyproject.toml',
      'pyproject.toml',
      'vendor/heron/pyproject.toml',
    ])
  })

  it('takes a virtual workspace root without a [project] table', async () => {
    expect(
      await problemOf({
        'pyproject.toml': '[tool.uv.workspace]\nmembers = ["app"]\n',
        'app/pyproject.toml': member('app'),
      }),
    ).toBeNull()
  })

  it.each([
    [
      'a dynamic root',
      { 'pyproject.toml': '[project]\nname = "v"\ndynamic = ["version"]\n' },
      'dynamic metadata',
    ],
    [
      'a multi line dynamic list',
      { 'pyproject.toml': `${STATIC}dynamic = [\n  "dependencies",\n]\n` },
      'dynamic metadata',
    ],
    [
      'a root without a version',
      { 'pyproject.toml': '[project]\nname = "v"\n' },
      'no static project version',
    ],
    [
      'a root without a name',
      { 'pyproject.toml': '[project]\nversion = "1"\n' },
      'no static project name',
    ],
    [
      'an empty [project] table',
      { 'pyproject.toml': '[project]\n[tool.uv]\nno-index = true\n' },
      'no static project name',
    ],
    [
      'a dynamic workspace member',
      {
        'pyproject.toml': `${STATIC}[tool.uv.workspace]\nmembers = ["packages/*"]\n`,
        'packages/a/pyproject.toml': '[project]\nname = "a"\ndynamic = ["version"]\n',
      },
      'packages/a/pyproject.toml declares dynamic metadata',
    ],
    [
      'a member without a [project] table',
      {
        'pyproject.toml': `${STATIC}[tool.uv.workspace]\nmembers = ["a"]\n`,
        'a/pyproject.toml': '[build-system]\nrequires = []\n',
      },
      'no [project] table',
    ],
    [
      'a dynamic path source',
      {
        'pyproject.toml': `${STATIC}[tool.uv.sources]\nheron = { path = "vendor/heron", editable = true }\n`,
        'vendor/heron/pyproject.toml': '[project]\nname = "heron"\ndynamic = ["version"]\n',
      },
      'vendor/heron/pyproject.toml declares dynamic metadata',
    ],
    [
      'a dynamic path source of a member, in a [tool.uv.sources.<name>] table',
      {
        'pyproject.toml': `${STATIC}[tool.uv.workspace]\nmembers = ["a"]\n`,
        'a/pyproject.toml': member('a', '[tool.uv.sources.b]\npath = "../b"\n'),
        'b/pyproject.toml': '[project]\nname = "b"\nversion = "1"\ndynamic = ["readme"]\n',
      },
      'b/pyproject.toml declares dynamic metadata',
    ],
    [
      'a path source with only a setup.py',
      {
        'pyproject.toml': `${STATIC}[tool.uv.sources]\nheron = { path = "heron" }\n`,
        'heron/setup.py': 'raise SystemExit',
      },
      'heron has no pyproject.toml',
    ],
    [
      'a path source outside the repo',
      { 'pyproject.toml': `${STATIC}[tool.uv.sources]\nheron = { path = "../heron" }\n` },
      'outside the repo',
    ],
    [
      'a source archive',
      {
        'pyproject.toml': `${STATIC}[tool.uv.sources]\nheron = { path = "dist/heron-1.0.tar.gz" }\n`,
      },
      'source archive',
    ],
    [
      'a git source',
      {
        'pyproject.toml': `${STATIC}[tool.uv.sources]\nheron = { git = "https://example.dev/heron.git" }\n`,
      },
      'git or URL source',
    ],
    [
      'a URL source',
      {
        'pyproject.toml': `${STATIC}[tool.uv.sources.heron]\nurl = "https://example.dev/heron.tar.gz"\n`,
      },
      'git or URL source',
    ],
    [
      'a direct URL dependency',
      {
        'pyproject.toml': `${STATIC}dependencies = ["heron @ https://example.dev/heron.tar.gz"]\n`,
      },
      'direct URL',
    ],
    [
      'a direct URL override',
      {
        'pyproject.toml': `${STATIC}[tool.uv]\noverride-dependencies = ["plover-sig @ git+https://example.dev/p.git"]\n`,
      },
      'direct URL',
    ],
    [
      'a direct URL in a dependency group of a member',
      {
        'pyproject.toml': `${STATIC}[tool.uv.workspace]\nmembers = ["a"]\n`,
        'a/pyproject.toml': member(
          'a',
          '[dependency-groups]\ndev = ["wren[cli] @ file:///tmp/wren"]\n',
        ),
      },
      'direct URL',
    ],
    [
      'a recursive member glob',
      { 'pyproject.toml': `${STATIC}[tool.uv.workspace]\nmembers = ["packages/**"]\n` },
      'does not expand',
    ],
  ])('refuses %s', async (_label, files: Record<string, string>, problem: string) => {
    expect(await problemOf(files)).toContain(problem)
  })

  it('reads a project in a sub folder from there', async () => {
    expect(
      await problemOf(
        {
          'py/pyproject.toml': `${STATIC}[tool.uv.sources]\nheron = { path = "../vendor/heron" }\n`,
          'vendor/heron/pyproject.toml': '[project]\nname = "heron"\ndynamic = ["version"]\n',
        },
        'py',
      ),
    ).toContain('vendor/heron/pyproject.toml')
  })
})

describe('sourceIsPypi across the workspace', () => {
  const workspace = (memberExtra: string) =>
    repo({
      'pyproject.toml': `${STATIC}[tool.uv.workspace]\nmembers = ["a"]\n`,
      'a/pyproject.toml': member('a', memberExtra),
    })

  it('trusts PyPI when no file of the workspace says otherwise', async () => {
    expect(
      await sourceIsPypi(workspace('dependencies = ["plover-sig>=1"]\n'), '.', 'plover-sig'),
    ).toBe(true)
  })

  it.each([
    ['a member source for the package', '[tool.uv.sources]\nPlover_Sig = { index = "mirror" }\n'],
    [
      'a member index other than PyPI',
      '[[tool.uv.index]]\nname = "m"\nurl = "https://mirror.example.dev/simple"\n',
    ],
    [
      'a direct URL override',
      '[tool.uv]\nconstraint-dependencies = ["plover-sig @ https://example.dev/p.whl"]\n',
    ],
    ['a dynamic member', 'dynamic = ["dependencies"]\n'],
  ])('trusts no PyPI publish time with %s', async (_label, extra) => {
    expect(await sourceIsPypi(workspace(extra), '.', 'plover-sig')).toBe(false)
  })
})
