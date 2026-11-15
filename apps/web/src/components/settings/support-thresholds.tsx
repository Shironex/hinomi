import { useState } from 'react'
import {
  RUNTIME_BEHIND_MAX_RELEASES,
  RUNTIME_BEHIND_MIN_RELEASES,
  SUPPORT_WINDOW_MAX_DAYS,
  SUPPORT_WINDOW_MIN_DAYS,
  type SettingsDto,
} from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Field } from '@/components/form/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { describeError } from '@/lib/errors'
import { settingsKeys, updateSettings } from '@/lib/settings-api'
import { Mono, Panel, SaveStatus } from './settings-section'

type Key = 'supportWindowDays' | 'rustBehindReleases' | 'bunBehindReleases'

const FIELDS: {
  key: Key
  label: string
  min: number
  max: number
  unit: string
  help: React.ReactNode
}[] = [
  {
    key: 'supportWindowDays',
    label: 'Warn before end of life',
    min: SUPPORT_WINDOW_MIN_DAYS,
    max: SUPPORT_WINDOW_MAX_DAYS,
    unit: 'days',
    help: 'A runtime or framework line turns to a warning this many days before its support ends.',
  },
  {
    key: 'rustBehindReleases',
    label: 'Rust releases behind',
    min: RUNTIME_BEHIND_MIN_RELEASES,
    max: RUNTIME_BEHIND_MAX_RELEASES,
    unit: 'stable releases',
    help: (
      <>
        A pinned toolchain warns once it is more than this many stable releases behind the latest.
        Channels such as <Mono>stable</Mono> never warn.
      </>
    ),
  },
  {
    key: 'bunBehindReleases',
    label: 'Bun releases behind',
    min: RUNTIME_BEHIND_MIN_RELEASES,
    max: RUNTIME_BEHIND_MAX_RELEASES,
    unit: 'minor releases',
    help: 'A pinned version warns once it is more than this many minor releases behind the latest.',
  },
]

/** The server's own rule: a whole number between min and max. Returns the number, or null. */
function parse(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text)
  return n >= min && n <= max ? n : null
}

/** The support window and the "behind latest" allowances, saved together with one button. */
export function SupportThresholds({ settings }: { settings: SettingsDto }) {
  const queryClient = useQueryClient()
  const [drafts, setDrafts] = useState<Partial<Record<Key, string>>>({})
  const mutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.settings, data)
      setDrafts({})
    },
  })

  const text = (key: Key) => drafts[key] ?? String(settings[key])
  const errors = Object.fromEntries(
    FIELDS.map((f) => [
      f.key,
      parse(text(f.key), f.min, f.max) === null
        ? `Enter a whole number from ${f.min} to ${f.max}.`
        : null,
    ]),
  ) as Record<Key, string | null>
  const changed = FIELDS.filter(
    (f) => drafts[f.key] !== undefined && drafts[f.key] !== String(settings[f.key]),
  )
  const invalid = FIELDS.some((f) => errors[f.key] !== null)

  function save(event: React.FormEvent) {
    event.preventDefault()
    if (invalid || changed.length === 0) return
    mutation.mutate(Object.fromEntries(changed.map((f) => [f.key, Number(text(f.key))])))
  }

  return (
    <Panel>
      <form onSubmit={save} noValidate className="flex flex-col gap-4">
        <div className="grid gap-5 tab:grid-cols-3">
          {FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              help={f.help}
              error={drafts[f.key] === undefined ? null : errors[f.key]}
            >
              {(control) => (
                <div className="flex items-center gap-2">
                  <Input
                    {...control}
                    type="text"
                    inputMode="numeric"
                    className="w-24"
                    value={text(f.key)}
                    disabled={mutation.isPending}
                    onChange={(e) => setDrafts({ ...drafts, [f.key]: e.target.value })}
                  />
                  <span className="text-sm text-muted-foreground">{f.unit}</span>
                </div>
              )}
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="sm"
            disabled={mutation.isPending || invalid || changed.length === 0}
          >
            Save
          </Button>
          <SaveStatus
            pending={mutation.isPending}
            saved={mutation.isSuccess && changed.length === 0}
            error={mutation.isError ? describeError(mutation.error) : null}
          />
        </div>
      </form>
    </Panel>
  )
}
