import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/queries'
import { settingsKeys, settingsQuery, updateSettings } from '@/lib/settings-api'

/** The daily update check switch: its value (optimistic while saving) and a setter. */
export function useUpdateCheckSetting() {
  const queryClient = useQueryClient()
  const settings = useQuery(settingsQuery)
  const mutation = useMutation({
    mutationFn: (updateCheckEnabled: boolean) => updateSettings({ updateCheckEnabled }),
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.settings, data)
      // Turning it on makes the server look at once; turning it off hides the banner.
      void queryClient.invalidateQueries({ queryKey: queryKeys.version })
    },
  })
  const enabled = mutation.isPending
    ? (mutation.variables ?? true)
    : (settings.data?.updateCheckEnabled ?? true)
  return { settings, mutation, enabled, setEnabled: (next: boolean) => mutation.mutate(next) }
}
