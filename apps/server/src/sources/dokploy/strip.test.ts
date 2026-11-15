import { describe, expect, it } from 'vitest'
import { isSecretKey, parseStripped, stripSecrets } from './strip.js'
import { SECRET_MARKER, fixture } from './testing.js'

describe('isSecretKey', () => {
  it.each([
    'password',
    'databasePassword',
    'databaseRootPassword',
    'githubWebhookSecret',
    'refreshToken',
    'accessToken',
    'apiKey',
    'sshKeyId',
    'privateKey',
    'PASSWORD',
    'env',
    'previewEnv',
    'buildArgs',
    'composeFile',
  ])('drops %s', (key) => {
    expect(isSecretKey(key)).toBe(true)
  })

  it.each([
    'name',
    'owner',
    'repository',
    'branch',
    'domains',
    'host',
    'dockerImage',
    'environments',
  ])('keeps %s', (key) => {
    expect(isSecretKey(key)).toBe(false)
  })
})

describe('parseStripped', () => {
  it('drops secret keys at every depth, in objects and arrays', () => {
    const parsed = parseStripped(
      JSON.stringify({
        name: 'harbor',
        password: 'x',
        nested: { deep: [{ apiToken: 'y', host: 'a.example.dev' }], clientSecret: 'z' },
      }),
    )
    expect(parsed).toEqual({ name: 'harbor', nested: { deep: [{ host: 'a.example.dev' }] } })
  })

  it('leaves no secret value of any recorded fixture', () => {
    for (const name of ['project-all', 'application-harbor', 'application-proxy', 'compose-docs']) {
      const raw = fixture(name)
      expect(raw).toContain(SECRET_MARKER)
      expect(JSON.stringify(parseStripped(raw))).not.toContain(SECRET_MARKER)
    }
  })
})

describe('stripSecrets', () => {
  it('matches parseStripped on an already parsed value', () => {
    const raw = fixture('application-harbor')
    expect(stripSecrets(JSON.parse(raw))).toEqual(parseStripped(raw))
  })

  it('never lets a __proto__ key reach the prototype', () => {
    const out = stripSecrets(
      JSON.parse('{"__proto__": {"polluted": true}, "name": "a"}'),
    ) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
