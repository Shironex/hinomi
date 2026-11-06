import { Fragment } from 'react'
import { SHORTCUT_HELP } from '@/lib/shortcuts'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          Shortcuts work anywhere except while typing in a field.
        </DialogDescription>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 p-4 text-sm">
          {SHORTCUT_HELP.map((s) => (
            <Fragment key={s.label}>
              <dt className="text-foreground-2">{s.label}</dt>
              <dd className="flex items-center justify-end gap-1">
                {s.keys.map((k, i) => (
                  <Fragment key={k}>
                    {i > 0 && s.keys[0] === 'g' ? (
                      <span className="text-xs text-muted-foreground">then</span>
                    ) : null}
                    <Kbd>{k}</Kbd>
                  </Fragment>
                ))}
              </dd>
            </Fragment>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
