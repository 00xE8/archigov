# Provided assessments

## What it is

A submitter can attach an assessment (impact, scope, DPIA, security…) to their own review when they submit or at any point before the decision. It arrives completed, signed by its author, and is supporting information for the board — it never blocks an outcome. It is the counterpart to a **board-requested** assessment, which a board seat raises and which does block every approving outcome until its named assessor records a result or the chair waives it with a reason.

## Why

Boards kept asking for the same due diligence after submission, which turned every request into a round-trip. Letting the submitter put the assessment on the table up front shortens the cycle without weakening the control: the blocking semantics stay exclusively with board-requested assessments, so a submitter can inform the board but can never satisfy the board's own ask on its behalf. Evidence, not assurance — the record shows who stands behind each assessment.

## Who can do what

- **Submitter of the review** (capability `submit_review`): provides an assessment on their own review, updates their own provided assessment. Nobody else — another author gets 403, as do the auditor and the platform admin (segregation of duties).
- **Board seats**: request assessments (the blocking kind) as before; they do not edit a provided one.
- **Chair**: waives board-requested assessments; a provided assessment needs no waiver because it never blocks.
- A board-requested assessment's recorded result is immutable through the provided-update path (409) — the record stands.

## API

- `GET /assessments/types` — the nine types (dpia, security, supplier, clinical-safety, ai-impact, accessibility, impact, scope, other), each with a markdown result template (`## …` skeleton) the UI preloads.
- `POST /reviews/:id/assessments/provide` — body `{type, title?, result, result_md, reference?, area?}`; arrives `status: completed`, `provided: true`, `completed_by` = caller. 403 for anyone but the review's submitter.
- `PUT /assessments/:id/provided` — author-only update; re-affirms (clears `stale`) after a resubmission; 409 on a board-requested assessment.

Provided assessments never count toward `progress.open_assessments`, `canDecide`, `progress.ready` or consent-agenda eligibility.

## Data & audit

- Migration m012 adds `provided` to `review_assessments`; no new table.
- Timeline events `assessment_provided` / `assessment_updated`; audit actions `assessment:provide` / `assessment:update` on the review, in the hash chain.
- The evidence pack carries provided assessments with each review, flagged as provided, with author and `reference` (an external pointer, never the document itself).
- Resubmission marks completed provided results `stale` exactly like requested ones; the author's update clears it.

## UI

ReviewDetail's Assessments table shows provided rows with a "Provided by Submitter" tag (self-explaining on hover), the result template renders as markdown in the expanded sub-row, and the submitter sees a "Provide Assessment" action where a board seat sees "Request Assessment"; the reason a submitter cannot request is surfaced in place from the server's `why`. Demo: REV-0010 carries a provided Scope assessment.

## Verification

`server/test/provided-assessments.test.ts` (type catalogue incl. templates; provide → completed, non-blocking; 403s for other authors and the platform admin; 409 on a requested result; stale on resubmit, re-affirm on update). Review-flow regressions are pinned by `smoke-sessions.sh` and `boards.test.ts`.
