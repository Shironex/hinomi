import {
  createRepoContents,
  listRepoTree,
  mapLimit,
  type FetchLockfilesOptions,
} from '../sources/osv/index.js'
import { isPinFilePath, type PinFile } from './read.js'

/** Most files one repo read fetches, so a huge monorepo cannot flood the API. */
export const MAX_PIN_FILES = 80
/** Larger files are skipped: a pin file is a few lines, a manifest at most some kilobytes. */
const MAX_FILE_CHARS = 512 * 1024

/**
 * The files the pin readers need, found through the contents walk the lockfile phase uses
 * (root, `apps/*`, `packages/*` and their children) plus one listing of `.github/workflows`.
 * Only files that are in the listing are fetched. `token` may be null for public repos.
 */
export async function fetchPinFiles(
  owner: string,
  repo: string,
  ref: string,
  token: string | null,
  options: FetchLockfilesOptions = {},
): Promise<PinFile[]> {
  const contents = createRepoContents(owner, repo, ref, token, options)
  const listed = await listRepoTree(contents)
  const workflows = listed.some((e) => e.type === 'dir' && e.path === '.github')
    ? await contents.list('.github/workflows')
    : []
  const wanted = [...listed, ...workflows]
    .filter((e) => e.type === 'file' && isPinFilePath(e.path))
    .slice(0, MAX_PIN_FILES)
  const files = await mapLimit(wanted, 4, async (entry): Promise<PinFile | null> => {
    const text = await contents.readText(entry.path)
    return text === null || text.length > MAX_FILE_CHARS ? null : { path: entry.path, text }
  })
  return files.filter((f): f is PinFile => f !== null)
}
