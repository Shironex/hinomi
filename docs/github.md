# Connecting GitHub

Hinomi reads Dependabot alerts, repo metadata and lockfiles from GitHub. It never writes anything. Connect it in onboarding or under Settings, Sources, with either a personal access token or a GitHub App.

| | Personal access token | GitHub App |
|---|---|---|
| Tied to | your user | an installation on a user or organization |
| Repos read | every repo the token can see | the repos picked when installing |
| Expires | when you set it to | never: Hinomi mints a one hour installation token as needed |
| Stored | the token, encrypted | the private key, encrypted |

## Personal access token

Fine-grained: Dependabot alerts (read) and Metadata (read) on the repos to watch, plus Contents (read) for the OSV.dev lockfile scan of private repos and Administration (read) to see whether Dependabot alerts are on. Classic: `repo` and `security_events`.

In setup, the GitHub step links to the classic token form with both scopes ticked and to the fine-grained form. If the repos belong to an organization with SAML SSO, authorize the token for it (Configure SSO on the token's page), or its repos stay hidden.

## Create the GitHub App

1. Open Settings, Developer settings, GitHub Apps, New GitHub App. For an organization, use the organization's settings instead, so the app belongs to it.
2. Give it a name and any homepage URL. Untick Webhook, Active: Hinomi does not need events.
3. Under Repository permissions, set these to Read-only:
   - **Dependabot alerts**: the alerts themselves.
   - **Contents**: lockfiles for the OSV.dev scan.
   - **Metadata**: repo names, archived state, default branch (GitHub adds it on its own).
   - **Administration** (recommended): lets Hinomi see whether Dependabot alerts are switched on. Without it every repo shows the "alerts unknown" blind spot.
4. Under "Where can this GitHub App be installed?", keep "Only on this account". Create the app.
5. On the app's settings page, note the **App ID** (the Client ID works too). Under Private keys, click "Generate a private key". GitHub downloads a `.pem` file.
6. Click Install App, pick the account, and choose all repos or only the ones Hinomi should watch.
7. The **installation ID** is the number at the end of the installation's settings URL, for example `https://github.com/settings/installations/51234567`.

In Hinomi choose "GitHub App", enter the App ID and the installation ID, and paste or load the `.pem` file. The connection test reports the account the app is installed on and how many repos it can read, and fails when Dependabot alerts, Contents or Metadata is missing.

If you change the app's permissions later, GitHub asks the installation's owner to accept them before they apply.

## How Hinomi signs in as the app

- It signs a JWT with RS256 using the private key: `iat` 60 seconds in the past to absorb clock drift, `exp` nine minutes ahead (GitHub allows at most ten), `iss` the App ID.
- It exchanges the JWT at `POST /app/installations/{installation_id}/access_tokens` for an installation token, which lasts one hour.
- The token is cached and replaced five minutes before it expires. When GitHub answers 401, Hinomi drops the token, mints a new one and retries once.
- Repos come from `GET /installation/repositories`; alerts and repo health use the same calls as a token.

The private key is encrypted at rest with AES-256-GCM under `HINOMI_SECRET_KEY`, like tokens. It is never logged and never sent back: the API only says whether it is set. Rotate it by generating a new key on GitHub, replacing it in Hinomi, then deleting the old one on GitHub.
