# Archigov — project context for Claude Code

Open-source, product-led architecture governance tool. Solo-founder project. Read `README.md` for the user-facing description; this file is the working context. The research/decision documents behind the thesis, the business constraints (pricing, licensing strategy, free-tier economics) and the managed-service infrastructure live in the private repo `00xE8/archigov-internal`; in a working copy, `CLAUDE.local.md` (gitignored) mirrors the business constraints and machine-specific notes. Consult them before changing scope, pricing, positioning or the compliance approach.

## The thesis (do not drift from it)

- **The architecture model is derived, not authored.** Cloud estates (Azure Resource Graph first), backlogs (Azure DevOps as a *feed*, not a gate) and existing repositories/documents (CSV, ArchiMate) populate the as-is model. Humans spend their effort on decisions, standards and reviews. This is what makes the product usable in minutes with an empty database, which is what makes self-serve/PLG possible in a sales-led category.
- **Governance artefacts are machine-checkable policy.** One catalogue, four kinds — standard (`STD-`), principle (`PRN-`), pattern (`PAT-`, with context/solution/applicability), policy (`POL-`, mandatory or recommended) — each a human statement + control references (ISO 27001, DORA, DSPT, AI Act, NIST…) + optional JSON rule. Every *adopted* artefact with a rule is evaluated by the same engine, so a finding cites a pattern or a policy exactly as it cites a standard. Artefacts have a lifecycle — draft → in_review → adopted → retired, versioned (editing an adopted one makes a new draft) — and adoption happens only through a review approved by a board. Packs, CSV, JSON and ArchiMate motivation elements import any kind as drafts (the core pack imports as adopted so a first run is useful immediately); references only — never control-body text.
- **Boards decide; the workflow is explicit.** Reviews are typed — design, decision, standard, principle, pattern, policy, exception — each with its own automatic pre-review, routed by type/kind/category to a board (seeded: Design Authority `DA`, Policy & Compliance Board `PCB`). A board has seats (chair, decision maker, reviewer, secretary, observer), routing rules and an approval policy per review type expressed as steps. An approvals step runs in **count** mode (N distinct `yes` positions from the listed seats — the PCB) or **areas** mode (the DA): the board defines **areas of responsibility** (seeded: security, data, integration, infrastructure, resilience, cost, compliance, ai), each decision maker owns some, a review's touched areas are *derived* (artefact category, decision topic, cited standards, design sections, resource types; the author may correct them, visibly), and every touched area needs a position from an owner. **Decision makers record their own positions** — `yes`, `no`, `conditional`, `not_my_area` — never anyone on their behalf; a `conditional` keeps the item open until the **chair resolves it with a mandatory explanation** (a tracked condition, addressed in session, or a **dependent decision** the item is then approved *pending*). **The chair has no vote: the chair moderates, directs and declares** the outcome the positions allow (approved · approved with conditions · approved subject to circulation · changes requested · deferred · referred · rejected); the reviewer seat is advisory (sends an item back without holding an area, never approves); the secretary runs the board and its **sessions**. A session (`SES-xxxx`) is a sitting with a derived agenda (ready items first, a consent agenda for items already satisfied at open), attendance, one-hop per-session **delegations** of a decision maker's seat, per-area quorum, and **minutes derived from the records** on close (hashed into the audit chain, in the evidence pack); the secretary's notes are the only authored part. Circulation finishes an item asynchronously when an area's owner was absent. A design policy may offer a **fast lane**: a low-risk design that follows adopted patterns and passes every deterministic check is satisfied without positions, so the chair declares it at once; any area owner's `no`/`conditional` takes it out. Full contract: `docs/board-sessions.md`, `docs/features/fast-lane.md`. The ARB of the research is the Design Authority in the UI.
- **Continuous conformance** between what the boards approved (ADRs with checkable constraints, approvals with conditions, adopted artefacts) and what is deployed/planned is the differentiator. Resource-level compliance checks are *imported* from Defender for Cloud / Azure Policy as evidence, never rebuilt; a rule that needs a resource-configuration fact asserts on imported evidence (`op: evidence`). A technology-radar rule (e.g. retired OS versions) is an architecture decision and may read derived props directly.
- **Evidence, not assurance.** The product never asserts compliance. It shows evidence and who stands behind it. The evidence pack is signed and chained so a third party can verify it; OSCAL and DORA exports carry the same disclaimer.
- **Verification state is first-class.** Every element, relation, decision, standard and AI output carries `origin` (derived | inferred | human | ai | rules) and `verification` (verified | unverified) with `verified_by/at`. Verification drops back to unverified automatically when the underlying content hash changes. AI never approves anything; it pre-reviews with citations that must resolve to a real standard/decision/resource/section.
- **One image everywhere.** Same container for self-host (Docker volume) and the managed cloud (Cloudflare Containers + Litestream → R2). App code never knows which. Storage stays SQLite; anything Cloudflare-specific lives in `infra/`, not the app.
- **Expressive app style** (founder decision, Oct 2026 — deliberately beyond Carbon's productive-motion guidance for product UI): every page opens on a g100 hero band (`PageHeader` → `Theme g100` zone with a constellation seeded by the page title via `HeroNetwork`); the band's tone follows the part of the product (`HERO_CONTEXT` in components.tsx: Overview blue · Model teal · catalogue/decisions purple · reviews cyan · boards/sessions magenta · conformance red · evidence/audit green · settings gray — glow, constellation and icon chip all take the tone) and carries a contextual Carbon icon that animates ONCE as the page lands and replays on hover (pop/rise/spin/swing/pulse — brand-book motion-icon rules; `@carbon/icons-motion` was rejected because it drags in `@carbon/ibm-products` 2.x, which pins `@carbon/react` ~1.28); the title stays ONE colour (text-primary) on every page; content carries faint ambient light; content blocks and tiles enter in a stagger; numbers count up (`CountUp`); section headings get a gradient accent; tiles lift with a gradient top bar; the header bar has a gradient edge (`ag-header-glow` — `ag-shell` is the full-height wrapper, never reuse it). Every animation is inert under prefers-reduced-motion; status semantics (colour + icon + word) are untouched.
- **Carbon design system** (`@carbon/react` 1.118.0, `@carbon/charts-react` 1.27.21, IBM Plex bundled, g100 header, g10 content, square corners, one primary blue, status = colour + icon + word). **Labels are Title Case** — a founder decision (Oct 2026) that deliberately overrides Carbon's sentence-case guideline: nav items, page titles, tabs, table headers, section headings, buttons, menu items and modal headings capitalise every significant word ("Governance Catalogue", "Board Sessions"); minor words (of, by, for, and…) stay lowercase unless first or last. Prose — subtitles, captions, empty states, tooltips, tag values — stays sentence case. The brand book snapshot still says sentence case; re-export it if the artifact is updated to match. The brand book also carries the Carbon **building-blocks guidance** distilled in Oct 2026 — chart anatomy, axes (incl. breaks) and legends under "Data visualisation", and a "Patterns" section (common actions, dialogs, disabled/read-only/hidden, disclosures, empty states, filtering, forms, global header, loading, login, notifications, overflow, status indicators, text toolbar, fluid styles) — follow it for every new UI surface: diagrams get a toolbar + bottom interactive legend (hover dims others to 30%, click isolates with a checkmark), deletes are tiered by impact, icon-only buttons always carry tooltips, skeletons for data containers, inline errors on the form itself. Compose from Carbon components; do not restyle raw elements. Before any UI work read `design-system/README.md` (the brand book exported from the Carbon artifact on claude.ai) and use the semantic `var(--cds-*)` tokens from `design-system/tokens.json` rather than literal colours. This is a snapshot: if the artifact changes, re-export both files — Claude Code won't see the update otherwise. Charts follow the brand book's data-visualisation rules and the dataviz method (form by the data's job, colour last, palette validated by script, never colour alone); chart colours come from `@carbon/colors` exports, never hex literals.
- **Carbon MCP + carbon-builder skill.** The official Carbon MCP server (`https://mcp.carbondesignsystem.com/mcp`; reconnect per machine with `/mcp`, IBMid OAuth) and the official **carbon-builder** skill (v1.3.1, installed globally at `~/.claude/skills/carbon-builder` so every project gets it) are the live source of Carbon truth — training data is stale. For any Carbon work: invoke carbon-builder; route design/usage/accessibility questions to `docs_search`, component examples/variants/props/icons to `code_search`, Carbon Charts to `get_charts` (never code_search), experimental `@carbon-labs/*` to `labs_search` (never introduce Labs unprompted), and validate changed UI code with `code_audit` before committing. Never assume icon export names or props from memory — verify via MCP. Token conservation: discover → canonicalise `component_id` → target; don't restate tool output. Division of truth: MCP answers "what does Carbon provide/say", the brand book (`design-system/`) answers "what did this product decide" (e.g. Title Case overrides Carbon's sentence case).

## Layout

```
server/src/routes.ts           /api aggregator: auth middleware first, then one Hono module per domain from routes/
server/src/routes/             system (overview + pipeline, settings, audit with item codes, search, evidence-pack, health), me (/me/work: the
                               caller's work queue), auth, applications, standards (+packs),
                               decisions, reviews, conformance, sources (+evidence), backlog, integrations (azure/defender/policy/ado tests
                               & syncs, /hooks/ado, /import/*), exports (oscal, dora-roi.csv, archimate, evidence-pack/verify, audit/verify, runs/:id)
server/src/http.ts             actorOf()/roleOf() (session-aware), row mappers, nextCode()
server/src/auth/               session.ts (HMAC cookie), entra.ts (OIDC code+PKCE, jose/JWKS), roles.ts (user types + platform flag + board roles →
                               capabilities, ROUTE_RULES: unknown mutations default to manage_platform), users.ts, middleware.ts, context.ts
server/src/artefacts.ts        governance catalogue: kinds, lifecycle (setArtefactLifecycle), preReviewArtefact(), dryRunArtefact(), import
server/src/boards/             workflow.ts (routing, policies incl. count/areas mode, positions, areas-mode progress, canRecordPosition/canDecide per
                               outcome, awaitingMe; an open assessment blocks approving outcomes), areas.ts (area catalogue + deriveAreas),
                               declare.ts (declareOutcome, effects, makeEffective, dependencies, positions/resolutions),
                               assessments.ts (due diligence requested by a board seat, recorded by its named assessor, waived by the chair;
                               stale-marked on resubmit), sessions.ts (agenda, attendance, delegations, quorum, consent, close + minutes),
                               fastlane.ts (riskTierOf: max of declared tier, criticality, open high findings; fastLaneOf: the eight
                               checks, derived on read — approvalProgress folds it in as via_fast_lane; only reviews.patterns_json, m016,
                               is stored), seed.ts (DA + PCB + demo users and seats/areas, SES-0001, the fast-lane Intranet review), work.ts (workQueueFor: the role-aware queue behind
                               /me/work and overview.me; reviewInFlightFor: the review that decides a decision — the 409 on a direct status change)
server/src/reviews.ts          shared review helpers (reviewRow, targetOf, pre-review by type, createReview, refreshAreas) used by routes and declare
server/src/routes/artefacts.ts /artefacts (+ /standards aliases); routes/boards.ts (+ /boards/:id/sessions), routes/sessions.ts, routes/users.ts;
                               routes/reviews.ts carries types, targets, positions (+ /approvals alias), areas, patterns, dependencies,
                               assessments, decide; routes/boards.ts carries GET /boards/:id/fast-lane + POST …/fast-lane/declare (chair)
server/src/db.ts               SQLite (better-sqlite3, WAL), migrate() (async, loads migrations/), audit() with hash chain, settings, keys dir
server/src/migrations/         mNNN-slug.ts, auto-loaded and sorted; a new migration is one new file, nothing else
server/src/model.ts            derived model: ingestResources(), application inference w/ provenance, shared-service classification, verification
server/src/classification.ts   criticality classification (m015 app_classifications): deriveClassification() from tier/service tags with
                               method + evidence, refreshClassifications() (start of every run; a human row is kept, its derived view refreshed;
                               verification drops on a derived change), set/reset/verify, classificationView() (rules' app.*), businessServices()
                               (service → applications → resource types, regions, shared services, findings). Routes in routes/applications.ts:
                               PUT /applications/:id/classification, POST …/reset|verify|suggest (capability verify), GET /business-services
server/src/lifecycle.ts        legacy register: lifecycle snapshot (lifecycle/snapshot.ts, generated from endoflife.date, MIT; settings
                               lifecycle.snapshot overrides it after POST /lifecycle/refresh), matchComponents() from collected facts only
                               (image sku/offer, linuxFxVersion/netFrameworkVersion, engine versions, kubernetesVersion — SQL Server by year,
                               latest SP assumed and said), stateOfCycle (supported/ending/extended/end_of_life; unknown), lifecycle_overrides
                               (m017, a person's correction), legacyOf()/recordLegacyAssessment() (register_assessments, kind legacy, 12-month
                               validity, stale when a new legacy component appears), legacyRegister(). Routes in routes/registers.ts
server/src/risks.ts            risk register (m021 risks, RSK-nnnn): sources decision (standing follows the decision: proposed / withdrawn when
                               rejected·superseded·deprecated, else the stored status), manual, and active exceptions read live (never copied,
                               not editable here); open|accepted|mitigated|closed, owner-or-logger edits, a note to mitigate/close, review overdue.
                               architectureDebt(): derived kinds aged_finding (> debt.finding_days, 90), drift, condition_overdue,
                               exception_expired (still failing), end_of_life, legacy_assessment_due, exit_plan_due. Routes in routes/risks.ts:
                               GET/POST /risks, PUT /risks/:id, GET /debt, POST /decisions/:id/suggest-risks (AI)
server/src/signoffs.ts         reaffirmations (the UI's word; the record of one is a sign-off, so API, table, audit and /me/work keep
                               "sign_off"): subjects = adopted artefacts + accepted decisions; owning board = routeBoard of their review type;
                               due = latest sign_offs.next_due (m020) else adopted_at/decided_at + review.artefact_months (12) /
                               review.decision_months (24); status overdue|due_soon (≤30 d)|current; signOff() — owning chair only, reaffirmed (+cadence)
                               or revision_needed (note ≥10, +3 months), audited signoff:<outcome>; signOffsDueFor() feeds /me/work.sign_offs;
                               reaffirmationOf() (standing + history + can_sign) rides on GET /decisions/:id and /artefacts/:id as `reaffirmation`,
                               standingsByKind() on the list rows. Routes in routes/signoffs.ts: GET/POST /sign-offs
server/src/metrics.ts          governanceMetrics({days}): reviews (lead time median/p90 overall+by type, recycle rate, fast-lane approvals, position
                               latency, open/oldest, 6 monthly points), decisions (accepted, lead time, realisation from the roadmap), conditions,
                               exception ageing buckets, conformance (trend = last run per day, opened/resolved, time to fix), coverage; nulls never
                               zeros, no verdicts. server/src/boardpack.ts: buildBoardPack() — the snapshot + decisions/reviews of the period, roadmap
                               Now, register gaps, narrative {md, origin human|ai_assisted, author}; signAndPersist like the evidence pack, indexed in
                               board_packs (m019). Routes in routes/metrics.ts: GET /metrics, GET /board-packs(/:hash), POST /board-packs and
                               /board-packs/draft-narrative (chair or secretary seat, checked in the handler)
server/src/roadmap.ts          roadmap(): decisions (realisation = conforming resources of allowedTypes vs open drift findings with decision_id:
                               realised/in_progress/not_started; no constraint → not_checkable; proposed), planned changes (nested under their
                               decision when linked), conditions, legacy-register deadlines, expiring exceptions → lanes now/next/later/done by
                               fixed rules (≤90 days now, ≤180 next, done = realised or closed in 90 days). Read-only; GET /roadmap in routes/roadmap.ts
server/src/suppliers.ts        third parties: providersOf() (platform from the type namespace, suppliers from supplier/vendor/provider/
                               third-party/saas tags), ctpList() (DEFAULT_CTP: SI 2026/777, four entities; setting suppliers.ctp replaces it,
                               PUT /third-parties/ctp, platform admin), reliancesOf() + exit plans (register_assessments kind exit_plan,
                               subject = provider, details_json m018: substitutability, tested_at), thirdParties() (providers, concentration
                               ≥50% of the critical estate, exit plans). Routes in routes/registers.ts
server/src/rules.ts            rule DSL + validateRule + evaluateAll() (findings, exceptions, conditions, per-run changes_json)
server/src/ai.ts               AI gateway: AI_PROVIDERS (openai/anthropic/mistral/ollama — two adapters: OpenAI chat-completions and the
                               Anthropic Messages API) and AI_FEATURES — eleven, each enabled separately with its own provider+model (settings
                               ai.providers / ai.features; GET /ai/features is the open per-feature flag read the UI's Draft buttons key on;
                               legacy LLM_* env still drives unconfigured features): pre_review, draft_decision, draft_rule (generate→verify:
                               validateRule + live dry run travel with the draft; POST /artefacts/draft-rule, manage_artefacts),
                               suggest_references (POST /artefacts/suggest-references, manage_artefacts), draft_assessment
                               (POST /reviews/:id/assessments/draft, comment/submit_review), draft_minutes (POST /sessions/:id/draft-notes,
                               chair/secretary like the notes), suggest_evidence_mapping (POST /evidence/suggest-mapping, manage_platform;
                               filtered to keys the instance has seen), review_decision (POST /decisions/review-draft, create_decision: a
                               critical assessment of a decision draft's argument — unsupported claims, strawman options, unstated risks,
                               contradictions citing adopted codes — plus a tightened version the author may apply; the form's
                               "Review Argument with AI"), suggest_risks (POST /decisions/:id/suggest-risks, create_decision: the risks a
                               decision's text accepts, for the author to log as ai_assisted), draft_board_narrative (POST /board-packs/draft-narrative, chair/secretary:
                               the board pack narrative from its figures only), suggest_classification (POST /applications/:id/classification/suggest, verify:
                               tier + services for an application the tags leave open, normalised to the classification invariants, shown in
                               the Classify form to apply). Draft endpoints store nothing and answer 409 when off.
                               rulesPreReview(), llmPreReview() (citation filtering), draftDecisionFromWorkItem(), aiTest() (POST /ai/test)
server/src/secrets.ts          secrets at rest: AES-256-GCM for settings-stored values (today the AI keys — enc:v1: ciphertext, so backups and
                               Litestream replicas never carry a key); master key = ARCHIGOV_SECRET_KEY else DATA_DIR/keys/secret.key (0600,
                               never replicated); legacy plaintext re-encrypts on first read; AI_<PROVIDER>_API_KEY / _FILE env beats the DB
server/src/evidence.ts         imported evidence: importEvidence() upsert by (resource, source, control), summaries
server/src/evidence-pack.ts    Ed25519 signing, canonical JSON, chain head, persisted packs, verify()
server/src/sync.ts             runSync() shared by routes and the scheduler; demo/azure/defender/policy/ado syncs; sourcesOverview()
server/src/azure/              client.ts (ARM token + throttling), resourceGraph.ts, defender.ts, policy.ts, controls.ts (mapping), fixtures.ts
server/src/ado/                client.ts (WIQL + workitemsbatch, PAT/Entra), sync.ts (backfill + hook events), fixtures.ts
server/src/importers/          csv.ts, archimate.ts
server/src/exporters/          archimate.ts: deterministic ArchiMate viewpoints from the derived model (per application a Deployment view —
                               resources as technology elements grouped by region into Locations, externals in a Grouping — and an Application
                               usage view from provider references; fixed packing rules, no layout engine, no AI). **Physical/technology layer
                               ONLY — founder decision (Oct 2026): no logical-layer modelling (application services, interactions, data objects,
                               App Insights flow import), because only the physical layer derives deterministically; the sole logical element is
                               the inferred ApplicationComponent anchor the whole product already rests on, and every edge is a literal ARM
                               reference, never a modelled flow. The Carbon palette (AM_COLORS,
                               from @carbon/colors) travels inside the XML as per-node <style>, so Archi and the UI show the same colours.
                               Connections are routed orthogonally (routeView: fanned side anchors + sparse-grid A*, 90° turns only, never
                               through an element box, deterministic tie-breaks); interior points go in the XML as <bendpoint>s and in the JSON
                               as connections[].route — the web viewer draws rounded corners and semicircle hops at crossings (ArchimateView:
                               the library's <connection>s are stripped before browser rendering, the download keeps them)
                               Serves GET /exports/archimate[?application=] (Open Exchange 3.0 XML, XSD-validated, opens in Archi) and
                               GET /applications/:id/views (the views as JSON + the XML + each view's xml_id + design annotations, for the
                               web Design tab). Annotations (`design_annotations`, m011): notes on a view or one of its elements — capability
                               `comment` (authors and acting seats; auditor/platform admin 403), author-only edit/delete (soft), audited as
                               annotation:add|edit|delete; routes in routes/applications.ts
server/src/packs.ts            archigov-core, azure-waf-architecture, dora-ict-architecture, ai-act-annex-iv-design (references only)
server/src/collectors/demo.ts  fixture estate + demo evidence (Defender/Policy split mirrors what each really assesses)
server/src/seed.ts             demo tenant on top of the core pack
server/test/*.test.ts          node:test via tsx (npm test)
scripts/smoke*.sh              smoke.sh (governance flow), smoke-auth.sh (two-level RBAC), smoke-boards.sh (workflow, fast lane), smoke-sessions.sh (areas,
                               positions, sessions, delegation, dependencies, circulation, minutes, assessments), smoke-work.sh (/me/work by role, pipeline,
                               decisions 409, per-area findings, audit item codes), smoke-registers.sh (classification: derived, set/reset/verify,
                               business services, DORA column, app.* rules; legacy register, corrections, legacy assessment; third parties,
                               exit plans into the DORA register; the roadmap; metrics and a signed board pack; reaffirmations on the record; risks and debt), smoke-catalogue.sh (kinds/lifecycle/import),
                               smoke-integrations.sh (fixtures), smoke-empty.sh (first run)
web/src/App.tsx                Carbon shell: grouped nav (Model / Governance / Evidence / Risk; the Settings item, help-panel link and Overview
                               "Open Settings" render only with manage_platform — Settings is operations, so only the platform admin carries
                               it; the /settings route stays open for the Catalogue's ArchiMate-import deep link, and the evidence signing
                               key is republished on the Audit Log page for auditors), header search, help, account, and a notification bell:
                               /me/work polled every minute and on navigation, a numbered badge of what is ASSIGNED (positions, declarations,
                               conditionals to resolve, assessments, owned conditions, circulations, resubmissions, reaffirmations due — linked to the record), a panel of linked rows,
                               and a localStorage seen-set that only drives the per-item "New" tag (never the badge)
web/src/auth.tsx               AuthProvider, useCan(), Gated, SignIn page, account panel / switch user
web/src/charts.tsx             Overview charts (lazy chunk), forms by the data's job: at-a-glance row (evidence-passing and human-verification
                               gauges — neutral blue, no thresholds: a pass-rate judgment would assert compliance — and a reviews-by-stage donut
                               whose slice hues echo the stage tags), then severity bars, findings-over-time stacked area by severity (line
                               fallback for older servers), evidence by source (emphasis form), open findings by application
web/src/pages/*                RiskRegister (/risks, Risk group: tabs Risks — filterable table, Log Risk and Update via components/RiskModal.tsx
                               — and Architecture Debt — expandable by application); DecisionDetail gains Accepted Risks (Add Risk, Suggest
                               from Consequences) and a Reaffirmation section, Reaffirmations (/reaffirmations, /sign-offs redirects; Governance group after
                               Board Sessions: sortable table — item, owning board, last outcome, reaffirm by, status — and the shared
                               components/Reaffirmation.tsx: ReaffirmModal for the owning chair + ReaffirmationPanel on the decision page and in the
                               catalogue item, which steps aside for the modal — modals never nest; Decision Log Reaffirm By column), Metrics (/metrics, Evidence group: period select, figure tiles, charts lazy in metricsCharts.tsx — decided per month,
                               median lead time per month, findings trend, exception ageing — Board Packs list + Prepare Board Pack modal for chairs
                               and secretaries with Draft with AI), BoardPack (/board-packs/:hash: printable document, verification re-checked on
                               open, narrative with origin, figure tables; print hides .ag-no-print — the header and side nav), Roadmap (/roadmap, Governance group after Decision Log: hero lane counts, application/kind filters, four lanes of
                               Carbon Tiles — kind + status tags, linked title, due date, a Realisation ProgressBar, nested changes), ThirdParties (/third-parties, Risk group: counts, concentration warning, Providers table with the Designated
                               tag, Exit Plans table + Record Exit Plan modal with Draft with AI, designations footer), LegacyRegister (/legacy, Risk group: counts by state, Legacy Assessments table + Record Assessment modal with
                               Draft with AI, Components expandable table with Correct, Version Unknown with Set Version, data footer with
                               Refresh for the platform admin), Overview, Applications (Criticality column + ?criticality= filter), BusinessServices (/services, Model group:
                               the service dependency map), ApplicationDetail (header Classification line + Classify modal from
                               components/ClassificationPanel.tsx; Design tab: components/ArchimateView.tsx renders the exchange XML in
                               real ArchiMate notation via the archimate-renderer npm package (MIT), interactive per the brand book's chart
                               anatomy — zoom/fit toolbar, drag-pan + Ctrl+wheel, element selection card, bottom legend with hover-dim and
                               click-isolate, annotation badges and threads; unverified elements are named in words under each view),
                               Catalogue (kinds; /standards redirects), Decisions (the record argues in three parts: Recommended Option,
                               Justification — the argument the board tests — and Consequences stating what acceptance means and which risks
                               are accepted (justification_md, m013); the form's AI review block critiques the argument and offers a tightened
                               version to apply; the form is two columns in the lg modal — fields left, AI Review panel right with the Review
                               Argument button at its top, greyed via Gated with the enable-it reason when the admin feature is off — and missing-evidence
                               suggestions become tracked assessments in one click — save draft & trigger), DecisionDetail (Evidence section:
                               trigger/provide/complete assessments on the proposed decision; Submit for Review creates the decision review),
                               Reviews (typed; ProgressIndicator for the policy steps; Fast Lane tag; the submit modal's Follows Adopted Patterns
                               FilterableMultiSelect), ReviewDetail (Fast Lane section — checks table, leads in the lane, folds to the failing
                               checks under the positions out of it, Edit Patterns for the submitter; logical blocks: facts strip under the
                               title; workflow strip + a waiting-on line naming who holds the item up, "you" marked; a Submission column —
                               summary, design, requirements, then the Activity timeline — beside a Board Record column — areas & positions
                               or approvals, assessments, conditions, dependencies, all Carbon tables, findings and written results as folded
                               full-width subrows at table scale; superseded pre-reviews folded to their recommendation line; one action
                               language per Carbon's button-emphasis guidance — header actions, tertiary on section headers, ghost in rows;
                               resolve, dependencies, declare; closed reviews read as history — "Not recorded", empty record sections hidden;
                               isSubmitter trusts the session identity, never the x-user fallback),
                               Boards, BoardDetail (composition tiers, areas, member areas with a danger confirm on removal that names the
                               governance consequence, sessions, a setup callout naming what a new board still lacks, and Decision Flow with a
                               workflow table listing EVERY review type (a Fast Lane tag on a design policy that offers it; the policy editor's Fast Lane
                               toggle + require-pattern checkbox; Declare Fast Lane (n) for the chair over Reviews in Flight) — routing, steps or "no workflow — chair declares at once", in-place
                               View Flow / Edit Workflow / Add Workflow; the server's can{members,routing,policies,areas,sessions} gates the UI,
                               platform admin true on all but sessions), Session (/sessions/:id: agenda, consent, attendance,
                               delegations, quorum, notes, minutes), components/DeclareModal (shared by the review page and the agenda), Conformance,
                               Evidence, Audit, Backlog, Settings (General: tenant, interval, home regions, data & backups incl. last backup,
                               evidence signing public key, evidence.control_map editor / Sources / Import: starter packs + CSV + ArchiMate /
                               Users & access: users, types, platform admin / AI: provider cards + per-feature enablement / Demo tools; GET+POST /settings carry version,
                               backups, signing_public_key and evidence_control_map — POST validates the map as string→string).
                               Display labels are explicit where the noun alone is ambiguous: Planned Changes (the delivery-backlog feed —
                               named for its architectural meaning, not the source's artifact, so the tool never reads as a work tracker;
                               Oct 2026 founder decision), Decision Log (the authored ADR register: what was decided), Reaffirmations (the owning chair's periodic statement that an
                               adopted item or accepted decision still holds — never "sign-off", which reads as approval; Oct 2026 founder decision), Board Sessions,
                               Imported Evidence, Governance Catalogue, Run History (file and route names keep the short form: /backlog).
                               Planned changes can also be logged BY HAND (projects/initiatives no backlog tool knows yet): POST/PUT
                               /work-items, capability log_change (authors only — content, so auditor AND platform admin get 403), PC-xxxx
                               ids under a 'manual' source, state Removed instead of delete, same needs-decision/material-change pipeline
                               (NEEDS_DECISION_TYPES in http.ts); rows from a real source are read-only here (409)
web/src/components.tsx         StatusTag, VerificationTag, FindingEvidence, ExportMenu, EmptyState, LoadError, DateField, useLoad …
design-system/                 README.md (brand book) + tokens.json, exported from the Carbon artifact
infra/                         README (self-host deployment + env matrix), litestream/ (S3/R2/MinIO example config);
                               docker-compose.prod.yml at the root. The managed-service front door (Cloudflare Worker + Durable Object +
                               Containers), the archigov.com landing page and the research documents live in the private repo 00xE8/archigov-internal
Dockerfile, docker/entrypoint.sh, docker-compose.yml
```

## Run / build / test

```bash
cd server && npm install && npm run dev        # API :8080, seeds demo on first boot (DATA_DIR defaults to ../data)
cd web && npm install && npm run dev           # UI :5173, proxies /api
cd web && npm run build && cd ../server && npm run build && npm start     # prod-like
docker compose up --build                      # http://localhost:8080
cd server && npm test                          # unit tests
scripts/smoke.sh | smoke-auth.sh | smoke-boards.sh | smoke-sessions.sh | smoke-work.sh | smoke-registers.sh | smoke-catalogue.sh | smoke-integrations.sh (ARCHIGOV_FIXTURES=1 ADO_HOOK_SECRET=…) | smoke-empty.sh (SEED_DEMO=false)  <base-url>
```

- `npx tsc -p tsconfig.json` in both folders must be clean before committing; `npm test` must pass; all nine smoke scripts must be green, **each once on a fresh instance**: smoke.sh → smoke-auth.sh → smoke-boards.sh → smoke-sessions.sh → smoke-work.sh → smoke-registers.sh → smoke-catalogue.sh in that order on one seeded instance (smoke-catalogue retires and re-imports fixed artefacts, so it is not re-runnable on the same instance), smoke-integrations.sh on a fresh `ARCHIGOV_FIXTURES=1` instance, smoke-empty.sh on a fresh `SEED_DEMO=false` instance. They mutate the demo: reset with `docker compose down -v && docker compose up -d`. Build the image with the compose file's absolute path (`docker compose -f /…/docker-compose.yml build`) and check `docker images archigov:local` is fresh before swapping — a build launched from the wrong directory "succeeds" with `no configuration file provided`.
- Lock files must stay in sync with package.json (`npm ci --dry-run`); the Docker build uses `npm ci`.
- Native test instances: pick free ports with `ss -ltn` first (8080 is the container; machine-specific port reservations are in `CLAUDE.local.md`). `npm run dev` is `tsx watch`: killing only the child `node` makes the watcher respawn it on the next file change — stop the `tsx watch src/index.ts` process (or the harness task) itself. On a cold container boot wait for health with `curl --retry-all-errors` (Docker's proxy resets before the app listens).
- Browser checks: `playwright-core` + `/usr/bin/google-chrome` with `headless:false, args:["--headless=new","--no-sandbox"]`; Carbon keeps inactive tab panels in the DOM, so scope locators to `[role=tabpanel]:not([hidden])`.

## Delivery process (full SDLC — every change from v0.1.0 on)

The repo is public (github.com/00xE8/archigov, AGPL-3.0). The consolidation commit that preceded v0.1.0 is the
last direct-to-main blob; from here on:

- **Branch per change**: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>` off `main`; `main` stays
  releasable. Open a PR even solo — the PR body carries what and why, links the feature doc, and is squash-merged
  with a conventional title after the quality gate passes.
- **Conventional commits**: `feat:` `fix:` `docs:` `refactor:` `test:` `chore:` (+ scope: `feat(boards): …`).
  The body explains why; attribution lines per the harness convention.
- **Every feature ships with its documentation, in the same PR**: a page under `docs/features/<slug>.md`
  (what it does; who it serves, by role; how it works — endpoints, tables, capabilities, migrations; what it
  deliberately does not do), a CHANGELOG.md entry under Unreleased, and CLAUDE.md's layout/conventions kept
  current. Code comments keep the existing rule: constraints the code cannot show, never narration.
- **Every change — feature, fix, refactor or chore — gets a documentation impact check before its PR is
  opened**: decide explicitly what must be **created**, **updated** or **deleted**, and do it in the same PR.
  Walk the whole set: `README.md`, `docs/features/*`, `docs/board-sessions.md` and other specs, CHANGELOG.md,
  this file (layout, conventions, known gaps — strike what the change closed), `infra/README.md` (env vars,
  deployment), code comments that describe the changed behaviour, and the user documentation at
  archigov.com/docs (sources in the private repo's `site/docs-src/`: prose, screenshots and process diagrams —
  a changed UI label, route, rule, role or workflow step means the page, its screenshot or its diagram is now
  wrong). Stale documentation is a defect: remove what no longer applies rather than leaving it to mislead.
  The PR body states the outcome in one line — what was created, updated or deleted, or "no documentation
  impact" with the reason.
- **Quality gate** (unchanged, now per-PR): tsc clean in both folders, `npm test` green, the nine-smoke battery
  on fresh instances, axe + a browser pass on touched UI, `npm ci --dry-run` lock check.
- **Releases**: semver. Bump both package.json versions, move Unreleased to a dated heading in CHANGELOG.md,
  tag `vX.Y.Z`, `gh release create vX.Y.Z` with that section as the notes. Patch = fixes; minor = features;
  major = breaking API/schema (migrations are forward-only — a breaking one forces a major).
- **Public-repo hygiene**: `data/` is gitignored and holds real credentials — nothing under it is ever committed;
  no tokens, account ids or infrastructure identifiers in tracked files; the secret scan is part of going public,
  not a one-off. Operational auth notes (Cloudflare tokens, wrangler versions, machine specifics) live in
  `CLAUDE.local.md` (gitignored) and the private repo, never here.

## Conventions

- **RBAC has two levels, and platform admin is not an author.** A user may hold one system role — **author** (submits every kind of review, authors catalogue drafts and decisions, runs pre-review, verifies, imports drafts; submitter and author are the same thing), **auditor** (reads and exports, changes nothing), **service** (integrations; read only) — or none. The **platform admin** flag is separate and operational only: sources, settings, users, boards configuration, backups, pack installation on first run; it never grants submit, comment, approve or decide. Governance rights come from **board seats**: chair (declares outcomes once the positions allow — no vote in areas mode — resolves conditionals, opens/closes sessions, exceptions/resolve/conditions/decision status in the board's remit, manages the board), decision maker (records positions per area they own — yes/no/conditional/not my area — or, in count mode, approves/requests changes; may delegate their seat per session), reviewer (assesses: comments, pre-reviews, may send an item back without holding an area, never approves), secretary (runs the board: members, routing, sessions, attendance, notes; no vote), observer (read-only). The platform admin gets 403 on every session, position and declaration route. Demo DA decision makers: m.hughes (security, data, compliance, ai) and p.osei (integration, infrastructure, resilience, cost). A platform admin with no seat and no role sees everything and changes nothing (segregation of duties). Users live in the `users` table (`auth/users.ts`); legacy names migrate and are accepted as aliases (admin → platform admin flag only; architect/engineer/submitter → author; chair → author + DA chair; reviewer → author + DA reviewer; board_member → DA decision maker; member → decision maker). Entra: `roles` claim values are system roles, `platform_admin` sets the flag, `DA:chair` / `board/PCB/decision_maker` grant seats, a dotted value like `arb.chair` keeps the legacy-suffix meaning.
- **Auth modes.** `AUTH_MODE=local` (default): the session cookie wins; without one the `x-user` header is accepted and an unknown user becomes a platform admin only (no system role, no seats) — so scripts act as explicit demo users for governance actions (authors s.patel/a.okafor, decision maker m.hughes, chairs j.duduka/r.khan, platform admin ops.admin). Local mode is a trusted-network convenience, not a security boundary. Local mode is also the UI's dev mode: the header carries a **View as** dropdown of every user with their roles for one-click persona switching (it signs in via `POST /auth/local`, so later actions and audit rows are genuinely theirs); the account panel's **Custom user** builds an identity with any system role, the admin flag and multiple board seats. Neither exists under Entra. `AUTH_MODE=entra`: OIDC code + PKCE, id_token verified via JWKS, user id `<tid>:<oid>` (never email); `x-user` is ignored; unauthenticated calls get 401 `{error:'sign_in_required', login_url}`. Capabilities live in `auth/roles.ts`; route rules are matched top-down and **an unlisted mutation falls to manage_platform**, so a new POST is closed until opened; board-level checks (`boards/workflow.ts`) run inside the review handlers and answer 403 with a `reason`. Only `/health`, `/auth/*` and `/hooks/*` are exempt. The UI gates with `useCan()`/`Gated` and each review's own `can`, but the server is the authority.
- Everything that matters writes to `audit_log`; rows carry `actor`, `role`, `prev_hash` and `hash` (SHA-256 chain, verified by `GET /audit/verify`). The evidence pack is canonical JSON signed with the instance's Ed25519 key (`DATA_DIR/keys/`) and records the chain head; `GET /evidence-pack/verify?hash=` re-checks hash, signature and chain.
- IDs are UUIDs; human codes are `STD-xxx` (3 digits), `ADR-xxxx`, `REV-xxxx` (4 digits); `nextCode` numbers per prefix, numerically, so suffixed codes like `STD-006b` never cause collisions.
- Rule DSL: `{scope: resource|application, match: {type|typeIn|typePrefix|where[]}, assert: {path, op, value} | {op: decisionConstraint, topic} | {op: evidence, control, source?, state?} | {op: hasDecision, topic, type?} | {op: hasOwnerTag} | {op: maxResourcesOfType, type, max}}`. Ops: eq neq in notIn exists missing gte lte matches. `evidence` asserts on *imported* evidence (sources `defender` | `azure_policy` | `manual`; omit `source` to accept any): missing evidence is a finding ("no evidence imported"), never a pass. Unknown op / invalid regex = rule error (`rule_errors` on the run, `rule_error` on the standard), never a pass. Normalised props: `props.publicAccess`, `props.minTlsVersion`, `props.osSku`, `props.location`, `props.httpsOnly`, `tags.owner`; the owning application's classification as `app.criticality|regulated|services|service_kinds` (`match.where` works at both scopes); `lifecycle.state|product|cycle|eol|tracked` (the resource's worst component). Lifecycle ops: `{op: lifecycle, states?: [...], unknown?: ignore|finding}` (resource) and `{op: assessmentCurrent, kind: legacy|exit_plan}` (application) — malformed ones are refused at authoring.
- **Control mapping** (`azure/controls.ts`, override with the `evidence.control_map` setting): Defender assesses storage public access, SQL public network access, App Service HTTPS-only / min TLS, system updates; Azure Policy covers storage/SQL min TLS, Key Vault purge protection / soft delete, Cognitive Services local auth. Unmapped items keep `defender:<slug>` / `policy:<definitionName>` keys. Keep demo fixtures honest to that split — never show evidence a real tenant cannot produce. Verified API versions: Resource Graph 2024-04-01 (`resultTruncated` is a string; paging ends on a missing `$skipToken`), Defender assessments 2021-06-01 (list has no `$expand`; join `assessmentMetadata`), Policy Insights 2024-10-01 (PascalCase `$filter`, `@odata.nextLink`), ADO 7.1.
- **Fixture mode** `ARCHIGOV_FIXTURES=1`: collectors answer from `azure/fixtures.ts` / `ado/fixtures.ts` through the real parsing code; a fixture Azure sync adds its own small recorded subscription (it never touches demo ids, so human verification on the demo survives).
- Findings are keyed by fingerprint (standard × element × application) so they persist across runs with first_seen/last_seen; exceptions turn them `excepted`; a human can resolve with a reason (`resolved_by/resolution`) and re-evaluation reopens it with a `reopened` audit row if the condition persists; each run stores `changes_json` (opened/resolved/reopened).
- LLM output is always `origin='ai'`, `verification='unverified'`; citations that do not resolve are discarded before storage; rules pre-review is `origin='rules'`, `unverified`.
- **Every tag explains itself on hover.** `explainTag` in `web/src/components.tsx` maps kind (and value, where the value carries governance meaning) to a plain-language sentence; the title goes on a span *inside* the Carbon Tag because Carbon's `Tag` swallows a `title` prop (it is reserved for the filter close button). Raw `<Tag>` usages in pages carry their own titled span. Diagram legend entries do the same (ArchimateView GROUPS carry `explain`; the Serves entry states the ArchiMate serving semantics).
- **Third parties** (`suppliers.ts`, `docs/features/third-parties.md`): providers are derived (type namespace; supplier tags — a tag naming a platform joins it), never typed in. An exit plan is needed for each provider of an application that is critical/important or regulated (`needsExitPlan`); status due|current|not_needed, valid 12 months; result as legacy, substitutability not_substitutable|highly_complex|medium_complexity|easily_substitutable (ITS B_07.01 wording in the DORA export, blank without a plan), tested_at not in the future, reference link only. The CTP list is reference data with its instrument (SI 2026/777) — re-check designations before quoting externally; HM Treasury designates on a rolling basis. Demo: `vendor: Ledgerline` on vm-erp-app-01; PatientFlow holds a current Microsoft exit plan.
- **Legacy register** (`lifecycle.ts`, `docs/features/legacy-register.md`): versions are matched from collected facts only — a tracked resource without one is `unknown`, never assumed supported, until an author sets it (PUT /resources/:id/lifecycle, reason ≥10, capability `verify`, audited `lifecycle:set`). "Legacy" = extended or end_of_life. The yearly legacy assessment (DORA Art. 8(7)) lives in `register_assessments` (kind `legacy`; `subject` is for the exit plans to come), result satisfactory|satisfactory_with_remarks|unsatisfactory, summary ≥10, reference an http(s) link only — never the document; status not_needed|due|stale|current. Refreshing the lifecycle data is the platform admin's (default for an unlisted mutation) and keeps a failed product's previous data. The AI draft rides on `draft_assessment` (no new toggle). Demo: Finance ERP holds a current assessment; Pharmacy (Windows Server 2012 R2), Referral API (.NET 6), Data Platform (AKS 1.29), Intranet and PatientFlow (Node.js 20) are due.
- **Fast lane** (`boards/fastlane.ts`, `docs/features/fast-lane.md`): policy JSON `fast_lane {enabled, require_pattern}`, design policies only (400 elsewhere). Eligibility is derived on every read, never stored or cached: tier low (max of the submitter's declared tier, the app's criticality — critical high, important/unclassified medium — and open high findings), claimed patterns adopted (≥1 when required) and their rules passing for the app (live dry run, app-wide exceptions honoured), no live rule finding ≥ medium, the latest pre-review newer than the (re)submission with no finding ≥ medium (**an AI finding vetoes; nothing AI grants the lane**), no open requested assessment, no live no / unresolved conditional, stage open. In the lane `progress.satisfied/ready` are true and `via_fast_lane` is set: owners are not awaited (`awaitingMe`, `/me/work` positions skip it), the chair's declare queue and the consent agenda pick it up, and `declareOutcome` records `data.fast_lane` + audit `basis: "fast_lane"`. Claims: `POST /reviews {patterns}` / `PUT /reviews/:id/patterns` (submitter only, adopted patterns only). Demo DA design policy has it on with a pattern required (DEMO_USERS_VERSION 4).
- **Criticality classification** (`classification.ts`, feature doc `docs/features/criticality-classification.md`): critical · important · standard · unclassified, plus services of kind ibs | cif | essential_function | business_service. **A regulated service (ibs, cif, essential_function) makes an application critical** — enforced for derivation, a person's PUT (400) and the AI suggestion alike. Derived from tags (`criticality`/`tier`/`service-tier`… and `ibs`/`cif`/`essential-function`/`business-service`, values split on `;,|`); a person's classification (origin human, reason ≥10, verified by the setter, audited `classification:set`) is never overwritten by collection — Reset to Derived hands it back. Rules read `app.criticality|regulated|services|service_kinds` in `match.where` at both scopes; the DORA register's B_06.01.0050 ("Critical or important" for critical, "Not critical or important" for standard, blank for important and unclassified — never guessed) and function name come from it; the evidence pack carries it. Classifying is capability `verify` (authors) — platform admin, auditor and seat-only decision makers get 403. Demo tags classify every app but Pharmacy (left unclassified on purpose).
- The Applications page flags deployed regions outside the `home_regions` setting (default `uksouth, ukwest, global`; edited under Settings · General, stored as `regions.home`, `[]` flags nothing). The flag is advisory UI; region findings still come only from adopted catalogue rules.
- **Assessments** (`review_assessments`): due diligence on a review — type (dpia, security, supplier, clinical-safety, ai-impact, accessibility, impact, scope, other+title), optional area, assignee, due date. **Two flavours.** A chair/decision-maker/reviewer seat **requests** one (never the submitter — the board asks, the submitter may be the assessor); **only the assignee records the result** (satisfactory · satisfactory with remarks · unsatisfactory · not applicable, summary ≥10 chars, external `reference` pointer only — never the document). An open request blocks every approving outcome (`canDecide`, `progress.ready`, consent eligibility) until recorded or **waived by the chair with a reason**; an unsatisfactory result never hard-blocks (boards decide). The **submitter PROVIDES** one instead (`provided=1`, m012): supporting information attached at or after creation, arriving already recorded by its author, so it never blocks; only its author updates it (POST /reviews/:id/assessments/provide + PUT /assessments/:id/provided, capability submit_review; a board-requested result is never editable this way, 409). Every type carries a **template** (ASSESSMENT_TEMPLATES, served by GET /assessments/types) — the headings a competent result answers, inserted as the summary's skeleton in the UI; prompts only, never regulation text. Resubmission marks completed results `stale`, never deletes; an author's update to a provided one re-affirms it (stale clears). Everything lands on the timeline (`assessment_*` events incl. provided/updated), the audit chain (`assessment:request|result|waive|reassign|provide|update`) and the evidence pack; the assignee's queue is in `/me/work.assessments`. Platform admin gets 403 on all of it. **Third anchor (m014): a DECISION.** The author of a proposed decision gathers the evidence its argument needs before review — triggers an assessment (`POST /decisions/:id/assessments`, assessor completes via the shared result route) or provides one (`…/assessments/provide`); rows carry `decision_id` (review_id nullable, CHECK one of the two), are audited on the decision, follow it onto its review flagged `on_decision`, and NEVER block (no waive, no reassign — blocking stays with board-requested review assessments).
- Never add a feature that only makes sense for a hand-authored repository (capability maps, free-form modelling). Everything must feed the model, improve a decision, or prove conformance. Importers (CSV, ArchiMate) are sources with provenance, not editors.

## Known gaps / next steps (in rough priority)

1. Real round-trips: **Resource Graph, Defender and Policy Insights verified against a live tenant (Oct 2026)** — client-credentials token, five-subscription scope, collection, RG-convention inference and region flagging all worked; syncs report `ok`, no schema errors. Two learnings from that shakedown: (a) real tenants return **subscription-scoped** assessments (Defender MCSB recommendations, Policy states at subscription scope) whose target id is the subscription itself — the evidence matcher attaches only to resource elements, so they all land in `unmatched`; decide whether to attach them to a tenant-level pseudo-element or filter them explicitly. (b) The test tenant was nearly empty (1 resource), so pagination, quota headers and Defender `assessmentMetadata` key resolution at volume remain unverified — re-check on a populated tenant. Entra sign-in and Azure DevOps still fixture-verified only.
2. Azure DevOps: Entra-token auth is wired (global PATs end 1 Dec 2026); the service-hook subscription must be created in ADO by hand (document a `wit`/`workitem.updated` subscription with the header secret); `revision.fields` diff shape unconfirmed in docs — parsed defensively.
3. Cloudflare deployment is a validated scaffold (private repo `archigov-internal`, `infra/cloudflare`, four `TODO(verify)` items in its README). Workflows for long syncs and AI Gateway not started.
4. DORA register CSV: column codes follow the ITS annex as reproduced in the EBA draft — confirm against the Official Journal; Annex III service-type codes and LEIs are left blank for a human.
5. Standards packs: ISO 27001 design controls and DSPT/CAF packs (references only); pack versioning/upgrade of already-imported standards.
6. Importers: LeanIX/Ardoq via API/MCP; AI import of Visio/PPTX/Word with a staging queue and confidence scores.
7. GitHub Issues/Projects and Jira as backlog sources; AWS/GCP collectors (wrap Cartography/Steampipe as optional, keep native Azure).
8. Platform: rate limiting on `/hooks/*` and `/auth/*`, session revocation, admin UI for the tenant directory in the managed front door.
9. Governance workflow: Entra group → board membership mapping (seat areas are managed in-app only); notifications/SLAs for positions awaiting a user and for circulation due dates; artefact version history and diff between versions; per-board exception/resolve rights instead of "chair of any board".
10. Sessions: observers cannot self-record attendance (the seat holds no capability; the secretary records them); a scheduled job for overdue circulations (today they are flagged at read time and pulled onto the next agenda); minutes export as a signed file; in-flight DA reviews that pre-date areas mode keep their count-mode approvals as area-less positions and need re-recording per area.

## Business constraints to remember

- AGPLv3 core, Apache-2.0 connectors/templates/policy SDK, CLA for dual licensing. Decide once, never relicense to something more restrictive (this much is public — see README · Licensing).
- Pricing, tiers and free-tier economics are not published: see `CLAUDE.local.md` in a working copy, or `BUSINESS.md` in the private repo `00xE8/archigov-internal`.
