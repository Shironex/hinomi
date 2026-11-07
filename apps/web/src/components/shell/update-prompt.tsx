import { useState } from 'react'
import { IconRefresh } from '@tabler/icons-react'
import { applyServiceWorkerUpdate, useUpdateReady } from '@/lib/pwa'
import { Button } from '@/components/ui/button'

/**
 * A small prompt when a new version is waiting. It never reloads by itself, so a triage in
 * progress is not lost; dismissing it keeps the old version until the next visit.
 */
export function UpdatePrompt() {
  const ready = useUpdateReady()
  const [dismissed, setDismissed] = useState(false)
  if (!ready || dismissed) return null
  return (
    <div
      role="status"
      className="fixed right-4 bottom-[calc(80px+env(safe-area-inset-bottom))] left-4 z-40 flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm shadow-lg tab:right-6 tab:bottom-6 tab:left-auto tab:max-w-sm"
    >
      <span className="min-w-0 flex-1 text-foreground">New version available</span>
      <Button size="sm" onClick={applyServiceWorkerUpdate}>
        <IconRefresh aria-hidden="true" />
        Reload
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        Later
      </Button>
    </div>
  )
}
