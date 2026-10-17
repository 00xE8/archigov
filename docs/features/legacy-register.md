# Legacy register and the yearly legacy assessment

## What it is

The **Legacy Register** lists every lifecycle-tracked component in the estate against its vendor's support dates. Tracked components are operating system images, App Service runtimes, PostgreSQL and MySQL engines and AKS Kubernetes versions. Each is in one of five states:

| State | Meaning |
|---|---|
| Supported | The vendor still supports this version. |
| Support ending | Support ends within the warning window, 365 days by default. |
| Extended support | Past standard support, inside a paid extended-support window. |
| End of life | The vendor no longer issues security fixes. |
| Unknown | No version fact was collected. |

Components in extended support or past end of life are **legacy**. Every application with a legacy component needs a **yearly legacy assessment** (DORA Art. 8(7)). The assessment is recorded by a named author with a result and a written assessment. It goes stale when a new legacy component appears.

## Why

DORA Art. 8(7) requires a specific ICT risk assessment of legacy ICT systems every year, and again before and after connecting new technologies. ISO 27001 A.8.8 and NIST SP 800-53 SA-22 ask the same question in other words: what is unsupported, and what have you done about it? archigov answers from the derived model instead of a spreadsheet.

- The versions come from facts collection already holds.
- The dates come from a public, versioned dataset ([endoflife.date](https://endoflife.date), MIT).
- The assessment is a governance record with a named author.
- A rule turns all of this into findings, so the register stays continuous.

## Heuristics and AI

Everything that decides a state or a finding is deterministic.

- **Matching** reads only what collection holds:
  - **VM image sku and offer**: Windows Server year and R2, Ubuntu `NN.NN`, RHEL major, Debian major. An `sqlYYYY-wsYYYY` offer yields both SQL Server and Windows Server.
  - **App Service runtime**: `linuxFxVersion` (DOTNETCORE, NODE, PYTHON, PHP, JAVA) and a Windows `netFrameworkVersion` of v5 or later.
  - **Engine and platform versions**: PostgreSQL, MySQL and AKS.
- **Missing facts are not guessed.** A tracked resource with no version fact is **unknown** until a person sets its components, with a reason of at least 10 characters. That correction has origin `human` and collection never overwrites it.
- **SQL Server versions**: SQL Server is named by year, and its service packs are separate lifecycle cycles. The latest service pack is assumed, and the method says so.
- **States** come from the cycle's dates and today:
  - past `eol` → extended support if `extendedSupport` is still in the future, otherwise end of life;
  - `eol` within the warning window → support ending;
  - otherwise → supported. A cycle with no published end of support is supported, not unknown.
- **The assessment's status:**
  - *not needed* when the application has no legacy component;
  - *due* when there is no assessment in date (valid for 12 months by default);
  - *stale* when an assessment is in date but a legacy component it did not cover has appeared since;
  - otherwise *current*.

**AI is optional and advisory.** *Draft with AI* in the assessment form uses the existing **Assessment Drafting** feature (`draft_assessment`), so there is no new toggle. It fills the template headings from the register's facts and writes "To be confirmed: …" where the facts are silent. It never invents controls, plans or dates. Nothing is stored, and the author records the assessment as their own. No AI maps versions or sets states.

## Who can do what

- **Authors** (capability `verify`) can:
  - set or reset a resource's components;
  - record a legacy assessment;
  - ask for an AI draft.
- **Platform admin** (`manage_platform`, the default for an unlisted mutation) refreshes the lifecycle data from endoflife.date.
- **Everyone who can read the model** sees the register and the assessments.
- **Refused with 403**:
  - the platform admin and the auditor, on corrections and assessments;
  - an author, on refreshing the lifecycle data.

## API

- `GET /lifecycle`: the register. It returns:
  - `snapshot {source, licence, url, fetched_at, products[], refreshed}`, `warn_days` and `assessment_months`;
  - `counts` by state;
  - `components[]`, one per product version: `{key, product, product_label, cycle, label, state, eol, extended, support, resources[] {id, name, type, application, origin, method, evidence}, applications[]}`, worst first;
  - `unmatched[]`;
  - `applications[]` `{id, name, legacy[], worst, status, last, new_since_last[]}` and `due`.
- `GET /lifecycle/products`: the products and their cycles, with state, for the correction form.
- `POST /lifecycle/refresh` (platform admin): fetches every product from `https://endoflife.date/api/<product>.json`. A product that fails keeps its previous data. Returns `{fetched_at, products, failed[]}`.
- `GET /resources/:id/lifecycle`: one resource's components.
- `PUT /resources/:id/lifecycle` with `{components: [{product, cycle}], reason}` sets the components. Returns 400 for an unknown product or cycle, more than five components, or a reason under 10 characters.
- `POST /resources/:id/lifecycle/reset`: hands the resource back to the collected facts. Returns 409 if it is already derived.
- `GET /applications/:id/legacy`: the application's standing, its assessment history, the template and the allowed results.
- `POST /applications/:id/legacy-assessments` with `{result: satisfactory | satisfactory_with_remarks | unsatisfactory, summary_md (≥ 10 characters), reference?}` records an assessment. The reference must be an http(s) link to where the document lives; the document itself is never uploaded.
- `POST /applications/:id/legacy-assessments/draft`: the AI draft. Returns 409 when Assessment Drafting is off.
- **Rule DSL additions:**
  - `{op: "lifecycle", states?: [...], unknown?: "ignore" | "finding"}` at resource scope. It produces one finding per resource whose worst component is in one of `states`, which defaults to `["end_of_life"]`.
  - `lifecycle.state|product|cycle|eol|tracked` can be read in `match.where`.
  - `{op: "assessmentCurrent", kind: "legacy"}` at application scope produces a finding when the application's assessment is due or stale.
  - A malformed rule of either kind is refused when it is authored.

## Data & audit

- **Migration m017** adds two tables:
  - `lifecycle_overrides` (resource → components, reason, set_by/at);
  - `register_assessments` (kind, application, subject, result, summary, reference, the components covered, assessed_by/at, valid_until, origin). The table is shared with the exit plans that will follow.
- **Settings:**
  - `lifecycle.snapshot` holds the refreshed data; without it the release's bundled snapshot in `server/src/lifecycle/snapshot.ts` applies;
  - `lifecycle.warn_days` defaults to 365;
  - `lifecycle.assessment_months` defaults to 12.
- **Audit actions:** `lifecycle:set` and `lifecycle:reset` (on the element), `legacy:assess` (on the application, with result, components and validity) and `lifecycle:refresh`.
- **Evidence pack:** each application carries `legacy {status, components, assessment {result, assessed_by, assessed_at, valid_until, reference, covers}}`.
- **DORA pack:** `dora-ict-architecture` gains two standards, imported as drafts:
  - **STD-DORA-06** *Legacy ICT systems are risk-assessed every year* (`assessmentCurrent`, DORA Art. 8(7));
  - **STD-DORA-07** *No ICT component runs past its end of life* (`lifecycle`, DORA Art. 8(7), ISO 27001 A.8.8, NIST SP 800-53 SA-22).
- **Seed:** the demo has one current assessment (Finance ERP, SQL Server 2016 SP3 in extended support). The other applications with legacy components are due.

## UI

**Legacy Register** sits in a new **Risk** nav group at `/legacy`, with a red hero and the Hourglass icon. The page has:

- **Glass counts** by state.
- **A warning notification** naming how many applications are due.
- **Legacy Assessments**, a table per application with Record Assessment. The assessment form has:
  - the components it covers;
  - the result as radio buttons;
  - the template in a monospace text area, with Draft with AI greyed and its reason shown when the feature is off;
  - a reference link with inline validation.
- **Components**, an expandable DataTable, worst first. Each version expands to its resources, how each was matched, and **Correct**.
- **Version Unknown**, listing tracked resources with no version fact, with **Set Version**.
- **A footer** naming the data source, licence and date, with **Refresh Lifecycle Data** for the platform admin only.

States and assessment statuses are status tags (colour, icon and word) and explain themselves on hover.

## What it deliberately does not do

- It does not scan hosts or guess versions from names. Unknown stays unknown until a person says otherwise.
- It does not track Azure-managed services with no customer-chosen version, such as Azure SQL Database logical servers.
- It does not assert compliance. An unsatisfactory assessment is recorded as such, and the board decides what follows.
- It does not upload or store the assessment document. It keeps a link only.

## Verification

- `server/test/lifecycle.test.ts`, 8 tests:
  - the state boundaries;
  - matching for every tracked type and the SQL Server service-pack note;
  - the demo register;
  - corrections, including 403s and validation;
  - the assessment, including validation, a stale status after a new legacy component, and 403s;
  - the `lifecycle` and `assessmentCurrent` ops, including `where` on `lifecycle.state` and malformed rules refused;
  - a refresh that keeps failed products, with a mocked fetch;
  - the AI draft returning 409 when off, and the evidence pack.
- `scripts/smoke-registers.sh` steps `g` and `h`.
