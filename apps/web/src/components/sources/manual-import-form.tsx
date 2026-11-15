import { useState } from 'react'
import { MANUAL_IMPORT_MAX_BYTES, type SourceDto } from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'
import { Field } from '@/components/form/field'
import { Button } from '@/components/ui/button'
import { inputClass } from '@/components/ui/input'
import { importManualDeployments, refreshManualList } from '@/lib/manual-api'
import { mutationMessage } from '@/lib/form'
import { cn } from '@/lib/utils'

const EXAMPLE = `deployments:
  - name: billing-api
    repo: example-org/billing
    branch: main
    image: registry.example.com/billing:1.4.2
    domains: [https://billing.example.com]
    reach: public
    server: edge-1`

/** Imports a YAML file of entries (the same fields as the form) into a manual list. */
export function ManualImportForm({
  source,
  onDone,
  onCancel,
}: {
  source: SourceDto
  onDone: (message: string) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [replace, setReplace] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  const run = useMutation({
    mutationFn: () => importManualDeployments({ sourceId: source.id, yaml: text, replace }),
    onSuccess: async (result) => {
      await refreshManualList(queryClient)
      onDone(
        `Imported: ${result.created} added, ${result.updated} updated, ${result.removed} removed.`,
      )
    },
  })

  const readFile = async (file: File | undefined) => {
    setFileError(null)
    if (!file) return
    if (file.size > MANUAL_IMPORT_MAX_BYTES) {
      setFileError('That file is larger than 48 KiB.')
      return
    }
    setText(await file.text())
  }

  return (
    <form
      aria-label="Import deployments from YAML"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        if (text.trim()) run.mutate()
      }}
      className="flex flex-col gap-3.5 rounded-md border border-border bg-background p-4"
    >
      <h4 className="text-sm font-semibold">Import from YAML</h4>
      <Field
        label="YAML"
        help="A list under deployments, with the same fields as the form. Entries are matched by name: a name that is already in the list is updated."
      >
        {(control) => (
          <textarea
            {...control}
            rows={9}
            spellCheck={false}
            placeholder={EXAMPLE}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={cn(inputClass, 'h-auto resize-y py-2 font-mono text-xs')}
          />
        )}
      </Field>
      <label className="flex w-fit items-center gap-2 text-xs text-foreground-2">
        <span>Or load a file</span>
        <input
          type="file"
          accept=".yaml,.yml,text/yaml"
          onChange={(e) => void readFile(e.target.files?.[0])}
          className="text-xs"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={replace}
          onChange={(e) => setReplace(e.target.checked)}
          className="size-4 accent-(--primary)"
        />
        Also remove entries the file does not list
      </label>
      {fileError || run.isError ? (
        <p role="alert" className="text-sm whitespace-pre-line text-sev-critical">
          {fileError ?? mutationMessage(run.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={run.isPending || !text.trim()}>
          {run.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
          Import
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={run.isPending}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
