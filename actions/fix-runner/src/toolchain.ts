import type { StepPackageManager } from './appliers/index.js'
import { declaredIn } from './detect.js'
import { isJsonObject, parseJsonFile } from './json-file.js'
import { repoJoin, type RepoFs } from './repo-fs.js'

// What the reusable workflow installs before the apply step: every package manager among the
// dispatch's projects (a repo with a pnpm app and a Rust crate gets both), plus Node for the
// npm family. The detect step turns this into outputs; the workflow gates its setup steps on
// them. Nothing here runs a tool, it only reads files of the checkout.

/** pnpm version used when no `packageManager` field names one. */
export const DEFAULT_PNPM_VERSION = '10'
/** bun version used when no `packageManager` field names one. */
export const DEFAULT_BUN_VERSION = 'latest'

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
  return {
    managers,
    node: firstNode !== undefined,
    nodeVersionFile: firstNode ? await findNodeVersionFile(fs, firstNode.root) : '',
    pnpm,
    yarn,
    bun,
    rust: cargoProject ? { root: cargoProject.root } : null,
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
  }
}
