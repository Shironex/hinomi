import { FIX_WORKFLOW, renderCallerWorkflow } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createGithubClient } from '../sources/github/index.js'
import { inspectCallerWorkflow, readCaller } from './caller.js'
import { fakeGithub, fileReply } from './testing.js'

// Caller detection on fictional repos.

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const LATEST = { sha: NEW, version: 'v0.2.0' }
const PATH = '/repos/kestrel-co/harbor/contents/.github/workflows/hinomi-fix.yml?ref=main'

describe('renderCallerWorkflow', () => {
  it('renders the design template, pinned to the SHA or a placeholder', () => {
    const pinned = renderCallerWorkflow({ sha: NEW, version: 'v0.2.0' })
    expect(pinned).toContain(`uses: ${FIX_WORKFLOW}@${NEW} # v0.2.0`)
    expect(pinned).toContain('run-name: hinomi fix ${{ inputs.run_id }}')
    const doc = parse(pinned) as {
      on: { workflow_dispatch: { inputs: Record<string, { type: string }> } }
      jobs: { fix: { with: Record<string, string>; permissions: Record<string, string> } }
    }
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(['run_id', 'plan', 'encoding'])
    expect(doc.on.workflow_dispatch.inputs.encoding?.type).toBe('choice')
    expect(doc.jobs.fix.permissions).toEqual({ contents: 'write' })
    expect(Object.keys(doc.jobs.fix.with)).toEqual(['run_id', 'plan', 'encoding'])
    expect(renderCallerWorkflow()).toContain(`${FIX_WORKFLOW}@<40 char sha>`)
  })

  it('reads back as current with every input declared', () => {
    expect(inspectCallerWorkflow(renderCallerWorkflow({ sha: NEW }), LATEST)).toEqual({
      state: 'current',
      ref: NEW,
      missingInputs: [],
    })
  })
})

describe('inspectCallerWorkflow', () => {
  it.each([
    ['an older SHA', renderCallerWorkflow({ sha: OLD }), LATEST, 'outdated', OLD],
    ['a SHA with no release known', renderCallerWorkflow({ sha: OLD }), null, 'pinned', OLD],
    ['a tag', renderCallerWorkflow({ sha: 'v0.2.0' }), LATEST, 'unpinned', 'v0.2.0'],
    [
      'another workflow',
      renderCallerWorkflow({ sha: OLD }).replace(
        FIX_WORKFLOW,
        'kestrel-co/ci/.github/workflows/x.yml',
      ),
      LATEST,
      'not_hinomi',
      null,
    ],
    ['broken YAML', 'jobs: [unclosed', LATEST, 'invalid', null],
  ] as const)('reports %s', (_label, text, latest, state, ref) => {
    expect(inspectCallerWorkflow(text, latest)).toMatchObject({ state, ref })
  })

  it('matches the owner case insensitively and lists missing inputs', () => {
    const text = renderCallerWorkflow({ sha: NEW })
      .replace('Shironex/hinomi', 'shironex/HINOMI')
      .replace('      encoding:\n        type: choice', '      mode:\n        type: choice')
    expect(inspectCallerWorkflow(text, LATEST)).toEqual({
      state: 'current',
      ref: NEW,
      missingInputs: ['encoding'],
    })
  })
})

describe('readCaller', () => {
  const client = (routes: Parameters<typeof fakeGithub>[0]) =>
    createGithubClient({ token: 'fictional', fetch: fakeGithub(routes).fetch, maxRetries: 0 })
  const options = {
    owner: 'kestrel-co',
    name: 'harbor',
    workflow: 'hinomi-fix.yml',
    ref: 'main',
    latest: LATEST,
  }

  it('reports a missing file with the template to paste', async () => {
    const caller = await readCaller(client([]), options)
    expect(caller).toMatchObject({
      state: 'missing',
      path: '.github/workflows/hinomi-fix.yml',
      latestSha: NEW,
    })
    expect(caller.template).toContain(`${FIX_WORKFLOW}@${NEW} # v0.2.0`)
  })

  it('reads the file from the default branch', async () => {
    const caller = await readCaller(
      client([{ path: PATH, reply: fileReply(renderCallerWorkflow({ sha: OLD })) }]),
      options,
    )
    expect(caller).toMatchObject({ state: 'outdated', ref: OLD })
    expect(caller.message).toContain('older commit')
  })

  it('says unknown when contents may not be read', async () => {
    const caller = await readCaller(
      client([
        { path: PATH, reply: { status: 403, body: { message: 'Resource not accessible' } } },
      ]),
      options,
    )
    expect(caller.state).toBe('unknown')
    expect(caller.message).toContain('Contents: read')
  })
})
