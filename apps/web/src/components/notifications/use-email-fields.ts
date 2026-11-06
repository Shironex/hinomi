import { useState } from 'react'
import {
  emailChannelInputSchema,
  type EmailChannelInput,
  type EmailChannelPatch,
  type EmailChannelView,
  type SmtpSecurity,
} from '@hinomi/shared'
import { checkField } from '@/lib/form'

const DEFAULT_PORTS: Record<SmtpSecurity, string> = { tls: '465', starttls: '587', none: '25' }

const shape = emailChannelInputSchema.shape
const addressSchema = shape.from
const hostSchema = shape.host

export type EmailFieldName = 'host' | 'port' | 'user' | 'password' | 'from' | 'to'
type Errors = Partial<Record<EmailFieldName, string>>

const splitAddresses = (text: string) =>
  text
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean)

/** Editing starts from the stored settings; the password is never sent back, so it starts empty. */
export function useEmailFields(current?: EmailChannelView) {
  const [host, setHost] = useState(current?.host ?? '')
  const [port, setPort] = useState(current ? String(current.port) : DEFAULT_PORTS.starttls)
  const [portTouched, setPortTouched] = useState(current !== undefined)
  const [security, setSecurityValue] = useState<SmtpSecurity>(current?.security ?? 'starttls')
  const [user, setUser] = useState(current?.user ?? '')
  const [password, setPassword] = useState('')
  const [from, setFrom] = useState(current?.from ?? '')
  const [to, setTo] = useState(current?.to.join(', ') ?? '')
  const [errors, setErrors] = useState<Errors>({})

  function setSecurity(next: SmtpSecurity) {
    setSecurityValue(next)
    if (!portTouched) setPort(DEFAULT_PORTS[next])
  }

  function clear(name: EmailFieldName) {
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: undefined }))
  }

  /** Sets the field errors and returns the first field with one, or null when everything is valid. */
  function validate(): EmailFieldName | null {
    const portNumber = Number(port)
    const addresses = splitAddresses(to)
    const next: Errors = {}
    const hostError = checkField(hostSchema, host, 'Enter the SMTP host.')
    if (hostError) next.host = hostError
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      next.port = 'The port is a number from 1 to 65535.'
    }
    const fromError = checkField(addressSchema, from, 'Enter the address mails come from.')
    if (fromError) next.from = fromError
    const bad = addresses.find((a) => checkField(addressSchema, a) !== null)
    if (addresses.length === 0) next.to = 'Enter at least one address to send to.'
    else if (bad) next.to = `${bad} is not an email address.`
    else if (addresses.length > 20) next.to = 'At most 20 addresses.'
    setErrors(next)
    const order: EmailFieldName[] = ['host', 'port', 'from', 'to']
    return order.find((name) => next[name]) ?? null
  }

  const base = () => ({
    host: host.trim(),
    port: Number(port),
    security,
    user: user.trim(),
    from: from.trim(),
    to: splitAddresses(to),
  })

  return {
    values: { host, port, security, user, password, from, to },
    errors,
    set: {
      host: (v: string) => (setHost(v), clear('host')),
      port: (v: string) => (setPort(v), setPortTouched(true), clear('port')),
      security: setSecurity,
      user: setUser,
      password: setPassword,
      from: (v: string) => (setFrom(v), clear('from')),
      to: (v: string) => (setTo(v), clear('to')),
    },
    validate,
    /** The body for a new channel. */
    toInput(): EmailChannelInput {
      return { ...base(), ...(password !== '' && { password }) }
    },
    /** Only what changed against the stored settings; undefined when nothing did. */
    toPatch(stored: EmailChannelView): EmailChannelPatch | undefined {
      const next = base()
      const patch: EmailChannelPatch = {}
      if (next.host !== stored.host) patch.host = next.host
      if (next.port !== stored.port) patch.port = next.port
      if (next.security !== stored.security) patch.security = next.security
      if (next.user !== (stored.user ?? '')) patch.user = next.user
      if (next.from !== stored.from) patch.from = next.from
      if (next.to.join(',') !== stored.to.join(',')) patch.to = next.to
      if (password !== '') patch.password = password
      return Object.keys(patch).length > 0 ? patch : undefined
    },
  }
}

export type EmailFieldsController = ReturnType<typeof useEmailFields>
