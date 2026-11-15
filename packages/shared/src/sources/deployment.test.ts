import { describe, expect, it } from 'vitest'
import { SOURCE_KINDS } from '../model.js'
import {
  DEPLOYMENT_SOURCE_CAPABILITIES,
  DEPLOYMENT_SOURCE_KINDS,
  deploymentGuardCapabilities,
  isDeploymentSourceKind,
} from './deployment.js'

describe('deployment source kinds', () => {
  it('are source kinds, each with its capabilities', () => {
    for (const kind of DEPLOYMENT_SOURCE_KINDS) {
      expect(SOURCE_KINDS).toContain(kind)
      expect(DEPLOYMENT_SOURCE_CAPABILITIES[kind].facts.size).toBeGreaterThan(0)
    }
  })

  it('tells deployment sources from the others', () => {
    expect(isDeploymentSourceKind('coolify')).toBe(true)
    expect(isDeploymentSourceKind('github')).toBe(false)
    expect(isDeploymentSourceKind('osv')).toBe(false)
  })
})

describe('deploymentGuardCapabilities', () => {
  it('reads each container check from the source declarations', () => {
    expect(deploymentGuardCapabilities('root_user')).toEqual({ coolify: 'partial' })
    expect(deploymentGuardCapabilities('docker_socket')).toEqual({ coolify: 'partial' })
    expect(deploymentGuardCapabilities('shared_network')).toEqual({ coolify: 'partial' })
    expect(deploymentGuardCapabilities('watch_paths_skip')).toEqual({ coolify: 'full' })
  })

  it('answers nothing for checks that read the repo, not the container', () => {
    expect(deploymentGuardCapabilities('runtime_support')).toEqual({})
  })
})
