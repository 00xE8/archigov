# Changelog

All notable changes to Archigov are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [semver](https://semver.org). Each feature links its page under `docs/features/`.

## [Unreleased]

### Added


- AI providers, chosen per feature ([docs](docs/features/ai-providers.md)): the platform admin configures OpenAI, Claude (Anthropic), Mistral and Ollama under Settings · AI and enables each AI feature separately with its own provider and model, with a one-click connection test. Everything is off by default, every feature keeps its deterministic fallback, and the legacy `LLM_*` environment gateway still works.
- Seven AI features, each "AI proposes, a named human promotes": pre-review, decision drafting, **rule drafting** (NL → the JSON rule DSL, validated and dry-run against the live model before anyone saves), **control-reference suggestions** on catalogue drafts, **assessment summary drafting** under the type's template headings, **session notes drafting** for the secretary from the session's own records, and **evidence-mapping suggestions** for unmapped Defender/Policy keys pinned through the control-map editor.
- Secrets management for provider keys: AES-256-GCM encryption at rest (`ARCHIGOV_SECRET_KEY` or a generated keyfile outside every backup and replica; legacy plaintext re-encrypts on first read), `AI_<PROVIDER>_API_KEY` / `…_FILE` environment injection that beats the database, and the existing guarantees — keys never returned, never audited, never exported.
- The Overview leads with an at-a-glance chart row: a gauge of imported evidence currently passing, a gauge of how much of the model a human has verified, and a reviews-by-stage donut whose slice colours echo the stage tags. The findings trend became a stacked area by severity, and a new bar chart shows where the open findings sit by application. Gauges carry no status thresholds — a pass-rate judgment would assert compliance, and the product shows evidence, never assurance.

- Decisions argue in three parts: **Recommended Option**, **Justification** (the argument the board will test) and **Consequences** — what accepting the decision means and which risks are explicitly accepted (new `justification_md`, migration m013; the drafter fills all three).
- An eighth AI feature, **Decision Review** (admin-toggled like the rest; the form carries a Review Argument with AI button, greyed with the reason when the admin has not enabled the feature): a critical assessment of the argument before submitting — unsupported claims, strawman options, circular reasoning, unstated risks, contradictions with adopted artefacts cited by code — plus a tightened version the author can apply with one click. Advisory; nothing is stored and the author decides what to submit.
- **Evidence on a draft decision, tracked end to end** (migration m014): where the AI review finds a critical claim with no evidence, it suggests the assessment that would evidence it; one click saves the decision as a proposed draft and triggers that assessment on it. The author (or a named assessor) completes it on the decision page, attaches evidence already gathered with Provide, and submits the decision for review from its own page — the rows keep `decision_id`, so the review shows each one as "On the Decision". Decision-attached evidence informs the board and never blocks anything.

### Changed

- The decision form fills its modal: fields on the left, an AI Review panel on the right with the Review Argument button at its top — greyed with an explanatory tooltip when the admin has not enabled the feature.

- Public-repo scope: internal strategy documents and the managed-service front-door scaffold moved to a private repository. The public repo is everything needed to self-host — including the Litestream replication example and the production compose file — and nothing else.
- The review page is organised into logical blocks: a facts strip under the title (for / board / submitted by / declared by), the workflow strip followed by a **waiting-on line** that names exactly who holds the item up (missing positions by owner — "you" marked — unresolved conditionals, open assessments), a **Submission** column (summary, design, requirements) with the **Activity** timeline beneath it, beside a **Board Record** column (areas & positions or approvals, assessments, conditions, dependencies). Superseded pre-reviews fold to their recommendation line.
- One action language across the page, per Carbon's button-emphasis guidance: page-level actions in the header, section-header actions tertiary (Request Assessment, Edit Areas, Create Dependent Decision), every in-row table action a ghost button (Record Position, Record Result, View Result, Mark Met, Resolve, Waive).
- The assessments table reads as a table: one result tag per row, compact people and dates, and the written result folded behind View Result, rendered at table scale.
- Closed reviews read as history: a never-recorded position shows "Not recorded" instead of "Awaiting position", and empty assessment/condition/dependency sections disappear.

### Fixed

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

[0.1.0]: https://github.com/00xE8/archigov/releases/tag/v0.1.0
