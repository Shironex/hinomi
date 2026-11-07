import { describe, expect, it } from 'vitest'
import { checkRunnerUrl, isPublicAddress } from './ssrf.js'

// Where the webhook runner may post. Hosts are fictional or documentation ranges.

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.10',
    '169.254.169.254',
    '100.100.100.100',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.51.100.7',
    '::1',
    '::',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['1.1.1.1', '8.8.4.4', '2606:4700:4700::1111', '::ffff:1.1.1.1'])(
    'accepts %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )
})

describe('checkRunnerUrl', () => {
  it('accepts an https URL with a host name', () => {
    const checked = checkRunnerUrl('https://runner.example.dev/hinomi', false)
    expect(checked.ok && checked.url.host).toBe('runner.example.dev')
  })

  it('refuses plain http unless private addresses are allowed', () => {
    expect(checkRunnerUrl('http://runner.example.dev/', false)).toMatchObject({ ok: false })
    expect(checkRunnerUrl('http://runner.example.dev/', true)).toMatchObject({ ok: true })
    expect(checkRunnerUrl('ftp://runner.example.dev/', true)).toMatchObject({ ok: false })
  })

  it('refuses credentials, fragments and garbage', () => {
    const withUser = checkRunnerUrl('https://user:pw@runner.example.dev/', false)
    expect(!withUser.ok && withUser.message).toContain('user name or password')
    expect(checkRunnerUrl('https://runner.example.dev/#x', false)).toMatchObject({ ok: false })
    expect(checkRunnerUrl('not a url', false)).toMatchObject({ ok: false })
  })

  it('refuses private literal addresses and localhost unless allowed', () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://10.0.0.8:8443/run',
      'https://[::1]/',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/',
      'https://edge.localhost/',
    ]) {
      expect(checkRunnerUrl(url, false)).toMatchObject({ ok: false })
      expect(checkRunnerUrl(url, true)).toMatchObject({ ok: true })
    }
  })
})
