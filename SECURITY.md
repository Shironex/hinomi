# Security policy

## Supported versions

Hinomi is in early development. Only the latest release receives security fixes, and until the first release only `main` does.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/Shironex/hinomi/security/advisories/new) of the repository and choose "Report a vulnerability". Do not open a public issue or discussion.

Helpful details: the affected version, how you run Hinomi, steps to reproduce, and the impact you see. I will acknowledge a report within a few days, keep you updated while I work on it, and credit you in the advisory if you want that.

## What is in scope

Problems in Hinomi itself, for example:

- bypassing or spoofing the access detection and protections described in docs/access.md,
- leaking stored credentials (Coolify or GitHub tokens, notification secrets) through the API, UI or logs,
- server side request forgery or injection reachable from configuration or API input,
- weaknesses in how secrets are encrypted at rest,
- vulnerabilities in the published Docker image caused by how Hinomi builds it.

## What is out of scope

- Vulnerabilities in a dependency with no reachable path in Hinomi (please report those upstream; Dependabot also tracks them here).
- Issues that require an attacker to already control the host, the container or the database volume.
- Running Hinomi on the open internet without a login in front of it (Tailscale, Cloudflare Access or similar), see [docs/access.md](docs/access.md).
- Missing hardening headers or rate limits without a demonstrated impact.
- Reports from automated scanners without a working proof of concept.
