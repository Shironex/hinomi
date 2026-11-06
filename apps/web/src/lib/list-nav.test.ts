import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeRowIndex,
  clearListSelection,
  moveListSelection,
  openListSelection,
} from './list-nav'

describe('list navigation', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-list>
        <div data-row><a href="#a" data-row-link>A</a></div>
        <div data-row><a href="#b" data-row-link>B</a></div>
        <div data-row><a href="#c" data-row-link>C</a></div>
      </div>`
  })

  it('moves down and up, clamped to the list, focusing the row link', () => {
    expect(moveListSelection(1)).toBe(0)
    expect(moveListSelection(1)).toBe(1)
    expect(document.activeElement?.textContent).toBe('B')
    expect(moveListSelection(1)).toBe(2)
    expect(moveListSelection(1)).toBe(2)
    expect(moveListSelection(-1)).toBe(1)
  })

  it('starts from the bottom when moving up first', () => {
    expect(moveListSelection(-1)).toBe(2)
  })

  it('opens the selected row and clears selection', () => {
    expect(openListSelection()).toBe(false)
    moveListSelection(1)
    const link = document.querySelector<HTMLAnchorElement>('a[href="#a"]')!
    const click = vi.fn((e: Event) => e.preventDefault())
    link.addEventListener('click', click)
    expect(openListSelection()).toBe(true)
    expect(click).toHaveBeenCalledOnce()
    clearListSelection()
    expect(activeRowIndex()).toBe(-1)
  })

  it('does nothing without a list', () => {
    document.body.innerHTML = ''
    expect(moveListSelection(1)).toBe(-1)
  })
})
