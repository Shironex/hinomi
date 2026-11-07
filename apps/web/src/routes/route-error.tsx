import { useQueryErrorResetBoundary } from '@tanstack/react-query'
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useEffect } from 'react'
import { ErrorState } from '@/components/states/error-state'

/** Shown inside the shell when a route throws while loading or rendering. */
export type RouteErrorProps = ErrorComponentProps

export function RouteError({ error, reset }: RouteErrorProps) {
  const router = useRouter()
  const queryReset = useQueryErrorResetBoundary()

  useEffect(() => {
    queryReset.reset()
  }, [queryReset])

  return (
    <ErrorState
      title="This page did not load"
      error={error}
      onRetry={() => {
        reset()
        void router.invalidate()
      }}
    />
  )
}
