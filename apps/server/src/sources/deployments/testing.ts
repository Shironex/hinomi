import {
  DEPLOYMENT_SOURCE_CAPABILITIES,
  type DeploymentRecord,
  type DeploymentSourceKind,
} from '@hinomi/shared'
import type { DeploymentSource, ImageScanReader } from './types.js'

// A deployment source for tests: reports the records it is given, of any kind, with that kind's
// declared capabilities. Every name in tests is fictional.

export interface FakeDeploymentSourceInput {
  sourceId: number
  name: string
  kind?: DeploymentSourceKind
  /** The records, or a function to compute or fail them per call. */
  records: readonly DeploymentRecord[] | (() => Promise<DeploymentRecord[]>)
  imageScan?: ImageScanReader
}

export function fakeDeploymentSource(input: FakeDeploymentSourceInput): DeploymentSource {
  const kind = input.kind ?? 'coolify'
  const { records } = input
  return {
    sourceId: input.sourceId,
    kind,
    name: input.name,
    capabilities: DEPLOYMENT_SOURCE_CAPABILITIES[kind],
    inventory: typeof records === 'function' ? records : () => Promise.resolve([...records]),
    ...(input.imageScan && { imageScan: input.imageScan }),
  }
}
