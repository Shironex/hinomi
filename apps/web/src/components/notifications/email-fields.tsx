import { SMTP_SECURITY_MODES, type EmailChannelView, type SmtpSecurity } from '@hinomi/shared'
import { Field } from '@/components/form/field'
import { Input, NativeSelect } from '@/components/ui/input'
import type { EmailFieldName, EmailFieldsController } from './use-email-fields'

const SECURITY_LABELS: Record<SmtpSecurity, string> = {
  tls: 'TLS (usually port 465)',
  starttls: 'STARTTLS (usually port 587)',
  none: 'None (a trusted local relay)',
}

/** The SMTP fields of an email channel. */
export function EmailFields({
  controller,
  stored,
  fieldRefs,
}: {
  controller: EmailFieldsController
  /** The channel being edited, for the password hint. */
  stored?: EmailChannelView | undefined
  fieldRefs?: Partial<Record<EmailFieldName, React.Ref<HTMLInputElement>>>
}) {
  const { values, errors, set } = controller
  return (
    <>
      <div className="grid gap-3.5 tab:grid-cols-[1fr_auto]">
        <Field label="SMTP host" error={errors.host}>
          {(control) => (
            <Input
              {...control}
              ref={fieldRefs?.host}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="smtp.example.dev"
              value={values.host}
              onChange={(e) => set.host(e.target.value)}
            />
          )}
        </Field>
        <Field label="Port" error={errors.port} className="tab:w-28">
          {(control) => (
            <Input
              {...control}
              ref={fieldRefs?.port}
              inputMode="numeric"
              autoComplete="off"
              className="font-mono"
              value={values.port}
              onChange={(e) => set.port(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Connection security">
        {(control) => (
          <NativeSelect
            {...control}
            value={values.security}
            onChange={(e) => set.security(e.target.value as SmtpSecurity)}
          >
            {SMTP_SECURITY_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {SECURITY_LABELS[mode]}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <div className="grid gap-3.5 tab:grid-cols-2">
        <Field label="User" help="Leave empty when the server needs no login.">
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              value={values.user}
              onChange={(e) => set.user(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Password"
          help={
            stored?.passwordSet
              ? 'A password is set. Leave empty to keep it.'
              : 'Stored encrypted. Never shown again.'
          }
        >
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              value={values.password}
              onChange={(e) => set.password(e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="grid gap-3.5 tab:grid-cols-2">
        <Field label="From" error={errors.from}>
          {(control) => (
            <Input
              {...control}
              ref={fieldRefs?.from}
              type="email"
              autoComplete="off"
              placeholder="hinomi@example.dev"
              value={values.from}
              onChange={(e) => set.from(e.target.value)}
            />
          )}
        </Field>
        <Field label="Send to" help="One or more addresses, separated by commas." error={errors.to}>
          {(control) => (
            <Input
              {...control}
              ref={fieldRefs?.to}
              autoComplete="off"
              placeholder="ops@example.dev, oncall@example.dev"
              value={values.to}
              onChange={(e) => set.to(e.target.value)}
            />
          )}
        </Field>
      </div>
    </>
  )
}
