import { describe, expect, it, vi } from 'vitest'
import { base64UrlToBytes, currentSubscription, webPushProblem } from './web-push'

const KEY = 'BAECAwQ'
const OTHER = 'BAUGBwg'

function pushManager(existingKey: string | null) {
  const existing = existingKey
    ? {
        options: { applicationServerKey: base64UrlToBytes(existingKey).buffer },
        unsubscribe: vi.fn(() => Promise.resolve(true)),
      }
    : null
  const fresh = { options: { applicationServerKey: base64UrlToBytes(KEY).buffer } }
  const manager = {
    getSubscription: vi.fn(() => Promise.resolve(existing)),
    subscribe: vi.fn(() => Promise.resolve(fresh)),
  }
  return { manager: manager as unknown as PushManager, existing, fresh, raw: manager }
}

describe('webPushProblem', () => {
  it('says so where the browser has no push API', () => {
    expect(webPushProblem()).toMatch(/does not support push/)
  })
})

describe('currentSubscription', () => {
  it('keeps a subscription made under the current key', async () => {
    const { manager, existing, raw } = pushManager(KEY)
    expect(await currentSubscription(manager, KEY)).toBe(existing)
    expect(raw.subscribe).not.toHaveBeenCalled()
  })

  it('drops a subscription made under an old key and subscribes again', async () => {
    const { manager, existing, fresh, raw } = pushManager(OTHER)
    expect(await currentSubscription(manager, KEY)).toBe(fresh)
    expect(existing?.unsubscribe).toHaveBeenCalledOnce()
    expect(raw.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(KEY),
    })
  })

  it('subscribes when there is no subscription yet', async () => {
    const { manager, fresh } = pushManager(null)
    expect(await currentSubscription(manager, KEY)).toBe(fresh)
  })
})
