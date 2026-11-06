import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { settingsKeys, settingsQuery, updateSettings } from '@/lib/settings-api'

/** The OSV.dev lockfile scan switch: its value (optimistic while saving) and a setter. */
export function useOsvSetting() {
  const queryClient = useQueryClient()
  const settings = useQuery(settingsQuery)
  const mutation = useMutation({
    mutationFn: (osvEnabled: boolean) => updateSettings({ osvEnabled }),
    onSuccess: (data) => queryClient.setQueryData(settingsKeys.settings, data),
  })
  const enabled = mutation.isPending
    ? (mutation.variables ?? false)
    : (settings.data?.osvEnabled ?? false)
  return { settings, mutation, enabled, setEnabled: (next: boolean) => mutation.mutate(next) }
}
