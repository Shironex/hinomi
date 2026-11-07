import { describe, expect, it } from 'vitest'
import {
  parseDockerfile,
  readDockerfileUser,
  readInstructions,
  resolveBaseImage,
  selectStage,
} from './dockerfile.js'

const MULTI_STAGE = `# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /src
RUN pnpm build

FROM node:22-alpine
COPY --from=build /src/dist /app
USER node
CMD ["node", "/app/index.js"]
`

describe('readInstructions', () => {
  it('joins continuations, skips comments inside them and blank lines', () => {
    const text = [
      'RUN apk add \\',
      '  # a comment in the middle',
      '  curl \\',
      '',
      '  git',
      'USER app',
    ].join('\n')
    expect(readInstructions(text)).toEqual([
      { keyword: 'RUN', args: 'apk add curl git', line: 1 },
      { keyword: 'USER', args: 'app', line: 6 },
    ])
  })

  it('honours the backtick escape directive', () => {
    const text = '# escape=`\nFROM base\nRUN echo a `\n  b\nUSER app'
    expect(readInstructions(text).map((i) => i.args)).toEqual(['base', 'echo a b', 'app'])
  })

  it('treats a directive after the first instruction as a plain comment', () => {
    const text = 'FROM base\n# escape=`\nRUN echo a \\\n  b'
    expect(readInstructions(text)[1]?.args).toBe('echo a b')
  })

  it('skips heredoc bodies so their lines are not read as instructions', () => {
    const text = [
      'FROM base',
      'RUN <<EOF',
      'USER root',
      'FROM evil',
      'EOF',
      'RUN <<-SCRIPT cat > /x',
      '\tUSER root',
      '\tSCRIPT',
      'USER app',
    ].join('\n')
    expect(readInstructions(text).map((i) => i.keyword)).toEqual(['FROM', 'RUN', 'RUN', 'USER'])
  })

  it('does not take a here string or arithmetic shift for a heredoc', () => {
    const text = 'RUN cat <<< "hi" && echo $((1 << 2))\nUSER app'
    expect(readInstructions(text).map((i) => i.keyword)).toEqual(['RUN', 'USER'])
  })

  it('handles CRLF and a byte order mark', () => {
    expect(readInstructions('\uFEFFFROM base\r\nUSER app\r\n').map((i) => i.keyword)).toEqual([
      'FROM',
      'USER',
    ])
  })
})

describe('parseDockerfile', () => {
  it('splits stages and records alias, image and tag', () => {
    const { stages } = parseDockerfile(MULTI_STAGE)
    expect(stages).toHaveLength(2)
    expect(stages[0]).toMatchObject({ index: 0, name: 'build', line: 2 })
    expect(stages[0]?.baseImage).toMatchObject({ repository: 'node', tag: '22-alpine' })
    expect(stages[1]?.name).toBeNull()
    expect(stages[1]?.users.map((u) => u.value)).toEqual(['node'])
  })

  it('substitutes ARG defaults before the first FROM', () => {
    const text =
      'ARG NODE_VERSION=22.11\nARG VARIANT=bookworm-slim\nFROM node:${NODE_VERSION}-$VARIANT\n'
    expect(parseDockerfile(text).stages[0]?.baseImage).toMatchObject({
      repository: 'node',
      tag: '22.11-bookworm-slim',
    })
  })

  it('lets build args override defaults', () => {
    const text = 'ARG NODE_VERSION=20\nFROM node:${NODE_VERSION}-alpine\n'
    const stage = parseDockerfile(text, { buildArgs: { NODE_VERSION: '24' } }).stages[0]
    expect(stage?.baseImage?.tag).toBe('24-alpine')
  })

  it('uses the default operator and marks other unset variables unresolved', () => {
    const withDefault = parseDockerfile('FROM node:${V:-lts}\n').stages[0]
    expect(withDefault?.baseImage?.tag).toBe('lts')
    const missing = parseDockerfile('ARG V\nFROM node:${V}\n').stages[0]
    expect(missing?.baseUnresolved).toBe(true)
    expect(missing?.baseImage).toBeNull()
  })

  it('reads --platform, a multi line FROM and a lower case as', () => {
    const text = 'FROM --platform=$BUILDPLATFORM \\\n  rust:1.82-slim \\\n  as builder\n'
    const stage = parseDockerfile(text).stages[0]
    expect(stage).toMatchObject({
      name: 'builder',
      platform: '$BUILDPLATFORM',
      from: 'rust:1.82-slim',
    })
    expect(stage?.baseImage).toMatchObject({ name: 'rust', tag: '1.82-slim' })
  })

  it('parses registries, digests and Docker Hub library paths', () => {
    const text = [
      'FROM registry.example.dev:5000/mirror/node:22 AS a',
      'FROM docker.io/library/node@sha256:' + 'a'.repeat(64) + ' AS b',
      'FROM oven/bun:1.1-alpine AS c',
      'FROM library/node AS d',
    ].join('\n')
    const [a, b, c, d] = parseDockerfile(text).stages
    expect(a?.baseImage).toMatchObject({
      registry: 'registry.example.dev:5000',
      repository: 'mirror/node',
      name: 'node',
    })
    expect(b?.baseImage).toMatchObject({
      repository: 'node',
      tag: null,
      digest: `sha256:${'a'.repeat(64)}`,
    })
    expect(c?.baseImage).toMatchObject({ repository: 'oven/bun', tag: '1.1-alpine' })
    expect(d?.baseImage).toMatchObject({ repository: 'node', tag: null })
  })

  it('links FROM an earlier stage and resolves the base through the chain', () => {
    const text = 'FROM node:22 AS base\nFROM base AS deps\nFROM Deps AS app\n'
    const df = parseDockerfile(text)
    expect(df.stages.map((s) => s.baseStage)).toEqual([null, 0, 1])
    expect(df.stages[2]?.baseImage).toBeNull()
    expect(resolveBaseImage(df, df.stages[2]!)?.tag).toBe('22')
  })

  it('knows scratch', () => {
    const stage = parseDockerfile('FROM scratch\nCOPY app /app\n').stages[0]
    expect(stage).toMatchObject({ scratch: true, baseImage: null, baseUnresolved: false })
  })

  it('ignores USER inside ONBUILD and instructions before the first FROM', () => {
    const text = 'USER root\nFROM base\nONBUILD USER root\nUSER app\n'
    expect(parseDockerfile(text).stages[0]?.users.map((u) => u.raw)).toEqual(['app'])
  })

  it('resolves USER from ENV and from ARG redeclared in the stage', () => {
    const text = [
      'ARG RUN_AS=svc',
      'FROM base',
      'ARG RUN_AS',
      'ENV HOME_DIR=/home/${RUN_AS}',
      'USER ${RUN_AS}',
      'USER "app-$RUN_AS"',
    ].join('\n')
    expect(parseDockerfile(text).stages[0]?.users.map((u) => u.value)).toEqual(['svc', 'app-svc'])
  })

  it('does not leak global ARG values into a stage that never redeclares them', () => {
    const text = 'ARG RUN_AS=svc\nFROM base\nUSER ${RUN_AS}\n'
    expect(parseDockerfile(text).stages[0]?.users[0]?.value).toBeNull()
  })

  it('reads the legacy ENV form with a space', () => {
    expect(
      parseDockerfile('FROM base\nENV WHO deploy bot\nUSER $WHO\n').stages[0]?.users[0]?.value,
    ).toBe('deploy bot')
  })
})

describe('selectStage', () => {
  const df = parseDockerfile('FROM a AS build\nFROM b AS Test\nFROM c\n')

  it('defaults to the last stage', () => {
    expect(selectStage(df)?.index).toBe(2)
    expect(selectStage(df, null)?.index).toBe(2)
  })

  it('finds a target by name (any case) or by number', () => {
    expect(selectStage(df, 'test')?.index).toBe(1)
    expect(selectStage(df, '0')?.index).toBe(0)
  })

  it('returns null for an unknown target or an empty file', () => {
    expect(selectStage(df, 'prod')).toBeNull()
    expect(selectStage(parseDockerfile(''))).toBeNull()
  })
})

describe('readDockerfileUser', () => {
  it('passes with USER node in the final stage and exposes the base', () => {
    const reading = readDockerfileUser(MULTI_STAGE)
    expect(reading).toMatchObject({ kind: 'non_root', userStage: 1, baseNonroot: false })
    expect(reading.user).toMatchObject({ raw: 'node', line: 8 })
    expect(reading.baseImage).toMatchObject({ repository: 'node', tag: '22-alpine' })
  })

  it('reports none when USER is only in the build stage', () => {
    const text =
      'FROM node:22-alpine AS build\nUSER node\nFROM node:22-alpine\nCOPY --from=build /a /a\n'
    expect(readDockerfileUser(text)).toMatchObject({ kind: 'none', user: null })
  })

  it('reads the last USER of the stage', () => {
    expect(readDockerfileUser('FROM a\nUSER app\nRUN x\nUSER root\n').kind).toBe('root')
    expect(readDockerfileUser('FROM a\nUSER root\nRUN x\nUSER app\n').kind).toBe('non_root')
  })

  it('tells root and numeric 0 from other ids, by the user part only', () => {
    const kind = (user: string) => readDockerfileUser(`FROM a\nUSER ${user}\n`).kind
    expect(kind('root')).toBe('root')
    expect(kind('0')).toBe('root')
    expect(kind('0:0')).toBe('root')
    expect(kind('root:app')).toBe('root')
    expect(kind('0:1000')).toBe('root')
    expect(kind('1000')).toBe('non_root')
    expect(kind('1000:1000')).toBe('non_root')
    expect(kind('1000:0')).toBe('non_root')
    expect(kind('app:app')).toBe('non_root')
  })

  it('is unknown when the last USER has an unresolved variable', () => {
    const text = 'FROM a\nARG APP_USER\nUSER ${APP_USER}\n'
    const reading = readDockerfileUser(text)
    expect(reading.kind).toBe('unknown')
    expect(reading.user).toMatchObject({ raw: '${APP_USER}', value: null })
  })

  it('resolves a USER variable from a build arg', () => {
    const text = 'FROM a\nARG APP_USER\nUSER ${APP_USER}\n'
    expect(readDockerfileUser(text, { buildArgs: { APP_USER: '0' } }).kind).toBe('root')
    expect(readDockerfileUser(text, { buildArgs: { APP_USER: '1001' } }).kind).toBe('non_root')
  })

  it('inherits USER from the stage it is built on', () => {
    const text = 'FROM node:22 AS base\nUSER 1000:1000\nFROM base AS app\nCOPY x y\n'
    expect(readDockerfileUser(text)).toMatchObject({ kind: 'non_root', userStage: 0 })
  })

  it('lets a target stage replace the last one', () => {
    const text = 'FROM a AS dev\nUSER root\nFROM a AS prod\nUSER app\n'
    expect(readDockerfileUser(text, { target: 'dev' }).kind).toBe('root')
    expect(readDockerfileUser(text).kind).toBe('non_root')
  })

  it('exposes a nonroot tag and follows the chain to the external base', () => {
    const text = 'FROM gcr.io/distroless/static:nonroot AS base\nFROM base\nCOPY a /a\n'
    const reading = readDockerfileUser(text)
    expect(reading).toMatchObject({ kind: 'none', baseNonroot: true })
    expect(reading.baseImage).toMatchObject({
      registry: 'gcr.io',
      repository: 'distroless/static',
      tag: 'nonroot',
    })
  })

  it('has no stage for a file without FROM or an unknown target', () => {
    expect(readDockerfileUser('# nothing\n').stage).toBeNull()
    expect(readDockerfileUser('FROM a\n', { target: 'nope' }).stage).toBeNull()
  })
})
