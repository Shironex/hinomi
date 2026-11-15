import { z } from 'zod'

// The parts of the Docker Engine API answers Hinomi reads (v1.47 shapes, docs/design/phase-2.md
// section 4). Every object is loose: unknown fields are dropped by zod, and `Config.Env` is never
// part of a schema, so environment variables are gone before anything is kept or logged.

const text = z.string().nullish()
const labels = z.record(z.string(), z.string()).nullish()

/** One entry of `GET /containers/json`. */
export const containerSummarySchema = z.object({
  Id: z.string().min(1),
  Names: z.array(z.string()).nullish(),
  Image: text,
  Labels: labels,
  State: text,
  Created: z.number().nullish(),
})
export type ContainerSummary = z.infer<typeof containerSummarySchema>

export const containerListSchema = z.array(z.unknown())

const mountSchema = z.object({
  Type: text,
  Name: text,
  Source: text,
  Destination: text,
  RW: z.boolean().nullish(),
})

const portBindingSchema = z.object({ HostIp: text, HostPort: text })

/** `GET /containers/{id}/json`, without `Config.Env`, `Config.Cmd` or anything else unread. */
export const containerInspectSchema = z.object({
  Id: z.string().min(1),
  Name: text,
  Created: text,
  State: z
    .object({
      Status: text,
      Running: z.boolean().nullish(),
      StartedAt: text,
      Health: z.object({ Status: text }).nullish(),
    })
    .nullish(),
  Config: z
    .object({
      User: text,
      Image: text,
      Labels: labels,
    })
    .nullish(),
  HostConfig: z
    .object({
      Binds: z.array(z.string()).nullish(),
      Privileged: z.boolean().nullish(),
      NetworkMode: text,
    })
    .nullish(),
  Mounts: z.array(mountSchema).nullish(),
  NetworkSettings: z
    .object({
      Networks: z.record(z.string(), z.unknown()).nullish(),
      Ports: z.record(z.string(), z.array(portBindingSchema).nullish()).nullish(),
    })
    .nullish(),
})
export type ContainerInspect = z.infer<typeof containerInspectSchema>

/** `GET /version`. */
export const versionSchema = z.object({
  Version: text,
  ApiVersion: text,
})
