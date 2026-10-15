# Risk register and architecture debt

## What it is

The **Risk Register** holds the architecture risks the organisation has accepted or is carrying. Each risk has an owner, a severity and a review date. Risks come from three sources:

- **Decisions:** the risks a decision accepts. These are its Consequences made explicit, and their standing follows the decision.
- **Exceptions:** every active exception is an accepted risk, under review until it expires.
- **Authors:** risks an author logs on their own.

Only the owner, or whoever logged the risk, changes it. Closing or mitigating a risk needs a note.

Beside the register, **Architecture Debt** lists what the records already show, grouped by application. This list is never logged by hand. It contains:

- findings open longer than the debt age;
- drift from accepted decisions;
- overdue conditions;
- end-of-life components;
- expired exceptions whose finding is still open;
- legacy assessments and exit plans that are due.

## Why

Boards accept risks constantly: in decisions ("we accept single-region writes"), in exceptions, and in conditions. That acceptance usually lives in prose and minutes, with no owner and no date to look again. The register turns each accepted risk into a record with an owner and a review date. Where the record already exists, the register reads it: an exception is shown, never copied.

Architecture debt is the other half. A head of architecture is asked "what are we carrying?", and the honest answer is a list of records, not an estimate.

## Heuristics and AI

Everything that sets a risk's standing, or puts an item on the debt list, is deterministic:

- **A risk tied to a decision** shows as *proposed* while the decision is proposed, and *withdrawn* if the decision is rejected, superseded or deprecated. Otherwise it shows the status its owner records: open, accepted, mitigated or closed. A new decision risk starts *accepted*; a manually logged risk starts *open*.
- **A review is overdue** when the review date has passed and the risk is open or accepted. For an exception, the review date is its expiry.
- **Debt is derived on every read**, with nothing stored:
  - a finding becomes debt after `debt.finding_days` days open (90 by default). Drift findings are listed as drift instead;
  - an expired exception counts only while its standard still fails for that application;
  - legacy assessments and exit plans count when due, following their own registers.

AI is optional and only proposes. **Risk Extraction** (`suggest_risks`, the eleventh AI feature, off by default) reads a decision's context, justification and consequences and suggests up to five risks. Each suggestion has a title, a description and a severity, and covers only what the text supports. Suggestions are filtered: short titles and unknown severities are dropped, and risks already registered are left out. Nothing is stored until an author logs a suggestion as their own; it is then recorded as `ai_assisted`. No AI sets a status or adds to the debt list.

## Who can do what

- **Authors** (`create_decision`) log risks, including against a decision, and ask for AI suggestions.
- **A risk's owner or whoever logged it** changes it. Board seats can reach the route; the handler checks the person's identity.
- **Exception risks** are changed through the exception, not here.
- **Everyone who can read the model** sees the register and the debt list.
- **Refused with 403:**
  - the platform admin and the auditor, for logging or changing risks;
  - anyone else trying to change a risk they neither own nor logged.

## API

- `GET /risks?application=&decision=` returns `{risks[], counts {open, accepted, proposed, review_overdue, high_or_critical, from_exceptions, total}, severities, statuses}`.
  - Each risk is `{id, code, title, description, severity, status, stored_status, owner, review_by, review_overdue, source, origin, decision, applications, created_by, closed_by, closed_at, closure_note, editable}`.
  - Exception risks have id `exception:<id>`, `editable: false`, and no code.
- `POST /risks` takes `{title (≥5), description?, severity, owner?, review_by?, decision_id?, application_ids?, origin?}` and returns the risk.
  - A decision's applications are added automatically.
  - Returns 400 for a short title, an unknown severity, an unknown owner or an unknown application, and 404 for an unknown decision.
- `PUT /risks/:id` takes `{status?, severity?, owner?, review_by?, note?}`. Moving to mitigated or closed needs a note of at least 10 characters.
- `GET /debt?application=` returns `{finding_days, items[] {kind, application, title, detail, since, link}, by_application[], counts, total}`. An unknown application returns 404.
- `POST /decisions/:id/suggest-risks` returns the AI suggestions. It returns 409 when the feature is off.

## Data & audit

- **Migration m021** adds `risks`: code (RSK-nnnn), title, description, severity, status, owner, review_by, source, decision_id, application_ids, origin, created_by/at, and closed_by/at with the closure note.
- **Audit:** `risk:log`, `risk:<new status>` and `risk:update`, recorded on the risk with what changed and the note.
- **Evidence pack:** carries the risk register in scope. For the tenant that is every risk; for an application, the risks that name it.
- **Board pack:** registers gain `risks {counts, attention[]}`, which lists live high and critical risks and any risk whose review is overdue.
- **Governance Metrics:** gains `risks` (counts) and `debt` (counts by kind).

## UI

**Risk Register** sits in the Risk group at `/risks`, with a red hero and the Debug icon. The page has:

- **Hero counts:** open, accepted, high or critical, review overdue, and debt items.
- **Log Risk** for authors.
- Two tabs:
  - **Risks:** a filterable table of risk (with an AI-assisted tag where relevant), severity, source (linking to the decision), owner, status, review date (marked when overdue) and **Update**. Update appears for the owner or the person who logged the risk; everyone else sees "Owner only" or "Via the exception".
  - **Architecture Debt:** an expandable table by application, with every item linking to the record behind it.

The decision page gains **Accepted Risks**. It has a table of the decision's risks, **Add Risk**, and **Suggest from Consequences**. That button is greyed with the reason when the AI feature is off; when on, it shows suggestions that can each be logged in one step. Governance Metrics gains a *Risks and Debt* figure row, and the board pack page gains *Risks Needing Attention*.

## What it deliberately does not do

- It does not score risks (likelihood × impact). Severity is one judgement by a named person, and the board weighs the rest.
- It does not copy exceptions into the register, and does not let a risk change an exception.
- It does not store debt, or let anyone mark debt as resolved here. Debt clears when the record behind it clears.

## Verification

- **`server/test/risks.test.ts`** (6 tests) covers:
  - logging a risk, with 403s and validation;
  - decision risks following the decision: proposed, then accepted, then withdrawn;
  - exception risks being read-only;
  - owner-or-logger edits, the closing note, the overdue review and the audit row;
  - the debt kinds, a finding turning into debt as it ages, and the per-application filter with its 404;
  - the AI suggestion: 409 when off, 403 for the auditor, filtering, nothing stored, and a logged suggestion recorded as AI-assisted.
- **`server/test/ai-features.test.ts`** now counts eleven features.
- **`scripts/smoke-registers.sh`** step `m`.
