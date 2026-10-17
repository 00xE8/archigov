<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
  <img src="docs/assets/banner-light.png" alt="archigov: architecture decisions, standards and reviews, derived from your cloud estate and backlog and checked continuously against them." width="1280">
</picture>

# Archigov — architecture decisions, governed

**Every architecture decision argued, linked and kept true.**

Archigov makes architecture decision-making coordinated and systematic:

- proposals are argued in three parts and tested before they reach the board;
- every decision links to the standards and earlier decisions it rests on;
- the right board decides on the record, area by area;
- the decision is then tracked through its whole lifecycle: enforced against your real estate, revisited when it drifts, and superseded with its lineage intact.

It runs as one container with one SQLite file and no other services. It is usable in minutes with the demo estate or your own Azure subscription. It is open source: the core is AGPL-3.0, and packs, templates, connectors and importers are Apache-2.0.

[archigov.com](https://archigov.com) · [Documentation](https://archigov.com/docs) · [Quickstart](https://archigov.com/docs/getting-started/quickstart) · [How to contribute](#how-to-contribute)

## How it works

| Stage | What happens |
|---|---|
| **1 · Propose** | **Argued, not asserted.** A decision states its recommended option, the justification (why it beats the alternatives) and the consequences of accepting it, including the risks accepted. An optional AI review tests the argument and names the evidence it is missing; missing evidence becomes a tracked assessment in one click. |
| **2 · Link** | **Linked to what you already decided.** Decisions cite the standards, principles, patterns, policies and earlier decisions they rest on, so contradictions surface while the decision is still a draft. |
| **3 · Decide** | **Coordinated, on the record.** Typed reviews route to the board that owns them. Decision makers record their own positions, one per area of responsibility. The chair has no vote: the chair declares the outcome the positions allow. Conditions and dependent decisions are tracked to closure. |
| **4 · Enforce** | **Checked against the real estate.** A checkable constraint runs continuously against the model collected from Azure, never drawn by hand. Drift raises a finding and returns the decision to the board. |
| **5 · Evolve** | **Kept true over its lifecycle.** The owning board's chair reaffirms it on a cadence. When it is replaced, it is superseded with its lineage intact. Every step is audited, hash-chained and in the signed evidence pack. |

The product never asserts compliance: it shows evidence and who stands behind it.

## What's in it

**Decisions and the boards that make them**

- **Architecture decision records** (MADR style). Each has context, options considered, recommended option, justification and consequences. A decision can carry:
  - a checkable constraint;
  - dependent decisions;
  - the risks it accepts, on the risk register.
- **A governance catalogue** of standards, principles, patterns and policies. Each item is a human statement, control references (ISO 27001, DORA, DSPT, Cyber Essentials, AI Act, NIST…) and, where it can be, a JSON rule. Items are versioned and move from draft to in review, adopted and retired; adoption happens only through a board. Five packs ship with it:
  - core architecture rules;
  - a governance starter;
  - Azure Well-Architected-aligned standards;
  - DORA ICT;
  - AI Act Annex IV design evidence.

  CSV, JSON and ArchiMate motivation elements import any kind. Every kind of item stores control references only, never control-body text.
- **Boards with an explicit workflow.** There are seven review types (design, decision, standard, principle, pattern, policy, exception), each with its own automatic pre-review and routed to the board that owns it. Two boards are seeded: a Design Authority and a Policy & Compliance Board.
  - **Seats:** chair, decision maker, reviewer, secretary and observer.
  - **Approval:** a policy either counts approvals or needs a position from the owner of every **area of responsibility** a review touches.
  - **Conditionals:** a conditional position keeps the item open until the chair resolves it with an explanation.
  - **Assessments:** a board can request due diligence (DPIA, security, supplier, clinical safety, AI impact…), recorded by a named assessor.
  - **Fast lane:** low-risk designs that follow adopted patterns and pass every deterministic check are declared without waiting for positions.
- **Board sessions.** The agenda is derived, with a consent agenda for items already satisfied. Attendance and per-session delegation give a per-area quorum. Circulation finishes an item when an area's owner was absent. The **minutes are derived from the records**, hash-chained and in the evidence pack.
- **Reaffirmations.** Every adopted catalogue item and accepted decision comes up on a cadence. The owning board's chair states it still holds or asks for a revision. A reaffirmation approves nothing.

**The model decisions are held to**

- **A derived as-is model** from Azure Resource Graph or the bundled demo estate, with CSV and ArchiMate (Open Exchange) as further sources. Resources are grouped into applications by tags and resource-group conventions, and shared platforms become shared services. Every element records how it was derived (provenance, confidence) and who stands behind it (verification state).
- **Criticality and business services.** Each application is Critical, Important or Standard, and names the important business services (PRA SS1/21, FCA SYSC 15A), critical or important functions (DORA) or essential functions (NCSC CAF) that depend on it. This is derived from tags and confirmed or corrected by a person with a reason.
- **Imported compliance evidence.** Defender for Cloud assessments and Azure Policy states attach to resources as evidence and are never rebuilt. A resource with no evidence is a finding, never a pass.
- **Planned changes.** The Azure DevOps backlog is a feed, not a gate, and projects nobody's backlog knows yet can be logged by hand. The product flags epics without a decision, and requirements that changed after their design was approved.

**Conformance, registers and the roadmap**

- **Continuous conformance:** standard violations, drift from accepted decisions, expired exceptions and overdue conditions, with a diff per run of what opened, resolved or reopened.
- **A roadmap built from records:** decisions and how far the estate has realised them, the planned changes under them, conditions, end-of-support deadlines and expiring exceptions, in Now, Next, Later and Done.
- **A legacy register:** OS images, runtimes, database engines and Kubernetes versions against their vendors' support dates, and the yearly legacy assessment DORA Art. 8(7) asks for.
- **Third parties:** the providers the estate relies on, concentration of critical applications (marking the UK's designated critical third parties), and an exit plan for each critical reliance.
- **A risk register and the architecture debt behind it.** Risks come from decisions, active exceptions and authors; debt (aged findings, drift, overdue conditions, end-of-life components…) is derived, never logged.

**Evidence, not assurance**

- **A signed evidence pack** (Ed25519 signature, SHA-256, and a hash chain over the audit log that anyone can re-verify).
- **Exports:** OSCAL 1.1.2 assessment results, a clearly labelled DORA register-of-information CSV, and ArchiMate Open Exchange deployment views that open in Archi.
- **Governance metrics** (review and decision lead times, recycling, exception ageing, the conformance trend, coverage) and **signed board packs** prepared from them.
- **Human verification state** on everything derived, inferred or AI-generated. It is dated and named, and drops back automatically when the underlying evidence changes.

**People and access**

- **Sign-in:** Microsoft Entra ID (OpenID Connect), or a local mode for a trusted network and first runs.
- **Two levels of access.** A system role (**author**, **auditor** or **service account**) sets what a person can author or read. A separate **platform admin** flag covers operations only and grants nothing in a review. Approving and deciding come from **board seats** alone.
- **A work queue, not just a dashboard.** The Overview and the header's notifications show what waits on *you*: positions, declarations, assessments, conditions and reaffirmations due. It is derived from the same rules the API enforces.

**AI proposes, humans decide**

There are eleven AI features, and the platform admin switches each one on separately with its own provider and model:

- decision review;
- pre-review with citations that must resolve;
- decision drafting;
- rule drafting, validated and dry-run before anyone saves;
- control-reference suggestions;
- assessment drafting;
- session-notes drafting;
- evidence mapping;
- classification suggestions;
- risk extraction;
- the board-pack narrative.

Providers are OpenAI, Claude (Anthropic), Mistral, Ollama, or any OpenAI-compatible endpoint, with your own keys, encrypted at rest. Every feature has a deterministic fallback, and every output is marked AI-generated. Nothing an AI writes approves, blocks or becomes the record without a named person's audited act.

UI: IBM Carbon (`@carbon/react` 1.118.0, `@carbon/charts-react` 1.27.21, IBM Plex bundled locally).

## Run it

### With Docker

```bash
docker compose up --build
# open http://localhost:8080
```

Data lives in the `archigov-data` volume (`/data/app.db`, `/data/blobs`, `/data/backups`, `/data/keys`, `/data/evidence-packs`). Nightly backups keep the last 14 copies. Upgrades are `docker compose pull && docker compose up`. `docker-compose.prod.yml` is the self-host production example; [infra/README.md](infra/README.md) has the deployment notes and the full environment matrix, and `infra/litestream/` an example replication config.

### Without Docker (Node 22)

```bash
cd web && npm install && npm run build && cd ..
cd server && npm install && npm run build && npm start
# open http://localhost:8080
```

For development: `cd server && npm run dev` (API on 8080) and `cd web && npm run dev` (UI on 5173 with a proxy to the API).

## Configuration (all optional)

| Variable | Purpose |
|---|---|
| `DATA_DIR`, `PORT`, `SEED_DEMO` | Data directory (`/data` in the container); port (8080); `SEED_DEMO=true` (default) loads the demo estate into an empty database on first boot. |
| `APP_BASE_URL` | Public URL of the instance, used for sign-in redirects and secure cookies (e.g. `https://archigov.example.org`). |
| `AUTH_MODE` | `local` (default): a trusted-network mode where the acting user is chosen in the UI's **View as** menu (or sent as `x-user`) and an unknown user is a platform admin only (no role, no seats). `entra`: Microsoft Entra ID sign-in is required for everything except `/api/health` and inbound webhooks. |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | Entra app registration (authorization code + PKCE; the secret is optional for a public client). Redirect URI: `<APP_BASE_URL>/api/auth/callback`. App-role values: a system role (`author`, `auditor`, `service`), `platform_admin` for the admin flag, and board seats as `DA:chair`, `PCB:decision_maker`, `board/DA/reviewer`; the older names (`admin`, `architect`, `engineer`, `submitter`, `chair`, `reviewer`, `board_member`) are accepted as aliases (`ENTRA_ROLE_MAP` can remap). Users without a role get `ENTRA_DEFAULT_ROLE` (default `author`). Board membership can also be managed in Settings → Access and on each board. |
| `SESSION_SECRET` | Session-cookie signing secret; generated into `DATA_DIR/keys/session.secret` when unset. |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTIONS` | Read-only collection via Resource Graph (Reader on the subscriptions), Defender for Cloud assessments and Azure Policy compliance states (Security Reader / Reader). Only metadata is read. Managed identity works without the secret. |
| `ADO_ORG`, `ADO_PROJECT`, `ADO_PAT`, `ADO_WIQL`, `ADO_HOOK_SECRET` | Azure DevOps backlog feed: WIQL backfill (default query: epics and features not removed, changed in the last year) and a service-hook receiver at `POST /api/hooks/ado` authenticated by the `x-archigov-hook-secret` header or basic-auth password. Without a PAT, an Entra token is used (scope `https://app.vssps.visualstudio.com/.default`). |
| `ARCHIGOV_FIXTURES=1` | Fixture mode: every Azure and DevOps call is answered from recorded-shape fixtures so the real integration code runs offline (used by the smoke scripts and useful for demos). |
| `AI_OPENAI_API_KEY`, `AI_ANTHROPIC_API_KEY`, `AI_MISTRAL_API_KEY`, `AI_OLLAMA_API_KEY` (each also as `…_FILE`) | AI provider keys from the environment; they beat a key saved in Settings · AI and never touch the database. Providers, models and each feature are switched on in Settings · AI; with nothing configured, every feature uses its deterministic fallback. |
| `ARCHIGOV_SECRET_KEY` | Master key for secrets saved in Settings (AI provider keys), encrypted with AES-256-GCM so backups and replicas carry only ciphertext. Unset: a generated `DATA_DIR/keys/secret.key` that is never replicated. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Legacy: one OpenAI-compatible endpoint for any AI feature not configured in Settings · AI. |
| `LITESTREAM_URL` or `LITESTREAM_CONFIG` (+ `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `AWS_ENDPOINT`, `AWS_REGION`) | Continuous replication of the SQLite file to object storage (S3, R2, any S3-compatible store) or another disk, and restore on start when the volume is empty. Use it in production when losing the volume or host must not lose data, and on platforms with ephemeral disks. What, when and how: [infra/README.md · Replication](infra/README.md#replication-with-litestream). |

Credentials from the environment never go into the database. AI provider keys saved in Settings are stored only as ciphertext, are never returned by the API, and are never audited or exported. The evidence-signing key pair lives in `DATA_DIR/keys/` (`evidence-signing.key` 0600, `.pub` 0644).

## Rule format

```json
{
  "scope": "resource",
  "match": { "type": "Microsoft.Storage/storageAccounts" },
  "assert": { "op": "evidence", "source": "defender",
              "control": "storage-public-access", "state": "pass" }
}
```

`scope` is `resource` or `application`. `match` takes `type`, `typeIn`, `typePrefix` and `where` (a list of assertions). Assertion ops: `eq neq in notIn exists missing gte lte matches` on a `path` (normalised props such as `props.publicAccess`, `props.minTlsVersion`, `props.osSku`, `props.location`, `tags.owner`, and the owning application's classification as `app.criticality`, `app.regulated`, `app.services`, `app.service_kinds` — usable in `where` at either scope); `evidence` (imported Defender / Azure Policy / manual evidence for a `control` must exist in `state`, default `pass`; missing evidence is a finding); `lifecycle` (a resource's worst component must not be in `states`, default `["end_of_life"]`; `lifecycle.*` is also readable in `where`); `decisionConstraint` (the resource must match the application's accepted decision on a `topic`); and application-level `hasDecision`, `hasOwnerTag`, `maxResourcesOfType`, `assessmentCurrent` (`kind: "legacy"`: the yearly legacy assessment is in date and covers every legacy component; `kind: "exit_plan"`: every provider a critical or important application relies on has an exit plan in date). An unknown op is a rule error, never a pass.

## Verify it

```bash
cd server && npm test                  # unit tests (node:test via tsx)
B=http://localhost:8080
scripts/smoke.sh $B                    # the end-to-end governance flow
scripts/smoke-auth.sh $B               # roles, segregation of duties, audit chain, signed pack
scripts/smoke-boards.sh $B             # boards, routing, approval policies, fast lane
scripts/smoke-sessions.sh $B           # areas, positions, sessions, delegation, minutes
scripts/smoke-work.sh $B               # the role-aware work queue and the pipeline
scripts/smoke-registers.sh $B          # classification, registers, metrics, reaffirmations, risks
scripts/smoke-catalogue.sh $B          # kinds, lifecycle, imports (once per fresh instance)
scripts/smoke-integrations.sh $B       # instance with ARCHIGOV_FIXTURES=1 and ADO_HOOK_SECRET
scripts/smoke-empty.sh $B              # instance with SEED_DEMO=false: the first run
```

Run the first seven in that order on one fresh demo instance, and the last two each on its own fresh instance; they mutate the data. Reset the demo with `docker compose down -v && docker compose up -d`.

## Layout

```
server/src/routes/       the /api modules, one per domain
server/src/auth/         sessions, Entra OpenID Connect, roles, platform flag, board seats → capabilities
server/src/boards/       routing, approval policies, positions, declarations, assessments, sessions,
                         fast lane, the work queue
server/src/artefacts.ts  the governance catalogue: kinds, lifecycle, pre-review checks, dry runs, imports
server/src/rules.ts      the rule DSL, its validator and the evaluation engine
server/src/model.ts      the derived model; beside it classification, lifecycle (legacy register),
                         suppliers, risks, roadmap, metrics and signoffs (reaffirmations)
server/src/packs/        policy packs                          (Apache-2.0)
server/src/templates/    assessment templates                  (Apache-2.0)
server/src/azure/        Resource Graph, Defender, Azure Policy (Apache-2.0)
server/src/ado/          Azure DevOps                          (Apache-2.0)
server/src/importers/    CSV and ArchiMate importers           (Apache-2.0)
server/src/exporters/    ArchiMate Open Exchange views
server/src/migrations/   one file per schema version, auto-loaded
web/src/                 React 18 + Carbon UI, built to web/dist and served by the server
docs/features/           one page per feature: what it does, who may do what, API, audit, limits
scripts/                 smoke scripts
infra/                   deployment notes and a Litestream example
```

## How to contribute

Contributions are welcome. The ones that help most carry domain knowledge from other architects, and they need the least paperwork:

| Contribute | Where | You need |
|---|---|---|
| A **policy pack**, e.g. ISO 27001 design controls, NHS DSPT, NCSC CAF | `server/src/packs/`: one file, plus one line in `index.ts`; `packs.test.ts` checks it automatically | A DCO sign-off |
| An **assessment template** | `server/src/templates/` | A DCO sign-off |
| A **connector** or an **importer**, e.g. AWS, GCP, Jira, GitHub Issues, LeanIX, Ardoq | Follow `server/src/azure/`, `server/src/ado/` and `server/src/importers/`. Open an issue first, so a new folder joins the Apache-2.0 list before your pull request | A DCO sign-off |
| A fix or a feature in the **core** | Anywhere else | A DCO sign-off, and the [CLA](docs/CLA.md) once |

Getting started:

```bash
git clone https://github.com/00xE8/archigov && cd archigov
cd server && npm install && npm run dev    # terminal 1: the API on :8080, demo estate loaded
cd web && npm install && npm run dev       # terminal 2, from the repo root: the UI on :5173
```

Open http://localhost:5173; the **View as** menu in the header switches between the demo users (author, chair, decision maker, auditor…). Before you push, run `npm test` and `npm run typecheck` in `server/`, and `npm run typecheck` in `web/` if you touched it. Commit with `git commit -s`.

- **Sign off every commit.** `-s` adds `Signed-off-by:`, certifying the [Developer Certificate of Origin](DCO); the **DCO** check verifies it.
- **The CLA is only for the core.** If your commits change core files, the **Archigov CLA** check asks you, once, to agree by commenting one sentence on the pull request. It is a licence grant on the Apache model, and you keep your copyright.
- **Process:** one pull request per change, with conventional commits (`feat(packs): …`, `fix(azure): …`). For a pack, template, connector or importer, the maintainer adds the CHANGELOG line and docs, and runs the full quality gate before merging.
- **Two product rules are not negotiable:**
  - nothing asserts compliance: the product shows evidence and who stands behind it;
  - AI output never changes state: it drafts, and a named person's audited act promotes it.

[CONTRIBUTING.md](CONTRIBUTING.md) has the details: what each folder expects, fixing a missed sign-off, and how the CLA is recorded.

### With an AI coding agent

Agent-assisted contributions are welcome. [AGENTS.md](AGENTS.md) is the brief your agent should read first: the product rules, the licence boundary, the commands and a definition of done. [docs/agents/](docs/agents/) has ready-made prompts for a policy pack, an assessment template, a connector or importer, and a core change.

A starting prompt:

```text
Read AGENTS.md and CONTRIBUTING.md in this repository and follow them.
Then follow docs/agents/new-policy-pack.md to add a pack for <framework>.
Stay inside the folder it names and run the tests. Never add a sign-off: I will
review the diff and sign off myself.
```

You remain the contributor:
- review the diff;
- sign off yourself;
- agree to the CLA yourself if a core change needs it;
- mark agent-written commits with an `Assisted-by:` trailer.

## Licensing

Two licences, by folder. The core is copyleft. The content architects most want to share is permissive, and so is the code that connects Archigov to other systems:

| Part | Licence | To contribute |
|---|---|---|
| **The core:** the derived model, the rules engine, boards and reviews, evidence and audit, exporters, the web UI. Everything not listed below | **AGPL-3.0-only** ([LICENSE](LICENSE)) | A [DCO](DCO) sign-off on each commit, and the [CLA](docs/CLA.md) once |
| **Policy packs** `server/src/packs/` · **assessment templates** `server/src/templates/` · **connectors** `server/src/azure/`, `server/src/ado/` · **importers** `server/src/importers/` | **Apache-2.0** ([LICENSE-APACHE](LICENSE-APACHE)) | A DCO sign-off only |

The folder list is kept in [.github/licensing.json](.github/licensing.json), and every file in those folders carries an `SPDX-License-Identifier: Apache-2.0` header. The policy SDK (the rule DSL and its validator as a package) will join the Apache-2.0 side when it is split out. [CONTRIBUTING.md](CONTRIBUTING.md) explains the DCO and the CLA.

What the AGPL means in practice:

- **Run it yourself, even modified, for your own organisation**: no obligations. The AGPL's network clause (section 13) applies only when you offer the software as a service to third parties; your own employees are not third parties.
- **Host a modified version for others**: you must offer them your modified source. That is the point: nobody can take this product, bolt on closed features and sell access to it without contributing those features back.
- **Host an unmodified copy for clients**: allowed. Consultancies running Archigov for customers are distribution, not a threat.

**Commitments, stated publicly:**

- **This project will never move to a licence more restrictive than AGPL-3.0.** No BSL, no SSPL, no rug-pull. Decided on day one.
- **Nothing is held back from the open-source release.** There is no closed edition, and any other licence the project grants covers the same code.
- **The CLA is a licence grant, not a copyright assignment.** Contributors keep their copyright. It is only needed for the AGPL core, where it keeps the option to license the core under other terms.

## Not in this release

These are the most useful places to contribute:

- AWS and GCP collectors;
- Jira and GitHub Issues as backlog sources;
- LeanIX and Ardoq importers;
- AI import of Visio, PPTX and Word;
- ISO 27001 design-control and DSPT/CAF packs.

In-app multi-tenancy and rate limiting on `/hooks` and `/auth` are also not in this release; the managed service maps tenants to containers.

**Verification status:**
- Resource Graph, Defender for Cloud and Azure Policy collection has been verified against a live tenant. That tenant was small, so paging and quota handling at volume are not yet proven.
- Entra sign-in and Azure DevOps are verified on recorded fixtures only.
- The DORA CSV column codes follow the ITS annex as reproduced in the EBA draft. Confirm them against the Official Journal text before external use.
