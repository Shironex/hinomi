import type * as React from 'react'
import { IconLoader2 } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  pending?: boolean
  /** Shown under the text when the action failed. */
  error?: string | null | undefined
}

/** Asks before a destructive action. Focus starts on Cancel so Enter never removes by accident. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  onConfirm,
  pending = false,
  error,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 px-4 py-4">
          <DialogDescription className="text-sm text-foreground-2">{children}</DialogDescription>
          {error ? (
            <p role="alert" className="text-sm text-sev-critical">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            autoFocus
          >
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
