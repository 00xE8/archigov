# Changelog

All notable changes to Archigov are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org). Each feature links its page under `docs/features/`.

## [Unreleased]

### Added

- **A published container image.** Every release tag publishes `ghcr.io/00xe8/archigov:<version>`, `:<major>.<minor>` and `:latest` for amd64 and arm64 (`.github/workflows/image.yml`), so trying Archigov is one `docker run` with no clone and no build. The README opens with that command and a screenshot; `docker compose up --build` from a clone is unchanged.
- **Issue forms** for a bug, an idea and a policy pack, and **SECURITY.md**: vulnerabilities are reported privately through GitHub's advisories, never in a public issue.

### Changed

- **A new identity: the plumb mark.** A stem and a bob hanging at rest beside it: the plumb line builders use to see whether work stands true, as Archigov shows whether the estate stands true to what the board approved. The bob is the one colour in the mark, a Carbon blue gradient. The app's favicon is the mark on its Blue 60 tile. The header and the sign-in page carry the mark and a lowercase "archigov" wordmark; labels elsewhere stay Title Case. The README opens on a light or dark banner. Decorative gradients (header edge, tile bars, ambient light, the Overview hero, meters, the stage rail) are now the one brand blue. Colours that carry meaning are unchanged: hero tones per part of the product, catalogue kinds, queues and status.
- **No commercial licence is offered.** README · Licensing, CONTRIBUTING and the CLA no longer describe one. The CLA stays for the AGPL core, so that the core can still be licensed under other terms. Its new version, [v1.2](docs/CLA.md), replaces the commercial-licence sentence in clause 4 with a commitment: any such licence covers the same code as the open-source release, and nothing is held back from it. The grants are unchanged, and the CLA check now records agreements against v1.2.

## [0.2.1] — 2026-10-16

A fix for continuous replication, and the documentation around it. With `LITESTREAM_URL` and `AWS_ENDPOINT` set for a store other than Amazon S3, such as Cloudflare R2 or a self-hosted S3-compatible store, the container did not start; it does now. Upgrade if you replicate that way; on 0.2.0, put the endpoint in the URL instead (`?endpoint=…&forcePathStyle=true`). No migrations, no API change. The release also documents when and how to use replication, and adds briefs and prompts for AI-assisted contributions and deployments.

### Added

- **AGENTS.md and task prompts for AI-assisted contributions.** `AGENTS.md` is the brief coding agents read: the product rules review enforces, the licence boundary, the commands, conventions and a definition of done. It states that the DCO sign-off and the CLA agreement are the contributor's own acts, which an agent never performs, and that agent-written commits carry an `Assisted-by:` trailer. `docs/agents/` has prompts for a policy pack, an assessment template, a connector or importer, and a core change. README, CONTRIBUTING and the pull-request template point to them.
- `npm run typecheck` in `server/` and `web/`.
- **`docs/agents/deploy.md`**: prompts for deploying and upgrading a self-hosted instance with an AI agent, and the rules an agent keeps around production data, secrets and cloud resources. Linked from `AGENTS.md`.

### Changed

- **Replication is documented properly.** `infra/README.md` · Replication with Litestream says what it is, why Archigov uses it, when it is needed (a table against the nightly backups), how to configure both modes, and what it does not cover:
  - `/data/keys` is never replicated;
  - one writer per replica path;
  - it is not an archive.

  It also gives the commands to check a replica, take a point-in-time copy, and test a restore. The restore test uses a scratch volume and a copy without replication settings, so it never puts a second writer on the replica path. It also states the retention: a day in one-URL mode, a week with the example config file. Every step was verified against the pinned Litestream 0.5.17.
- **`docker-compose.prod.yml` no longer offers a MinIO service.** MinIO stopped publishing community container images in October 2025, so the example could not be pulled. It now shows S3-compatible object storage and a `file://` replica on a second disk or NAS share.

### Fixed

- **Replication to a non-AWS store in one-URL mode now works.** With `LITESTREAM_URL` and `AWS_ENDPOINT` set as documented (Cloudflare R2, a self-hosted store), the container did not start: Litestream reads only the AWS SDK's `AWS_ENDPOINT_URL`, so it ignored the endpoint and failed against AWS. The entrypoint now carries the endpoint in the replica URL with path-style addressing. Config-file mode was not affected.

## [0.2.0] — 2026-10-15

The decision-centric release. Architecture decisions are argued in three parts and tested before they reach the board, linked to what they rest on, decided by the right board, and kept true over their lifecycle. This release adds:

- the registers regulated estates are asked for: criticality and business services, the legacy register, third parties and exit plans, risks and architecture debt;
- a roadmap, governance metrics and signed board packs, all built from the records;
- periodic reaffirmations;
- a fast lane for low-risk designs;
- eleven AI features, each with its own provider;
- licensing by folder: a DCO for every contribution, and the CLA only for the AGPL core.

### Added

- **Risk register and architecture debt** ([docs](docs/features/risk-register.md)): a **Risk Register** in the Risk group holds the risks decisions accept (their standing follows the decision), every active exception as an accepted risk, and risks authors log — each with an owner, a severity and a review date; only the owner or whoever logged it changes it, and closing needs a note. **Architecture Debt** is derived from the records, never logged: findings open over 90 days, drift from decisions, overdue conditions, end-of-life components, expired exceptions still failing, assessments and exit plans due. The decision page gains **Accepted Risks**; an eleventh AI feature, **Risk Extraction** (off by default), suggests a decision's risks from its text for the author to log. Risks reach the evidence pack, the board pack and Governance Metrics (migration m021).

- **Reaffirmations** ([docs](docs/features/reaffirmations.md)): every adopted catalogue item and accepted decision has a reaffirm-by date (adoption plus 12 months for artefacts, 24 for decisions, both settings), and the chair of the board that owns it reaffirms it or marks it for revision with a note (back in three months). A reaffirmation approves nothing: approval stays with the board's review and the Decision Log. The state sits on the record: the decision page and the catalogue item show it with its history and the chair's Reaffirm action, the Decision Log has a Reaffirm By column, and the catalogue list flags the overdue and those sent for revision. Due and overdue ones are in the chair's work queue and notifications, linked to the record; a **Reaffirmations** page lists them all; every reaffirmation is audited and none is deleted; Governance Metrics counts what is in date (migration m020).

- **Governance metrics and the signed board pack** ([docs](docs/features/governance-metrics.md)): a **Governance Metrics** page reports, from the records over a stated period, review lead time (median and 90th percentile), recycling, fast-lane approvals, position latency, decisions accepted and realised, conditions met on time, exception ageing, the conformance trend and time to fix, and how much a named person stands behind — figures, never verdicts. A board's chair or secretary prepares a **board pack**: a snapshot of those figures with the period's decisions and reviews, the roadmap's Now lane and the register gaps, signed and chained like the evidence pack and verifiable the same way, with a print view. A tenth AI feature, **Board Pack Narrative** (off by default), drafts the narrative from the figures only; the preparer submits it as their own and the pack records it as AI-assisted (migration m019).

- **Roadmap built from records** ([docs](docs/features/roadmap.md)): a **Roadmap** in the Governance group lays decisions, the planned changes under them, conditions of approvals, end-of-support deadlines and expiring exceptions into Now, Next, Later and Done by fixed rules. A decision with a checkable constraint shows how far the estate has realised it — resources of an allowed type against the drift it raised — and one without is "not checkable", never guessed. Filter by application or kind; nothing is drawn by hand, so it moves when the records move. No AI.

- **Third parties, concentration and exit plans** ([docs](docs/features/third-parties.md)): a **Third Parties** page in the Risk group derives the ICT providers the estate relies on (the cloud platform from resource types, named suppliers from `supplier`/`vendor`/`provider` tags), shows how many critical and important applications sit on each, marks the UK designated critical third parties (SI 2026/777, effective 13 July 2026; the platform admin keeps the list current) and warns when one provider carries half or more of the critical estate. Every critical or important reliance needs an exit plan recorded by a named author (adequacy, the plan, substitutability in the DORA ITS vocabulary, last test), valid for a year; substitutability fills the DORA register's B_07.01 column and suppliers named on tags get rows of their own. A new `assessmentCurrent` kind (`exit_plan`) and STD-DORA-08 make it checkable; the optional AI draft rides on Assessment Drafting (migration m018).

- **Legacy register and the yearly legacy assessment** ([docs](docs/features/legacy-register.md)): a new **Risk** group with a **Legacy Register** that lists every OS image, App Service runtime, PostgreSQL/MySQL engine and AKS version in the estate against its vendor's support dates (endoflife.date, bundled and refreshable): supported, support ending, extended support, end of life, or unknown — never guessed; an author sets a version the facts do not name, with a reason. Each application with legacy components needs a yearly legacy assessment (DORA Art. 8(7)) recorded by a named author, which goes stale when a new legacy component appears; the optional AI draft fills its template from the register's facts. Rules gain `lifecycle` and `assessmentCurrent` ops (and `lifecycle.*` in `where`), the DORA pack two standards (STD-DORA-06/07), and the evidence pack each application's legacy standing (migration m017).

- **Fast lane for low-risk designs** ([docs](docs/features/fast-lane.md)): a board can let a design review that is low risk, follows adopted patterns and passes every deterministic check be declared by the chair without collecting area positions — one at a time, on the consent agenda, or all together from the board page. The risk tier is derived (the submitter can raise it, never lower it), claimed patterns must be adopted and their rules pass for the application, the latest pre-review must be clean on this version (an AI pre-review can veto, never grant), and any area owner takes an item out of the lane with a no or a conditional. Approvals record that they rested on the lane and which checks held. Submitters claim patterns on submission and can edit the claim; the policy editor gains a Fast Lane toggle; the demo Design Authority offers the lane with one Intranet review in it (migration m016).

- **Criticality classification and Business Services** ([docs](docs/features/criticality-classification.md)): every application is classified Critical, Important or Standard and names the business services or regulated functions that depend on it — important business services (PRA SS1/21, FCA SYSC 15A), critical or important functions (DORA), essential functions (NCSC CAF). Derived from resource tags with the evidence kept; an author can verify it or set it with a reason, which collection never overwrites; supporting a regulated service makes an application critical. A new **Business Services** page maps each service to the applications, resources, regions and shared platforms behind it; the Applications list gains a Criticality column and filter; rules can target `app.criticality`, `app.regulated` and the service names in either scope; the DORA register fills B_06.01.0050 and the function name from the classification; the evidence pack records who stands behind each one (migration m015).
- A ninth AI feature, **Classification Suggestion** (off by default): for an application the tags leave open, suggests a tier and the dependent services with a rationale inside the Classify form. Nothing is stored; the author applies it and saves with their own reason.
- `scripts/smoke-registers.sh`: the classification flow end to end (runs after `smoke-work.sh`).


- AI providers, chosen per feature ([docs](docs/features/ai-providers.md)): the platform admin configures OpenAI, Claude (Anthropic), Mistral and Ollama under Settings · AI and enables each AI feature separately with its own provider and model, with a one-click connection test. Everything is off by default, every feature keeps its deterministic fallback, and the legacy `LLM_*` environment gateway still works.
- Seven AI features, each "AI proposes, a named human promotes": pre-review, decision drafting, **rule drafting** (NL → the JSON rule DSL, validated and dry-run against the live model before anyone saves), **control-reference suggestions** on catalogue drafts, **assessment summary drafting** under the type's template headings, **session notes drafting** for the secretary from the session's own records, and **evidence-mapping suggestions** for unmapped Defender/Policy keys pinned through the control-map editor.
- Secrets management for provider keys: AES-256-GCM encryption at rest (`ARCHIGOV_SECRET_KEY` or a generated keyfile outside every backup and replica; legacy plaintext re-encrypts on first read), `AI_<PROVIDER>_API_KEY` / `…_FILE` environment injection that beats the database, and the existing guarantees — keys never returned, never audited, never exported.
- The Overview leads with an at-a-glance chart row: a gauge of imported evidence currently passing, a gauge of how much of the model a human has verified, and a reviews-by-stage donut whose slice colours echo the stage tags. The findings trend became a stacked area by severity, and a new bar chart shows where the open findings sit by application. Gauges carry no status thresholds — a pass-rate judgment would assert compliance, and the product shows evidence, never assurance.

- Decisions argue in three parts: **Recommended Option**, **Justification** (the argument the board will test) and **Consequences** — what accepting the decision means and which risks are explicitly accepted (new `justification_md`, migration m013; the drafter fills all three).
- An eighth AI feature, **Decision Review** (admin-toggled like the rest; the form carries a Review Argument with AI button, greyed with the reason when the admin has not enabled the feature): a critical assessment of the argument before submitting — unsupported claims, strawman options, circular reasoning, unstated risks, contradictions with adopted artefacts cited by code — plus a tightened version the author can apply with one click. Advisory; nothing is stored and the author decides what to submit.
- **Evidence on a draft decision, tracked end to end** (migration m014): where the AI review finds a critical claim with no evidence, it suggests the assessment that would evidence it; one click saves the decision as a proposed draft and triggers that assessment on it. The author (or a named assessor) completes it on the decision page, attaches evidence already gathered with Provide, and submits the decision for review from its own page — the rows keep `decision_id`, so the review shows each one as "On the Decision". Decision-attached evidence informs the board and never blocks anything.

### Changed

- **Licensing and contributions** ([CONTRIBUTING.md](CONTRIBUTING.md), [README · Licensing](README.md#licensing)): policy packs (`server/src/packs/`, split out of `packs.ts`, which stays as the AGPL loader), assessment templates (`server/src/templates/`, split out of `boards/assessments.ts`), the Azure and Azure DevOps connectors and the CSV and ArchiMate importers are now **Apache-2.0** (`LICENSE-APACHE`, SPDX headers, the folder list in `.github/licensing.json`). The rest stays AGPL-3.0-only. Every contribution needs a **DCO** sign-off (`DCO`, checked per commit by `.github/workflows/dco.yml`). The **CLA** (v1.1, still a licence grant, not an assignment) is needed only from authors whose commits change AGPL files: they agree once by a pull-request comment, recorded on the `cla-signatures` branch and checked by `.github/workflows/cla.yml`. The repository owner and bots are exempt from both. README states a further commitment: the commercial licence covers the same code and holds nothing back from the open-source release. `server/test/packs.test.ts` now checks every pack without naming it, so a contributed pack needs no change outside its folder; `server/test/licensing.test.ts` keeps the SPDX headers and the folder list in step. A pull-request template lists the checks.
- Overview is more vivid: glass metric chips in the hero band; KPI tiles with Carbon icons, a tone each and a permanent accent, switching to the alert tone when their number needs attention (the word stays on the tag); colour-coded My Work queues; review stages on a connected rail; thick gradient verification meters that fill in.

- The app carries the landing page's expressive style: every page opens on a dark hero band whose tone follows the part of the product (blue Overview, teal Model, purple decisions and catalogue, cyan reviews, magenta boards, red conformance, green evidence, grey settings), with its own animated constellation, glow, a one-colour title and a contextual Carbon icon that animates once as the page lands; content enters in a stagger, Overview numbers count up, section headings and tiles gain gradient accents, and the header bar has a gradient edge. All motion stops under prefers-reduced-motion.

- The decision form fills its modal: fields on the left, an AI Review panel on the right with the Review Argument button at its top — greyed with an explanatory tooltip when the admin has not enabled the feature.

- Public-repo scope: internal strategy documents and the managed-service front-door scaffold moved to a private repository. The public repo is everything needed to self-host — including the Litestream replication example and the production compose file — and nothing else.
- The review page is organised into logical blocks: a facts strip under the title (for / board / submitted by / declared by), the workflow strip followed by a **waiting-on line** that names exactly who holds the item up (missing positions by owner — "you" marked — unresolved conditionals, open assessments), a **Submission** column (summary, design, requirements) with the **Activity** timeline beneath it, beside a **Board Record** column (areas & positions or approvals, assessments, conditions, dependencies). Superseded pre-reviews fold to their recommendation line.
- One action language across the page, per Carbon's button-emphasis guidance: page-level actions in the header, section-header actions tertiary (Request Assessment, Edit Areas, Create Dependent Decision), every in-row table action a ghost button (Record Position, Record Result, View Result, Mark Met, Resolve, Waive).
- The assessments table reads as a table: one result tag per row, compact people and dates, and the written result folded behind View Result, rendered at table scale.
- Closed reviews read as history: a never-recorded position shows "Not recorded" instead of "Awaiting position", and empty assessment/condition/dependency sections disappear.

### Fixed

- Reaffirmation coverage was computed for Governance Metrics and the board pack but shown in neither; it now has a figure tile on the metrics page and a row in the board pack's Coverage table.
- The board pack's decision list is every decision decided in the period, so its heading no longer says "accepted".
- The roadmap no longer lists a component whose version is not in the lifecycle data as an upgrade with an unlabelled "unknown" status; only dated deadlines belong on it.
- Status tags in the fast lane, legacy register and third-parties screens were rendered small, which drops their icon; they now carry colour, icon and word like every other status.
- Azure collection now keeps MySQL flexible servers' version, network access, backup and HA properties (they were dropped), so the legacy register can match their engine version and the public-network rules can read them.
- The DORA pack's description named five standards; it now describes all eight (version 1.1.0).
- The DORA register no longer writes "Not critical or important" for applications classified **important**: whether that tier is a DORA important function is the entity's call, so the cell stays blank, as it does for unclassified ones.
- Business Services: region names no longer wrap mid-word in the expanded service rows.
- Review page: the areas table drops its Actions column when the viewer has no action on any area, so it fits its half of the page.
- Action buttons no longer vanish for signed-in users: the page trusted a dev-mode fallback identity when deciding whether the viewer is the submitter, which hid Record Position and Approve from everyone on reviews submitted by the fallback user.
- The design section no longer shows a duplicated "Design" heading, and pre-review errors surface as an inline error notification instead of a muted line.

## [0.1.0] — 2026-10-15

First public release: the consolidation of the governance platform built to date, renamed from the working title *Archgov* to **Archigov**.

### The platform

- **Derived model**: Azure Resource Graph collection (live-verified against a real tenant), application inference with provenance and confidence, shared-service classification, human verification that collectors never override; CSV and ArchiMate Open Exchange importers as provenance-carrying sources; a demo estate for first-run value.
- **Governance catalogue**: standards, principles, patterns and policies with lifecycle (draft → in review → adopted → retired), control references only (never control-body text), optional machine-checkable rules, starter packs (core imports as adopted; Azure WAF, DORA ICT, EU AI Act Annex IV as drafts).
- **Boards and sessions**: typed reviews routed by rule; approval policies per review type in count or areas mode; positions recorded only by their owners; chair declares and never votes; sessions with derived agendas, consent agenda, delegations, per-area quorum and minutes derived from the records and hashed into the audit chain.
- **Assessments**: board-requested due diligence that blocks approving outcomes until recorded or waived by the chair, and submitter-provided assessments as never-blocking supporting information; nine types, each with a result template.
- **Continuous conformance**: findings keyed by fingerprint with exceptions, resolutions and reopens; Defender for Cloud and Azure Policy results imported as evidence, never rebuilt; decision drift against checkable constraints; changed-after-approval detection on the delivery feed.
- **Planned changes**: the Azure DevOps backlog as a feed (never a gate), plus manually logged potential changes (`PC-xxxx`, author-only, nothing deleted) flagged until a decision or review covers them.
- **Design views**: deterministic ArchiMate viewpoints per application (Deployment, Application Usage) in real notation — orthogonal bend-minimised routing that never crosses an element, centred equal-spaced attachments, crossing hops — rendered interactively (pan/zoom, selection with neighbourhood highlight, interactive legends, annotations) and exported as XSD-valid Open Exchange XML with the Carbon palette and routes embedded, so Archi shows the same diagrams.
- **Evidence, not assurance**: Ed25519-signed evidence packs anchored to a SHA-256 audit chain; OSCAL 1.1.2 and simplified DORA register-of-information exports carrying the same disclaimer; the signing public key published for auditors to pin.
- **Access model**: system roles (author, auditor, service) separate from the operational platform-admin flag; governance rights only from board seats; local dev mode with persona switching; Microsoft Entra ID (OIDC + PKCE) wired, fixture-verified.
- **UI**: IBM Carbon (g100 shell, g10 content), Title Case labels, every tag and legend entry self-explaining on hover, header notifications of assigned work, tables for tabular facts, accessibility checked with axe on every touched page.

[0.2.1]: https://github.com/00xE8/archigov/releases/tag/v0.2.1
[0.2.0]: https://github.com/00xE8/archigov/releases/tag/v0.2.0
[0.1.0]: https://github.com/00xE8/archigov/releases/tag/v0.1.0
