# Archigov — architecture governance that derives its own model

One container, one SQLite file, no other services. Usable in minutes with an empty database: load the demo estate or connect Azure, add the standards you want checked, and the overview fills in.

**What it does**

- **Derives the as-is model** from a cloud estate (Azure Resource Graph, or the bundled demo estate) and groups resources into applications by tags and resource-group conventions; shared platforms (hub networks, identity) become shared services, not applications. Every element records *how* it was derived (provenance, confidence) and *who stands behind it* (verification state). CSV and ArchiMate (Open Exchange) imports feed the same model as additional sources.
- **Knows what is critical.** Each application is classified Critical, Important or Standard and names the business services that depend on it — important business services (PRA SS1/21, FCA SYSC 15A), critical or important functions (DORA), essential functions (NCSC CAF). The classification is derived from resource tags with its evidence, confirmed or corrected by a person with a reason, and turned into a business-service dependency map; rules can target critical applications only, and the DORA register takes its criticality from it.
- **Knows what is past its end of support.** A legacy register matches OS images, runtimes, database engines and Kubernetes versions against their vendors' support dates (endoflife.date), shows what is supported, ending, in extended support or end of life — unknown stays unknown until a person says otherwise — and tracks the yearly legacy assessment DORA Art. 8(7) asks for, as a rule that turns into findings.
- **Knows who it depends on.** Providers are derived from the estate (the cloud platform from resource types, named suppliers from tags); the view shows how concentrated critical and important applications are on each — marking the UK's designated critical third parties — and tracks an exit plan for every critical reliance, whose substitutability fills the DORA register.
- **Imports compliance evidence instead of rebuilding checks**: Defender for Cloud assessments and Azure Policy compliance states attach to each resource as evidence; standards assert on that imported state and a resource with no evidence is a finding, never a pass.
- **A governance catalogue of standards, principles, patterns and policies**, each a human statement, control references (ISO 27001, DORA, DSPT, Cyber Essentials, AI Act, NIST…) and, where possible, a JSON rule. Every adopted artefact with a rule is evaluated continuously — a finding cites a pattern or a policy exactly as it cites a standard. Artefacts are versioned and move through draft → in review → adopted → retired; adoption is a board decision. Packs (core architecture rules, Azure WAF-aligned, DORA ICT, AI Act Annex IV design evidence, a governance starter), CSV, JSON and ArchiMate motivation elements import any kind — control references only, never control-body text.
- **Boards with an explicit approval workflow.** Reviews are typed — design, decision, standard, principle, pattern, policy, exception — each with its own automatic pre-review, and routed to a board (seeded: a Design Authority and a Policy & Compliance Board). Boards have seats (chair, decision maker, reviewer, secretary, observer), routing rules and an approval policy per review type. A policy counts approvals, or — with **areas of responsibility** (security, data, integration, infrastructure, resilience, cost, compliance, AI…) — needs a position from the decision maker who owns each area a review touches; the touched areas are derived from the review and shown, and the author can correct them. **Decision makers record their own positions** (yes, no, conditional, not my area); a conditional keeps the item open until the chair resolves it and explains how — as a tracked condition, as addressed, or by raising a **dependent decision** the item is then approved *pending*. **The chair has no vote**: the chair moderates and declares the outcome the positions allow. A board can offer a **fast lane** for low-risk designs that follow adopted patterns: when every deterministic check passes (derived risk tier, the patterns' rules, a clean pre-review, no objection), the chair declares without waiting for positions, and any area owner can take the item out of the lane.
- **Board sessions.** The secretary plans a sitting (`SES-0001`) and the agenda is derived: everything open on the board, ready items first, a consent agenda for items every area had already said yes to. Attendance and per-session **delegation** of a decision maker's seat (one hop; never an auditor, a service account or the author of an item) give a per-area quorum; the chair calls, defers, refers or declares items — including *approved subject to circulation* when an area's owner is absent; closing derives the **minutes** from the records (positions by area, resolutions, outcomes, conditions, dependencies), hashes them into the audit chain and ships them in the evidence pack. The secretary's notes are the only authored part.
- **Architecture decisions (MADR)** with checkable constraints, so the estate is held to the decision after it is made; approvals with tracked conditions; exceptions with expiry; a pre-reviewer that cites its evidence (rules engine, or any OpenAI-compatible model).
- **Backlog as a feed, not a gate**: Azure DevOps epics and features arrive by service hook or WIQL backfill; the product flags epics with no architecture decision and requirements that changed after their design was approved.
- **A roadmap built from records**: decisions with how far the estate has realised them (resources of an allowed type against the drift they raised), the planned changes under them, conditions, end-of-support deadlines and expiring exceptions, in Now / Next / Later / Done — never drawn by hand.
- **Governance metrics and a signed board pack**: review and decision lead times, recycling, exception ageing, the conformance trend and time to fix, computed from the records over a stated period — and a board pack a chair or secretary signs from them, verifiable like the evidence pack.
- **Continuous conformance**: standard violations, drift between accepted decisions and what is deployed, expired exceptions, overdue conditions, and per-run diffs of what opened, resolved or reopened.
- **Evidence, not assurance**: a signed evidence pack (Ed25519 signature, SHA-256, and a hash chain over the audit log that anyone can re-verify), an OSCAL 1.1.2 assessment-results export, and a clearly labelled simplified DORA register-of-information CSV. Nothing in the product asserts compliance.
- **Sign-in and two-level access control**: Microsoft Entra ID (OpenID Connect) or a local mode for a trusted network and first runs. A user holds a system role — **author** (submits reviews and authors catalogue drafts and decisions), **auditor** (read-only, exports) or **service account** — and platform administration (sources, settings, users, boards) is a separate **platform admin** flag that grants nothing in a review. Approving and deciding come from **board seats** — chair, decision maker, reviewer, secretary, observer — so an administrator cannot decide a review unless they also chair the board.
- **Human verification state** on everything derived, inferred or AI-generated; dated, named, and dropped automatically when the underlying evidence changes.
- **A work queue, not just a dashboard.** The overview opens with what waits on *you* — positions awaited, items ready to declare, conditionals to resolve, sessions this week, conditions you own, circulations due, items sent back, epics without a decision — derived from the same rules the API enforces, so it never offers an action the server would refuse. Every headline number links to the list behind it; a decision under review defers to its review instead of offering a second door to acceptance; the audit log names items by code and renders details readably.

UI: IBM Carbon (`@carbon/react` 1.118.0, `@carbon/charts-react` 1.27.21, IBM Plex bundled locally).

## Run it

### With Docker

```bash
docker compose up --build
# open http://localhost:8080
```

Data lives in the `archigov-data` volume (`/data/app.db`, `/data/blobs`, `/data/backups`, `/data/keys`, `/data/evidence-packs`). Nightly backups keep the last 14 copies. Upgrades are `docker compose pull && docker compose up`. `docker-compose.prod.yml` is the self-host production example; `infra/` holds the managed-cloud (Cloudflare) scaffold and Litestream configs.

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
| `AUTH_MODE` | `local` (default): a trusted-network mode where the acting user is chosen in the UI (or sent as `x-user`) and unknown users are admins. `entra`: Microsoft Entra ID sign-in is required for everything except `/api/health` and inbound webhooks. |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | Entra app registration (authorization code + PKCE; the secret is optional for a public client). Redirect URI: `<APP_BASE_URL>/api/auth/callback`. App-role values: a system role (`author`, `auditor`, `service`), `platform_admin` for the admin flag, and board seats as `DA:chair`, `PCB:decision_maker`, `board/DA/reviewer`; the older names (`admin`, `architect`, `engineer`, `submitter`, `chair`, `reviewer`, `board_member`) are accepted as aliases (`ENTRA_ROLE_MAP` can remap). Users without a role get `ENTRA_DEFAULT_ROLE` (default `author`). Board membership can also be managed in Settings → Access and on each board. |
| `SESSION_SECRET` | Session-cookie signing secret; generated into `DATA_DIR/keys/session.secret` when unset. |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SUBSCRIPTIONS` | Read-only collection via Resource Graph (Reader on the subscriptions), Defender for Cloud assessments and Azure Policy compliance states (Security Reader / Reader). Only metadata is read. Managed identity works without the secret. |
| `ADO_ORG`, `ADO_PROJECT`, `ADO_PAT`, `ADO_WIQL`, `ADO_HOOK_SECRET` | Azure DevOps backlog feed: WIQL backfill (default query: epics and features not removed, changed in the last year) and a service-hook receiver at `POST /api/hooks/ado` authenticated by the `x-archigov-hook-secret` header or basic-auth password. Without a PAT, an Entra token is used (scope `https://app.vssps.visualstudio.com/.default`). |
| `ARCHIGOV_FIXTURES=1` | Fixture mode: every Azure and DevOps call is answered from recorded-shape fixtures so the real integration code runs offline (used by the smoke scripts and useful for demos). |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Any OpenAI-compatible chat endpoint for pre-review and decision drafting. Without it, the deterministic rules engine and templates are used. |
| `LITESTREAM_URL` or `LITESTREAM_CONFIG` (+ `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `AWS_ENDPOINT`, `AWS_REGION`) | Continuous replication of the SQLite file to R2/S3/MinIO and restore on first boot if the volume is empty. See `infra/litestream/`. |

Secrets never go into the database; the signing key pair lives in `DATA_DIR/keys/` (`evidence-signing.key` 0600, `.pub` 0644).

## Rule format

```json
{ "scope": "resource", "match": { "type": "Microsoft.Storage/storageAccounts" },
  "assert": { "op": "evidence", "source": "defender", "control": "storage-public-access", "state": "pass" } }
```

`scope` is `resource` or `application`. `match` takes `type`, `typeIn`, `typePrefix` and `where` (a list of assertions). Assertion ops: `eq neq in notIn exists missing gte lte matches` on a `path` (normalised props such as `props.publicAccess`, `props.minTlsVersion`, `props.osSku`, `props.location`, `tags.owner`, and the owning application's classification as `app.criticality`, `app.regulated`, `app.services`, `app.service_kinds` — usable in `where` at either scope); `evidence` (imported Defender / Azure Policy / manual evidence for a `control` must exist in `state`, default `pass`; missing evidence is a finding); `lifecycle` (a resource's worst component must not be in `states`, default `["end_of_life"]`; `lifecycle.*` is also readable in `where`); `decisionConstraint` (the resource must match the application's accepted decision on a `topic`); and application-level `hasDecision`, `hasOwnerTag`, `maxResourcesOfType`, `assessmentCurrent` (`kind: "legacy"`: the yearly legacy assessment is in date and covers every legacy component; `kind: "exit_plan"`: every provider a critical or important application relies on has an exit plan in date). An unknown op is a rule error, never a pass.

## Verify it

```bash
cd server && npm test                                   # unit tests (node:test via tsx)
scripts/smoke.sh http://localhost:8080                  # the end-to-end governance flow (25 steps; mutates the demo)
scripts/smoke-auth.sh http://localhost:8080             # user types, platform admin, segregation of duties, audit chain, signed pack, exports
scripts/smoke-boards.sh http://localhost:8080           # boards, routing, approval policies, a policy review approved end to end
scripts/smoke-sessions.sh http://localhost:8080         # areas, positions, resolutions, sessions, delegation, consent, circulation, dependent decisions, minutes
scripts/smoke-work.sh http://localhost:8080             # the role-aware work queue, the pipeline, a decision under review refusing a direct accept
scripts/smoke-registers.sh http://localhost:8080        # criticality classification, business services, the DORA criticality column
scripts/smoke-catalogue.sh http://localhost:8080        # kinds, lifecycle, pre-review preview, imports (run once per fresh instance)
ARCHIGOV_FIXTURES=1 … && scripts/smoke-integrations.sh   # Azure / Defender / Policy / DevOps / importers on fixtures
SEED_DEMO=false … && scripts/smoke-empty.sh             # the first-run path on an empty instance
```

Run them in that order on a fresh instance; they mutate the demo. Reset it with `docker compose down -v && docker compose up -d`.

## Layout

```
server/src/routes/   /api modules by domain (auth, users, boards, system, applications, artefacts (+standards aliases),
                     decisions, reviews, conformance, sources, backlog, integrations, exports)
server/src/auth/     sessions, Entra OpenID Connect, users, user types + platform flag + board roles → capabilities, the one API gate
server/src/boards/   routing, approval policies (count / areas mode), positions and progress, declarations and their effects, sessions
                     (agenda, attendance, delegations, quorum, consent, minutes), areas of responsibility, seeded boards and demo users
server/src/artefacts.ts  the governance catalogue: kinds, lifecycle, pre-review checks, dry runs, imports
server/src/azure/    Resource Graph, Defender assessments, Policy states, control mapping, fixtures
server/src/ado/      Azure DevOps WIQL/batch client, service-hook handling, fixtures
server/src/importers/ CSV and ArchiMate Open Exchange importers
server/src/migrations/ one file per schema version, auto-loaded
web/src/             React 18 + Carbon UI (charts lazy-loaded), built to web/dist and served by the server
infra/               Cloudflare front door scaffold (Worker + Durable Object + Containers), Litestream configs
scripts/             smoke scripts
```

## Licensing

The core — everything in this repository — is **AGPL-3.0-only** ([LICENSE](LICENSE)). In practice:

- **Run it yourself, even modified, for your own organisation**: no obligations. AGPL's network clause (section 13) applies only when you offer the software as a service to third parties; your own employees are not third parties.
- **Host a modified version for others**: you must offer them your modified source. That is the point — nobody can take this product, bolt on closed features and sell access to it without contributing those features back.
- **Host an unmodified copy for clients**: allowed. Consultancies running Archigov for customers are distribution, not a threat.
- **Your organisation bans AGPL**: a commercial licence for the same code is available — contact the maintainer. Contributions are accepted under a [contributor licence agreement](docs/CLA.md) precisely so this dual licensing stays possible.
- Connectors, templates and the policy-pack SDK will be published under **Apache-2.0** as they are split out of the core, so integrating *with* Archigov never requires touching AGPL code.

**Commitment: this project will never move to a licence more restrictive than AGPL-3.0.** No BSL, no SSPL, no rug-pull. Decided on day one, stated publicly here.

## Not in this release

AWS/GCP collectors, Jira/GitHub backlogs, AI import of Visio/PPTX/Word, LeanIX/Ardoq connectors, in-app multi-tenancy (the managed front door maps tenants to containers), rate limiting. The Entra sign-in, Azure and DevOps integrations are built against the published API schemas and verified on recorded fixtures; a real tenant round-trip has not been exercised. The DORA CSV column codes follow the ITS annex as reproduced in the EBA draft and should be confirmed against the Official Journal text before external use. The Cloudflare scaffold is validated by `wrangler` but has not been deployed.
