import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GuardLevelBadge, GuardResultBadge } from './guard-badges'

/** The badge and its icon, as the look to compare: class of the badge and of the svg. */
function look(label: string) {
  const badge = screen.getByText(label).closest('[data-slot="badge"]') ?? screen.getByText(label)
  const svg = badge.querySelector('svg')
  return { badge: badge.className, icon: svg?.getAttribute('class') ?? '' }
}

describe('GuardLevelBadge', () => {
  it('looks the same for a fail whatever severity its check ranks it as', () => {
    const { unmount } = render(<GuardLevelBadge level="fail" severity="high" />)
    const high = look('Fail')
    unmount()
    for (const severity of ['critical', 'moderate', 'low'] as const) {
      const view = render(<GuardLevelBadge level="fail" severity={severity} />)
      expect(look('Fail')).toEqual(high)
      view.unmount()
    }
    const result = render(<GuardResultBadge result="fail" />)
    expect(look('Fail')).toEqual(high)
    result.unmount()
  })

  it('looks the same for a warn whatever severity, and apart from a fail', () => {
    const { unmount } = render(<GuardLevelBadge level="warn" severity="moderate" />)
    const warn = look('Warn')
    unmount()
    render(<GuardLevelBadge level="warn" severity="high" />)
    expect(look('Warn')).toEqual(warn)
    expect(warn.icon).not.toBe('')
    const fail = (() => {
      const view = render(<GuardLevelBadge level="fail" />)
      const out = look('Fail')
      view.unmount()
      return out
    })()
    expect(fail.icon).not.toBe(warn.icon)
    expect(fail.badge).not.toBe(warn.badge)
  })

  it('says in the tooltip what the finding ranks as, without changing the look', () => {
    render(<GuardLevelBadge level="fail" severity="moderate" />)
    expect(screen.getByTitle('Fail, counts as moderate')).toBeInTheDocument()
  })
})
