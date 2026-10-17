# Contributing to Archigov

Contributions are welcome: packs, templates, connectors, importers, fixes and docs. Read this before your first pull request. Contributing is quick, and where your work lands decides how much paperwork it needs.

## Where contributions help most

The contributions that compound are the ones carrying domain knowledge from other architects:

- policy packs;
- assessment templates;
- connectors to the systems an estate is collected from;
- import adapters for the repositories organisations already keep.

These folders are licensed **Apache-2.0**. A contribution to them needs only a DCO sign-off on each commit, and **no CLA**:

| Folder | What goes there |
|---|---|
| `server/src/packs/` | Policy packs. A pack is one file exporting a `StandardsPack`, plus one line in `index.ts`. It holds statements, control **references** (never a framework's own text), and rules that pass `validateRule`. Each item's code is unique and carries its kind's prefix (`STD-`, `PRN-`, `PAT-`, `POL-`). `server/test/packs.test.ts` checks every pack automatically. Packs import as drafts for a board to review. |
| `server/src/templates/` | Assessment templates: the headings a competent assessment result answers. Improving one is Apache-only. A *new* assessment type also needs a label in `web/src/api.ts` (core); the maintainer can add that line. |
| `server/src/azure/`, `server/src/ado/` | Connectors: Azure Resource Graph, Defender for Cloud, Azure Policy, Azure DevOps. Follow their pattern: recorded fixtures for `ARCHIGOV_FIXTURES=1`, parsed by the real code, and never evidence a real tenant cannot produce. A **new** connector (AWS, GCP, Jira, GitHub Issues…) gets its own folder: open an issue first so the maintainer adds the folder to the Apache-2.0 list, because the CLA check reads that list from `main`, not from your pull request. |
| `server/src/importers/` | Import adapters: CSV and ArchiMate today; LeanIX or Ardoq would sit beside them. An import is a source with provenance, not an editor. |

Keep a pull request inside these folders and it stays CLA-free: the maintainer adds the CHANGELOG line and any documentation. The exact list lives in [.github/licensing.json](.github/licensing.json), and every file in those folders starts with an `SPDX-License-Identifier: Apache-2.0` header (`server/test/licensing.test.ts` checks both).

## Every commit: sign off (DCO)

Every commit carries a sign-off: a `Signed-off-by:` line with the same email as the commit's author. With it you certify the [Developer Certificate of Origin](DCO): that you wrote the change or otherwise have the right to submit it under the project's licence. It is a statement, not a form. The Linux kernel, GitLab and NetBox work the same way.

```bash
git commit -s -m "feat(packs): NCSC CAF architecture outcomes"
# adds: Signed-off-by: Your Name <you@example.com>
```

Forgot? Sign off every commit on your branch and push again:

```bash
git rebase --signoff origin/main && git push --force-with-lease
```

The **DCO** check on the pull request lists any commit without a matching sign-off.

## Changes to the core: the CLA, once

Everything outside the Apache-2.0 folders is the core, licensed **AGPL-3.0-only**. If your commits change a core file, the **Archigov CLA** check asks you, once, to agree to the [contributor licence agreement](docs/CLA.md) by commenting on the pull request:

> I have read the Archigov CLA and I agree to it for this and all my future contributions.

Your agreement is recorded on the `cla-signatures` branch, with your GitHub login and account id, the date and a link to your comment. The check turns green, and you are never asked again. Comment `recheck cla` to run the check again, for example after re-authoring commits.

**What it is.** A licence grant on the Apache ICLA model. You keep the copyright in your work and grant Skygge Ltd, which maintains the project, a licence broad enough to license it under other terms as well as the AGPL. It is not a copyright assignment.

**Why it exists.** It keeps the project able to license the core under terms other than the AGPL, which needs the right to license every contribution to it. A CLA cannot be collected after the fact, so it is asked for from the start. The Apache-2.0 folders do not need it, because Apache-2.0 already allows that.

**What protects you.** The project's public commitments in [README · Licensing](README.md#licensing):

- the core never moves to a licence more restrictive than the AGPL-3.0: no BSL, no SSPL;
- any other licence covers the same code as the open-source release, so nothing is held back from it (clause 4 of the CLA).

**Commit emails.** The check matches commits to GitHub accounts by email. If a commit's email is not linked to your account, add it in your GitHub email settings, or re-author the commit, then comment `recheck cla`.

## Contributing with an AI coding agent

Agent-assisted contributions are welcome, on the same terms as any other. Point your agent at [AGENTS.md](AGENTS.md) first: it has the product rules, the licence boundary, the commands and a definition of done. [docs/agents/](docs/agents/) has ready-made prompts for a policy pack, an assessment template, a connector or importer, and a core change.

You are the contributor, so these stay yours:

- **Review every line.** You answer for the change in review, not the agent.
- **Sign off yourself** (`git rebase --signoff origin/main`) after reviewing. An agent never adds `Signed-off-by:`: the DCO is a statement only a person can make.
- **Agree to the CLA yourself** if the check asks. An agent never posts the agreement.
- **Say an agent helped.** Add an `Assisted-by:` trailer to the commits it wrote (e.g. `Assisted-by: Claude Code (claude-opus-5-5)`), and mention it in the pull request.

## The delivery process

Every change follows the process in [CLAUDE.md](CLAUDE.md) ("Delivery process"):

- a branch and pull request per change, with conventional commits (`feat(packs): …`, `fix(azure): …`);
- for features, a page under `docs/features/` and a CHANGELOG entry;
- before merge, the quality gate:
  - `tsc` clean in `server/` and `web/`;
  - `npm test` green;
  - the nine smoke scripts green on fresh instances;
  - an accessibility pass on touched UI;
  - lockfiles in sync (`npm ci --dry-run`).

As a contributor, run `npm test` and `npm run typecheck` in `server/` (and `npm run typecheck` in `web/` if you touched it). The maintainer runs the full gate.

Two product rules are not negotiable in review:

- nothing asserts compliance: the product shows evidence and who stands behind it;
- AI output never transitions state: it drafts, and a named person's audited act promotes it.

## For maintainers

- **Exemptions.** The repository owner's commits and bots are exempt from both checks, because the owner is the licensor.
- **Branch protection.** Make **DCO** and **Archigov CLA** required status checks on `main`.
- **The signature record.** `cla-signatures` is an orphan branch holding `signatures.json`, written only by the CLA workflow. Protect it from deletion and force-pushes. Correct a record only with a commit that says why.
- **Moving the licence boundary.** Changing what is Apache-2.0 means changing `.github/licensing.json`, the SPDX headers, and this file and README · Licensing together. Code moved *into* an Apache-2.0 folder is relicensed. Code moved *out* of one stays available under Apache-2.0 in every version already published.
