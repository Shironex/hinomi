import { z } from 'zod'
import type { SettingsRepository } from '../repository/index.js'
import type { GithubPins } from './allowlist.js'

/**
 * `github:<login>` rules are pinned to the numeric id of the account that first signs in with the
 * login. A login can be renamed and later claimed by someone else; the id cannot, so a later login
 * with the same name and another id is refused (auth/allowlist.ts admit).
 */

export const GITHUB_PINS_KEY = 'auth.githubPins'

const pinsSchema = z.record(z.string(), z.string().regex(/^[1-9][0-9]*$/))

export function readGithubPins(settings: SettingsRepository): GithubPins {
  return new Map(Object.entries(settings.get(GITHUB_PINS_KEY, pinsSchema) ?? {}))
}

export function pinGithubLogin(settings: SettingsRepository, login: string, id: string): void {
  const pins = settings.get(GITHUB_PINS_KEY, pinsSchema) ?? {}
  // First pin wins; never move a pin to another account. Own keys only: a login such as
  // `constructor` must not find Object.prototype's members.
  if (Object.hasOwn(pins, login)) return
  settings.set(GITHUB_PINS_KEY, { ...pins, [login]: id })
}
