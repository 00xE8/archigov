# Fast lane for low-risk designs

## What it is

A board can offer a **fast lane** on its design reviews. A design that is low risk, follows adopted patterns and passes every deterministic check counts as satisfied without positions, so the chair may declare it approved straight away, one at a time or all together. Any area owner can take an item out of the lane by recording a `no` or a `conditional`, and the board's full policy then applies. Every approval records that it rested on the fast lane and which checks held.

## Why

Boards spend much of their sittings on changes that follow a pattern they already adopted, which is how a board becomes a bottleneck for the obvious. The fast lane is the standard-change idea from service management. The thesis allows it only if the lane itself is governance. The tier is derived, not declared. The claim is checked against the catalogue and its rules. The evidence is recorded with the approval. The decision stays with a person: the chair declares, and any area owner can veto. Boards then spend their time on decisions that need judgement, and every fast-lane approval can still be traced back to the checks it passed.

## Heuristics and AI

Everything that decides eligibility is deterministic and derived on read; nothing but the submitter's pattern claim is stored.

- **Risk tier**, the highest of three inputs:
  - the tier the submitter declared;
  - the application's criticality ([classification](criticality-classification.md)): critical → high, important or unclassified → medium, standard → low;
  - open high or critical findings on the application, which raise it to at least medium.

  The submitter can raise the tier, never lower it.
- **Checks**, all of which must pass:
  1. Risk tier is low.
  2. Follows adopted patterns. Every claimed pattern is adopted, and at least one is claimed when the board requires it.
  3. Pattern rules pass. No live finding of a claimed pattern's rule on the application; application-wide exceptions are honoured.
  4. No medium or higher findings. The live rule dry run against the application finds nothing of medium severity or above.
  5. Pre-review clean. The latest pre-review ran on this version (after any resubmission) and raised nothing of medium or above.
  6. No open assessment. No board-requested assessment is still open.
  7. No objection. No live `no` and no unresolved `conditional`.
  8. Review is open.
- **AI can only make it harder.** An AI pre-review is the latest pre-review like any other, and one AI finding of medium or above vetoes the lane. The deterministic checks run regardless, so a model that leaves a finding out cannot grant the lane. Nothing a model says puts an item into the lane. There is no new AI feature.

## Who can do what

- **Chair** of the board (`decide_review` on that board): sees fast-lane items in their declare queue and on the consent agenda, declares one (`POST /reviews/:id/decide`) or all of them (`POST /boards/:id/fast-lane/declare`).
- **Decision makers**: are not awaited for positions on a fast-lane item; may still record one, and a `no` or `conditional` takes the item out of the lane.
- **Submitter** (author): claims the adopted patterns the design follows when submitting, and edits the claim while the review is open or sent back (`PUT /reviews/:id/patterns`). Nobody else changes the claim (403).
- **Chair or platform admin** (`manage_board` / `manage_platform`): switches the lane on per design policy.
- Refused with 403:
  - the platform admin, a decision maker or an author on the board-wide declaration;
  - anyone but the submitter on the claim;
  - a submitter on their own review, as for every declaration.

## API

- **Policy.** `PUT /boards/:id/policies/design` takes `policy.fast_lane: {enabled, require_pattern}` (`require_pattern` defaults to true). Setting it on any other review type is 400. `GET /boards/:id` returns it in `policies`, and `GET /boards/route` returns it with the routed policy.
- **Submission.** `POST /reviews` takes `patterns: [id or code]` on design reviews only. A code that is not a pattern, a pattern that is not adopted, or patterns on another review type is 400.
- **Claim.** `PUT /reviews/:id/patterns` takes `{patterns}`. Submitter only; 409 once the review is decided.
- **Progress.** Every review's `progress` carries:
  - `fast_lane`: `{eligible, require_pattern, risk {tier, declared, reasons[]}, patterns[] {id, code, title, adopted, has_rule, failing}, checks[] {id, name, ok, detail}}`, or null when the board does not offer the lane;
  - `via_fast_lane`: satisfied by the lane rather than by positions.

  When `via_fast_lane` is true, `satisfied` and `ready` are true.
- **Review.** `GET /reviews/:id` also returns `patterns` (the claim, resolved).
- **Board list.** `GET /boards/:id/fast-lane` lists the open reviews the lane satisfies, each with `can_declare` for the caller.
- **Board declaration.** `POST /boards/:id/fast-lane/declare` takes `{review_ids?, rationale?}` and returns `{declared[], skipped[] {id, code, reason}}`. Each item is checked again as it is declared.

## Data & audit

- Migration m016 adds `reviews.patterns_json`, the claimed pattern ids.
- The policy JSON gains `fast_lane`, with no schema change. `policy:set` audits it.
- The approve event's data and the `decide:approved` audit row carry the lane's evidence when the positions alone did not satisfy the policy:
  - the event's `data.fast_lane`: `{risk_tier, patterns, checks}`;
  - the audit row's `basis: "fast_lane"`.

  The approval sits in the hash chain and the evidence pack like any other.
- Editing the claim is audited as `review:patterns` (from → to), and a `patterns_changed` timeline event records it.
- Seed: the demo Design Authority offers the lane on design reviews with a pattern required (`DEMO_USERS_VERSION` 4). A demo review, *Intranet: staff news feed*, follows PAT-001 and sits in the lane.

## UI

- **Review detail.** A Fast Lane section in the Board Record column, with:
  - In the Fast Lane or Full Policy, plus the derived risk tier, each of which explains itself on hover;
  - one sentence on what that means;
  - the checks table (check · Passes/Fails · why). Out of the lane the section sits under the positions and lists only the failing checks, with Show All.

  The submitter gets Edit Patterns, a FilterableMultiSelect of adopted patterns. The facts strip shows *Follows PAT-001*. The waiting-on line reads *In the fast lane — nothing outstanding*, and areas without a position read *Not required*.
- **Lists.** On Reviews and on the board's Reviews in Flight, a Fast Lane tag sits beside the stage, and progress reads *Fast lane*.
- **Board detail.** The chair gets Declare Fast Lane (n), a confirm modal listing the items with an optional rationale. The design workflow row shows *Fast Lane · Pattern Required*. The policy editor gains a Fast Lane group: an Offer a Fast Lane toggle, a Require At Least One Adopted Pattern checkbox, and what the checks are.
- **Submission.** The Submit for Review modal offers Follows Adopted Patterns (FilterableMultiSelect). Its helper text says when the routed board offers a lane.

## What it deliberately does not do

- It does not approve anything by itself. The chair declares; the lane only says that positions are not required.
- It does not apply to decision, artefact or exception reviews.
- It does not trust the submitter's tier, and it does not let an AI grant the lane.
- It does not check a claimed pattern that has no rule. Reviewers judge that claim, and an owner who disagrees records a `no`.

## Verification

- `server/test/fastlane.test.ts` (7 tests):
  - the seeded lane;
  - claim validation and ownership;
  - the derived tier (critical, unclassified, declared medium);
  - pre-review vetoes, including an AI finding;
  - objections, conditionals and assessments;
  - the chair's declaration recording its basis;
  - the board-wide declaration, including 403s and a skipped item;
  - a stale pre-review after resubmission.
- `scripts/smoke-boards.sh` step `i` runs the flow end to end on a seeded instance.
