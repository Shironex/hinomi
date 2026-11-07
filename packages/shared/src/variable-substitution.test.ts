import { describe, expect, it } from 'vitest'
import { substituteVariables } from './variable-substitution.js'

const vars: Record<string, string> = { A: 'one', EMPTY: '' }
const lookup = (name: string) => vars[name]
const sub = (text: string, dialect: 'dockerfile' | 'compose' = 'dockerfile') =>
  substituteVariables(text, lookup, dialect)

describe('substituteVariables', () => {
  it('expands plain and braced names', () => {
    expect(sub('x-$A-${A}-y')).toBe('x-one-one-y')
  })

  it('returns null for an unset variable', () => {
    expect(sub('$MISSING')).toBeNull()
    expect(sub('a-${MISSING}')).toBeNull()
  })

  it('applies the default operators', () => {
    expect(sub('${MISSING:-d}')).toBe('d')
    expect(sub('${EMPTY:-d}')).toBe('d')
    expect(sub('${EMPTY-d}')).toBe('')
    expect(sub('${A:-d}')).toBe('one')
    expect(sub('${MISSING:-${A}}')).toBe('one')
    expect(sub('${MISSING:-${ALSO}}')).toBeNull()
  })

  it('applies the alternative operators', () => {
    expect(sub('${A:+alt}')).toBe('alt')
    expect(sub('${MISSING:+alt}')).toBe('')
    expect(sub('${EMPTY:+alt}')).toBe('')
    expect(sub('${EMPTY+alt}')).toBe('alt')
  })

  it('treats ? as required', () => {
    expect(sub('${A:?need}')).toBe('one')
    expect(sub('${MISSING:?need}')).toBeNull()
  })

  it('keeps a lone dollar and honours each dialect escape', () => {
    expect(sub('cost $5 and $')).toBe('cost $5 and $')
    expect(sub(String.raw`\$A`)).toBe('$A')
    expect(sub('$$A', 'compose')).toBe('$A')
    expect(sub(String.raw`\$A`, 'compose')).toBe(String.raw`\one`)
  })

  it('is null for a broken expression', () => {
    expect(sub('${A')).toBeNull()
    expect(sub('${1x}')).toBeNull()
    expect(sub('${A%x}')).toBeNull()
  })
})
