import { describe, expect, it } from 'vitest'
import { parseLockfile, parseRequirementsTxtDetailed } from './index.js'

const FILE = `# kestrel-api runtime pins
--index-url https://pypi.example.dev/simple
-r base.txt
-c constraints.txt
-e ./libs/tern-core
-e git+https://git.example.dev/kestrel-co/plover.git#egg=plover
Kestrel_HTTP==2.1.0  # inline comment
tern.client[socks,tls]===3.4.1 ; python_version >= "3.9"
plover==1.2.0 \\
    --hash=sha256:aaaa \\
    --hash=sha256:bbbb
gannet>=1.0
heron~=2.3
rail==1.*
bare-name
edge-agent @ https://files.example.dev/edge_agent-1.0.tar.gz
./local/pkg
pinned-twice==1.0
Pinned_Twice==1.0
`

describe('parseRequirementsTxtDetailed', () => {
  const result = parseRequirementsTxtDetailed(FILE)

  it('keeps exact pins with normalised names and drops extras, markers and hashes', () => {
    expect(result.dependencies.map((d) => `${d.name}@${d.version}`)).toEqual([
      'kestrel-http@2.1.0',
      'pinned-twice@1.0',
      'plover@1.2.0',
      'tern-client@3.4.1',
    ])
    for (const d of result.dependencies) {
      expect(d).toMatchObject({ ecosystem: 'PyPI', scope: 'runtime', direct: true })
      expect(d.path).toBeUndefined()
    }
  })

  it('counts what it could not check by reason', () => {
    expect(result.notChecked).toEqual({ unpinned: 4, includes: 2, direct: 4 })
  })

  it('reads dev scope from the file name', () => {
    const dev = parseRequirementsTxtDetailed('pytest==8.0.0\n', {
      filename: 'requirements-dev.txt',
    })
    expect(dev.dependencies[0]?.scope).toBe('dev')
    const test = parseRequirementsTxtDetailed('pytest==8.0.0\n', { filename: 'a/test-reqs.txt' })
    expect(test.dependencies[0]?.scope).toBe('dev')
  })

  it('tolerates empty input, CRLF and a trailing continuation', () => {
    expect(parseRequirementsTxtDetailed('').dependencies).toEqual([])
    const crlf = parseRequirementsTxtDetailed('a-pkg==1.0\r\nb-pkg==2.0 \\\r\n')
    expect(crlf.dependencies.map((d) => d.name)).toEqual(['a-pkg', 'b-pkg'])
  })

  it('is wired into parseLockfile', () => {
    const deps = parseLockfile('pytest==8.0.0\n', 'services/api/requirements.txt')
    expect(deps).toMatchObject([{ name: 'pytest', version: '8.0.0', scope: 'runtime' }])
  })

  it('treats hostile names as plain data and never touches Object.prototype', () => {
    const text = '__proto__==1.0\nconstructor==2.0\nprototype==3.0\ntoString[__proto__]==4.0\n'
    const { dependencies } = parseRequirementsTxtDetailed(text)
    expect(dependencies.map((d) => d.name).sort()).toEqual(['constructor', 'prototype', 'tostring'])
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(({} as Record<string, unknown>).version).toBeUndefined()
    expect(({} as Record<string, unknown>).name).toBeUndefined()
  })
})
