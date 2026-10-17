# Security

archigov holds an organisation's architecture decisions, its estate's metadata and a signed audit trail, so we treat
vulnerabilities seriously.

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this repository
([direct link](https://github.com/00xE8/archigov/security/advisories/new)). Never open a public issue for one.

Please include the version (image tag or release), the sign-in mode (`local` or `entra`), what an attacker needs
beforehand (network access, a user with which role or seat) and steps to reproduce. You will get an acknowledgement
within five working days. A fix ships as a patch release with an advisory that credits you, unless you prefer otherwise.

## Scope

In scope: the server and web UI in this repository and the published image `ghcr.io/00xe8/archigov`.

Known and documented, so not vulnerabilities in themselves:

- `AUTH_MODE=local` trusts the `x-user` header and the **View as** menu. It is for a trusted network and first runs,
  not a security boundary; use `AUTH_MODE=entra` anywhere else (README · Configuration).
- `/hooks` and `/auth` have no rate limiting yet (README · Not in this release).

Please never test against an instance you do not run yourself.

## Supported versions

The latest release receives fixes. Migrations are forward-only, so upgrading is the fix.
