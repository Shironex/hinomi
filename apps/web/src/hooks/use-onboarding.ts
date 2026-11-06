import type { OnboardingStateDto, UpdateOnboardingRequest } from '@hinomi/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { onboardingKeys, onboardingQuery, updateOnboarding } from '@/lib/onboarding-api'

const NOT_STARTED: OnboardingStateDto = { finished: false, alertsSkipped: false }

/**
 * The server side first run state and a setter. Updates show at once and roll
 * back if the server refuses them; while the state loads (or cannot load)
 * setup starts from the beginning.
 */
export function useOnboarding() {
  const queryClient = useQueryClient()
  const query = useQuery(onboardingQuery)
  const mutation = useMutation({
    mutationFn: updateOnboarding,
    onMutate: async (patch: UpdateOnboardingRequest) => {
      await queryClient.cancelQueries({ queryKey: onboardingKeys.state })
      const previous = queryClient.getQueryData<OnboardingStateDto>(onboardingKeys.state)
      queryClient.setQueryData<OnboardingStateDto>(onboardingKeys.state, {
        ...(previous ?? NOT_STARTED),
        ...patch,
      })
      return { previous }
    },
    onError: (_error, _patch, context) => {
      queryClient.setQueryData(onboardingKeys.state, context?.previous)
    },
    onSuccess: (data) => queryClient.setQueryData(onboardingKeys.state, data),
  })
  return {
    state: query.data ?? NOT_STARTED,
    isPending: query.isPending,
    /** Stable across renders (TanStack keeps `mutate` stable), so it is safe in effect deps. */
    update: mutation.mutate,
  }
}
