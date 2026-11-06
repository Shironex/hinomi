import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  CHORD_TIMEOUT_MS,
  createShortcutHandler,
  isTypingTarget,
  type ShortcutActions,
} from './shortcuts'

function makeActions(overrides: Partial<Record<keyof ShortcutActions, Mock>> = {}) {
  return {
    navigate: vi.fn<ShortcutActions['navigate']>(),
    toggleTheme: vi.fn<ShortcutActions['toggleTheme']>(),
    toggleHelp: vi.fn<ShortcutActions['toggleHelp']>(),
    focusSearch: vi.fn<ShortcutActions['focusSearch']>(),
    moveSelection: vi.fn<ShortcutActions['moveSelection']>(),
    openSelection: vi.fn<ShortcutActions['openSelection']>(() => true),
    listAction: vi.fn<ShortcutActions['listAction']>(),
    escape: vi.fn<ShortcutActions['escape']>(() => true),
    isDialogOpen: vi.fn<ShortcutActions['isDialogOpen']>(() => false),
    ...overrides,
  }
}

function press(
  handler: (e: KeyboardEvent) => void,
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = document.body,
) {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init })
  Object.defineProperty(event, 'target', { value: target })
  handler(event)
  return event
}

describe('createShortcutHandler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([
    ['e', '/'],
    ['d', '/deployments'],
    ['a', '/alerts'],
    ['f', '/fix-runs'],
    ['s', '/settings'],
  ])('g then %s goes to %s', (key, path) => {
    const actions = makeActions()
    const handler = createShortcutHandler(actions)
    press(handler, 'g')
    const event = press(handler, key)
    expect(actions.navigate).toHaveBeenCalledWith(path)
    expect(event.defaultPrevented).toBe(true)
  })

  it('forgets a pending g after the chord timeout', () => {
    const actions = makeActions()
    const handler = createShortcutHandler(actions)
    press(handler, 'g')
    vi.advanceTimersByTime(CHORD_TIMEOUT_MS + 1)
    press(handler, 'd')
    expect(actions.navigate).not.toHaveBeenCalled()
  })

  it('does not treat the second key of an unknown chord as a shortcut', () => {
    const actions = makeActions()
    const handler = createShortcutHandler(actions)
    press(handler, 'g')
    press(handler, 't')
    expect(actions.toggleTheme).not.toHaveBeenCalled()
    expect(actions.navigate).not.toHaveBeenCalled()
  })

  it('maps single keys to their actions', () => {
    const actions = makeActions()
    const handler = createShortcutHandler(actions)
    press(handler, 't')
    expect(press(handler, '?').defaultPrevented).toBe(true)
    expect(press(handler, '/').defaultPrevented).toBe(true)
    press(handler, 'j')
    press(handler, 'k')
    press(handler, 'Enter')
    expect(actions.toggleTheme).toHaveBeenCalledOnce()
    expect(actions.toggleHelp).toHaveBeenCalledOnce()
    expect(actions.focusSearch).toHaveBeenCalledOnce()
    expect(actions.moveSelection.mock.calls).toEqual([[1], [-1]])
    expect(actions.openSelection).toHaveBeenCalledOnce()
  })

  it('sends f, s, a and Esc to the list actions', () => {
    const actions = makeActions()
    const handler = createShortcutHandler(actions)
    press(handler, 'f')
    press(handler, 's')
    press(handler, 'a')
    expect(press(handler, 'Escape').defaultPrevented).toBe(true)
    expect(actions.listAction.mock.calls).toEqual([['fix'], ['snooze'], ['accept']])
    expect(actions.escape).toHaveBeenCalledOnce()
  })

  it('leaves Esc alone when nothing closes', () => {
    const actions = makeActions({ escape: vi.fn<ShortcutActions['escape']>(() => false) })
    const handler = createShortcutHandler(actions)
    expect(press(handler, 'Escape').defaultPrevented).toBe(false)
  })

  it('ignores keys while typing in a field', () => {
    const actions = makeActions()
    const handler = createShortcutHandler(actions)
    const input = document.createElement('input')
    for (const key of ['t', '/', 'j', '?', 'g']) press(handler, key, {}, input)
    press(handler, 'd', {}, input)
    expect(Object.values(actions).every((fn) => fn.mock.calls.length === 0)).toBe(true)
  })

  it('ignores keys with a modifier so browser shortcuts keep working', () => {
    const actions = makeActions()
    const handler = createShortcutHandler(actions)
    press(handler, 't', { metaKey: true })
    press(handler, 'k', { ctrlKey: true })
    press(handler, '/', { altKey: true })
    expect(actions.toggleTheme).not.toHaveBeenCalled()
    expect(actions.moveSelection).not.toHaveBeenCalled()
    expect(actions.focusSearch).not.toHaveBeenCalled()
  })

  it('leaves Enter alone on a focused link or button', () => {
    const actions = makeActions()
    const handler = createShortcutHandler(actions)
    press(handler, 'Enter', {}, document.createElement('button'))
    expect(actions.openSelection).not.toHaveBeenCalled()
  })

  it('only handles ? while a dialog is open', () => {
    const actions = makeActions({
      isDialogOpen: vi.fn<ShortcutActions['isDialogOpen']>(() => true),
    })
    const handler = createShortcutHandler(actions)
    press(handler, 't')
    press(handler, 'j')
    press(handler, '?')
    expect(actions.toggleTheme).not.toHaveBeenCalled()
    expect(actions.moveSelection).not.toHaveBeenCalled()
    expect(actions.toggleHelp).toHaveBeenCalledOnce()
  })
})

describe('isTypingTarget', () => {
  it('treats text fields and editable content as typing', () => {
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    expect(isTypingTarget(document.createElement('select'))).toBe(true)
    expect(isTypingTarget(editable)).toBe(true)
  })

  it('does not treat checkboxes or buttons as typing', () => {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    expect(isTypingTarget(checkbox)).toBe(false)
    expect(isTypingTarget(document.createElement('button'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
