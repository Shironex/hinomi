import { useState } from 'react'
import {
  repoFullNameSchema,
  type DeploymentItem,
  type DeploymentReach,
  type SourceDto,
} from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconLoader2 } from '@tabler/icons-react'
import { Field } from '@/components/form/field'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { checkField, mutationMessage } from '@/lib/form'
import { createManualDeployment, refreshManualList, updateManualDeployment } from '@/lib/manual-api'

type ReachChoice = DeploymentReach | 'auto'

const REACH_OPTIONS: readonly { value: ReachChoice; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'public', label: 'Public' },
  { value: 'internal', label: 'Internal only' },
  { value: 'unknown', label: 'Unknown' },
]

const REACH_HELP =
  'Automatic is public when a domain is an http(s) URL, otherwise unknown. Unknown ranks like public, so nothing is hidden by a guess.'

/** Domains typed as a list, separated by commas, spaces or new lines. */
const splitDomains = (text: string): string[] => text.split(/[,\s]+/).filter(Boolean)

/**
 * Adds a deployment to a manual list, or edits one. Only what the platform would tell Hinomi is
 * asked for: nothing about the container, so its checks say unknown.
 */
export function ManualDeploymentForm({
  source,
  entry,
  onDone,
  onCancel,
}: {
  source: SourceDto
  /** The entry to edit. Omit to add one. */
  entry?: DeploymentItem
  onDone: (message: string) => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(entry?.name ?? '')
  const [repo, setRepo] = useState(entry?.gitRepository ?? '')
  const [branch, setBranch] = useState(entry?.gitBranch ?? '')
  const [image, setImage] = useState(entry?.image ?? '')
  const [domains, setDomains] = useState(entry?.domains.join(', ') ?? '')
  const [reach, setReach] = useState<ReachChoice>(entry?.reach ?? 'auto')
  const [server, setServer] = useState(entry?.server ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [repoError, setRepoError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => {
      const fields = {
        name,
        domains: splitDomains(domains),
        ...(reach !== 'auto' && { reach }),
      }
      if (entry) {
        return updateManualDeployment(entry.id, {
          ...fields,
          repo: repo.trim() || null,
          branch: branch.trim() || null,
          image: image.trim() || null,
          server: server.trim() || null,
        })
      }
      return createManualDeployment({
        sourceId: source.id,
        ...fields,
        ...(repo.trim() && { repo: repo.trim() }),
        ...(branch.trim() && { branch: branch.trim() }),
        ...(image.trim() && { image: image.trim() }),
        ...(server.trim() && { server: server.trim() }),
      })
    },
    onSuccess: async (saved) => {
      await refreshManualList(queryClient)
      onDone(entry ? `${saved.name} saved.` : `${saved.name} added.`)
    },
  })

  const submit = (event: React.SyntheticEvent) => {
    event.preventDefault()
    const nameProblem = name.trim() ? null : 'Enter a name for the deployment.'
    const repoProblem = repo.trim() ? checkField(repoFullNameSchema, repo) : null
    setNameError(nameProblem)
    setRepoError(repoProblem)
    if (nameProblem || repoProblem) return
    save.mutate()
  }

  const title = entry ? `Edit ${entry.name}` : 'Add a deployment'
  const serverError = save.isError ? mutationMessage(save.error) : null
  return (
    <form
      onSubmit={submit}
      aria-label={title}
      noValidate
      className="flex flex-col gap-3.5 rounded-md border border-border bg-background p-4"
    >
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="grid gap-3.5 tab:grid-cols-2">
        <Field label="Name" error={nameError}>
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Repo"
          error={repoError}
          help="The GitHub repo it was built from, as owner/name. Leave empty for an image only deployment."
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              placeholder="example-org/billing"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
          )}
        </Field>
        <Field label="Branch" help="Optional. The branch that is live.">
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              placeholder="main"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
          )}
        </Field>
        <Field label="Image" help="Optional. The image that runs, with its tag.">
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              placeholder="registry.example.com/billing:1.4.2"
              value={image}
              onChange={(e) => setImage(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Domains"
          help="Separate with commas. A full URL (https://...) counts as public."
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://billing.example.com"
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
            />
          )}
        </Field>
        <Field label="Reach" help={REACH_HELP}>
          {(control) => (
            <NativeSelect
              {...control}
              value={reach}
              onChange={(e) => setReach(e.target.value as ReachChoice)}
            >
              {REACH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label="Server" help="Optional. Groups deployments by the machine they run on.">
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              placeholder="edge-1"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
          )}
        </Field>
      </div>
      {serverError ? (
        <p role="alert" className="text-sm text-sev-critical">
          {serverError}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? <IconLoader2 aria-hidden="true" className="animate-spin" /> : null}
          {entry ? 'Save changes' : 'Add deployment'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={save.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
