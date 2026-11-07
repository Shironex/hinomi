import { describe, expect, it } from 'vitest'
import { context, deployment, facts, reasonOf, resultFor } from './network-fixtures.js'
import { evaluateSharedNetwork } from './shared-network.js'

const SERVER = 'edge-1'
const blogProject = { key: 'proj-blog', name: 'kestrel-blog', environment: 'production' }

describe('shared_network', () => {
  it('warns for apps of two projects on one destination', () => {
    const shop = deployment(1, 'kestrel-shop-web')
    const blog = deployment(2, 'kestrel-blog-web', { facts: facts({ project: blogProject }) })
    const results = evaluateSharedNetwork(context([shop, blog]))
    const result = resultFor(results, 1)
    expect(result.level).toBe('warn')
    expect(result.level !== null && result.evidence).toMatchObject({
      basis: 'coolify_destination',
      destination: { server: SERVER, id: 3 },
      project: 'kestrel-shop',
      peers: [
        { deploymentId: 2, name: 'kestrel-blog-web', project: 'kestrel-blog', database: false },
      ],
    })
    expect(resultFor(results, 2).level).toBe('warn')
  })

  it('fails when a database of another project is on the network', () => {
    const shop = deployment(1, 'kestrel-shop-db', { kind: 'database' })
    const blog = deployment(2, 'kestrel-blog-web', { facts: facts({ project: blogProject }) })
    const results = evaluateSharedNetwork(context([shop, blog]))
    expect(resultFor(results, 2).level).toBe('fail')
    const blogEvidence = resultFor(results, 2)
    expect(blogEvidence.level !== null && blogEvidence.evidence).toMatchObject({
      peers: [{ name: 'kestrel-shop-db', database: true }],
    })
    // The database itself sits next to an app of another project: a warn, not a fail.
    expect(resultFor(results, 1).level).toBe('warn')
  })

  it('passes for resources of one project on a destination', () => {
    const results = evaluateSharedNetwork(
      context([deployment(1, 'kestrel-shop-web'), deployment(2, 'kestrel-shop-worker')]),
    )
    expect(resultFor(results, 1).level).toBe('pass')
    expect(resultFor(results, 2).level).toBe('pass')
  })

  it('passes for a service that keeps its own network', () => {
    const service = deployment(1, 'kestrel-shop-cache', {
      kind: 'service',
      facts: facts({ attachedToDestination: false }),
    })
    const blog = deployment(2, 'kestrel-blog-web', { facts: facts({ project: blogProject }) })
    const results = evaluateSharedNetwork(context([service, blog]))
    expect(resultFor(results, 1).level).toBe('pass')
    expect(resultFor(results, 2).level).toBe('pass')
  })

  it('keeps destinations of other ids, servers and sources apart', () => {
    const other = (over: Parameters<typeof facts>[0], row: Parameters<typeof deployment>[2] = {}) =>
      deployment(2, 'kestrel-blog-web', { facts: facts({ project: blogProject, ...over }), ...row })
    const shop = deployment(1, 'kestrel-shop-web')
    const destination = facts().destination!
    for (const peer of [
      other({ destination: { ...destination, id: 4 } }),
      other({ destination: { ...destination, server: 'edge-2' } }),
      other({}, { sourceId: 2 }),
    ]) {
      expect(resultFor(evaluateSharedNetwork(context([shop, peer])), 1).level).toBe('pass')
    }
  })

  it('warns for apps of two projects that name the same external network', () => {
    const shared = [{ origin: 'run_options' as const, name: 'shared-cache', service: null }]
    const shop = deployment(1, 'kestrel-shop-web', {
      facts: facts({ attachedToDestination: false, networks: shared }),
    })
    const blog = deployment(2, 'kestrel-blog-web', {
      facts: facts({ attachedToDestination: false, project: blogProject, networks: shared }),
    })
    const result = resultFor(evaluateSharedNetwork(context([shop, blog])), 1)
    expect(result.level).toBe('warn')
    expect(result.level !== null && result.evidence).toMatchObject({
      basis: 'external_network',
      network: 'shared-cache',
      destination: null,
    })
  })

  it('gives host network its own text', () => {
    const host = deployment(1, 'kestrel-shop-proxy', { facts: facts({ hostNetwork: true }) })
    const result = resultFor(evaluateSharedNetwork(context([host])), 1)
    expect(result.level).toBe('warn')
    expect(result.level !== null && result.evidence).toMatchObject({
      basis: 'host_network',
      peers: [],
    })
    expect(reasonOf(result)).toContain('host network')
  })

  it('is unknown when the facts have gaps, never a pass', () => {
    const noFacts = deployment(1, 'kestrel-shop-web', { facts: null })
    const noProject = deployment(2, 'kestrel-blog-web', {
      facts: facts({
        project: null,
        gaps: { project: 'the project could not be read from Coolify' },
      }),
    })
    const compose = deployment(3, 'kestrel-shop-stack', {
      kind: 'service',
      facts: facts({
        attachedToDestination: null,
        gaps: {
          networks:
            'Coolify did not say whether this compose resource joins the destination network',
        },
      }),
    })
    const noDestination = deployment(4, 'kestrel-shop-api', {
      facts: facts({
        destination: null,
        gaps: { destination: 'Coolify did not report the destination' },
      }),
    })
    const results = evaluateSharedNetwork(context([noFacts, noProject, compose, noDestination]))
    for (const id of [1, 2, 3, 4]) expect(resultFor(results, id).level).toBe('unknown')
    expect(reasonOf(resultFor(results, 2))).toContain('project')
    expect(reasonOf(resultFor(results, 3))).toContain('compose')
    expect(reasonOf(resultFor(results, 4))).toContain('destination')
  })

  it('ignores peers whose project is unknown', () => {
    const shop = deployment(1, 'kestrel-shop-web')
    const stray = deployment(2, 'stray', { facts: facts({ project: null }) })
    expect(resultFor(evaluateSharedNetwork(context([shop, stray])), 1).level).toBe('pass')
  })
})
