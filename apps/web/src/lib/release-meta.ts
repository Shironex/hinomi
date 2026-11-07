import type { RepoRelease, RepoReleaseStatus, ReleaseTierMode } from '@hinomi/shared'

/** Words for the desktop release tier, shared by the repo release panel and the finding views. */

/** The marker for a release finding the default branch already fixed. A word, never color alone. */
export const FIXED_ON_MAIN_LABEL = 'Fixed on main, not released yet'

export const FIXED_ON_MAIN_HINT =
  'The default branch no longer has the vulnerable version, but the latest release does. It stays open because users still run that build. Cut a release to clear it.'

export const TIER_MODE_INFO: Record<ReleaseTierMode, { label: string; hint: string }> = {
  auto: {
    label: 'Automatic',
    hint: 'Released when the latest release has installer files such as a .dmg, .exe or .AppImage. A release with only source archives is a library.',
  },
  on: {
    label: 'Always',
    hint: 'Treat the latest release as in the hands of users whatever its files are called. For an app the installer check misses.',
  },
  off: {
    label: 'Never',
    hint: 'Keep this repo out of the released tier, for a CLI or a library the installer check flags. Its release findings are resolved.',
  },
}

/** What the effective tier is and why it applies. `released` says whether the tier applies. */
export interface ReleaseVerdict {
  released: boolean
  title: string
  why: string
}

const VERDICTS: Record<RepoReleaseStatus, ReleaseVerdict> = {
  released: {
    released: true,
    title: 'In the released tier',
    why: 'Nothing deploys this repo and its latest release is in the hands of users, so the dependencies at that tag are scanned and ranked as released.',
  },
  deployed: {
    released: false,
    title: 'Not in the released tier',
    why: 'A deployment runs this repo, so its findings keep their deploy tiers. A stopped deployment counts too.',
  },
  turned_off: {
    released: false,
    title: 'Not in the released tier',
    why: 'The tier is set to Never for this repo, so no release is scanned.',
  },
  no_release: {
    released: false,
    title: 'Not in the released tier',
    why: 'GitHub has no final release for this repo. Drafts and prereleases do not count.',
  },
  no_installers: {
    released: false,
    title: 'Not in the released tier',
    why: 'The latest release has no installer files, only source archives, so it reads as a library. Set the tier to Always if this is an app.',
  },
  not_checked: {
    released: false,
    title: 'Not checked yet',
    why: 'The daily release check has not reached this repo. It asks GitHub once a day for repos nothing deploys.',
  },
}

export function releaseVerdict(release: RepoRelease): ReleaseVerdict {
  const verdict = VERDICTS[release.status]
  // The server says the mode; say it too when it decided the answer by hand.
  if (release.status === 'released' && release.tier === 'on') {
    return {
      ...verdict,
      why: 'The tier is set to Always, so the latest release counts whatever its files are called. Its dependencies at that tag are scanned and ranked as released.',
    }
  }
  return verdict
}

/** The release page of a tag on GitHub. */
export function releaseUrl(fullName: string, tag: string): string {
  return `https://github.com/${fullName}/releases/tag/${encodeURIComponent(tag)}`
}
