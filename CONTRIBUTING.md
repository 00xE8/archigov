# Contributing to Archigov

Contributions are welcome — connectors, packs, fixes, docs. Two things to know before your first PR.

## The CLA, and why it exists

Archigov's core is AGPL-3.0-only, and the project also sells commercial licences for the same code to organisations whose policy bans AGPL. That dual licensing only works if the project can license the whole codebase under both terms — which means every contribution needs a [contributor licence agreement](docs/CLA.md): you keep the copyright to your contribution and license it to the project broadly enough to be offered under the AGPL *and* under commercial terms.

To agree, add this line to the description of your first pull request:

> I have read and agree to the Archigov CLA (docs/CLA.md) for this and all my future contributions.

The flip side is a public commitment (see [README · Licensing](README.md#licensing)): the open-source licence will never move to something more restrictive than AGPL-3.0. Your contribution cannot end up under a BSL or SSPL.

## The delivery process

Every change follows the process in [CLAUDE.md](CLAUDE.md) ("Delivery process"): a branch and PR per change, conventional commits, a feature page under `docs/features/` plus a CHANGELOG entry for features, and the quality gate before merge — `tsc` clean in `server/` and `web/`, `npm test` green, the eight smoke scripts green on fresh instances, an accessibility pass on touched UI, lockfiles in sync (`npm ci --dry-run`).

Two product rules that are not negotiable in review: nothing asserts compliance (the product shows evidence and who stands behind it), and AI output never transitions state (it drafts; a named human's audited act promotes).
