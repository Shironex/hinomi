import type { VersionResponse } from '@hinomi/shared'

/** The build fixture mode pretends to be, so screenshots show the same version every time. */
export const FIXTURE_VERSION = '0.3.0'

const COMMIT = '3f9a1c7e5b2d4086a1c3e5f70912b4d6e8a0c2f4'

const RUNNING: VersionResponse = {
  version: FIXTURE_VERSION,
  commit: COMMIT,
  buildDate: '2026-11-07T09:30:00.000Z',
  isDev: false,
  prerelease: false,
  imageTag: `ghcr.io/shironex/hinomi:${FIXTURE_VERSION}`,
  releaseNotesUrl: `https://github.com/Shironex/hinomi/releases/tag/v${FIXTURE_VERSION}`,
  update: null,
}

/** `?fixture=update` shows the same build with a newer release available. */
export function versionFor(updateAvailable: boolean): VersionResponse {
  if (!updateAvailable) return RUNNING
  return {
    ...RUNNING,
    update: {
      version: '0.3.1',
      url: 'https://github.com/Shironex/hinomi/releases/tag/v0.3.1',
      imageTag: 'ghcr.io/shironex/hinomi:0.3.1',
    },
  }
}
