import { z } from 'zod'
import { BLIND_SPOT_TYPES } from './model.js'

// Guard checks (see docs/design/phase-2.md sections 2 to 5). A guard is a
// configuration or support check on a deployment or a repo. It writes a
// finding of kind `guard` with a check id and a level. The copy below is the
// one place titles, explanations and fix texts live, so the web and the
// notifications say the same thing.

/** Every guard check. One finding per check per subject (deployment or repo). */
export const GUARD_CHECKS = [
  'root_user',
  'shared_network',
  'docker_socket',
  'watch_paths_skip',
  'framework_support',
  'runtime_support',
  'runtime_pins_disagree',
  'action_runtime',
] as const
export const guardCheckSchema = z.enum(GUARD_CHECKS)
export type GuardCheck = z.infer<typeof guardCheckSchema>

/**
 * Level of an open guard finding. `unknown`: the source cannot give the signal
 * (never a silent pass); it shows in the coverage tier and is never notified.
 */
export const GUARD_LEVELS = ['warn', 'fail', 'unknown'] as const
export const guardLevelSchema = z.enum(GUARD_LEVELS)
export type GuardLevel = z.infer<typeof guardLevelSchema>

/** A check's result on one subject or one entry inside its evidence: a level, or pass. */
export const GUARD_RESULTS = ['pass', ...GUARD_LEVELS] as const
export const guardResultSchema = z.enum(GUARD_RESULTS)
export type GuardResult = z.infer<typeof guardResultSchema>

/**
 * Checks that can be turned off with a reason, per deployment or per repo: every
 * guard check and every blind spot type (so `archived_deployed` can be turned off too).
 */
export const OVERRIDABLE_CHECKS = [...GUARD_CHECKS, ...BLIND_SPOT_TYPES] as const
export const overridableCheckSchema = z.enum(OVERRIDABLE_CHECKS)
export type OverridableCheck = z.infer<typeof overridableCheckSchema>

/**
 * Finding event types guards add (event types are free text, these are the known ones).
 * `escalated`: the level got worse (reason `warn -> fail` or `warning -> eol`).
 * `level_changed`: the level got better. `turned_off`: a check override accepted it.
 */
export const GUARD_EVENT_TYPES = ['escalated', 'level_changed', 'turned_off'] as const
export type GuardEventType = (typeof GUARD_EVENT_TYPES)[number]

/** How much of a check a deployment source can answer. */
export const GUARD_CAPABILITIES = ['full', 'partial', 'unknown'] as const
export const guardCapabilitySchema = z.enum(GUARD_CAPABILITIES)
export type GuardCapability = z.infer<typeof guardCapabilitySchema>

// ---------------------------------------------------------------------------
// Runtimes

/** Runtimes whose support windows Hinomi checks (decision Q12: Node, Bun and Rust). */
export const RUNTIMES = ['node', 'bun', 'rust'] as const
export const runtimeSchema = z.enum(RUNTIMES)
export type Runtime = z.infer<typeof runtimeSchema>

/** endoflife.date product slug of each runtime. */
export const RUNTIME_PRODUCTS: Record<Runtime, string> = {
  node: 'nodejs',
  bun: 'bun',
  rust: 'rust',
}

/**
 * How the support check judges a runtime (decision Q12a).
 * `support_window`: the line's end of security support from endoflife.date (Node).
 * `behind_latest`: how many releases a pinned version is behind the latest one, because the
 * product publishes no usable end dates (Rust supports only the newest stable, Bun publishes none).
 * It can warn, never fail.
 */
export const RUNTIME_SUPPORT_RULES = ['support_window', 'behind_latest'] as const
export const runtimeSupportRuleSchema = z.enum(RUNTIME_SUPPORT_RULES)
export type RuntimeSupportRule = z.infer<typeof runtimeSupportRuleSchema>

/** The rule each runtime is judged by. */
export const RUNTIME_SUPPORT_RULE: Record<Runtime, RuntimeSupportRule> = {
  node: 'support_window',
  bun: 'behind_latest',
  rust: 'behind_latest',
}

/**
 * Where a runtime pin was read.
 * Node: `nvmrc`, `node_version`, `tool_versions`, `mise`, `volta`, `engines`,
 * `dev_engines`, `dockerfile` (FROM node), `setup_node`, `action_runs_using`.
 * Bun: `package_manager` (`bun@`), `bun_version`, `tool_versions`, `mise`,
 * `dev_engines`, `dockerfile` (FROM oven/bun), `setup_bun`.
 * Rust: `rust_toolchain` (`rust-toolchain.toml` or `rust-toolchain`),
 * `cargo_rust_version`, `dockerfile` (FROM rust), `rust_toolchain_action`.
 */
export const RUNTIME_PIN_SOURCES = [
  'nvmrc',
  'node_version',
  'bun_version',
  'tool_versions',
  'mise',
  'volta',
  'engines',
  'dev_engines',
  'package_manager',
  'rust_toolchain',
  'cargo_rust_version',
  'dockerfile',
  'setup_node',
  'setup_bun',
  'rust_toolchain_action',
  'action_runs_using',
] as const
export const runtimePinSourceSchema = z.enum(RUNTIME_PIN_SOURCES)
export type RuntimePinSource = z.infer<typeof runtimePinSourceSchema>

/**
 * What a support date is based on. `security`: the product publishes an end of
 * security support date. `release_cycle`: it does not, so the date comes from its
 * release cycle (when the next line replaces it); the finding says so.
 */
export const SUPPORT_BASES = ['security', 'release_cycle'] as const
export const supportBasisSchema = z.enum(SUPPORT_BASES)
export type SupportBasis = z.infer<typeof supportBasisSchema>

// ---------------------------------------------------------------------------
// Copy

export interface GuardCopy {
  /** Short name of the check, shown as the finding title. */
  title: string
  /** The question the check answers. */
  question: string
  /** What the check reads, for the checks page. */
  reads: string
  /** Levels this check can produce. */
  levels: readonly GuardLevel[]
  /** Why it matters, per level it can produce. */
  explanation: Partial<Record<GuardLevel, string>>
  /** What to do about it, per level it can produce. */
  fix: Partial<Record<GuardLevel, string>>
  /** Section id in docs/guards.md. */
  docsAnchor: string
}

const ROOT_FIX =
  "Add a non root user in the final stage and switch to it: `RUN addgroup -S app && adduser -S app -G app` then `USER app`, or set `--user 1000:1000` in the platform's run options. Make sure files the app writes are owned by that user."

const SUPPORT_FIX_RUNTIME =
  'Move every pin to a supported line: the version files, the Dockerfile `FROM`, the CI setup step and the `engines` range. The finding lists each file and line.'

/** Titles, explanations and fix texts per check. Values from the evidence are shown next to them. */
export const GUARD_COPY: Record<GuardCheck, GuardCopy> = {
  root_user: {
    title: 'Container runs as root',
    question: 'Does the main process run as root?',
    reads:
      'The container user from Docker inspect, `--user` in the run options, compose `user:`, or the last `USER` in the final Dockerfile stage.',
    levels: ['fail', 'warn', 'unknown'],
    explanation: {
      fail: 'The container runs as root. A bug in the app or a dependency gets root inside the container, and any host mount or socket becomes a root foothold.',
      warn: "No USER is set, so the container runs as the base image's user. Most official base images run as root.",
      unknown: 'This source does not report the container user.',
    },
    fix: {
      fail: ROOT_FIX,
      warn: ROOT_FIX,
      unknown: 'Add a USER line to the Dockerfile or connect a Docker host source.',
    },
    docsAnchor: 'root-user',
  },
  shared_network: {
    title: 'Shares a network with another project',
    question:
      'Can this container reach containers of an unrelated project over a shared Docker network?',
    reads:
      'Docker networks from inspect, or the Coolify destination, project and `connect_to_docker_network` of each resource, plus networks named in run options and compose.',
    levels: ['fail', 'warn', 'unknown'],
    explanation: {
      fail: 'This container is on the same Docker network as a database from another project. A compromise here can reach that database directly, without going through its domain.',
      warn: 'This container is on the same Docker network as resources from another project. A compromise here can reach them directly, without going through their domains.',
      unknown: 'This source does not report which networks the container is on.',
    },
    fix: {
      fail: 'Put each project on its own destination (its own network), or turn off the shared network for compose resources. Connect projects only through their public endpoints.',
      warn: 'Put each project on its own destination (its own network), or turn off the shared network for compose resources. Connect projects only through their public endpoints.',
      unknown: 'Connect a Docker host source to read the real networks.',
    },
    docsAnchor: 'shared-network',
  },
  docker_socket: {
    title: 'Docker socket mounted',
    question: 'Is the Docker daemon socket mounted into the container?',
    reads:
      "Mounts from Docker inspect, volumes in the run options and compose, and the resource's storages.",
    levels: ['fail', 'unknown'],
    explanation: {
      fail: 'The Docker socket is mounted. Anyone who gets code execution in this container controls the Docker daemon, which is root on the host, even when the mount is read only.',
      unknown: "This source does not report the container's mounts.",
    },
    fix: {
      fail: 'Remove the mount. If the app needs container data, put a socket proxy in front that allows only the GET endpoints it needs, and mount nothing else.',
      unknown: 'Connect a Docker host source to read the real mounts.',
    },
    docsAnchor: 'docker-socket',
  },
  watch_paths_skip: {
    title: 'Watch paths skip the lockfile or Dockerfile',
    question:
      'Will a change to the Dockerfile or a lockfile not trigger a deploy because the watch paths skip it?',
    reads:
      "The deployment's watch paths and auto deploy setting, matched against its Dockerfile, lockfiles, manifests and runtime pins.",
    levels: ['warn', 'unknown'],
    explanation: {
      warn: 'The watch paths do not include every lockfile and Dockerfile the app is built from. A security bump that only changes the lockfile will merge without deploying, and the old version keeps running.',
      unknown: 'This source has no watch paths, so Hinomi cannot tell what triggers a deploy.',
    },
    fix: {
      warn: 'Add the lockfile and the Dockerfile to the watch paths, for example `apps/api/**`, `pnpm-lock.yaml`, `package.json`.',
      unknown: 'Nothing to do here; check by hand how this platform decides to redeploy.',
    },
    docsAnchor: 'watch-paths-skip',
  },
  framework_support: {
    title: 'Framework near or past end of support',
    question:
      'Is a framework the app runs on on a release line that has lost, or is about to lose, security support?',
    reads:
      'Direct runtime dependencies from the lockfile, matched to endoflife.date products by package identifier.',
    levels: ['fail', 'warn', 'unknown'],
    explanation: {
      fail: 'A framework the app runs on is on a release line that no longer gets security fixes. New vulnerabilities in it will not be patched.',
      warn: 'A framework the app runs on is on a release line that loses security support soon.',
      unknown:
        'The installed version matches no release line in the support data (a typo, or a line newer than the cached copy).',
    },
    fix: {
      fail: "Upgrade to a supported line. Follow the framework's upgrade guide.",
      warn: "Plan the upgrade to a supported line before the end date. Follow the framework's upgrade guide.",
      unknown:
        'Check the version in the lockfile; the next support data refresh may know the line.',
    },
    docsAnchor: 'framework-support',
  },
  runtime_support: {
    title: 'Runtime near or past end of support',
    question:
      'Does the repo pin a Node line that has lost, or is about to lose, security support, or a Rust or Bun version far behind the latest?',
    reads:
      'Runtime pins that decide production: the deployed Dockerfile `FROM`, version files (`.nvmrc`, `.node-version`, `.bun-version`, `.tool-versions`, `mise.toml`, `rust-toolchain.toml`, `volta`, `devEngines`, `packageManager`) and the `engines` floor. Node is checked against its end of security support dates; Rust and Bun against how many releases the pin is behind the latest. Cargo `rust-version` is a minimum, never the running toolchain.',
    levels: ['fail', 'warn', 'unknown'],
    explanation: {
      fail: 'The runtime line this repo runs on no longer gets security fixes.',
      warn: 'The runtime line this repo runs on loses support soon, or (Rust and Bun) the pinned version is several releases behind the latest one.',
      unknown:
        'The pinned line is not in the support data (a typo, or a line newer than the cached copy).',
    },
    fix: {
      fail: SUPPORT_FIX_RUNTIME,
      warn: SUPPORT_FIX_RUNTIME,
      unknown: 'Check the pinned version; the next support data refresh may know the line.',
    },
    docsAnchor: 'runtime-support',
  },
  runtime_pins_disagree: {
    title: 'Runtime pins disagree',
    question: 'Do the files that pin one runtime name different lines?',
    reads:
      'Every non floating pin of a runtime in the repo: version files, Dockerfiles, CI setup steps and the `engines` range.',
    levels: ['warn'],
    explanation: {
      warn: 'Files in this repo pin different lines of the same runtime, so what CI tests is not what production runs, and native modules built on one line can break on another.',
    },
    fix: {
      warn: 'Pick one line and set every pin to it. CI may test more lines as long as one of them is the production line.',
    },
    docsAnchor: 'runtime-pins-disagree',
  },
  action_runtime: {
    title: 'Action runtime near or past end of life',
    question:
      "Does the repo's own action, or an action its workflows use, run on a Node line past or near end of life?",
    reads:
      "The repo's `action.yml` `runs.using`, and `runs.using` of every action its workflows use.",
    levels: ['fail', 'warn'],
    explanation: {
      fail: 'An action runs on a Node line past end of life. GitHub moves such actions to a newer runtime or stops running them, and the old line gets no security fixes.',
      warn: 'An action runs on a Node line that reaches end of life soon.',
    },
    fix: {
      fail: 'Bump each listed action to a release that runs on a supported Node line, or update `runs.using` in your own `action.yml`.',
      warn: 'Bump each listed action to a release that runs on a supported Node line, or update `runs.using` in your own `action.yml`.',
    },
    docsAnchor: 'action-runtime',
  },
}
