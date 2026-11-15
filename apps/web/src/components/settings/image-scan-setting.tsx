import { IMAGE_SCAN_MODES, type ImageScanMode } from '@hinomi/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Field } from '@/components/form/field'
import { NativeSelect } from '@/components/ui/input'
import { describeError } from '@/lib/errors'
import { settingsKeys, updateSettings } from '@/lib/settings-api'
import { Mono, Panel, SaveStatus } from './settings-section'

const MODE_LABEL: Record<ImageScanMode, string> = {
  off: 'Off',
  coolify: 'Coolify scan results',
  sbom: 'Coolify results and registry SBOMs',
}

/** What each mode needs, shown under the select for the chosen mode and listed in full below it. */
const MODE_NEEDS: Record<ImageScanMode, React.ReactNode> = {
  off: (
    <>
      Deployments that run an image with no git source keep their &ldquo;image only&rdquo; coverage
      note and nothing reads what the image contains.
    </>
  ),
  coolify: (
    <>
      Reads the scan results Coolify already computed. Needs Coolify <Mono>4.7.0</Mono> or newer
      with image scanning turned on for the server, and a token that can read them. Nothing is
      pulled or installed.
    </>
  ),
  sbom: (
    <>
      Does the same, and for deployments Coolify does not scan reads the SBOM attestation of their
      public registry images and matches it on OSV. An image with no attestation, or a private one,
      gets a &ldquo;no image SBOM&rdquo; note.
    </>
  ),
}

/** The image scan mode of image only deployments; saves on change like the scan interval. */
export function ImageScanSetting({ value }: { value: ImageScanMode }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (imageScan: ImageScanMode) => updateSettings({ imageScan }),
    onSuccess: (data) => queryClient.setQueryData(settingsKeys.settings, data),
  })
  const mode = mutation.isPending ? (mutation.variables ?? value) : value

  return (
    <Panel>
      <div className="flex flex-col gap-1.5">
        <Field
          label="Scan images"
          help="Applies to the next scan. Turning it off reopens the image only notes."
        >
          {(control) => (
            <NativeSelect
              {...control}
              value={mode}
              disabled={mutation.isPending}
              onChange={(e) => mutation.mutate(e.target.value as ImageScanMode)}
            >
              {IMAGE_SCAN_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <SaveStatus
          pending={mutation.isPending}
          saved={mutation.isSuccess}
          error={mutation.isError ? describeError(mutation.error) : null}
        />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        {IMAGE_SCAN_MODES.map((m) => (
          <div key={m} className="contents">
            <dt className={m === mode ? 'font-medium text-foreground' : 'text-muted-foreground'}>
              {MODE_LABEL[m]}
            </dt>
            <dd className="m-0 text-pretty text-foreground-2">{MODE_NEEDS[m]}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}
