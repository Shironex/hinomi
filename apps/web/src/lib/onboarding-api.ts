import {
  onboardingStateSchema,
  type OnboardingStateDto,
  type UpdateOnboardingRequest,
} from '@hinomi/shared'
import { queryOptions } from '@tanstack/react-query'
import { api, request } from './api'

/** First run state from GET /api/onboarding, kept on the server so every tab agrees. */
export const onboardingKeys = { state: ['onboarding'] as const }

export const onboardingQuery = queryOptions({
  queryKey: onboardingKeys.state,
  queryFn: ({ signal }) => api.get('/onboarding', onboardingStateSchema, { signal }),
})

export const updateOnboarding = (body: UpdateOnboardingRequest): Promise<OnboardingStateDto> =>
  request('/onboarding', onboardingStateSchema, { method: 'PATCH', json: body })
