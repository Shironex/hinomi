import { afterEach, describe, expect, it, vi } from 'vitest'
import { canRegisterServiceWorker, registerServiceWorker } from './pwa'

describe('service worker registration guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function stubBrowser({ secure, supported }: { secure: boolean; supported: boolean }) {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure })
    const register = vi.fn().mockResolvedValue({})
    if (supported) {
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { register, controller: null },
      })
    } else {
      Reflect.deleteProperty(navigator, 'serviceWorker')
    }
    return register
  }

  it('never registers in dev', () => {
    vi.stubEnv('PROD', false)
    stubBrowser({ secure: true, supported: true })
    expect(canRegisterServiceWorker()).toBe(false)
    expect(registerServiceWorker()).toBe(false)
  })

  it('never registers on an insecure context', () => {
    vi.stubEnv('PROD', true)
    stubBrowser({ secure: false, supported: true })
    expect(canRegisterServiceWorker()).toBe(false)
    expect(registerServiceWorker()).toBe(false)
  })

  it('skips browsers without service workers', () => {
    vi.stubEnv('PROD', true)
    stubBrowser({ secure: true, supported: false })
    expect(canRegisterServiceWorker()).toBe(false)
  })

  it('registers at the root scope in a secure production page', () => {
    vi.stubEnv('PROD', true)
    const register = stubBrowser({ secure: true, supported: true })
    expect(registerServiceWorker()).toBe(true)
    window.dispatchEvent(new Event('load'))
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })
})
