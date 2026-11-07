import type { VersionResponse } from '@hinomi/shared'

const SHORT_SHA = 7

export const shortCommit = (commit: string | null): string | null =>
  commit ? commit.slice(0, SHORT_SHA) : null

/** "v0.3.0" for a release, "dev 3f9a1c7" (or just "dev") for a build that is not one. */
export function versionLabel(v: Pick<VersionResponse, 'version' | 'isDev' | 'commit'>): string {
  if (!v.isDev) return `v${v.version}`
  const sha = shortCommit(v.commit)
  return sha ? `dev ${sha}` : 'dev'
}

/** The rail tooltip: the build commit when the build says it. */
export function versionTitle(v: Pick<VersionResponse, 'version' | 'isDev' | 'commit'>): string {
  const sha = shortCommit(v.commit)
  return `Hinomi ${versionLabel(v)}${sha && !v.isDev ? `, build ${sha}` : ''}`
}

/** How to upgrade to a release: the compose variable, or the image tag to pull. */
export function upgradeLine(update: { version: string }): string {
  return `HINOMI_VERSION=${update.version} docker compose up -d`
}
