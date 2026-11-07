import type { VersionResponse } from '@hinomi/shared'

/** The image repository releases are pushed to (see .github/workflows/release.yml). */
export const IMAGE_REPOSITORY = 'ghcr.io/shironex/hinomi'
/** Where the release notes of every version live. */
export const RELEASES_URL = 'https://github.com/Shironex/hinomi/releases'

/** What the build says about itself. Baked in through Docker build args, see the Dockerfile. */
export interface BuildInfo {
  /** A release such as `0.3.0` or `0.3.0-rc.1`, or `dev` for any build that did not get one. */
  version: string
  /** Full git sha, or null when the build did not say. */
  commit: string | null
  /** ISO timestamp, or null when the build did not say. */
  buildDate: string | null
}

export const DEV_VERSION = 'dev'

/**
 * Reads the build info from HINOMI_BUILD_VERSION, HINOMI_BUILD_COMMIT and HINOMI_BUILD_DATE.
 * Anything missing or malformed falls back to a dev build rather than failing the boot: the
 * values are labels, never inputs the server depends on.
 */
export function readBuildInfo(env: NodeJS.ProcessEnv): BuildInfo {
  const raw = (env.HINOMI_BUILD_VERSION ?? '').trim().replace(/^v/, '')
  const version = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(raw) ? raw : DEV_VERSION
  const sha = (env.HINOMI_BUILD_COMMIT ?? '').trim().toLowerCase()
  const date = new Date((env.HINOMI_BUILD_DATE ?? '').trim())
  return {
    version,
    commit: /^[0-9a-f]{7,40}$/.test(sha) ? sha : null,
    buildDate: Number.isNaN(date.getTime()) ? null : date.toISOString(),
  }
}

export const isDevBuild = (build: BuildInfo): boolean => build.version === DEV_VERSION

/** A pre-release carries a suffix after the three numbers (`0.3.0-rc.1`). */
export const isPrereleaseBuild = (build: BuildInfo): boolean =>
  !isDevBuild(build) && build.version.includes('-')

export const releaseUrl = (version: string): string => `${RELEASES_URL}/tag/v${version}`
export const imageTag = (version: string): string => `${IMAGE_REPOSITORY}:${version}`

/** The GET /api/version body, without an update. */
export function describeBuild(build: BuildInfo): Omit<VersionResponse, 'update'> {
  const dev = isDevBuild(build)
  return {
    version: build.version,
    commit: build.commit,
    buildDate: build.buildDate,
    isDev: dev,
    prerelease: isPrereleaseBuild(build),
    imageTag: dev ? null : imageTag(build.version),
    releaseNotesUrl: dev ? null : releaseUrl(build.version),
  }
}
