import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FixResultV1 } from '@hinomi/shared'

/** File names inside the output folder the workflow uploads as one artifact. */
export const RESULT_FILE = 'hinomi-result.json'
export const PATCH_FILE = 'fix.patch'

export interface WrittenArtifacts {
  resultPath: string
  /** Null when there is no patch. */
  patchPath: string | null
}

/** Writes hinomi-result.json and, when there is one, fix.patch into `dir` (absolute). */
export async function writeArtifacts(
  dir: string,
  result: FixResultV1,
  patch: string | null,
): Promise<WrittenArtifacts> {
  await mkdir(dir, { recursive: true })
  const resultPath = join(dir, RESULT_FILE)
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  let patchPath: string | null = null
  if (patch !== null) {
    patchPath = join(dir, PATCH_FILE)
    await writeFile(patchPath, patch, 'utf8')
  }
  return { resultPath, patchPath }
}
