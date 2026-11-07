import type { FetchLockfilesOptions } from '../sources/osv/index.js'
import type { RuntimePinRecord } from '@hinomi/shared'
import type { RuntimePinsRepository } from '../repository/index.js'
import { fetchPinFiles } from './fetch.js'
import { readRuntimePins, type ReadPinsOptions } from './read.js'

export interface ScanRuntimePinsInput extends ReadPinsOptions {
  repoId: number
  owner: string
  name: string
  /** Branch or release tag to read. */
  ref: string
  /** The reading GitHub source's token, null for an anonymous read of a public repo. */
  token: string | null
  fetch?: typeof fetch
  apiUrl?: string
  now: Date
}

/**
 * Reads the runtime pins of one repo at one ref through the GitHub contents walk and stores
 * them, replacing what was stored for that ref. Returns the pins. A GitHub error is thrown
 * before anything is replaced, so a failed read keeps the last good pins.
 */
export async function scanRuntimePins(
  pinsRepository: Pick<RuntimePinsRepository, 'replace'>,
  input: ScanRuntimePinsInput,
): Promise<RuntimePinRecord[]> {
  const options: FetchLockfilesOptions = {
    ...(input.fetch && { fetch: input.fetch }),
    ...(input.apiUrl && { apiUrl: input.apiUrl }),
  }
  const files = await fetchPinFiles(input.owner, input.name, input.ref, input.token, options)
  const pins = readRuntimePins(files, {
    ...(input.productionDockerfiles && { productionDockerfiles: input.productionDockerfiles }),
  })
  pinsRepository.replace(input.repoId, input.ref, pins, input.now)
  return pins
}
