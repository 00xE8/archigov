# AGENTS.md: contributing to archigov with an AI coding agent

This is the brief for coding agents (Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Aider and the like) and for the people who run them. Read it before changing anything. [CONTRIBUTING.md](CONTRIBUTING.md) has the same rules for people; [docs/agents/](docs/agents/) has ready-made prompts for the most useful tasks.

> Using Claude Code? It loads `CLAUDE.md` automatically. That file is the maintainer's working context. Its conventions apply to you, but its delivery process, release, deployment and private-repository parts are the maintainer's. Start from this file.

## The person is the contributor

The agent writes code; the person running it contributes it and answers for it. Two acts are legal statements by that person, and an agent never makes them:

1. **The DCO sign-off.** Do not add `Signed-off-by:` lines, and do not run `git commit -s`. You may commit, on a branch with a conventional message and an `Assisted-by:` trailer, unless the person asks you to leave the changes uncommitted. The person reviews the diff and signs off themselves (`git rebase --signoff origin/main`), certifying the [Developer Certificate of Origin](DCO).
2. **The CLA agreement.** If the **archigov CLA** check asks for agreement to [docs/CLA.md](docs/CLA.md), tell the person. Never post the agreement comment.

**Say when an agent helped.** Add an `Assisted-by:` trailer to every commit an agent wrote, for example `Assisted-by: Claude Code (claude-opus-5-5)`, and say so in the pull request description. Never describe work as reviewed or tested when it was not.

## What archigov is, and the rules review enforces

archigov governs architecture decisions: argued in three parts, linked to the standards they rest on, decided by the right board on the record, then kept true against the estate collected from Azure. These rules are not negotiable in review:

- **Evidence, not assurance.** No code, text or UI may assert that something is compliant. Show the evidence and who stands behind it.
- **AI proposes; a named person decides.**
  - AI output is stored as `origin: 'ai'`, `verification: 'unverified'`.
  - It never approves, blocks, changes state, or becomes the record without an audited act by a person.
  - Citations that do not resolve are dropped.
  - Every AI feature keeps a deterministic fallback.
- **The model is derived, not authored.** No feature that only makes sense for a hand-drawn repository. Importers are sources with provenance, not editors.
- **Boards decide.** Decision makers record only their own positions; the chair has no vote; the platform admin is operational and gets `403` on every governance act.
- **The server is the authority.**
  - Every route is gated in `server/src/auth/roles.ts`. An unlisted mutation falls to `manage_platform`, so a new endpoint stays closed until you open it deliberately.
  - Board-level checks run in the handlers.
  - Gating in the UI is a convenience only.
- **Everything that matters is audited.** Every state change calls `audit()` (`server/src/db.ts`, SHA-256 hash-chained). Never edit or delete audit rows.
- **Schema changes are forward-only.** One new file per change: `server/src/migrations/mNNN-slug.ts`.
- **Packs and templates carry references only.** Never reproduce the text of ISO, DORA, NIST or any other control body.
- **Compliance checks on resource configuration are imported, never rebuilt.**
  - Defender for Cloud and Azure Policy results arrive as evidence; a rule asserts on them with `op: evidence`, using a control key that exists in `server/src/azure/controls.ts`.
  - Missing evidence is a finding, never a pass.
  - Architecture properties the collector derives (redundancy, region, tags, decisions, `app.*` classification) may be read directly.
  - Fixtures never show evidence a real tenant could not produce.

## Repository map

```
server/src/routes/       the /api modules (Hono), one per domain
server/src/auth/roles.ts capabilities and the route rules every request passes
server/src/boards/       routing, approval policies, positions, declarations, sessions
server/src/rules.ts      the rule DSL, validateRule and the evaluation engine
server/src/model.ts      the derived model; the registers and metrics sit beside it
server/src/packs/        policy packs                (Apache-2.0)
server/src/templates/    assessment templates        (Apache-2.0)
server/src/azure/, ado/  connectors                  (Apache-2.0)
server/src/importers/    CSV and ArchiMate importers (Apache-2.0)
server/src/migrations/   one file per schema version
server/test/             node:test unit tests
web/src/                 React + IBM Carbon UI
docs/features/           one page per feature
scripts/                 smoke scripts (bash + python3) against a running instance
```

## Commands

```bash
cd server && npm install && npm run dev    # API on :8080 with the demo estate
cd web && npm install && npm run dev       # UI on :5173; the "View as" menu switches demo users
cd server && npm test                      # unit tests
npm run typecheck                          # in server/ and in web/
ARCHIGOV_FIXTURES=1 npm run dev            # in server/: Azure and DevOps from fixtures
```

Experiment on a scratch instance so the demo data stays clean: `DATA_DIR=$(mktemp -d) PORT=8091 npm run dev`. The smoke scripts (`scripts/smoke*.sh <base-url>`) each need a fresh instance and mutate it. Run the one nearest your change if you can; the maintainer runs the full battery before merging.

## Where a change goes: the licence boundary

| Folders | Licence | The contributor needs |
|---|---|---|
| `server/src/packs/`, `server/src/templates/`, `server/src/azure/`, `server/src/ado/`, `server/src/importers/` (the list is in `.github/licensing.json`) | Apache-2.0 | A DCO sign-off |
| Everything else | AGPL-3.0-only | A DCO sign-off and the CLA, once |

- A new file in an Apache-2.0 folder starts with exactly these two lines:
  ```ts
  // SPDX-License-Identifier: Apache-2.0
  // SPDX-FileCopyrightText: The archigov Authors
  ```
  No file anywhere else carries them. `server/test/licensing.test.ts` checks both.
- Do not move code across the boundary. Do not edit `.github/licensing.json`, `LICENSE`, `LICENSE-APACHE`, `DCO`, `docs/CLA.md`, `TRADEMARKS.md` or `.github/workflows/` unless an issue from the maintainer asks for it.
- Keep the legal notices: `server/src/about.ts` and **About archigov** (`web/src/components/About.tsx`) carry the copyright, the licences, the no-warranty statement and the source offer the AGPL requires. Do not remove or reword them.
- A new connector or importer needs a new folder. Ask in an issue first, so the folder joins the Apache-2.0 list on `main` before the pull request.
- A pull request kept inside the Apache-2.0 folders stays CLA-free. The maintainer adds the CHANGELOG line and any docs.

## Conventions

- **Code.** TypeScript, ES modules, with imports ending `.js`. Match the surrounding code: its naming, density and idiom. A comment states a constraint the code cannot show; it never narrates.
- **API.** Hono routes in `server/src/routes/`. Request bodies are validated with zod. Errors are `{ error }` with a status; refusals go through `forbidden()`. A new mutation gets its rule in `auth/roles.ts` and an `audit()` call.
- **Tests.** `node:test` in `server/test/`. Set `DATA_DIR` to a temporary directory before importing `db.js`, and call the API through the Hono app with an `x-user` header, as the existing tests do. New behaviour gets a test.
- **UI.**
  - Use IBM Carbon (`@carbon/react` 1.118) only: compose Carbon components, use `var(--cds-*)` tokens, never hex colours.
  - Labels are Title Case (nav, titles, headings, buttons, table headers); prose is sentence case.
  - A status is colour, icon and word. Every tag explains itself on hover (`explainTag`). Icon-only buttons carry a tooltip. Modals never nest.
  - Read `design-system/README.md` first. If your agent has the Carbon MCP server, use it to check component props and icon names; never guess them.
- **Features.** A feature ships with a page `docs/features/<slug>.md` (the sections are listed in `docs/features/README.md`, including "Heuristics and AI": what is deterministic and what, if anything, AI may propose) and a CHANGELOG entry under Unreleased.
- **Commits.** Conventional commits (`feat(packs): …`, `fix(azure): …`); the body says why. Plus the `Assisted-by:` trailer.
- **Secrets.** Never commit anything under `data/`. Never put tokens, account ids, or real tenant data into code, fixtures, tests or screenshots.

## Definition of done

Before handing back, check the diff against this list and report what you could not do:

- [ ] `npm test` passes; `npm run typecheck` is clean in `server/`, and in `web/` if touched
- [ ] New behaviour has a test; a new feature has its docs page and CHANGELOG line, or is an Apache-folder change the maintainer will document
- [ ] Files in Apache-2.0 folders carry the header; nothing crossed the boundary
- [ ] Nothing asserts compliance; AI output stays a draft; every new mutation is gated in `auth/roles.ts` and audited
- [ ] Commits carry `Assisted-by:` and no `Signed-off-by:` from the agent
- [ ] A summary for the person: what changed and why, how it was tested, and what is left for them (review, sign-off, the CLA if asked)

## Ready-made tasks

Prompts to paste into your agent, each scoped to stay inside the right folder:

- [A policy pack](docs/agents/new-policy-pack.md): the contribution that helps most
- [An assessment template](docs/agents/new-assessment-template.md)
- [A connector or an importer](docs/agents/new-connector.md)
- [A fix or a feature in the core](docs/agents/core-change.md)

Deploying or upgrading an instance rather than contributing? [docs/agents/deploy.md](docs/agents/deploy.md) has the prompts and the rules an agent keeps around production data, secrets and cloud resources.
