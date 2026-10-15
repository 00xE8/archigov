# Governance metrics and the signed board pack

## What it is

**Governance Metrics** reports how the governance itself is performing, computed from the records over a stated period (30, 90, 180 or 365 days). It covers:

- **Reviews:** how fast they are decided (median and 90th percentile), how often they are sent back, how many approvals rested on the fast lane, and how long decision makers take to record a position.
- **Decisions:** how many were accepted and how long they took, and how far the estate has realised them.
- **Conditions and exceptions:** how conditions are met and how exceptions age.
- **Conformance:** how open findings trend and how fast they are fixed.
- **Coverage:** how much of the model and the registers a named person stands behind.

A **board pack** is a signed snapshot of those figures for a board. It also holds:

- the decisions accepted and the reviews declared in the period;
- the roadmap's Now lane;
- the register gaps and any concentration on a single provider;
- an optional narrative written by the person who prepares the pack.

A board's chair or secretary prepares the pack. It is hashed, anchored to the audit chain and signed with the instance key, so it can be verified exactly like the evidence pack.

## Why

A head of architecture reports to a board on the function's own performance, not just the estate's: decision speed and quality, exception ageing, conformance trend. These numbers are usually rebuilt by hand in slides each quarter. Here they come from the same records the governance runs on, and the period is always stated. A board pack that a third party can verify keeps the figures honest after the meeting. This follows the evidence-not-assurance stance: the pack shows what was held and who prepared it, and asserts nothing.

## Heuristics and AI

Every figure is deterministic: a count, a median or a 90th percentile over rows anyone can open.

| Figure | How it is computed |
|---|---|
| **Lead time** | Submission (`created_at`) to the declared outcome (`decided_at`), for reviews decided in the period, overall and by type. Decisions are measured from draft to `decided_at`. |
| **Recycled** | Share of reviews decided in the period that were sent back at least once (a `request_changes` or `resubmitted` event). |
| **Fast lane** | Approvals in the period whose event records `fast_lane`, out of all approvals. |
| **Position latency** | From (re)submission to each position recorded in the period. |
| **Realisation** | From the [roadmap](roadmap.md): realised, in progress, not started, not checkable. |
| **Conditions** | Open, overdue, met in the period, met on time (closed by the due date) and days to meet. |
| **Exceptions** | Active exceptions by age (0–30, 31–90, 91–180, over 180 days), those expiring within 30 days, those without expiry, and expired. |
| **Conformance** | The open-findings trend (the last evaluation run of each day), findings opened and resolved in the period, time to fix (first seen → resolved) and the oldest open finding. |
| **Coverage** | Human verification, classification, legacy assessments in date, exit plans in date, and catalogue items and decisions in date for reaffirmation. |

A series with no data is reported as *not available* (null), never as zero. No figure is coloured or labelled good or bad.

AI is optional and only narrates. **Board Pack Narrative** (`draft_board_narrative`) is a new per-feature toggle, off by default. It drafts the narrative from the pack's figures:

- every statement must quote a figure;
- a missing figure is called "not available", never estimated;
- no judgement such as compliant, good or bad.

The chair or secretary edits the draft and submits it as their own. The pack records the narrative's origin as `ai_assisted` or `human`, with the author. A model never prepares or signs a pack.

## Who can do what

- **Everyone who can read the model** sees Governance Metrics (`GET /metrics`).
- **Board packs are read like the evidence pack** (`export_evidence`): auditors, authors, board seats and the platform admin.
- **A board's chair or secretary** prepares a pack and asks for a narrative draft. The handler checks the seat. The route admits `manage_board` or `decide_review`.
- **Refused with 403** when preparing: the platform admin, the auditor, a decision maker or reviewer, and an author with no chair or secretary seat.

## API

- `GET /metrics?days=` returns `{generated_at, period_days, from, reviews, decisions, conditions, exceptions, conformance (incl. trend), coverage, registers, roadmap}`. The period is clamped to between 7 and 730 days and always stated.
- `GET /board-packs` lists the packs (index rows).
- `POST /board-packs` prepares a pack. It takes `{days?, title?, board_id?, narrative_md?, narrative_origin?: "human" | "ai_assisted"}` and returns `{id, hash, title, signed_at}`.
- `GET /board-packs/:hash` returns the signed pack. Add `?download=1` to download it as an attachment.
- `GET /evidence-pack/verify?hash=` verifies a board pack too: content hash, Ed25519 signature and audit chain.
- `POST /board-packs/draft-narrative` takes `{days?}` and returns the AI draft. It returns 409 when the feature is off. Nothing is stored.

## Data & audit

- **Migration m019** adds `board_packs` (an index: hash, title, period, board, narrative origin, who prepared it and when).
- **The pack itself** is persisted, hashed, chained and signed by the same code as the evidence pack (`signAndPersist` → `DATA_DIR/evidence-packs/<hash>.json`). It carries:
  - `kind: "board_pack"`, the tenant, the board, the period and who prepared it;
  - the narrative with its origin;
  - the full metrics;
  - the decisions and declared reviews in the period, with fast-lane approvals marked;
  - the roadmap counts and its Now lane;
  - the register gaps (legacy assessments and exit plans due) and the concentration;
  - a disclaimer that it asserts no compliance.

  If the pack is board-scoped, its reviews are that board's; the other figures are tenant-wide.
- **Audit:** `board_pack:create`, with the hash, title, period, board and narrative origin.

## UI

**Governance Metrics** sits in the Evidence group at `/metrics`, with a green hero and the ChartLineData icon. The page has:

- a period select;
- figure tiles grouped as Reviews · Decisions, Conditions and Exceptions · Conformance and Coverage;
- charts in a lazy chunk:
  - reviews decided per month (bars);
  - median lead time per month (a line with one label per month);
  - the open-findings trend by severity;
  - active exceptions by age (bars);

  Charts use one neutral hue, whole-number count axes, and an empty-trend message instead of a fake line.
- a **Board Packs** list;
- **Prepare Board Pack**, for chairs and secretaries: period, board, title and narrative, with Draft with AI greyed and its reason shown when the feature is off.

**Board pack** (`/board-packs/:hash`) is a document laid out to read in a sitting and to print. It has:

- the verification re-checked on open (content intact, signature valid, audit chain intact — each a status tag), with an error notification if any fails;
- the narrative with its origin, then the figure tables, decisions, reviews, Now items and register gaps;
- the disclaimer;
- **Print** and **Download JSON**. Print hides the shell and the hero decoration.

## What it deliberately does not do

- It does not set targets or colour figures against them. The board decides what a figure means.
- It does not let a model prepare, edit after signing, or sign a pack.
- It does not recompute a pack. The page shows the snapshot as signed; a new period means a new pack.

## Verification

- `server/test/metrics.test.ts` has 5 tests:
  - quantiles;
  - the demo's realisation, coverage, registers and period clamping;
  - recycling and fast-lane counting after real declarations;
  - the board pack: 403s for platform admin, auditor, reviewer and decision maker; a secretary prepares it; read as auditor; verify ok; the list and the audit row; tampering detected;
  - the narrative draft: 409 when off, 403 for a non-preparer, the figures sent without the raw trend, nothing stored.
- `server/test/ai-features.test.ts` now counts ten features.
- `scripts/smoke-registers.sh` step `k`.
