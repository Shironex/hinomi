import { z } from 'zod'
import { silentLogger, type Logger } from '../log.js'
import type { SettingsRepository } from '../repository/index.js'
import { compareVersions } from '../sources/osv/semver.js'
import type { AvailableUpdate } from '@hinomi/shared'
import {
  imageTag,
  isDevBuild,
  isPrereleaseBuild,
  releaseUrl,
  type BuildInfo,
} from './build-info.js'

/** The setting behind the Settings switch. A JSON boolean; on unless it says false. */
export const UPDATE_CHECK_KEY = 'updates.checkEnabled'

const RELEASES_API = 'https://api.github.com/repos/Shironex/hinomi/releases'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** The first check waits a little, so a boot (and a restart loop) never hits GitHub at once. */
export const FIRST_CHECK_DELAY_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000
/** Only the newest releases matter when a pre-release build looks at the list. */
const LIST_SIZE = 20

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
})
const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

export function readUpdateCheckEnabled(settings: SettingsRepository): boolean {
  return settings.get(UPDATE_CHECK_KEY, z.boolean()) ?? true
}

export interface UpdateChecker {
  /** The newer release found by the last check, or null (also null while the switch is off). */
  available(): AvailableUpdate | null
  /** Looks at GitHub now. Never throws; does nothing when the switch is off or the build is dev. */
  check(): Promise<void>
  /** Plans the first check, then one a day. */
  start(): void
  stop(): void
}

export interface UpdateCheckerOptions {
  settings: SettingsRepository
  build: BuildInfo
  fetch?: typeof fetch
  log?: Logger
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * The one outbound call Hinomi makes that is not to a configured source: a GET of the GitHub
 * releases API, unauthenticated, with an ETag, carrying nothing but the request itself (no
 * version, no instance id). A final build compares with the latest final release; a pre-release
 * build also considers pre-releases. Any failure (offline, rate limit, odd answer) leaves the
 * last result alone and is only logged.
 */
export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const { settings, build } = options
  const doFetch = options.fetch ?? fetch
  const log = options.log ?? silentLogger
  const setTimer =
    options.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref()
      return handle
    })
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const prerelease = isPrereleaseBuild(build)

  let found: string | null = null
  let etag: string | null = null
  let timer: unknown = null
  let stopped = true
  let inFlight: Promise<void> | null = null

  function newestOf(releases: z.infer<typeof releaseSchema>[]): string | null {
    let best: string | null = null
    for (const release of releases) {
      if (release.draft) continue
      if (release.prerelease && !prerelease) continue
      const version = TAG_PATTERN.exec(release.tag_name)?.[1]
      if (!version) continue
      // A final build never moves to a pre-release tag, whatever the flag says.
      if (version.includes('-') && !prerelease) continue
      if (best === null || compareVersions(version, best) > 0) best = version
    }
    return best
  }

  async function run(): Promise<void> {
    if (isDevBuild(build) || !readUpdateCheckEnabled(settings)) return
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'hinomi-update-check',
    }
    if (etag) headers['if-none-match'] = etag
    const url = prerelease ? `${RELEASES_API}?per_page=${LIST_SIZE}` : `${RELEASES_API}/latest`
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (res.status === 304) return
      if (!res.ok) {
        log.info('update check: GitHub did not answer with a release', { status: res.status })
        return
      }
      const body: unknown = await res.json()
      const releases = z
        .union([z.array(releaseSchema), releaseSchema.transform((r) => [r])])
        .parse(body)
      found = newestOf(releases)
      etag = res.headers.get('etag')
    } catch (error) {
      log.info('update check: could not read the latest release', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function check(): Promise<void> {
    inFlight ??= run().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function arm(ms: number): void {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (stopped) return
    timer = setTimer(() => {
      timer = null
      void check().finally(() => arm(CHECK_INTERVAL_MS))
    }, ms)
  }

  return {
    available() {
      if (found === null || isDevBuild(build) || !readUpdateCheckEnabled(settings)) return null
      if (compareVersions(found, build.version) <= 0) return null
      return { version: found, url: releaseUrl(found), imageTag: imageTag(found) }
    },
    check,
    start() {
      stopped = false
      arm(FIRST_CHECK_DELAY_MS)
    },
    stop() {
      stopped = true
      arm(0)
    },
  }
}
