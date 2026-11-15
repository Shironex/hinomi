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
      expect(DEPLOYMENT_SOURCE_CAPABILITIES[kind].facts).toBeInstanceOf(Set)
    }
  })

  it('declares no container fact or check for Dokploy until one is confirmed', () => {
    expect(DEPLOYMENT_SOURCE_CAPABILITIES.dokploy.facts.size).toBe(0)
    expect(DEPLOYMENT_SOURCE_CAPABILITIES.dokploy.guards).toEqual({})
    expect(DEPLOYMENT_SOURCE_CAPABILITIES.dokploy.status).toBe(false)
  })

  it('tells deployment sources from the others', () => {
    expect(isDeploymentSourceKind('coolify')).toBe(true)
    expect(isDeploymentSourceKind('dokploy')).toBe(true)
    expect(isDeploymentSourceKind('docker')).toBe(true)
    expect(isDeploymentSourceKind('github')).toBe(false)
    expect(isDeploymentSourceKind('osv')).toBe(false)
  })
})

describe('deploymentGuardCapabilities', () => {
  it('reads each container check from the source declarations', () => {
    expect(deploymentGuardCapabilities('root_user')).toEqual({
      coolify: 'partial',
      manual: 'unknown',
      docker: 'full',
    })
    expect(deploymentGuardCapabilities('docker_socket')).toEqual({
      coolify: 'partial',
      manual: 'unknown',
      docker: 'full',
    })
    expect(deploymentGuardCapabilities('shared_network')).toEqual({
      coolify: 'partial',
      manual: 'unknown',
      docker: 'full',
    })
    expect(deploymentGuardCapabilities('watch_paths_skip')).toEqual({
      coolify: 'full',
      manual: 'unknown',
    })
  })

  it('answers the container checks in full for a Docker host, watch paths not at all', () => {
    for (const check of ['root_user', 'docker_socket', 'shared_network'] as const) {
      expect(deploymentGuardCapabilities(check).docker).toBe('full')
    }
    expect(deploymentGuardCapabilities('watch_paths_skip').docker).toBeUndefined()
  })

  it('answers nothing for checks that read the repo, not the container', () => {
    expect(deploymentGuardCapabilities('runtime_support')).toEqual({})
  })
})
