import { z } from 'zod'

// The desktop release tier: a repo nothing deploys whose latest GitHub release ships
// installers is "released", so the version in that release is in users' hands. This module holds
// the per repo mode and the installer heuristic (decision Q16), shared by the scan and the UI.

/**
 * Per repo release tier mode. `auto`: released when the latest release has installer like
 * assets. `on`: released whenever it has a latest release (an app the heuristic misses). `off`:
 * never (a CLI or a library the heuristic flags).
 */
export const RELEASE_TIER_MODES = ['auto', 'on', 'off'] as const
export const releaseTierModeSchema = z.enum(RELEASE_TIER_MODES)
export type ReleaseTierMode = z.infer<typeof releaseTierModeSchema>

/** File endings that are an installer or a package for one platform on their own. */
const INSTALLER_ENDINGS = [
  '.dmg',
  '.pkg',
  '.exe',
  '.msi',
  '.msix',
  '.msixbundle',
  '.appx',
  '.appxbundle',
  '.appimage',
  '.deb',
  '.rpm',
  '.flatpak',
  '.flatpakref',
  '.snap',
  '.apk',
  '.aab',
] as const

/** Archive endings that count only when the name says which platform they are for. */
const ARCHIVE_ENDINGS = ['.zip', '.tar.gz', '.tgz', '.tar.xz', '.tar.bz2', '.tar.zst'] as const

/**
 * Words (whole tokens of the name) that tie an archive to a platform or a CPU, like
 * `Kestrel-2.3.0-mac.zip`, `kestrel-win-x64.zip` or `kestrel_1.0.0_linux_amd64.tar.gz`.
 * `x86_64` splits into `x86` and `64`, so `x86` covers it.
 */
const PLATFORM_WORDS: ReadonlySet<string> = new Set([
  'mac',
  'macos',
  'osx',
  'darwin',
  'win',
  'win32',
  'win64',
  'windows',
  'linux',
  'x64',
  'x86',
  'amd64',
  'arm64',
  'aarch64',
  'armv7',
  'universal',
])

/**
 * Words that mark an asset as something other than the app: debug symbols and source bundles.
 * Checked for every asset, so `kestrel-2.3.0-linux-x64-debug-symbols.zip` and
 * `kestrel-2.3.0-src.tar.gz` never count.
 */
const NOT_THE_APP_WORDS: ReadonlySet<string> = new Set([
  'symbols',
  'dsym',
  'pdb',
  'debug',
  'src',
  'source',
  'sources',
])

function tokensOf(name: string): string[] {
  return name.split(/[^a-z0-9]+/).filter((t) => t !== '')
}

/**
 * True when a release asset looks like something a user installs (decision Q16):
 *
 * - a platform installer or package: `.dmg`, `.pkg`, `.exe`, `.msi`, `.msix`, `.appx`,
 *   `.AppImage`, `.deb`, `.rpm`, `.flatpak`, `.snap`, `.apk`, `.aab` (bundle variants too);
 * - an archive (`.zip`, `.tar.gz`, `.tgz`, `.tar.xz`, `.tar.bz2`, `.tar.zst`) whose name has a
 *   platform or CPU word as a whole token (`mac`, `darwin`, `win`, `linux`, `x64`, `arm64`,
 *   `universal`, ...).
 *
 * Never: debug symbols or source bundles (a `symbols`, `dsym`, `pdb`, `debug`, `src` or `source`
 * token), and anything else (checksums, signatures, `.blockmap`, update feeds like `latest.yml`),
 * since those end in another extension. Case is ignored. GitHub's own source archives are not
 * release assets, so a release with nothing uploaded has no installer.
 */
export function isInstallerAsset(name: string): boolean {
  const lower = name.trim().toLowerCase()
  if (lower === '') return false
  const tokens = tokensOf(lower)
  if (tokens.some((t) => NOT_THE_APP_WORDS.has(t))) return false
  if (INSTALLER_ENDINGS.some((ending) => lower.endsWith(ending))) return true
  const archive = ARCHIVE_ENDINGS.find((ending) => lower.endsWith(ending))
  if (!archive) return false
  const stem = tokensOf(lower.slice(0, lower.length - archive.length))
  return stem.some((t) => PLATFORM_WORDS.has(t))
}

/** The asset names that look installable, in their order. */
export function installerAssets(names: readonly string[]): string[] {
  return names.filter(isInstallerAsset)
}
