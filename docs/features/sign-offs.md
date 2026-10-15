# Review dates and periodic sign-offs

## What it is

Every adopted catalogue item and every accepted decision has a **next review date**. Catalogue items are standards, principles, patterns and policies. The **chair of the board that owns it** signs it off by doing one of two things:

- **reaffirming** it: it still holds, and the next review is a full cadence away;
- marking **revision needed**, with a note saying what should change. It then comes back for sign-off in three months.

Items due within 30 days, or overdue, appear in that chair's work queue and in the header's notifications. Every sign-off is recorded under the chair's name in the audit chain, and none is ever deleted.

## Why

Governance artefacts go stale quietly. Annual attestation of policies and standards is a common expectation, for example of ISO 27001 (A.5.1 review of policies) and COBIT APO03. A decision accepted two years ago may no longer reflect the estate or the market. Without a date and a named person, "still valid" is an assumption. Here it is a record, and the board that adopted the item is the one that reaffirms it.

## Heuristics and AI

No AI: a sign-off is a named person's statement. The dates and statuses are deterministic.

- **Next review date:**
  - before any sign-off: the item's adoption date (artefacts) or decision date (decisions), plus the cadence for its kind;
  - after a sign-off: the date that sign-off set. Reaffirmed → a full cadence ahead; revision needed → three months ahead.
- **Cadence:** settings `review.artefact_months` (default 12) and `review.decision_months` (default 24).
- **Status:** *overdue* when the date has passed; *due soon* within 30 days; otherwise *in date*. *Revision needed* is shown when the latest sign-off asked for one.
- **The owning board** is the board the item's review type routes to: the artefact's kind and category, or a decision's topic.

## Who can do what

- **The chair of the owning board** signs off (`decide_review` at the route; the handler checks the chair seat on that board).
- **Everyone who can read the model** sees the list.
- **Refused with 403:**
  - the platform admin and decision makers;
  - the auditor;
  - a chair of another board. The DA chair cannot sign off a PCB policy, and the PCB chair cannot sign off a DA standard.

## API

- `GET /sign-offs?status=` returns `{items[], cadence_months {artefact, decision}}`. Each item is `{subject {kind, id, code, title, type, since}, board, due, status, revision_needed, last {outcome, note, signed_by, signed_at}, can_sign}`. The `status` filter takes overdue, due_soon, current or revision_needed.
- `POST /sign-offs` with `{subject_kind: "artefact" | "decision", subject_id, outcome: "reaffirmed" | "revision_needed", note?}` signs an item off.
  - 404 for an item that is not adopted or accepted.
  - 400 for an unknown outcome, or for revision needed with a note under 10 characters.
  - 403 for anyone but the owning chair.
- `GET /me/work` gains `sign_offs[] {subject, board, due, status, revision_needed}`: the due and overdue items on boards the caller chairs.

## Data & audit

- **Migration m020** adds `sign_offs` (subject kind and id, outcome, note, board, signed_by/at, next_due). Only the latest row per item sets its date; earlier rows are the history.
- **Audit:** `signoff:reaffirmed` and `signoff:revision_needed`, recorded on the artefact or decision with the code, board, next date and note.
- **Metrics:** Governance Metrics coverage gains `sign_offs {current, total, overdue, due_soon}`, shown as a *Sign-offs* figure on the metrics page and a row in the board pack's Coverage table.
- **Seed:** the demo backdates the adoption of STD-001, STD-005 (Design Authority) and POL-001 (Policy & Compliance Board) to 350 days ago. They are due soon, so each chair has sign-offs in their queue.

## UI

**Sign-offs** (`/sign-offs`) sits in the Governance group after Board Sessions, with a magenta hero and the Stamp icon. It is a sortable table:

| Column | Shows |
|---|---|
| Item | Kind tag and linked code |
| Owning board | The board's name |
| Last sign-off | Outcome tag, date, who, note |
| Next review | The date |
| Status | Status tag (colour, icon and word) |
| Actions | **Sign Off** for the owning chair; *Chair only* for anyone else |

The table filters by status and kind and has a search box.

The sign-off modal has:

- outcome radios that state the next date;
- a note, required for a revision, with inline validation.

Overview's My Work gains a *Sign-offs due* queue, and the bell shows *Sign-off due* or *Sign-off overdue*.

## What it deliberately does not do

- It does not retire or revise anything by itself. Revision needed is a statement; an author drafts the revision and a board adopts it through a review.
- It does not let anyone but the owning board's chair sign off, or let a model propose an outcome.

## Verification

- `server/test/signoffs.test.ts`, 4 tests:
  - the demo's due items and their boards;
  - the owning chair's work queue, and nobody else's;
  - who may sign off, and validation; a sign-off moves the date and is audited; a revision comes back in three months;
  - the cadence setting, overdue decisions, and the metrics coverage.
- `server/test/work.test.ts` and `scripts/smoke-work.sh` count `sign_offs` among the work lists.
- `scripts/smoke-registers.sh` step `l`.
