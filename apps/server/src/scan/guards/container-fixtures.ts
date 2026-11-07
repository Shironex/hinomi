import type { DeploymentFacts } from '@hinomi/shared'
import type { DeploymentRow, RepoRow } from '../../db/schema.js'
import type { DeploymentIndex } from '../deployments.js'
import { noRepoFiles } from './testing.js'
import type { GuardContext } from './types.js'

// Test fixtures for the container checks: fictional deployments of the kestrel-co org.

export const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

export function baseFacts(over: Partial<DeploymentFacts> = {}): DeploymentFacts {
  return {
    version: 1,
    fetchedAt: '2026-11-08T10:00:00.000Z',
    buildPack: 'dockerfile',
    image: null,
    commit: SHA,
    user: null,
    services: [],
    dockerfile: null,
    mounts: [],
    mountsChecked: ['run_options', 'file_storage', 'persistent_storage'],
    networks: [],
    hostNetwork: false,
    privileged: false,
    destination: null,
    attachedToDestination: true,
    project: null,
    autoDeploy: null,
    gaps: {},
    ...over,
  }
}

export const repo = { id: 7, owner: 'kestrel-co', name: 'harbor', sourceId: 1 } as RepoRow

let nextId = 100

export function deployment(facts: DeploymentFacts | null, over: Partial<DeploymentRow> = {}) {
  return {
    id: nextId++,
    kind: 'application',
    name: 'harbor-web',
    gitBranch: 'main',
    facts,
    ...over,
  } as DeploymentRow
}

export function contextOf(
  deployments: DeploymentRow[],
  over: Partial<GuardContext> = {},
): GuardContext {
  const index: DeploymentIndex = {
    deployments,
    byRepo: new Map([[repo.id, deployments]]),
    unmapped: [],
  }
  return {
    deployments,
    repos: [repo],
    index,
    scans: new Map(),
    repoFiles: noRepoFiles(),
    support: null,
    supportWindowDays: 90,
    now: new Date('2026-11-08T10:00:00Z'),
    ...over,
  }
}
