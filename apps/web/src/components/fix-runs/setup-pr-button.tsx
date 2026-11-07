import type { RunnerStatus, SetupPrResponse } from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconExternalLink, IconGitPullRequest, IconLoader2 } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/errors'
import { fixKeys, openSetupPr } from '@/lib/fix-api'

function Outcome({ result }: { result: SetupPrResponse }) {
  if (!result.pr) {
    return (
      <span className="text-sm text-foreground-2">
        Already set up: <span className="font-mono">{result.path}</span> pins {result.version}.
      </span>
    )
  }
  return (
    <a
      href={result.pr.url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-sm text-accent-ink hover:underline"
    >
      <IconExternalLink aria-hidden="true" className="size-3.5" />
      {result.outcome === 'created' ? 'Opened' : 'Updated'} setup PR #{result.pr.number}, pins{' '}
      {result.version}
    </a>
  )
}

/**
 * Has Hinomi open the pull request that adds the caller workflow, or moves an outdated pin to
 * the latest release. When the credential cannot, it says why instead.
 */
export function SetupPrButton({ status, repoId }: { status: RunnerStatus; repoId: number }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => openSetupPr(repoId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: fixKeys.runner(repoId) }),
  })
  const label = status.caller.outdated ? 'Update pin PR' : 'Open setup PR'
  if (!status.setupPr.available) {
    return <p className="text-xs text-muted-foreground">{status.setupPr.reason}</p>
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? (
            <IconLoader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <IconGitPullRequest aria-hidden="true" />
          )}
          {label}
        </Button>
        {mutation.data ? (
          <span aria-live="polite">
            <Outcome result={mutation.data} />
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{status.setupPr.reason}</span>
        )}
      </div>
      {mutation.error ? (
        <p role="alert" className="text-sm text-sev-critical">
          {describeError(mutation.error)}
        </p>
      ) : null}
    </div>
  )
}
