# Criticality classification and business services

## What it is

Every application carries a classification: how critical it is (**Critical**, **Important**, **Standard**, or unclassified) and which business services or regulated functions depend on it — an important business service (PRA SS1/21, FCA SYSC 15A), a critical or important function (DORA), an essential function (NCSC CAF / NIS) or a plain business service. The classification is derived from resource tags with its evidence kept, a person can confirm it or set it with a reason, and the **Business Services** page turns it into the dependency map those rules ask for: each service, the applications behind it, and through them the resources, regions and shared platforms it relies on.

## Why

Operational-resilience rules (PRA SS1/21 ch. 5, FCA SYSC 15A.4, DORA Art. 8 and the register of information, NCSC CAF A3) all start from the same question: which systems support the services that must not fail, and what do those systems rest on? Hand-maintained answers drift from the estate. Here the answer is **derived, not authored** — tags that cloud estates already carry populate it, the derivation's method and evidence travel with it, and a person spends their effort confirming or correcting it, exactly as for application inference. Once classified, the rest of governance can use it: rules can target critical applications only (`app.*`), the DORA register fills its criticality column, and the evidence pack records who stands behind each classification.

## Heuristics and AI

Deterministic, because it gates or changes state:

- **Derivation** (`deriveClassification`): tier tags (`criticality`, `business-criticality`, `tier`, `service-tier`, case- and `_`/`-`-insensitive) map known values to a tier (`critical`/`mission-critical`/`tier-1`/`gold`/`high`…, `important`/`tier-2`/`silver`/`medium`…, `standard`/`tier-3`/`bronze`/`low`…); the highest tier any resource carries wins. Service tags (`ibs`, `important-business-service`, `cif`, `critical-function`, `dora-cif`, `essential-function`, `business-service`) name services, several per value split on `;` `,` `|`. An unknown value classifies nothing.
- **The invariant**: supporting a regulated service (IBS, CIF, essential function) makes an application critical — for derivation (method `regulated-service`), for a person's classification (400 otherwise) and for an AI suggestion (normalised before it is shown).
- **Verification** drops back to unverified the moment the derived content changes; a person's classification is never overwritten by collection.
- Rules, the DORA register and the business-service map read the stored classification only.

AI, optional and advisory — **Classification Suggestion** (`suggest_classification`, off by default, enabled per feature under Settings · AI): for an application the tags leave open, a model reads its name, resources, tags, decisions and planned changes, plus the service names the estate already uses, and suggests a tier, the services and a short rationale. Suggest → confirm: nothing is stored, the suggestion appears inside the Classify form beside an **Apply Suggestion** button, and the person still saves it with their own reason, as their own classification. Rules never read a suggestion.

## Who can do what

- **Authors** (capability `verify`): classify an application (`PUT`), reset it to derived, verify a derived classification, ask for an AI suggestion.
- **Everyone who can read the model** (auditor, service, board seats, platform admin): sees classifications, the Business Services page, the DORA register column.
- Refused with 403: the **platform admin** (operations, not content — segregation of duties), the **auditor**, and a **seat-only decision maker** with no system role.

## API

- `GET /applications` — each application carries `classification {criticality, services, regulated, origin, verification}`.
- `GET /applications/:id` — the full `classification`: also `method`, `evidence[] {resource, tag, value}`, `derived` (what the tags say, kept beside a person's classification), `reason`, `set_by/at`, `verified_by/at`.
- `PUT /applications/:id/classification` — `{criticality: "critical"|"important"|"standard"|null, services: [{name, kind}], reason}` (reason ≥ 10 characters; a regulated service with a tier other than critical is 400). The result is `origin: human`, verified by the setter.
- `POST /applications/:id/classification/reset` — hands it back to derivation (409 when already derived).
- `POST /applications/:id/classification/verify` — `{verified?: false}` to withdraw.
- `POST /applications/:id/classification/suggest` — the AI suggestion; 409 when the feature is off, 404 for a non-application, nothing stored.
- `GET /business-services` — `services[] {name, kind, regulated, applications[] {criticality, verification, resource_types, regions, shared_services, open_findings}, resources, regions, shared_services, open_findings, verified}` (regulated services first), `unclassified[]`, `critical_without_service[]`, `counts`.
- **Rules** read `app.criticality`, `app.regulated`, `app.services`, `app.service_kinds` — in `match.where` for both resource and application scope (application-scope `where` is new and validated like the resource one).

## Data & audit

- Migration m015: `app_classifications` (one row per application — criticality, `services_json`, `origin` derived|human, `method`, `evidence_json`, `derived_json`, `reason`, `set_by/at`, verification fields, `content_hash`/`verified_hash`). Refreshed at the start of every evaluation run.
- Audit actions on `applications`: `classification:set` (from → to, with the reason), `classification:reset`, `classification:verify` / `classification:unverify`.
- DORA register (`/exports/dora-roi.csv`): `B_06.01.0050` reads "Critical or important" for a critical application and "Not critical or important" for a standard one, and stays blank for an important or unclassified one — whether our important tier is a DORA important function is the entity's call, never guessed; the function name comes from its regulated services.
- The evidence pack carries each application's classification with its origin and who verified it.

## UI

- Application detail: a **Classification** line under the title — tier tag, service tags, origin, verification, how it was reached — with **Classify**, **Reset to Derived** and **Verify** for authors. The Classify modal (Select, service rows with an icon-only remove button carrying a tooltip, a reason with inline validation) shows what the tags say and, when enabled, **Suggest with AI** (greyed with the reason when the admin has not enabled it).
- Applications: a **Criticality** column and a filter (`?criticality=critical|important|standard|unclassified`).
- **Business Services** (Model group, `/services`): hero counts by tier, a notification listing unclassified applications with **Show Unclassified**, a note on critical applications that name no service, and an expandable Service Dependency Map table.
- Every tag explains itself on hover (`explainTag`: criticality, service kind).

## Verification

`server/test/classification.test.ts` (9 tests: derivation incl. the regulated-service rule; the demo estate; who classifies; human classification surviving re-collection and reset; verification dropping on a derived change; rules reading `app.*` in both scopes; the business-service map; the DORA column; the evidence pack). `server/test/ai-features.test.ts` covers the suggestion (409 when off, 403 for the platform admin and auditor, normalisation, nothing stored). `scripts/smoke-registers.sh` runs the flow end to end on a seeded instance, after `smoke-work.sh`.
