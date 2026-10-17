# Reaffirmations

## What it is

Every adopted catalogue item and every accepted decision has a **reaffirm-by date**. Catalogue items are standards, principles, patterns and policies. By that date, the **chair of the board that owns it** does one of two things:

- **reaffirms** it: it still holds, and the next reaffirmation is a full cadence away;
- marks **revision needed**, with a note saying what should change. It then comes back for reaffirmation in three months.

The state is shown in two places:

- **On the record itself:** the decision page and the catalogue item. Each shows whether the record is in date, its reaffirm-by date, the owning board and every reaffirmation so far, with the chair's **Reaffirm** action.
- **On the Reaffirmations page:** every record together, which is the list an auditor asks for.

Items due within 30 days, or overdue, appear in that chair's work queue and in the header's notifications. Every reaffirmation is recorded under the chair's name in the audit chain, and none is ever deleted.

### Not the same as the Decision Log

A reaffirmation approves nothing:

- **The Decision Log** records what was decided and why. A decision is accepted once, through a board review where decision makers record positions.
- **A reaffirmation** is the periodic statement that an accepted decision, or an adopted catalogue item, is still true. It is made by one named person, the owning chair, with no vote, and it changes nothing by itself.

Most items due for reaffirmation are catalogue items, not decisions.

**Naming:** the UI says *reaffirmation*. The record of one is a *sign-off*, so the API (`/sign-offs`), the table (`sign_offs`), the audit actions (`signoff:*`) and `/me/work.sign_offs` keep that word. The feature has not been released, so nothing outside depends on the old UI name.

## Why

Governance artefacts go stale quietly. Annual attestation of policies and standards is a common expectation, for example of ISO 27001 (A.5.1 review of policies) and COBIT APO03. A decision accepted two years ago may no longer reflect the estate or the market. Without a date and a named person, "still valid" is an assumption. Here it is a record, and the board that adopted the item is the one that reaffirms it.

The state sits on the record because that is where people look. A decision whose reaffirmation is overdue says so on its own page, and in the Decision Log beside its status.

## Heuristics and AI

No AI: a reaffirmation is a named person's statement. The dates and statuses are deterministic.

- **Reaffirm-by date:**
  - before any reaffirmation: the item's adoption date (artefacts) or decision date (decisions), plus the cadence for its kind;
  - after a reaffirmation: the date it set. Reaffirmed → a full cadence ahead; revision needed → three months ahead.
- **Cadence:** settings `review.artefact_months` (default 12) and `review.decision_months` (default 24).
- **Status:** *overdue* when the date has passed; *due soon* within 30 days; otherwise *in date*. *Revision needed* is shown when the latest reaffirmation asked for one.
- **The owning board** is the board the item's review type routes to: the artefact's kind and category, or a decision's topic and the applications it applies to ([routing by application](routing-by-application.md)).
- **Starts and stops with the record:** an item has a reaffirmation only while adopted (artefact) or accepted (decision). A proposed, superseded or retired record has none. A newly adopted version restarts the clock from its own adoption.

## Who can do what

- **The chair of the owning board** reaffirms (`decide_review` at the route; the handler checks the chair seat on that board).
- **Everyone who can read the model** sees the state on each record and on the Reaffirmations page.
- **Refused with 403:**
  - the platform admin and decision makers;
  - the auditor;
  - a chair of another board. The DA chair cannot reaffirm a PCB policy, and the PCB chair cannot reaffirm a DA standard.

## API

- `GET /sign-offs?status=` returns `{items[], cadence_months {artefact, decision}}`. Each item is `{subject {kind, id, code, title, type, since}, board, due, status, revision_needed, last {outcome, note, signed_by, signed_at}, can_sign}`. The `status` filter takes overdue, due_soon, current or revision_needed.
- `POST /sign-offs` with `{subject_kind: "artefact" | "decision", subject_id, outcome: "reaffirmed" | "revision_needed", note?}` records a reaffirmation.
  - 404 for an item that is not adopted or accepted.
  - 400 for an unknown outcome, or for revision needed with a note under 10 characters.
  - 403 for anyone but the owning chair.
- **On the records:**
  - `GET /decisions/:id` and `GET /artefacts/:id` carry `reaffirmation`. It is `{subject, board, due, status, revision_needed, last, can_sign, cadence_months, history[] {outcome, note, board_id, signed_by, signed_by_name, signed_at, next_due}}`, newest first, and `null` unless the record is accepted or adopted.
  - `GET /decisions` and `GET /artefacts` carry `reaffirmation {due, status, revision_needed}` per row, `null` likewise.
- `GET /me/work` carries `sign_offs[] {subject, board, due, status, revision_needed}`: the due and overdue items on boards the caller chairs.

## Data & audit

- **Migration m020** adds `sign_offs` (subject kind and id, outcome, note, board, signed_by/at, next_due). The latest row per item sets its date; every row is the history.
- **Audit:** `signoff:reaffirmed` and `signoff:revision_needed`, recorded on the artefact or decision with the code, board, next date and note. The Audit Log and the decision's audit trail read them as *Reaffirmed* and *Marked as needing revision*.
- **Metrics:** Governance Metrics coverage carries `sign_offs {current, total, overdue, due_soon}`, shown as a *Reaffirmations* figure on the metrics page and as *Items in date for reaffirmation* in the board pack's Coverage table.
- **Seed:** the demo backdates the adoption of STD-001, STD-005 (Design Authority) and POL-001 (Policy & Compliance Board) to 350 days ago. They are due soon, so each chair has reaffirmations in their queue.

## UI

- **Decision page:** a **Reaffirmation** section in the right column, shown for accepted decisions. It has:
  - the status tag (and *Revision needed* when asked for);
  - *Reaffirm by* with the date, and the owning board;
  - the cadence in one line;
  - the history table (outcome, by, date, note), or *Not reaffirmed yet* with the decision date;
  - **Reaffirm** (tertiary, on the section header) for the owning chair.
- **Catalogue item:** the same section in the item's detail, for adopted items. Reaffirm steps the detail aside for the reaffirm dialog and returns to it after, because modals never nest.
- **Decision Log:** a **Reaffirm By** column. It shows the date alone while in date, and adds the status tag once due soon or overdue, or *Revision needed* when asked for. It shows *—* for decisions that are not accepted.
- **Catalogue list:** the Status cluster shows only exceptions. It adds *Reaffirmation overdue* or *Revision needed* when they apply.
- **Reaffirmations page** (`/reaffirmations`, Governance group after Board Sessions, magenta hero, Stamp icon; `/sign-offs` redirects to it). It is a sortable table:

  | Column | Shows |
  |---|---|
  | Item | Kind tag and linked code |
  | Owning Board | The board's name |
  | Last Outcome | Outcome tag, date, who, note |
  | Reaffirm By | The date |
  | Status | Status tag (colour, icon and word) |
  | Actions | **Reaffirm** for the owning chair; *Chair only* for anyone else |

  The table filters by status and kind and has a search box.
- **The reaffirm dialog** (*Reaffirm or Revise STD-001*):
  - says it approves and changes nothing;
  - has outcome radios that state the next date;
  - has a note, required for a revision, with inline validation;
  - names the primary button after the choice: **Reaffirm** or **Ask for Revision**.
- **Overview** My Work has a *Reaffirmations due* queue, and the bell shows *Reaffirmation due* or *Reaffirmation overdue*. Both link to the record itself, where the chair reaffirms it.

## What it deliberately does not do

- It does not approve anything, and it is not a second Decision Log. Approval is the board's review.
- It does not retire or revise anything by itself. Revision needed is a statement; an author drafts the revision and a board adopts it through a review.
- It does not let anyone but the owning board's chair reaffirm, or let a model propose an outcome.

## Verification

- `server/test/signoffs.test.ts`, 5 tests:
  - the demo's due items and their boards;
  - the owning chair's work queue, and nobody else's;
  - who may reaffirm, and validation; a reaffirmation moves the date and is audited; a revision comes back in three months;
  - each record carries its reaffirmation: the history and `can_sign` on the detail, the standing on the list rows, `null` before acceptance;
  - the cadence setting, overdue decisions, and the metrics coverage.
- `server/test/work.test.ts` and `scripts/smoke-work.sh` count `sign_offs` among the work lists.
- `scripts/smoke-registers.sh` step `l`: the chair's act, the item's history, and the Decision Log's per-row date.
