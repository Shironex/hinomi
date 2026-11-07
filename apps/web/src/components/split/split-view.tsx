import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { IconChevronDown, IconChevronLeft, IconChevronUp } from '@tabler/icons-react'
import { SPLIT_QUERY, useMediaQuery } from '@/hooks/use-media-query'
import { registerSplit, type ListAction, type SplitController } from '@/lib/split-nav'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import { KeyHintBar } from '@/components/shell/key-hint-bar'
import type { KeyHint } from '@/components/shell/key-hints-meta'
import { TopBar } from '@/components/shell/top-bar'
import { SplitListGroup } from './split-parts'

export type SplitKey = string | number

export interface SplitRowState {
  selected: boolean
  index: number
}

export interface SplitDetailState {
  /** True in the focus view (Enter): the list is hidden and the detail can use two columns. */
  focused: boolean
  index: number
  total: number
}

export interface SplitGroup {
  key: string
  label: ReactNode
  count?: ReactNode
}

export interface SplitViewProps<T> {
  items: readonly T[]
  /** Stable id of an item; it is what goes in the URL as `?sel=`. */
  getKey: (item: T) => SplitKey
  /** Short name of an item for the breadcrumb ("tessera"). */
  getLabel: (item: T) => string
  /** Accessible name of the list ("Findings that need action"). */
  listLabel: string
  renderRow: (item: T, state: SplitRowState) => ReactNode
  /**
   * A control in front of the row link, outside it (a bulk select checkbox): links cannot hold
   * other interactive elements. The selection highlight then covers both.
   */
  renderRowLead?: (item: T, state: SplitRowState) => ReactNode
  renderDetail: (item: T, state: SplitDetailState) => ReactNode
  /** Group headings between rows: called per item, a heading is drawn when the key changes. */
  getGroup?: (item: T) => SplitGroup | undefined
  /** Top of the list pane, usually a SplitListHeader (holds the page's h1). */
  listHeader?: ReactNode
  /** Foot of the list pane, usually a SplitListFooter. */
  listFooter?: ReactNode
  /** In the list pane while there are no items: loading, empty or error state. */
  emptyList?: ReactNode
  /** In the detail pane while there is nothing to show. */
  emptyDetail?: ReactNode
  /** f, s and a on the selected item. Keys without a handler do nothing and are not hinted. */
  actions?: Partial<Record<ListAction, (item: T) => void>>
  /** The list header has a search field marked data-search-input; adds "/ search" to the hints. */
  searchable?: boolean
  /** Esc when the split has nothing of its own to leave (wide, not in the focus view). True when handled. */
  onEscape?: () => boolean
}

const PARAM = 'sel'

const SELECTED_ROW =
  'bg-[color-mix(in_oklab,var(--primary)_13%,var(--background))] shadow-[inset_3px_0_0_var(--primary)]'

/**
 * The split triage layout: a ranked list pane (440 px) beside the live detail of the selected
 * item. The selection lives in the URL (`?sel=`), so a reload or a shared link keeps it.
 *
 * From 1100 px both panes show; nothing selected means the first item. Keys: j and k move,
 * Enter opens the focus view (list hidden behind a position strip), Esc leaves it, f s a run
 * the view's actions. Below 1100 px it is list then detail: a row opens its detail as its own
 * page (same route, `?sel=` set), with back, previous and next.
 *
 * The route needs `staticData.layout: 'split'` and `splitSearchSchema` in its validateSearch.
 */
export function SplitView<T>(props: SplitViewProps<T>) {
  const { items, getKey, getLabel, listLabel, actions, searchable } = props
  const wide = useMediaQuery(SPLIT_QUERY)
  const navigate = useNavigate()
  const search: Record<string, unknown> = useSearch({ strict: false })
  const raw = search[PARAM]
  const selKey = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined
  const found =
    selKey === undefined ? -1 : items.findIndex((item) => String(getKey(item)) === selKey)
  const index = found !== -1 ? found : wide && items.length > 0 ? 0 : -1
  const item = index === -1 ? undefined : items[index]
  const [focusView, setFocusView] = useState(false)
  const focused = focusView && wide && item !== undefined
  const narrowDetail = !wide && found !== -1
  const rowLinks = useRef(new Map<string, HTMLAnchorElement>())
  const scroller = useRef<HTMLDivElement>(null)

  const select = (key: SplitKey | undefined, replace = true) =>
    navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, [PARAM]: key }),
      replace,
    } as never)

  const focusRow = (key: SplitKey) => {
    const link = rowLinks.current.get(String(key))
    if (!link) return
    link.focus({ preventScroll: true })
    link.scrollIntoView?.({ block: 'nearest' })
  }

  const controller: SplitController = {
    move: (delta) => {
      if (items.length === 0) return
      const from = index === -1 ? (delta > 0 ? -1 : items.length) : index
      const next = items[Math.max(0, Math.min(items.length - 1, from + delta))]
      if (next === undefined) return
      const key = getKey(next)
      void select(key).then(() => requestAnimationFrame(() => focusRow(key)))
    },
    open: () => {
      if (!wide || item === undefined) return false
      setFocusView(true)
      return true
    },
    action: (kind) => {
      const run = actions?.[kind]
      if (!run || item === undefined) return false
      run(item)
      return true
    },
    escape: () => {
      if (focused && item !== undefined) {
        setFocusView(false)
        const key = getKey(item)
        requestAnimationFrame(() => focusRow(key))
        return true
      }
      if (narrowDetail) {
        void select(undefined)
        return true
      }
      return props.onEscape?.() ?? false
    },
  }
  const latest = useRef(controller)
  useEffect(() => {
    latest.current = controller
  })

  // Wide, or a narrow detail page: the split owns j, k, Enter, Esc, f, s, a. A narrow list
  // falls back to the shell's DOM list navigation over the data-list rows below.
  const owns = wide || narrowDetail
  useEffect(() => {
    if (!owns) return
    return registerSplit({
      move: (delta) => latest.current.move(delta),
      open: () => latest.current.open(),
      action: (kind) => latest.current.action(kind),
      escape: () => latest.current.escape(),
    })
  }, [owns])

  const itemKey = item === undefined ? undefined : String(getKey(item))
  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 })
  }, [itemKey])

  const onRowKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, key: SplitKey) => {
    // On a wide screen the row is already showing; Enter means the focus view.
    if (event.key !== 'Enter' || !wide || event.metaKey || event.ctrlKey || event.shiftKey) return
    event.preventDefault()
    if (String(key) !== itemKey) void select(key)
    setFocusView(true)
  }

  // An empty list has nothing to move through or focus.
  const listHints: KeyHint[] =
    items.length === 0
      ? []
      : [
          { keys: ['j', 'k'], label: 'move' },
          focused ? { keys: ['Esc'], label: 'back to list' } : { keys: ['Enter'], label: 'focus' },
        ]
  const hints: KeyHint[] = [
    ...listHints,
    ...(actions?.fix ? [{ keys: ['f'], label: 'fix with Hinomi' }] : []),
    ...(actions?.snooze ? [{ keys: ['s'], label: 'snooze' }] : []),
    ...(actions?.accept ? [{ keys: ['a'], label: 'accept' }] : []),
    ...(searchable ? [{ keys: ['/'], label: 'search' }] : []),
  ]

  const detailState = { focused, index, total: items.length }

  if (narrowDetail && item !== undefined) {
    const prev = items[index - 1]
    const next = items[index + 1]
    const navButton = buttonVariants({ variant: 'outline', size: 'icon' })
    return (
      <section aria-label={`${listLabel}, ${getLabel(item)}`} className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 tab:px-7">
          <Link
            to="."
            search={((p: Record<string, unknown>) => ({ ...p, [PARAM]: undefined })) as never}
            aria-label="Back to the list"
            className={navButton}
          >
            <IconChevronLeft aria-hidden="true" />
          </Link>
          <span className="text-md font-semibold tabular-nums">
            #{index + 1} of {items.length}
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              aria-label="Previous"
              disabled={!prev}
              onClick={() => prev !== undefined && void select(getKey(prev))}
              className={navButton}
            >
              <IconChevronUp aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next"
              disabled={!next}
              onClick={() => next !== undefined && void select(getKey(next))}
              className={navButton}
            >
              <IconChevronDown aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="flex flex-col gap-6 px-4 pt-5 pb-8 tab:px-8 tab:pt-7">
          {props.renderDetail(item, detailState)}
        </div>
      </section>
    )
  }

  const lead = props.renderRowLead
  const list = (
    <div
      className={cn(
        'flex flex-col bg-background',
        wide ? 'w-[440px] shrink-0 border-r border-border' : 'min-h-full flex-1',
      )}
    >
      {props.listHeader}
      <div className={cn(wide && 'min-h-0 flex-1 overflow-y-auto')}>
        {items.length === 0 ? (
          props.emptyList
        ) : (
          <ul aria-label={listLabel} data-list="">
            {items.map((entry, i) => {
              const key = getKey(entry)
              const selected = wide && i === index
              const group = props.getGroup?.(entry)
              const prevGroup = i > 0 ? props.getGroup?.(items[i - 1] as T) : undefined
              return (
                <GroupedRow
                  key={String(key)}
                  group={group && group.key !== prevGroup?.key ? group : undefined}
                >
                  <li
                    data-row=""
                    className={cn(
                      lead && 'flex items-start',
                      lead && selected && SELECTED_ROW,
                      lead && 'border-b border-border',
                    )}
                  >
                    {lead ? (
                      <span className="shrink-0 py-[13px] pl-[18px]">
                        {lead(entry, { selected, index: i })}
                      </span>
                    ) : null}
                    <Link
                      to="."
                      search={((p: Record<string, unknown>) => ({ ...p, [PARAM]: key })) as never}
                      replace={wide}
                      data-row-link=""
                      aria-current={selected ? 'true' : undefined}
                      ref={(node) => {
                        if (node) rowLinks.current.set(String(key), node)
                        else rowLinks.current.delete(String(key))
                      }}
                      onKeyDown={(event) => onRowKeyDown(event, key)}
                      className={cn(
                        'block py-[13px] text-foreground-2 no-underline focus-visible:-outline-offset-2',
                        lead
                          ? 'min-w-0 flex-1 pr-[18px] pl-2.5'
                          : 'border-b border-border px-[18px]',
                        selected
                          ? !lead && SELECTED_ROW
                          : 'hover:bg-[color-mix(in_oklab,var(--muted)_55%,transparent)]',
                      )}
                    >
                      {props.renderRow(entry, { selected, index: i })}
                    </Link>
                  </li>
                </GroupedRow>
              )
            })}
          </ul>
        )}
      </div>
      {props.listFooter}
    </div>
  )

  if (!wide) return list

  return (
    <div className="flex h-full min-h-0">
      {focused ? <FocusStrip index={index} total={items.length} /> : list}
      <section
        aria-label={item ? `${listLabel}, ${getLabel(item)}` : listLabel}
        className="flex min-w-0 flex-1 flex-col"
      >
        <TopBar extraCrumb={item ? getLabel(item) : undefined} />
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              'flex flex-col gap-[26px] px-8 pt-7 pb-10',
              focused ? 'max-w-[1220px]' : 'max-w-[980px]',
            )}
          >
            {item === undefined ? props.emptyDetail : props.renderDetail(item, detailState)}
          </div>
        </div>
        <KeyHintBar hints={hints} />
      </section>
    </div>
  )
}

function GroupedRow({ group, children }: { group: SplitGroup | undefined; children: ReactNode }) {
  if (!group) return children
  return (
    <>
      <SplitListGroup label={group.label} count={group.count} />
      {children}
    </>
  )
}

/** Where the selection sits in the list, while the focus view hides it. Decorative. */
function FocusStrip({ index, total }: { index: number; total: number }) {
  const shown = Math.min(total, 9)
  const start = Math.max(0, Math.min(index - 4, total - shown))
  return (
    <div
      aria-hidden="true"
      className="flex w-14 shrink-0 flex-col items-center gap-2.5 border-r border-border bg-background pt-4"
    >
      {Array.from({ length: shown }, (_, i) => (
        <i
          key={start + i}
          className={cn(
            'block h-7 w-1.5 rounded-[3px]',
            start + i === index ? 'bg-primary' : 'bg-input',
          )}
        />
      ))}
    </div>
  )
}
