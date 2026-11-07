import { readFileSync } from 'node:fs'
import { renderCallerWorkflow } from '@hinomi/shared'
import { describe, expect, it } from 'vitest'

// docs/runner/hinomi-fix.yml is the caller workflow the docs tell people to copy; it must stay
// exactly what Hinomi renders in the runner panel, placeholder SHA included.

const TEMPLATE = new URL('../../../../docs/runner/hinomi-fix.yml', import.meta.url)

describe('the caller template in the docs', () => {
  it('equals renderCallerWorkflow()', () => {
    expect(readFileSync(TEMPLATE, 'utf8')).toBe(renderCallerWorkflow())
  })
})
