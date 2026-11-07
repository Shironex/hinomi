import { fixRunName, type GithubWebhookEvent } from '@hinomi/shared'
import { z } from 'zod'
import type { FixRunRow } from '../db/schema.js'

// What a delivery says about Hinomi's fix runs: the repo it is about and which of that repo's
// runs it may concern (by workflow run id, run name, PR number, head commit or branch). It never
// says what state a run is in: the tracker polls the runs picked and GitHub's answer to that poll
// is what moves them. A false match only costs one early poll.

const repositorySchema = z.object({
  full_name: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  default_branch: z.string().optional(),
})

const prNumbersSchema = z.array(z.object({ number: z.number().int() })).default([])

const payloadSchemas = {
  workflow_run: z.object({
    workflow_run: z.object({
      id: z.number().int(),
      display_title: z.string().nullish(),
      head_sha: z.string().nullish(),
    }),
  }),
  pull_request: z.object({
    number: z.number().int(),
    pull_request: z.object({
      head: z.object({ ref: z.string(), sha: z.string() }),
    }),
  }),
  check_suite: z.object({
    check_suite: z.object({
      head_sha: z.string(),
      head_branch: z.string().nullish(),
      pull_requests: prNumbersSchema,
    }),
  }),
  check_run: z.object({
    check_run: z.object({
      head_sha: z.string(),
      check_suite: z.object({ head_branch: z.string().nullish() }).nullish(),
      pull_requests: prNumbersSchema,
    }),
  }),
  status: z.object({
    sha: z.string(),
    branches: z.array(z.object({ name: z.string() })).default([]),
  }),
  push: z.object({ ref: z.string(), after: z.string() }),
} as const

type FollowedEvent = keyof typeof payloadSchemas

/** A delivery read for matching: its repo and the test that picks the runs it concerns. */
export interface DeliveryTarget {
  owner: string
  name: string
  /** True for a run of that repo the delivery may concern. `defaultBranch` is the repo's. */
  concerns(run: FixRunRow, defaultBranch: string | null): boolean
}

export type ReadDeliveryResult =
  | { kind: 'target'; target: DeliveryTarget }
  /** `ping`, or an event this build does not follow. */
  | { kind: 'ignored' }
  /** The payload lacks the fields this event carries. */
  | { kind: 'malformed'; message: string }

function isFollowed(event: GithubWebhookEvent): event is FollowedEvent {
  return event in payloadSchemas
}

function sameSha(run: FixRunRow, sha: string | null | undefined): boolean {
  return Boolean(sha) && run.headSha !== null && run.headSha.toLowerCase() === sha?.toLowerCase()
}

function samePr(run: FixRunRow, numbers: readonly { number: number }[]): boolean {
  return run.prNumber !== null && numbers.some((pr) => pr.number === run.prNumber)
}

function concernsFor(event: FollowedEvent, payload: unknown): DeliveryTarget['concerns'] | null {
  switch (event) {
    case 'workflow_run': {
      const parsed = payloadSchemas.workflow_run.safeParse(payload)
      if (!parsed.success) return null
      const { id, display_title } = parsed.data.workflow_run
      return (run) =>
        run.githubRunId === id ||
        (Boolean(display_title) && display_title === fixRunName(run.correlationId))
    }
    case 'pull_request': {
      const parsed = payloadSchemas.pull_request.safeParse(payload)
      if (!parsed.success) return null
      const { number, pull_request } = parsed.data
      return (run) =>
        run.prNumber === number ||
        (run.prNumber === null && run.branch === pull_request.head.ref) ||
        sameSha(run, pull_request.head.sha)
    }
    case 'check_suite': {
      const parsed = payloadSchemas.check_suite.safeParse(payload)
      if (!parsed.success) return null
      const suite = parsed.data.check_suite
      return (run) =>
        sameSha(run, suite.head_sha) ||
        samePr(run, suite.pull_requests) ||
        run.branch === suite.head_branch
    }
    case 'check_run': {
      const parsed = payloadSchemas.check_run.safeParse(payload)
      if (!parsed.success) return null
      const check = parsed.data.check_run
      return (run) =>
        sameSha(run, check.head_sha) ||
        samePr(run, check.pull_requests) ||
        run.branch === check.check_suite?.head_branch
    }
    case 'status': {
      const parsed = payloadSchemas.status.safeParse(payload)
      if (!parsed.success) return null
      const { sha, branches } = parsed.data
      return (run) => sameSha(run, sha) || branches.some((b) => b.name === run.branch)
    }
    case 'push': {
      const parsed = payloadSchemas.push.safeParse(payload)
      if (!parsed.success) return null
      const { ref } = parsed.data
      // The fix branch moved, or the default branch did (a fix PR may just have merged).
      return (run, defaultBranch) =>
        ref === `refs/heads/${run.branch}` ||
        (defaultBranch !== null && ref === `refs/heads/${defaultBranch}` && run.prNumber !== null)
    }
  }
}

/**
 * Reads a verified delivery. `push` is followed only when `includePush` is on. Never throws for
 * a payload, whatever it holds.
 */
export function readDelivery(
  event: GithubWebhookEvent,
  payload: unknown,
  options: { includePush: boolean },
): ReadDeliveryResult {
  if (!isFollowed(event) || (event === 'push' && !options.includePush)) return { kind: 'ignored' }
  const repository = z.object({ repository: repositorySchema }).safeParse(payload)
  if (!repository.success) {
    return { kind: 'malformed', message: `The ${event} payload has no repository` }
  }
  const concerns = concernsFor(event, payload)
  if (!concerns) {
    return { kind: 'malformed', message: `The ${event} payload is missing fields Hinomi reads` }
  }
  const [owner = '', name = ''] = repository.data.repository.full_name.split('/')
  const payloadDefault = repository.data.repository.default_branch ?? null
  return {
    kind: 'target',
    target: {
      owner,
      name,
      concerns: (run, defaultBranch) => concerns(run, payloadDefault ?? defaultBranch),
    },
  }
}
