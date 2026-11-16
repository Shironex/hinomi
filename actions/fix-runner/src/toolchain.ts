import type { StepPackageManager } from './appliers/index.js'
import { declaredIn } from './detect.js'
import { isJsonObject, parseJsonFile } from './json-file.js'
import { repoJoin, type RepoFs } from './repo-fs.js'

// What the reusable workflow installs before the apply step: every package manager among the
// dispatch's projects (a repo with a pnpm app and a Rust crate gets both), plus Node for the
// npm family and PHP for composer. pip needs nothing: its fix is a text edit. The detect step turns this into outputs; the workflow gates its setup steps on
// them. Nothing here runs a tool, it only reads files of the checkout.

/** pnpm version used when no `packageManager` field names one. */
export const DEFAULT_PNPM_VERSION = '10'
/** bun version used when no `packageManager` field names one. */
export const DEFAULT_BUN_VERSION = 'latest'
/** uv version the runner installs; pinned so a lock never depends on the day it runs. */
export const DEFAULT_UV_VERSION = '0.13.2'
/** PHP version for composer when composer.json names none. */
export const DEFAULT_PHP_VERSION = '8.4'
/** Composer version the runner installs (2.7 or later has --minimal-changes). */
export const COMPOSER_VERSION = '2.11.1'

const NODE_FAMILY: readonly StepPackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']
const NODE_VERSION_FILES = ['.node-version', '.nvmrc']

export interface ToolchainProject {
  /** Repo relative folder of the lockfile. */
  root: string
  packageManager: StepPackageManager
}

export interface Toolchains {
  /** Every package manager to set up, in the order its first project comes. */
  managers: StepPackageManager[]
  node: boolean
  /** Repo relative file for setup-node's node-version-file, empty for the current LTS. */
  nodeVersionFile: string
  /** `version` is empty when `packageJsonFile` names the version in its packageManager field. */
  pnpm: { version: string; packageJsonFile: string } | null
  /** `version` from the packageManager field, empty to use the yarn on the runner image. */
  yarn: { version: string } | null
  bun: { version: string } | null
  /** Folder of the first cargo project, where a rust-toolchain file would apply. */
  rust: { root: string } | null
  /** go.mod of the first Go project, for setup-go's go-version-file. */
  go: { versionFile: string } | null
  uv: { version: string } | null
  /** PHP `major.minor` and the composer version, for setup-php. */
  php: { version: string; composer: string } | null
}

const PHP_VERSION = /^\d+\.\d+$/

/**
 * The PHP version composer should resolve with, from the project's composer.json:
 * `config.platform.php` (what the repo told composer to assume), else the lowest
 * `major.minor` its `require.php` names, else DEFAULT_PHP_VERSION.
 */
export async function findPhpVersion(fs: RepoFs, root: string): Promise<string> {
  const text = await fs.read(repoJoin(root, 'composer.json'))
  if (text === null) return DEFAULT_PHP_VERSION
  try {
    const { data } = parseJsonFile(text)
    if (!isJsonObject(data)) return DEFAULT_PHP_VERSION
    const config = isJsonObject(data.config) ? data.config : null
    const platform = config && isJsonObject(config.platform) ? config.platform : null
    const requires = isJsonObject(data.require) ? data.require : null
    for (const value of [platform?.php, requires?.php]) {
      if (typeof value !== 'string') continue
      const versions = [...value.matchAll(/(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])
      const lowest = versions.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)[0]
      const version = lowest ? `${lowest[0]}.${lowest[1]}` : ''
      if (PHP_VERSION.test(version)) return version
    }
  } catch {
    // Unreadable composer.json: the default, and composer itself will say what is wrong.
  }
  return DEFAULT_PHP_VERSION
}

async function hasEnginesNode(fs: RepoFs, file: string): Promise<boolean> {
  const text = await fs.read(file)
  if (text === null) return false
  try {
    const { data } = parseJsonFile(text)
    if (!isJsonObject(data)) return false
    const engines = data.engines
    return isJsonObject(engines) && typeof engines.node === 'string' && engines.node !== ''
  } catch {
    return false
  }
}

/**
 * The Node version source setup-node should read: a `.node-version` or `.nvmrc` in the project
 * folder or the repo root, else a package.json there with `engines.node`. Empty means LTS.
 */
export async function findNodeVersionFile(fs: RepoFs, root: string): Promise<string> {
  const folders = [...new Set([root, '.'])]
  for (const folder of folders) {
    for (const name of NODE_VERSION_FILES) {
      const file = repoJoin(folder, name)
      if (await fs.exists(file)) return file
    }
  }
  for (const folder of folders) {
    const file = repoJoin(folder, 'package.json')
    if (await hasEnginesNode(fs, file)) return file
  }
  return ''
}

/** The toolchains for these projects (already matched with the checkout by detection). */
export async function planToolchains(
  fs: RepoFs,
  projects: readonly ToolchainProject[],
): Promise<Toolchains> {
  const managers = [...new Set(projects.map((project) => project.packageManager))]
  const firstOf = (manager: StepPackageManager) =>
    projects.find((project) => project.packageManager === manager)
  const firstNode = projects.find((project) => NODE_FAMILY.includes(project.packageManager))

  let pnpm: Toolchains['pnpm'] = null
  const pnpmProject = firstOf('pnpm')
  if (pnpmProject) {
    const declared = await declaredIn(fs, pnpmProject.root)
    pnpm =
      declared?.name === 'pnpm' && declared.version !== null
        ? { version: '', packageJsonFile: declared.file }
        : {
            version: DEFAULT_PNPM_VERSION,
            packageJsonFile: repoJoin(pnpmProject.root, 'package.json'),
          }
  }

  let yarn: Toolchains['yarn'] = null
  const yarnProject = firstOf('yarn')
  if (yarnProject) {
    const declared = await declaredIn(fs, yarnProject.root)
    const version = declared?.name === 'yarn' ? declared.version : null
    yarn = { version: version ?? '' }
  }

  let bun: Toolchains['bun'] = null
  const bunProject = firstOf('bun')
  if (bunProject) {
    const declared = await declaredIn(fs, bunProject.root)
    const version = declared?.name === 'bun' ? declared.version : null
    bun = { version: version ?? DEFAULT_BUN_VERSION }
  }

  const cargoProject = firstOf('cargo')
  const goProject = firstOf('go')
  const composerProject = firstOf('composer')
  return {
    managers,
    node: firstNode !== undefined,
    nodeVersionFile: firstNode ? await findNodeVersionFile(fs, firstNode.root) : '',
    pnpm,
    yarn,
    bun,
    rust: cargoProject ? { root: cargoProject.root } : null,
    go: goProject ? { versionFile: repoJoin(goProject.root, 'go.mod') } : null,
    uv: firstOf('uv') ? { version: DEFAULT_UV_VERSION } : null,
    php: composerProject
      ? { version: await findPhpVersion(fs, composerProject.root), composer: COMPOSER_VERSION }
      : null,
  }
}

/** The detect step's toolchain outputs, as the workflow reads them. */
export function toolchainOutputs(toolchains: Toolchains): Record<string, string> {
  return {
    package_managers: toolchains.managers.join(','),
    setup_node: String(toolchains.node),
    node_version_file: toolchains.nodeVersionFile,
    setup_pnpm: String(toolchains.pnpm !== null),
    pnpm_version: toolchains.pnpm?.version ?? '',
    pnpm_package_json: toolchains.pnpm?.packageJsonFile ?? '',
    setup_yarn: String(toolchains.yarn !== null),
    yarn_version: toolchains.yarn?.version ?? '',
    setup_bun: String(toolchains.bun !== null),
    bun_version: toolchains.bun?.version ?? '',
    setup_rust: String(toolchains.rust !== null),
    rust_root: toolchains.rust?.root ?? '',
    setup_go: String(toolchains.go !== null),
    go_version_file: toolchains.go?.versionFile ?? '',
    setup_uv: String(toolchains.uv !== null),
    uv_version: toolchains.uv?.version ?? '',
    setup_php: String(toolchains.php !== null),
    php_version: toolchains.php?.version ?? '',
    composer_version: toolchains.php?.composer ?? '',
  }
}
