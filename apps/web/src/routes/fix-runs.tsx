import { useMemo } from 'react'
import type { FixPlanRef, FixRun, RepoRef } from '@hinomi/shared'
import { useQueries, useQuery } from '@tanstack/react-query'
import { getRouteApi, Link } from '@tanstack/react-router'
import { IconRadar2, IconRobot } from '@tabler/icons-react'
import { FixRunRow } from '@/components/fix-runs/fix-run-row'
import { PlanPane } from '@/components/fix-runs/plan-pane'
import { PlanRow } from '@/components/fix-runs/plan-row'
import { RunPane } from '@/components/fix-runs/run-pane'
import { SplitListFooter, SplitListHeader } from '@/components/split/split-parts'
import { SplitView } from '@/components/split/split-view'
import { DetailEmpty } from '@/components/states/detail-empty'
import { ErrorState } from '@/components/states/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { SPLIT_QUERY, useMediaQuery } from '@/hooks/use-media-query'
import { plansQuery, repoRunsQuery } from '@/lib/fix-api'
import { planKey, runUrgency } from '@/lib/fix-run-meta'
import { requestFix } from '@/lib/fix-request'

const route = getRouteApi('/fix-runs')

/** Runs listed under each repo; older ones stay in the repo's plan pane. */
const RUNS_PER_REPO = 5

type Item =
  | { type: 'plan'; repo: RepoRef; plan: FixPlanRef; runs: readonly FixRun[] }
  | { type: 'run'; repo: RepoRef; run: FixRun }

const itemKey = (item: Item) => (item.type === 'plan' ? planKey(item.repo.id) : item.run.id)

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading fix plans" className="flex flex-col gap-3 p-[18px]">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  )
}

function NoPlans() {
  return (
    <DetailEmpty
      icon={IconRobot}
      title="No fix plans yet"
      actions={
        <Button asChild>
          <Link to="/">
            <IconRadar2 aria-hidden="true" />
            Pick a finding to fix
          </Link>
        </Button>
      }
    >
      <p>
        Every scan builds one upgrade plan per repo. Fix with Hinomi runs it on the runner you pick
        per repo (its own GitHub Actions by default), opens one pull request, follows its checks and
        shows each run here until a rescan verifies the fix.
      </p>
      <p className="text-sm text-muted-foreground">
        The runner is off for every repo until you turn it on, only gets the GitHub permissions you
        grant, and never merges a fix on its own.
      </p>
    </DetailEmpty>
  )
}

/** Plans per repo with their runs, the repos that need a person first. */
export function FixRunsPage() {
  const wide = useMediaQuery(SPLIT_QUERY)
  const search = route.useSearch()
  const plans = useQuery(plansQuery)
  const planItems = useMemo(() => plans.data?.items ?? [], [plans.data])
  const runQueries = useQueries({ queries: planItems.map((p) => repoRunsQuery(p.repoId)) })
  const runsByRepo = runQueries.map((q) => q.data?.items ?? [])
  const selected = search.sel === undefined ? undefined : String(search.sel)

  const repos = planItems
    .map((plan, i) => ({ plan, runs: runsByRepo[i] ?? [], i }))
    .sort((a, b) => runUrgency(a.runs[0]?.state) - runUrgency(b.runs[0]?.state) || a.i - b.i)
  const items: Item[] = repos.flatMap(({ plan, runs }) => {
    const shown = runs.filter((run, i) => i < RUNS_PER_REPO || String(run.id) === selected)
    return [
      { type: 'plan' as const, repo: plan.repo, plan, runs },
      ...shown.map((run) => ({ type: 'run' as const, repo: plan.repo, run })),
    ]
  })
  const attention = repos.filter((r) => runUrgency(r.runs[0]?.state) === 0).length
  const live = repos.filter((r) => runUrgency(r.runs[0]?.state) === 1).length

  const empty = <NoPlans />
  return (
    <SplitView<Item>
      items={items}
      getKey={itemKey}
      getLabel={(item) =>
        item.type === 'plan' ? `${item.repo.name} plan` : `${item.repo.name} run ${item.run.id}`
      }
      listLabel="Fix plans and runs"
      listHeader={
        <SplitListHeader
          title="Fix runs"
          meta={
            attention
              ? `${attention} need${attention === 1 ? 's' : ''} a person`
              : live
                ? `${live} running`
                : undefined
          }
        />
      }
      getGroup={(item) => ({ key: String(item.repo.id), label: item.repo.fullName })}
      renderRow={(item) =>
        item.type === 'plan' ? (
          <PlanRow plan={item.plan} latest={item.runs[0]} />
        ) : (
          <FixRunRow run={item.run} />
        )
      }
      renderDetail={(item, { focused }) =>
        item.type === 'plan' ? (
          <PlanPane key={item.repo.id} repo={item.repo} runs={item.runs} focused={focused} />
        ) : (
          <RunPane key={item.run.id} run={item.run} repo={item.repo} focused={focused} />
        )
      }
      actions={{
        fix: (item) => requestFix({ repos: [{ id: item.repo.id, fullName: item.repo.fullName }] }),
      }}
      emptyList={
        plans.error ? (
          <div className="p-[18px]">
            <ErrorState
              title="Fix plans did not load"
              error={plans.error}
              onRetry={() => void plans.refetch()}
            />
          </div>
        ) : !plans.data ? (
          <ListSkeleton />
        ) : wide ? (
          <p className="px-[18px] py-[18px] text-xs text-foreground-2">Nothing here yet</p>
        ) : (
          <div className="px-4 pt-8 pb-10 tab:px-7">{empty}</div>
        )
      }
      emptyDetail={plans.data ? <div className="pt-14">{empty}</div> : undefined}
      listFooter={
        items.length ? (
          <SplitListFooter>Repos that need a person first, then running fixes</SplitListFooter>
        ) : undefined
      }
    />
  )
}
