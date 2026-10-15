# Third parties, concentration and exit plans

## What it is

**Third Parties** shows which ICT providers the estate relies on. For each provider it shows:

- the applications that rely on it;
- how many of them are critical or important;
- which regulated services stand behind them;
- whether HM Treasury has designated the provider a **critical third party** (CTP).

A warning names any provider that carries half or more of the critical and important applications.

Every application that is critical or important, or that supports a regulated service, needs an **exit plan** for each provider it relies on. A named author records each plan with:

- its adequacy;
- the written plan;
- the provider's **substitutability**, in the DORA ITS vocabulary;
- when the plan was last tested.

An exit plan is valid for a year. Its substitutability fills the DORA register's B_07.01 column.

## Why

DORA Art. 28(8) requires exit strategies for ICT services that support critical or important functions, and the register of information asks how substitutable each provider is (B_07.01). PRA SS2/21 chapter 10 expects documented, tested exit plans for material outsourcing.

The UK critical third parties regime adds a concentration question. HM Treasury designated four cloud providers effective 13 July 2026 (SI 2026/777), so a firm needs to know how much of its critical estate sits on any of them. In an Azure estate the honest answer is usually "all of it". The view states that plainly, and the exit plans are how a firm shows it has thought about it.

## Heuristics and AI

Everything that decides a reliance, a status or a finding is deterministic.

- **Providers are derived, not typed in:**
  - The cloud platform comes from the resource type's namespace: `Microsoft.*` → Microsoft. AWS, Google and Oracle types are recognised the same way, for imported resources.
  - Named suppliers come from `supplier`, `vendor`, `provider`, `third-party` or `saas` tags on resources. Values split on `;`, `,` and `|`. A tag that names a platform (Azure, AWS…) counts towards that platform, not as a separate supplier.
- **An exit plan is needed** when the application is classified critical or important, or supports a regulated service (see [criticality classification](criticality-classification.md)). It is due when there is no plan in date for that provider, and current otherwise.
- **The designations** are reference data with their legal source, not code. The release ships the four designated entities, and the platform admin replaces the list (`PUT /third-parties/ctp`) as HM Treasury designates more.
- **The concentration flag** is raised when one provider carries half or more of the applications that need exit plans.

AI is optional and advisory. *Draft with AI* in the exit-plan form uses the existing **Assessment Drafting** feature (`draft_assessment`), so there is no new toggle. It fills the template headings from what the model knows about the reliance: the resources, the regions and the designation. Where the facts are silent (alternatives, timelines, costs, test results) it writes "To be confirmed: …". It never invents a provider, a date or a result. Nothing is stored, and the author records the plan as their own. No AI derives providers or sets a status.

## Who can do what

- **Authors** (capability `verify`) record an exit plan and ask for an AI draft.
- **The platform admin** (`manage_platform`, the default for an unlisted mutation) keeps the designations list current.
- **Everyone who can read the model** sees the view and the plans.
- **Refused with 403:**
  - the platform admin and the auditor, when recording a plan;
  - an author, when editing the designations.

## API

- `GET /third-parties` returns:
  - `ctp {regime, instrument, effective, entries[] {provider, entity}}`;
  - `providers[]`: `{id, name, kind (platform | supplier), ctp, applications[] {id, name, criticality, regulated, resources}, resources, regions[], critical, regulated_services[], share}`;
  - `concentration[]`;
  - `exit_plans[]`: `{application, provider, status, last}`;
  - `counts`;
  - `substitutability`, the allowed values.
- `PUT /third-parties/ctp` with `{regime?, instrument, effective, entries: [{provider, entity}]}` replaces the designations list (platform admin).
- `GET /applications/:id/third-parties` returns the application's providers with each exit plan's standing, the template, the allowed results and the substitutability values.
- `POST /applications/:id/exit-plans` records an exit plan. The body is `{provider, result, substitutability, summary_md, tested_at?, reference?}`:
  - `result`: satisfactory | satisfactory_with_remarks | unsatisfactory;
  - `substitutability`: not_substitutable | highly_complex | medium_complexity | easily_substitutable;
  - `summary_md`: at least 10 characters;
  - `tested_at`: a date, not in the future;
  - `reference`: an http(s) link only.

  It returns 400 for a provider the application does not rely on.
- `POST /applications/:id/exit-plans/draft` takes `{provider}` and returns the AI draft. It returns 409 when Assessment Drafting is off.
- In the rule DSL, `{op: "assessmentCurrent", kind: "exit_plan"}` at application scope raises a finding listing the providers relied on with no exit plan in date.

## Data & audit

- **Migration m018** adds `details_json` to `register_assessments`. An exit plan is a register assessment with kind `exit_plan`, subject = the provider, and details `{substitutability, tested_at, provider_name}`.
- **Settings:** `suppliers.ctp` holds the designations list. Without it, the release's list applies.
- **Audit actions:** `exit_plan:record` (on the application: provider, result, substitutability, test date, validity) and `ctp:set`.
- **DORA register** (`/exports/dora-roi.csv`):
  - B_07.01 substitutability comes from the latest exit plan for that application and provider, in the ITS wording. It is blank where there is no plan, and never inferred.
  - Each supplier named on tags gets rows of its own as an ICT third-party provider. Where and how it serves is left for the entity to fill.
- **Evidence pack:** each application carries `third_parties[] {provider, name, kind, designated_ctp, resources, exit_plan {status, result, substitutability, tested_at, assessed_by, valid_until}}`.
- **DORA pack:** `dora-ict-architecture` (version 1.1.0, eight standards) gains **STD-DORA-08** *Critical reliance on a third party has an exit plan* (`assessmentCurrent` exit_plan; DORA Art. 28(8), ITS B_07.01, PRA SS2/21 ch. 10). It is imported as a draft.
- **Seed:**
  - the demo ERP's application VM is tagged `vendor: Ledgerline`, a fictional ERP vendor;
  - PatientFlow holds a current exit plan for Microsoft (highly complex, tested in August);
  - every other critical or important reliance is due.

## UI

**Third Parties** (`/third-parties`) sits in the **Risk** group, with a red hero and the Partnership icon. The page has:

- **Glass counts:** providers, designated CTPs relied on, critical applications on a CTP, and exit plans due.
- **A concentration warning** naming the provider, its designated entity and the instrument.
- **Providers:** a table with a *Designated* tag that explains the entity and instrument on hover.
- **Exit Plans:** a table with status tags and Record Exit Plan. The form has:
  - substitutability;
  - the last test date;
  - adequacy;
  - the template, with Draft with AI greyed and the reason shown when the feature is off;
  - a reference link with inline validation.
- **A footer** naming the designations in force.

## What it deliberately does not do

- It does not discover contracts, LEIs or sub-contracting chains. Those stay for the entity to fill in the DORA register.
- It does not guess a supplier from a resource name. Only tags name suppliers.
- It does not say that concentration is acceptable or unacceptable. It shows the reliance and the plans; the board weighs them.
- It does not store the plan document. It keeps a link only.
- It has no designations-list editor in the UI yet. The platform admin updates the list through the API.

## Verification

- **`server/test/thirdparties.test.ts`, 5 tests:**
  - provider derivation (namespaces, supplier tags, a tag naming a platform);
  - the demo's concentration on a designated CTP;
  - the exit plan: 403s, validation, the audit row, and substitutability in the DORA register, including the supplier row;
  - the designations list as the platform admin's data;
  - the `assessmentCurrent` exit_plan rule, the AI draft's 409, and the evidence pack.
- **`server/test/exports.test.ts`** now pins the DORA register's supplier rows and plan-only substitutability.
- **`scripts/smoke-registers.sh`** step `i`.
