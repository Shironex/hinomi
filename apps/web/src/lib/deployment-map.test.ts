import { describe, expect, it } from 'vitest'
import { deploymentItem, findingItem } from '@/test/fixtures'
import {
  bumpsThatClear,
  compareVersions,
  deploymentFacts,
  groupByServer,
  heatLevel,
} from './deployment-map'

describe('heatLevel', () => {
  it('steps at 1, 35 and 60 exposed findings', () => {
    expect([0, 1, 34, 35, 59, 60, 400].map(heatLevel)).toEqual([0, 1, 1, 2, 2, 3, 3])
  })
})

describe('deploymentFacts', () => {
  it('keeps unknown, image only and stopped apps off the heat scale', () => {
    const unmapped = deploymentItem({ repos: [], exposed: 0, openBlindSpots: 1 })
    expect(deploymentFacts(unmapped)).toMatchObject({ unmapped: true, blind: false, heat: 0 })
    const stopped = deploymentItem({ status: 'exited:0', exposed: 70 })
    expect(deploymentFacts(stopped)).toMatchObject({ stopped: true, heat: 0 })
    const hot = deploymentItem({ exposed: 70, openBlindSpots: 2 })
    expect(deploymentFacts(hot)).toMatchObject({ blind: true, heat: 3, open: 12 })
  })
})

describe('groupByServer', () => {
  it('puts public servers first by exposure, internal next and an unknown server last', () => {
    const groups = groupByServer([
      deploymentItem({ id: 1, server: null, exposed: 90 }),
      deploymentItem({ id: 2, server: 'core-1', reach: 'internal', exposed: 0 }),
      deploymentItem({ id: 3, server: 'edge-1', exposed: 3 }),
      deploymentItem({ id: 4, server: 'edge-2', exposed: 10, name: 'b' }),
      deploymentItem({ id: 5, server: 'edge-2', exposed: 20, name: 'a' }),
    ])
    expect(groups.map((g) => [g.server, g.role, g.items.map((d) => d.id)])).toEqual([
      ['edge-2', 'public edge', [5, 4]],
      ['edge-1', 'public edge', [3]],
      ['core-1', 'internal network', [2]],
      [null, 'public edge', [1]],
    ])
  })
})

describe('compareVersions', () => {
  it('compares number by number', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0)
    expect(compareVersions('2.0.7', '2.0.7')).toBe(0)
    expect(compareVersions('2.0', '2.0.1')).toBeLessThan(0)
  })
})

describe('bumpsThatClear', () => {
  const adv = (id: number, pkg: string, patched: string | null, tier = 'exposed' as const) => {
    const base = findingItem()
    return findingItem({
      id,
      tier,
      advisory: base.advisory && {
        ...base.advisory,
        packageName: pkg,
        firstPatchedVersion: patched,
      },
    })
  }

  it('groups exposed advisories by package and bumps to the highest patch', () => {
    const bumps = bumpsThatClear([
      adv(1, 'tessera', '14.2.6'),
      adv(2, 'tessera', '14.2.9'),
      adv(3, 'quillparse', '2.0.7'),
      adv(4, 'imgsharp', null),
      adv(5, 'imgsharp', null),
      adv(6, 'tessera', null),
      findingItem({ id: 7, tier: 'internal' }),
    ])
    expect(bumps).toEqual([
      { packageName: 'tessera', to: '14.2.9', clears: 2, waiting: 1 },
      { packageName: 'quillparse', to: '2.0.7', clears: 1, waiting: 0 },
      { packageName: 'imgsharp', to: null, clears: 0, waiting: 2 },
    ])
  })
})
