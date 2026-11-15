# Deployment sources

A deployment source tells Hinomi what runs where: each deployment's name, the repo it was built from, its domains, its status and, where the platform says so, how its container is configured. Hinomi joins those deployments with advisories and guard checks; nothing in the join, the ranking or the guards depends on which source reported a deployment. Coolify is the only deployment source today. A manual list, Docker labels and Dokploy are planned for v0.3 ([design/phase-2.md](design/phase-2.md) section 9). Every source is read only: Hinomi never deploys, stops or changes anything on a platform.

GitHub and OSV are sources too (under Settings, Sources), but they read repos and advisories, not deployments. See [github.md](github.md) and [self-hosting.md](self-hosting.md#tokens).

## What each source can tell

Each kind of source declares once what it can report (`SourceCapabilities` in `packages/shared/src/sources/deployment.ts`). A guard whose signal the source cannot give says `unknown`, never pass, so a deployment a source knows little about never looks safe.

| | Coolify |
|---|---|
| Repo and branch | yes (`git_repository`, `git_branch`) |
| Domains, so reach | yes (`fqdn`) |
| Run status | yes |
| Container user | partial: run options, compose `user:`, the Dockerfile's final stage; nixpacks, static and image apps say unknown |
| Mounts | partial: run options, compose volumes, file storages (`host_path` of persistent storages is not in Coolify's API spec) |
| Networks | partial: grouped by destination and project, plus external networks named in run options and compose |
| Watch paths and auto deploy | yes |
| Deploy history | applications only |
| Image scan results | yes, on Coolify v4.7.0 and newer (see [self-hosting.md](self-hosting.md#image-scan)) |

`GET /api/guards` shows, per check, what each connected source kind can answer (`full`, `partial` or `unknown`), taken from these declarations.

## How a scan reads them

The `deployments` phase reads every enabled deployment source, one after the other (a source that needs a token is read only once one is stored). Each source returns its deployments as normalised records; Hinomi maps each repo to a repo row, stores the deployment under its source, and removes the deployments that source no longer reports. A deployment is keyed by its source and its id inside that source, so two sources can report the same id without clashing.

A source that fails (unreachable, a rejected token) is marked with its error and keeps the deployments it reported last; the other sources go on, and the scan ends as `partial`. The scan run's per source results count units per kind (`attempted`, `failed`, `deployments`, `removed`).

Facts about the container (user, mounts, networks and so on) are read during the inventory and stored on the deployment, so the guards never call a source. A source reads them again only when the resource changed since the last read (Coolify: its `updated_at` moved, or the stored facts are a day old). Only parsed values are kept, never environment variables, raw compose files, run options or storage contents.

## Adding a source

For contributors. The interface is `DeploymentSource` in `apps/server/src/sources/deployments/types.ts`:

```ts
interface DeploymentSource {
  sourceId: number
  kind: DeploymentSourceKind // one of DEPLOYMENT_SOURCE_KINDS
  name: string // set as `source` on every record
  capabilities: SourceCapabilities // facts, guards, domains, status
  inventory(): Promise<DeploymentRecord[]>
  deployHistory?: (deployment, limit) => Promise<DeployHistoryRead> // absent: no deploy history
  imageScan?: ImageScanReader // absent: only the registry SBOM half covers its images
}
```

1. Add the kind to `SOURCE_KINDS` (`packages/shared/src/model.ts`) and to `DEPLOYMENT_SOURCE_KINDS`, and declare its `SourceCapabilities` in `DEPLOYMENT_SOURCE_CAPABILITIES` (`packages/shared/src/sources/deployment.ts`). List in `facts` only what the source really reads, and in `guards` what each container check can make of it. The guards' `GET /api/guards` entries follow from it.
2. Write the client under `apps/server/src/sources/<kind>/` and a `DeploymentSourceFactory` (`kind`, `capabilities`, `needsToken`, `open(config)`) next to it, then add the factory to `DEPLOYMENT_SOURCES` in `apps/server/src/sources/deployments/registry.ts`. `open` gets the source's id, name, URL, a lazy `token()` (it throws a message without the token when none is stored or it cannot be decrypted), the stored facts by external id and an optional `fetch`.
3. `inventory()` returns `DeploymentRecord` (`deploymentRecordSchema`): validate everything the platform answers with zod, keep `externalId` unique within the source, set `facts` when the source read them (and a `facts.gaps` entry with a reason for each fact it could not give for that deployment), leave `facts` out to keep the stored ones. Throw when the source cannot be read at all; never let one bad resource fail the whole list.
4. Strip secrets on receipt. Never log or store a credential, an environment variable or anything the platform returns that looks like one.
5. Test the client against fixtures with fictional names, and the factory through `openDeploymentSource`. `fakeDeploymentSource` (`sources/deployments/testing.ts`) gives scan tests a source of any kind without a client.

Nothing else changes: the scan, the image scan, the deploy history endpoint and the guards read sources only through this interface.
