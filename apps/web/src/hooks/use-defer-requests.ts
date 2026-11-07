import type { FindingListItem } from '@hinomi/shared'
import { useCallback, useState } from 'react'
import { requestFix } from '@/lib/fix-request'
import type { DeferKind } from '@/lib/view-api'

/** A request from the list (s or a on the selected row) to open the decision form. */
export interface DeferRequest {
  id: number
  kind: DeferKind
  /** Bumped on every key press, so pressing s twice reopens a closed form. */
  n: number
}

/** f on an advisory with a repo: the dispatch dialog for that repo's plan. */
function fixFinding(item: Pick<FindingListItem, 'id' | 'kind' | 'repo'>) {
  if (item.kind !== 'advisory' || !item.repo) return
  requestFix({ repos: [{ id: item.repo.id, fullName: item.repo.fullName }], findingId: item.id })
}

/**
 * The f, s and a keys of a split list: f opens Fix with Hinomi for the finding's repo, s and a
 * ask the selected finding's pane to open its decision form. Fixed findings take no decision.
 */
export function useDeferRequests() {
  const [request, setRequest] = useState<DeferRequest | null>(null)
  const ask = useCallback(
    (kind: DeferKind) => (item: Pick<FindingListItem, 'id' | 'state'>) => {
      if (item.state === 'fixed') return
      setRequest((prev) => ({ id: item.id, kind, n: (prev?.n ?? 0) + 1 }))
    },
    [],
  )
  return {
    request,
    actions: { fix: fixFinding, snooze: ask('snooze'), accept: ask('accept') },
  }
}
