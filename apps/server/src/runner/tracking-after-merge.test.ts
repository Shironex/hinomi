import { describe, expect, it } from 'vitest'
import { afterMergeExpectation } from './tracking.js'
import type { FixRunDeployment } from '@hinomi/shared'

const link = (status: FixRunDeployment['status']): FixRunDeployment => ({
  deploymentId: 1,
  name: 'harbor-web',
  branch: 'main',
  status,
  deploy: null,
  checkedAt: null,
  error: null,
})

describe('afterMergeExpectation', () => {
  it('rescans after the merge when no app builds the default branch', () => {
    expect(afterMergeExpectation({ deployLinks: null }, [], 'main')).toEqual({
      expects: 'rescan_after_merge',
    })
    expect(afterMergeExpectation({ deployLinks: null }, [{ gitBranch: 'next' }], 'main')).toEqual({
      expects: 'rescan_after_merge',
    })
  })

  it('counts the apps on the default branch, or on an unknown one', () => {
    const apps = [{ gitBranch: 'main' }, { gitBranch: null }, { gitBranch: 'next' }]
    expect(afterMergeExpectation({ deployLinks: null }, apps, 'main')).toEqual({
      expects: 'deploy',
      apps: 2,
    })
    expect(afterMergeExpectation({ deployLinks: null }, apps, null)).toEqual({
      expects: 'deploy',
      apps: 3,
    })
  })

  it('follows the links once the tracker recorded them, as the tracker does', () => {
    const links = [link('waiting'), link('other_branch')]
    expect(afterMergeExpectation({ deployLinks: links }, [], 'main')).toEqual({
      expects: 'deploy',
      apps: 1,
    })
    expect(
      afterMergeExpectation(
        { deployLinks: [link('other_branch')] },
        [{ gitBranch: 'main' }],
        'main',
      ),
    ).toEqual({ expects: 'rescan_after_merge' })
  })
})
