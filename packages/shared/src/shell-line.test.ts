import { describe, expect, it } from 'vitest'
import { tokenizeShellLine } from './shell-line.js'

describe('tokenizeShellLine', () => {
  it('splits on any whitespace including newlines', () => {
    expect(tokenizeShellLine('  --user  1000\n--init\t--rm ')).toEqual([
      '--user',
      '1000',
      '--init',
      '--rm',
    ])
  })

  it('returns nothing for an empty line', () => {
    expect(tokenizeShellLine('')).toEqual([])
    expect(tokenizeShellLine('   ')).toEqual([])
  })

  it('keeps spaces inside quotes and drops the quotes', () => {
    expect(tokenizeShellLine(`--label "a b" --env 'c d'`)).toEqual([
      '--label',
      'a b',
      '--env',
      'c d',
    ])
  })

  it('keeps an empty quoted word', () => {
    expect(tokenizeShellLine(`--user ""`)).toEqual(['--user', ''])
  })

  it('joins quoted and bare parts of one word', () => {
    expect(tokenizeShellLine(`--name=my"-app 1"'-x'`)).toEqual(['--name=my-app 1-x'])
  })

  it('treats single quotes inside double quotes and the reverse as text', () => {
    expect(tokenizeShellLine(`"it's" 'say "hi"'`)).toEqual(["it's", 'say "hi"'])
  })

  it('honours escapes in double quotes and outside quotes', () => {
    expect(tokenizeShellLine(String.raw`"a \"b\" \\ \$x \n" c\ d`)).toEqual([
      String.raw`a "b" \ $x \n`,
      'c d',
    ])
  })

  it('joins a backslash newline continuation', () => {
    expect(tokenizeShellLine('--user \\\n1000 -v /a:/b')).toEqual(['--user', '1000', '-v', '/a:/b'])
  })

  it('runs an unterminated quote to the end', () => {
    expect(tokenizeShellLine(`--label "open end`)).toEqual(['--label', 'open end'])
  })
})
