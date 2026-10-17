# Board sessions, areas of responsibility, positions and dependent decisions

Build spec (v1). This is the contract between `server/` and `web/`; the smoke script `scripts/smoke-sessions.sh` exercises it end to end.

## Principles (agreed with the founder, 2026-10-12)

- **Decision makers record their own positions.** Nobody records on anyone's behalf — not the secretary, not the chair. A delegate records as themselves, on behalf of a seat.
- **The chair moderates, directs and declares; the chair has no vote.** A review is decided by the positions of the areas it touches; the chair *declares* the outcome those positions allow, and can always send an item back, defer it, refer it or reject it.
- **Positions are per area of responsibility**: `yes`, `no`, `conditional` (keeps the item open until the chair resolves the condition and explains how), `not_my_area` (drops a wrongly derived area, with a reason).
- **A conditional is never overwritten.** The chair adds a *resolution* with a mandatory explanation; the decision maker keeps the right to flip to `no` until the session closes.
- **The author proposes** (presents, answers, accepts conditions, owns follow-ups, may withdraw) and never acts on their own item, whatever seats they hold. A chair who authored an item nominates an acting chair for it.
- **Outcomes can create dependent decisions.** An item can be approved *pending* decisions created from it; it becomes effective when they are decided.
- **Delegation is per session, one hop**, recorded by the delegator (or by the secretary *on instruction*, shown as such); never to an auditor, a service account, or the author of an agenda item.
- **Agenda and minutes are derived**, not authored; the secretary's notes are the only human-written part of the minutes. Minutes are hashed into the audit chain and shipped in the evidence pack.
- **Circulation** finishes an item asynchronously after a sitting when an area was absent and undelegated.
- The platform admin has no part in any of this (operations only).

## Vocabulary

| Term | Values |
|---|---|
| Area (of responsibility) | per board, seeded: `security`, `data`, `integration`, `infrastructure`, `resilience`, `cost`, `compliance`, `ai` — labels: Security · Data · Integration · Infrastructure · Resilience & operations · Cost · Privacy & compliance · AI. Editable per board (chair or platform admin). A board with no areas runs every policy in count mode. |
| Policy approvals step `mode` | `count` (today: `min` distinct `yes` positions from seats in `roles`) or `areas` (one `yes` or resolved conditional per touched area from a decision maker — or delegate — who owns it; `min` ignored; `roles` defaults to `[decision_maker]`). |
| Position | `yes` · `no` · `conditional` · `not_my_area` |
| Resolution (of a conditional, by the chair) | `accepted_condition` (becomes a tracked condition with area, owner, due) · `addressed` (explanation of what changed) · `dependent_decision` (links a decision the item now depends on) |
| Review stage | existing `submitted` `pre_review` `in_review` `changes_requested` `approved` `approved_with_conditions` `rejected` `withdrawn` **plus** `approved_pending_dependencies`, `approved_subject_to_circulation` |
| Declared outcome (`POST /reviews/:id/decide`) | `approved` · `approved_with_conditions` · `approved_subject_to_circulation` · `changes_requested` · `deferred` · `referred` · `rejected` · `withdrawn` (submitter only). `approved_pending_dependencies` is never chosen: it is what `approved`/`approved_with_conditions` is stored as while the item has undecided dependencies. |
| Session status | `planned` → `open` → `closed` |
| Agenda item state (derived) | `awaiting_positions` · `open` (unresolved conditional) · `blocked` (a live `no`) · `ready` · `declared` · `deferred` · `withdrawn` |
| Attendance | `present` · `apologies` · `absent` (default for members with no record) |

Codes: sessions are `SES-0001` (`nextCode("board_sessions","SES")`, width 4).

## Schema — migration `m009-sessions-areas.ts` (version 9)

```sql
ALTER TABLE boards        ADD COLUMN areas_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE board_members ADD COLUMN areas_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reviews ADD COLUMN areas_json TEXT;            -- touched areas (final); NULL = not derived yet (seedBoards fills it at boot)
ALTER TABLE reviews ADD COLUMN areas_derived_json TEXT;    -- what derivation gave, for display
ALTER TABLE reviews ADD COLUMN areas_origin TEXT;          -- 'derived' | 'human'
ALTER TABLE reviews ADD COLUMN session_id TEXT;            -- session that declared it (set on declare)
ALTER TABLE reviews ADD COLUMN pending_outcome TEXT;       -- approved | approved_with_conditions, while pending deps / circulation
ALTER TABLE reviews ADD COLUMN circulation_due TEXT;
ALTER TABLE reviews ADD COLUMN deferred_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN deferred_reason TEXT;
ALTER TABLE reviews ADD COLUMN last_deferred_at TEXT;
ALTER TABLE review_events ADD COLUMN session_id TEXT;
ALTER TABLE conditions ADD COLUMN area TEXT;
ALTER TABLE conditions ADD COLUMN position_id TEXT;

CREATE TABLE review_positions (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL, session_id TEXT,
  user_id TEXT NOT NULL, board_role TEXT NOT NULL, on_behalf_of TEXT, delegation_id TEXT,
  area TEXT,                                   -- NULL in count mode
  position TEXT NOT NULL,                      -- yes | no | conditional | not_my_area
  text TEXT, at TEXT NOT NULL, superseded INTEGER NOT NULL DEFAULT 0,
  resolution TEXT, resolution_text TEXT, resolved_by TEXT, resolved_at TEXT, resolution_ref TEXT  -- ref: condition id or decision id
);
CREATE INDEX idx_review_positions_review ON review_positions(review_id);
-- migrate review_approvals → positions (approve → yes, request_changes → no, area NULL), then drop review_approvals
CREATE TABLE board_sessions (
  id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, board_id TEXT NOT NULL, title TEXT, scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned', created_by TEXT NOT NULL,
  opened_by TEXT, opened_at TEXT, closed_by TEXT, closed_at TEXT,
  notes_md TEXT, minutes_json TEXT, minutes_hash TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE session_items (
  session_id TEXT NOT NULL, review_id TEXT NOT NULL, position INTEGER NOT NULL,
  consent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'listed',   -- listed | called | declared | deferred | withdrawn
  acting_chair TEXT, called_at TEXT, outcome TEXT, declared_at TEXT, note TEXT,
  PRIMARY KEY (session_id, review_id)
);
CREATE TABLE session_attendance (
  session_id TEXT NOT NULL, user_id TEXT NOT NULL, board_role TEXT, status TEXT NOT NULL,
  on_behalf_of TEXT, recorded_by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (session_id, user_id)
);
CREATE TABLE session_delegations (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, delegator TEXT NOT NULL, delegate TEXT NOT NULL,
  areas_json TEXT NOT NULL, recorded_by TEXT NOT NULL, on_instruction INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, revoked_at TEXT, revoked_by TEXT
);
CREATE TABLE review_dependencies (
  id TEXT PRIMARY KEY, review_id TEXT NOT NULL, decision_id TEXT NOT NULL, dependency_review_id TEXT,
  created_by TEXT NOT NULL, session_id TEXT, created_at TEXT NOT NULL, resolved_at TEXT, resolved_state TEXT  -- accepted | rejected
);
CREATE TABLE decision_links (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,   -- depends_on | supersedes | related
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (from_id, to_id, kind)
);
```

`j(reviews.areas_json)` is the list of area ids. A review on a board with no areas has `areas_json='[]'` and runs in count mode.

## Deriving touched areas (`boards/areas.ts`)

`deriveAreas(review) → string[]` restricted to the board's areas, in board order:

- Category/topic → area map (case-insensitive, prefix-tolerant; unknown → ignored): Security→security · Data, Storage, Database, data-store→data · Networking, Network, Integration, Messaging, API, integration→integration · Hosting, Compute, Infrastructure, Platform, Cloud, hosting→infrastructure · Resilience, Availability, Operations, Backup→resilience · Cost, FinOps→cost · Governance, Compliance, Privacy, Regulatory, Principle→compliance · AI, ML, ai-system→ai.
- design: categories of the catalogue items cited by the latest pre-review's findings ∪ non-empty design sections (`## Data`→data, `## Security`→security, `## Resilience`→resilience) ∪ application resource types (`Microsoft.Sql|Storage|DocumentDB|DBforPostgreSQL`→data, `Microsoft.Network`→integration, `Microsoft.Compute|Web|ContainerService`→infrastructure, `Microsoft.CognitiveServices|MachineLearning`→ai, `Microsoft.KeyVault`→security).
- decision: topic ∪ categories of `standard_ids`.
- standard/principle/pattern/policy: the artefact's category.
- exception: the finding's standard category (or the artefact's).
- Empty result → the board's first area (so an item always has at least one gate).

Stored at creation (`areas_json = areas_derived_json`, `areas_origin='derived'`), re-derived after a pre-review *only while `areas_origin='derived'`* (an author's edit sticks), and re-derived on `referred` against the new board. Reviews with `areas_json IS NULL` at boot are filled by `seedBoards()` (count reported as `reviews_areas_derived`).

## Workflow semantics (`boards/workflow.ts`)

- `policyFor` / `normalisePolicy`: approvals step gains `mode` (default `count`; stored policies without it are count). In `areas` mode `roles` is validated like today (approving seats only) and defaults to `[decision_maker]`; `min` is dropped.
- `positionsOf(reviewId)` replaces `approvalsOf`; keep an `approvalsOf` adapter that maps positions to `{…, decision: yes→"approve" | no→"request_changes"}` for `GET /reviews/:id.approvals` (count mode compatibility).
- `approvalProgress(review)` returns, in both modes, `{ mode, required, received, satisfied, changes_requested, blocked, open_conditionals, ready, steps, outstanding, areas }`:
  - count: as today (`yes` positions count; a live `no` = changes requested).
  - areas: `areas: [{ area, label, state, by, on_behalf_of, text, position_id, resolution, owners: [user_id…] }]`, state ∈ `missing | yes | no | conditional | resolved | not_my_area` (precedence: no > conditional > resolved/yes > not_my_area > missing). `required` = touched areas not dropped by `not_my_area`; `received` = those in `yes|resolved`; `satisfied` = received === required && !blocked && open_conditionals === 0; `outstanding` lists missing areas with their owners. Owners = board members (decision makers) whose `areas_json` includes the area, plus delegates in an open session.
- The **reviewer seat stays advisory in areas mode**: it records no area position (never a `yes`), but it can still send an item back — `POST /reviews/:id/positions { position: "no", text }` with no area (or the `/approvals request_changes` alias) stores a `no` with `area: null`, moves the review to `changes_requested`, and is reported in `progress.advisory_objections` (`{ by, board_role, text, at, position_id }`); it blocks like any `no` and counts for no area. The chair does not request changes this way; the chair declares `changes_requested`.
- `canRecordPosition(p, review, area)`: review open (`OPEN_STAGES`, `changes_requested` for a fresh yes after discussion is **not** allowed — resubmit first — but `approved_subject_to_circulation` **is** allowed for areas still `missing`); not the submitter; a decision-maker seat on the review's board (or chair in count mode when the policy lists chair) owning the area — or a live delegation for the session the review is on. In count mode `area` is null and any seat the step lists qualifies. Users who own none of the touched areas → 403 `approve_review` with reason listing the areas and who owns them.
- Recording a position supersedes the same user's live position on that area; `no` moves the review to `changes_requested` (as today's request_changes); `yes/conditional/not_my_area` keep `in_review`. A `no` recorded in circulation moves the review back to `in_review` (event `circulation_objection`) — it goes on the next agenda.
- `resolvePosition(p, position, resolution)`: chair of the board (or the item's acting chair in an open session), `resolution_text` mandatory (≥ 10 chars). `accepted_condition` inserts a `conditions` row (`area`, `position_id`, owner default the submitter, `due_at`) and the position state becomes `resolved`; `addressed` → resolved; `dependent_decision` → links `decision_id` through `review_dependencies` (creating the ADR + its review if `create` is given, see below) → resolved. Event `position_resolved` on the timeline, audit `position:resolve`.
- `canDecide(p, review, outcome)`:
  - `withdrawn`: submitter.
  - `changes_requested | deferred | referred | rejected`: a decision-step seat (chair) of the board — or the acting chair of the item in an open session — at any open stage including `changes_requested`. `deferred` and `referred` are session outcomes but also allowed outside one.
  - `approved | approved_with_conditions`: as above **and** progress.satisfied (count mode as today).
  - `approved_subject_to_circulation`: areas mode, review on an **open** session, every area whose owner (or delegate) is `present` is `yes|resolved|not_my_area`, at least one `missing` area has no present owner, no `no`, no open conditional; `circulation_due` required (ISO date).
  - A submitter who is also chair → 403 "a submitter cannot decide their own review; nominate an acting chair" (session) / plain refusal.
- `declare` (the body of `POST /reviews/:id/decide`, factored into `boards/declare.ts`): stores the outcome; if the review has unresolved `review_dependencies`, `approved*` is stored as stage `approved_pending_dependencies` with `pending_outcome`; `approved_subject_to_circulation` stores `pending_outcome` + `circulation_due`; `deferred` increments `deferred_count`, sets `deferred_reason/last_deferred_at`, stage stays `in_review`; `referred {board_id}` moves the board, supersedes positions, re-derives areas, stage `in_review`; `changes_requested` stage `changes_requested`. Effects (ADR accepted/rejected, artefact adopted/draft, exception created, `evaluateAll`) are applied by `applyOutcomeEffects(review, outcome, actor)` **only when the outcome is effective** (`approved`, `approved_with_conditions`, `rejected`). If the review is on an **open** session's agenda, the item row is updated (`state=declared`, `outcome`, `declared_at`) and the event/audit rows carry `session_id`.
- `makeEffective(review, actor='system')`: stage ← `pending_outcome`, event `became_effective`, audit `review:effective`, then `applyOutcomeEffects`. Triggered (a) when the last dependency's decision review is approved, (b) when the last missing circulation area records `yes`/is resolved. A dependency rejected → dependent review stage `in_review`, event `dependency_rejected`, audit — back on the next agenda.
- `awaitingMe(p, review)`: areas mode — a decision maker (or delegate) owning a touched area with no live position from them; the chair when `ready` or when `open_conditionals > 0`; count mode as today.

## Sessions (`routes/sessions.ts`, helpers in `boards/sessions.ts`)

Rights: **chair or secretary of that board** create/plan/refresh/reorder/record attendance/close-notes; **chair** (or the item's acting chair) opens, closes, calls, nominates, declares, resolves; **decision makers** self-record attendance (`present`) and delegate their own seat; any member may self-record attendance. Platform admin: read only. Auditor: read only.

- `GET /boards/:id/sessions` → `[{ id, code, title, scheduled_at, status, items, declared, deferred, opened_at, closed_at }]` newest first.
- `POST /boards/:id/sessions { scheduled_at, title? }` → derives the agenda: reviews routed to the board with stage in `submitted|pre_review|in_review|changes_requested|approved_subject_to_circulation` (circulation only when overdue or on request), excluding reviews already on another `planned|open` session; order: `ready` first, then by `deferred_count desc, created_at asc`. Returns the session.
- `GET /sessions/:id` →
  ```
  { id, code, title, board:{id,code,name}, scheduled_at, status, created_by, opened_*, closed_*, notes_md,
    quorum: [{ area, label, covered:boolean, by:[user_id…] }],            // open/closed sessions; from attendance + delegations
    attendance: [{ user_id, name, board_role, areas, status, on_behalf_of, recorded_by, at }],  // every member; absent by default
    delegations: [{ id, delegator, delegator_name, delegate, delegate_name, areas, on_instruction, recorded_by, created_at, revoked_at }],
    items: [{ position, consent, state, acting_chair, called_at, outcome, declared_at, note,
              review: { id, code, title, type, stage, submitted_by, submitted_by_name, created_at, deferred_count, areas, progress, target, item_state } }],
    consent_count, minutes: { … } | null,
    can: { manage, open, close, call, declare, consent, attend_self, delegate_self, record_attendance, nominate } }
  ```
  `item_state` is the derived state in the vocabulary above.
- `POST /sessions/:id/agenda/refresh` (planned/open) adds newly eligible reviews at the end. `PUT /sessions/:id/agenda { items: [{ review_id, position }] }` reorders / removes `listed` items (declared ones cannot be removed).
- `POST /sessions/:id/attendance { user_id?, status }` — self when `user_id` omitted; secretary/chair for anyone. Audit `session:attendance`.
- `POST /sessions/:id/delegations { delegate, areas?, delegator?, on_instruction? }` — a decision maker delegates their own seat (`delegator` = self); the secretary may record `delegator` + `on_instruction:true`. Validation: session `planned|open`; delegator holds a decision-maker seat on the board; delegate is an existing user, not an auditor/service account, not the submitter of any agenda item, not already a delegate for another seat in this session; `areas` ⊆ delegator's areas (default all). The delegate's attendance becomes `present` with `on_behalf_of`. `DELETE /sessions/:id/delegations/:did` by the delegator or secretary. Audit `session:delegate` / `session:revoke_delegation`.
- `POST /sessions/:id/open` (chair): status `open`; marks `consent=1` on items whose progress is `ready` (a design satisfied by the board's fast lane is `ready` without positions — see `docs/features/fast-lane.md`); computes quorum; audit `session:open`.
- `POST /sessions/:id/items/:reviewId/call` (chair/acting) → `called`; `…/nominate { acting_chair }` (chair; required when the chair is the item's submitter; the nominee must hold a decision-maker seat and not be the submitter); `…/pull` removes an item from the consent list (chair); `…/defer { reason }` and `…/declare { outcome, rationale, conditions?, circulation_due?, board_id? }` call the same code as `/reviews/:id/decide` (handlers may simply forward).
- `POST /sessions/:id/consent/declare { rationale? }` (chair): declares every `consent=1` item still `listed` as `approved` (or `approved_with_conditions` when it already has conditions), one audit row each, one `consent_declared` event per review. Returns `{ declared: n, skipped: [{ review_id, reason }] }`.
- `PUT /sessions/:id/notes { notes_md }` (secretary/chair; until closed).
- `POST /sessions/:id/close` (chair): every `called` item must be declared or deferred (listed-but-never-called items are auto-deferred with reason "not reached"); status `closed`; **minutes derived** (`minutes_json`): `{ code, board, scheduled_at, opened_at, closed_at, chair, attendance, delegations, quorum, items: [{ code, title, type, author, areas, positions: [{ area, position, by, on_behalf_of, text, resolution, resolution_text, resolved_by }], outcome, rationale, conditions, dependencies_created, deferred_reason }], notes_md }`, `minutes_hash = sha256(canonical(minutes_json))`, audit `session:close { minutes_hash, items, declared, deferred }`. Positions and resolutions on declared items are frozen (further changes refused with 409).
- `GET /sessions/:id/minutes` → `{ minutes, minutes_hash, markdown }` (markdown rendered server-side for export/paste), 404 while not closed.
- `GET /sessions?board=<id|code>&status=planned,open` (comma list) → `[{ id, code, title, board: {id,code,name}, scheduled_at, status, items, declared, deferred, consent_count, my_role, opened_at, closed_at }]`; forthcoming sittings first (the open one leads, then soonest), closed ones newest first. `my_role` is the caller's seat on that board or null.

## Reviews — additions (`routes/reviews.ts`)

- `GET /reviews/:id` adds `areas: { touched: [...], derived: [...], origin, board_areas: [{id,label}] }`, `positions: [...]` (live and superseded, with names), `dependencies: [{ id, decision: {id, code, title, status}, review: {id, code, stage} | null, resolved_state }]`, `dependents: [{ review: {id, code, title, stage} }]` (for decision reviews: items that depend on this decision), `session: { id, code, status } | null` (the open session it is listed on, else the one that declared it), `can` gains `record_position` (any area), `resolve`, `create_dependency`, `edit_areas`, `declare_outcomes: [...]` (the outcomes this principal may declare right now), `why` gains `record_position`, `resolve`.
- `PUT /reviews/:id/areas { areas: [...] }` — submitter (while open) or the board's chair/secretary; validated against board areas; `areas_origin='human'`; event `areas_changed`; audit `review:areas`.
- `POST /reviews/:id/positions { area?, areas?, position, text? }` — `text` required for `no|conditional|not_my_area`; `areas` records the same position on several areas. Response `{ ok, positions: [...], stage, progress }`. Audit `position:<position>` with `{ area, session_id, on_behalf_of }`.
- `POST /reviews/:id/approvals` stays as a **compatibility alias**: `approve` → `yes` on every touched area the caller owns (count mode: area null), `request_changes` → `no` likewise (comment required). 403 when the caller owns none.
- `POST /positions/:id/resolve { resolution, text, condition?: { owner?, due_at? }, decision_id?, create?: { title, topic?, context_md?, decision_md?, application_ids? } }`.
- `POST /reviews/:id/dependencies { decision_id? , create?: {...}, submit?: true }` — chair/decision maker/reviewer of the board, or the submitter; `create` makes a `proposed` ADR (author = the review's submitter, origin human) and, when `submit` (default true), a decision review for it routed normally (submitted_by = the review's submitter); links through `review_dependencies` (+ `decision_links depends_on` when the dependent item is itself a decision review). Event `dependency_created`, audit `dependency:create`. Response `{ dependency, decision: {id, code}, review: {id, code, board} | null }`.
- `POST /reviews/:id/decide` body: `{ outcome, rationale?, conditions?: [{ text, owner?, due_at?, area? }], circulation_due?, board_id? (referred), reason? (deferred) }` — rationale is mandatory for `changes_requested|deferred|referred|rejected`.
- `GET /reviews` rows gain `areas`, `deferred_count`, `session` (code/status), and `progress` in the new shape; filters gain `?session=<id>`.

## Boards — additions (`routes/boards.ts`)

- Routing rules may carry an application condition (`application_ids`, `owner`) for design, decision and exception reviews: see `docs/features/routing-by-application.md`.
- `GET /boards/:id` adds `areas: [{ id, label }]`, members gain `areas`, `sessions_planned`, `sessions: [... last 5 ...]`, `can.sessions` (chair/secretary), `area_coverage: [{ area, owners: [...] }]` (warn in UI when empty).
- `PUT /boards/:id { areas?: [...] }` — chair of the board or platform admin (areas are configuration); unknown ids allowed only as new custom areas `{ id: slug, label }`; removing an area that a member owns strips it from the member. Audit `board:areas`.
- `POST /boards/:id/members { user_id, board_role, areas? }` and `PUT /boards/:id/members/:userId { areas }` — chair/secretary/admin; areas only meaningful for decision makers (stored for any seat, ignored elsewhere).
- Policies: approvals step `{ mode: "areas" | "count", min?, roles }`.

## Route gate (`auth/roles.ts` ROUTE_RULES)

```
POST /reviews/:id/positions            → ["approve_review","request_changes"]
PUT  /reviews/:id/areas                → ["submit_review","manage_board","comment"]   (handler checks exact)
POST /positions/:id/resolve            → "decide_review"
POST /reviews/:id/dependencies         → ["comment","submit_review"]
POST /boards/:id/sessions, * /sessions/* → ["manage_board","approve_review","decide_review","comment"] (handlers check the board; `comment` lets any seat self-attend)
PUT  /boards/:id/members/:userId       → ["manage_board","manage_platform"]
```
`manage_platform` must **not** open any `/sessions` or `/positions` route.

## Seed (`boards/seed.ts`, `DEMO_USERS_VERSION = "3"`)

- DA areas: all eight. PCB: none (count mode stays).
- DA policies for design, decision, standard, pattern → `{ pre_review } → { approvals, mode: "areas", roles: ["decision_maker"] } → { decision, roles: ["chair"] }`. PCB policies unchanged.
- New demo user `p.osei` — Priya Osei, no system role, DA decision maker owning `integration, infrastructure, resilience, cost`; `m.hughes` DA decision maker owning `security, data, compliance, ai` (her PCB seat unchanged). Everyone else as today.
- One planned DA session (`SES-0001`, title "Design Authority — fortnightly", `scheduled_at` = next Tuesday 10:00 UTC, created_by a.okafor) when the demo is loaded and no session exists; agenda derived.
- Seeded reviews get areas derived at boot.

## Work queue, pipeline and the decisions under review (IA round)

- `GET /me/work` — what the workflow is waiting on the caller for, derived from the same checks the handlers enforce (`canRecordPosition` per area, `isDecider`, `canResolve`); someone without a governance identity (platform admin with no seat or system role, auditor, service account) gets every list empty. `R` = `{ id, code, title, type, stage, board: {id,code,name}, deferred_count }`, `S` = `{ id, code, status, scheduled_at }` (the open or next planned session the review is listed on).
  ```
  { user: { id, name }, counts: { total, positions, declare, resolve, sessions, conditions, circulations, resubmit, changed, no_decision },
    positions:    [{ review: R, areas: [area ids awaiting my position — owner or live delegate; [] in count mode], session: S|null }],
    declare:      [{ review: R, ready, outstanding: [area labels, or step names in count mode], session: S|null }],   // a decider (chair / acting chair): the item is ready, or sits on an open session I chair
    resolve:      [{ review: R, area, label, by, by_name, on_behalf_of, text, position_id, session: S|null }],       // open conditionals I may resolve
    sessions:     [{ id, code, title, board, scheduled_at, status, my_role, my_attendance: present|apologies|absent|null (nothing recorded), items, consent_count }],  // planned/open, boards where I hold a seat; open first, then soonest
    conditions:   [{ id, review: R, text, due_at, status, area }],                                                   // owner == me, open|overdue, overdue first
    circulations: [{ review: R, circulation_due, overdue, missing: [area labels], mine }],                           // approved_subject_to_circulation: I own a missing area (mine) or chair the board
    resubmit:     [{ review: R, requested_by, requested_by_name, requested_at, text }],                              // my reviews at changes_requested; the latest send-back on the timeline
    changed:      [{ work_item: { id, external_id, type, title }, review: R }],                                      // material_change on work items linked to reviews I submitted
    no_decision:  [{ work_item: { id, external_id, type, title, application_id, application_name } }] }             // authors only: open epics with no decision and no review
  ```
  The author never appears on their own item in `positions`, `declare`, `resolve` or `circulations`.
- `GET /overview` adds `pipeline: { by_stage: {stage: n}, in_flight, by_board: [{ id, code, name, in_flight, next_session: S|null }], next_session: S & { board } | null, open_conditions, overdue_conditions, circulations, circulations_overdue, changed_after_approval, epics_without_decision }` (in flight = submitted, pre_review, in_review, changes_requested, approved_pending_dependencies, approved_subject_to_circulation) and `me: { awaiting }` (= `/me/work` `counts.total` for the caller). Every earlier field stays.
- `GET /decisions` rows add `review: { id, code, stage, board, session: {id,code,status}|null } | null` — the most recent in-flight review that decides the decision when declared: any review with `decision_id` set to it (its own decision review, or a design that carries it) — and `links: { depends_on, blocks }` (decision_links out, review_dependencies in). `GET /decisions/:id` adds `review_in_flight` (same shape) and `links`. `POST /decisions/:id/status` with `accepted` or `rejected` answers **409** `{ error: "under review", review: { id, code, stage, board } }` while such a review is in flight (acceptance goes through the review) and audits `status:refused_under_review`; `proposed`, `superseded`, `deprecated` stay allowed; an unknown decision is 404.
- `GET /reviews/:id`: each `progress.areas[]` row gains `mine` (the caller may record on it now) and `findings: [{ severity, title, code, label, kind }]` + `findings_count` — the findings of the latest pre-review whose citations resolve to a catalogue item whose category maps to that area (`areas.ts` category map; decision and resource citations place nothing; one entry per finding per area). Top level gains `pre_review: { recommendation, findings, checks_failed, at } | null`. The list keeps the lean progress shape.
- Attendance follows the acts: `POST /sessions/:id/open` records the opener `present` (self-recorded); a position taken on a review listed on an open session records the recorder `present` when they have no attendance row yet (a delegate already has one; an existing record — apologies — is never overwritten). Both audit `session:attendance` as any self-record does.
- `GET /audit` rows add `item_code` / `item_label` resolved at read time from (entity, entity_id): reviews/review → code, title; decisions/decision → code, title; standards/standard/artefact(s)/policy/pattern/principle → code, title; sessions/session → code, title; boards/board → code, name; users/user → (null, name); elements/resource(s)/applications → (null, name); sources/source → (null, name); work_items → `<type> <external_id>`, title; runs/run → kind, `<kind> run <started_at>`; anything else null. Sign-ins and sign-outs are written under the entity `sign_in` (board sittings are `sessions`); rows written earlier under `session` are read back as `sign_in` in `rows` and `facets.entities`, and `?entity=sign_in` finds both spellings. Stored rows are chained history and are never rewritten.
- Smoke: `scripts/smoke-work.sh` runs after `smoke-sessions.sh` on the same instance (before `smoke-catalogue.sh`).

## Evidence pack / audit

- Pack gains `sessions: [{ code, board, scheduled_at, status, chair, attendance_count, delegations, items: [{ code, outcome, areas }], minutes_hash }]` (tenant-wide; per application only sessions that declared one of its reviews) and the dependency links on decisions.
- Audit actions introduced: `session:create|open|close|attendance|delegate|revoke_delegation|call|nominate|pull|defer|consent_declare|agenda`, `position:yes|no|conditional|not_my_area`, `position:resolve`, `dependency:create`, `review:effective`, `review:areas`, `decide:<outcome>` (existing), `board:areas`.

## Web

- `api.ts` labels: stages (`approved_pending_dependencies` "Approved pending dependencies", `approved_subject_to_circulation` "Approved subject to circulation"), `position` (Yes · No · Conditional · Not my area), `resolution`, `session_status` (Planned · Open · Closed), `item_state`, `attendance`, `area` labels, `outcome` labels for declare. `StatusTag` kinds: `position` (yes = green + Checkmark, no = red + Close, conditional = yellow/warning + Warning, not_my_area = gray, resolved = green outline, missing = gray outline), `session_status`, `item_state`, `attendance`, `quorum` (covered green / uncovered red). Always colour + icon + word.
- **Boards → board detail**: *Areas* section (tags; "Edit areas" for chair/admin: checkbox list of the seeded eight + custom); members table gains an *Areas* column (decision makers: editable MultiSelect for chair/secretary/admin); coverage warning (`InlineNotification kind="warning"`: "No decision maker owns Cost"); policy editor approvals step gains a *Mode* select (Count · Areas; hides Minimum in areas mode); *Sessions* section: table (code, date, status, items, declared/deferred) + "New session" (chair/secretary) → `/sessions/:id`.
- **Session page `/sessions/:id`** (new `pages/Session.tsx`): `PageHeader` with crumbs Boards › DA › SES-0001, status tag, date, chair; actions: Refresh agenda (planned/open; secretary/chair), Open session (chair, planned), Close session (chair, open; modal with the derived summary "3 declared, 1 deferred" and the secretary notes), Delegate my seat (decision makers; modal: delegate user + areas), I'm present / Apologies (members). Two-column: left — *Agenda* as `DataTable` (#, Review (link), Type, Author, Areas (tags coloured by state), State, Actions: Call · Pull (consent) · Declare · Defer); a *Consent agenda* group at the top with "Declare consent items" (chair). Right — *Attendance* (`Table`: member, seat, areas, status Select for secretary/chair; delegation rows show "for M. Hughes"), *Quorum by area* (tags covered/uncovered), *Notes* (TextArea for secretary while open), *Minutes* (closed: derived minutes rendered + hash + "Copy markdown"). Use `ProgressIndicator`? No — the session is a list, not a flow; the item state tags carry it.
- **Review detail**: *Areas & positions* section replaces *Approvals* in areas mode: one row per touched area — area tag, owners, current position tag + who (+ "for X" when delegated), text, resolution line ("resolved by chair: …") and buttons: **Record position** (owners; modal: radio Yes / No / Conditional / Not my area + text + note "You are recording as yourself; a delegate records on behalf of the seat"), **Resolve** (chair on conditionals; modal: radio Accept as tracked condition (owner, due) / Addressed in session (explanation) / Dependent decision (pick existing proposed decision or create: title, topic) + explanation), *Edit areas* (submitter/chair/secretary; MultiSelect of the board's areas with the derived set shown as hint). Count mode keeps today's Approvals panel (positions with area null). *Dependencies* section: depends-on list (code, status tag, link) + "Create dependent decision" (seat holders/submitter) and, for decision reviews, "Blocks" list. Header: session tag ("SES-0001 · open") linking to the session; `Decide` becomes **Declare outcome** with the outcome select driven by `can.declare_outcomes` (helper text per outcome; `referred` shows a board select; `deferred` a reason; `approved_subject_to_circulation` a due date). Timeline events show "· in SES-0001" when `session_id`. `approved_pending_dependencies` shows a notification "Effective once ADR-0019 is decided" with links.
- **Reviews list**: progress text for areas mode ("2 of 3 areas · Security conditional"), new stage labels, a *Session* column (code link) replacing nothing — add after Board.
- **Decision detail**: *Depends on* / *Blocks* in the Linked section (from `GET /decisions/:id` which gains `depends_on`, `dependents`).
- **Settings → Access** help text: one line on areas and delegation. **Help panel**: one line.
- No custom motion; Carbon only; sentence case; status = colour + icon + word.

## As built — where the implementation sharpened the spec

- `progress.ready` = satisfied **and** still open (a sent-back item never lands on the consent agenda). Area-state precedence: no > conditional > resolved > yes > not_my_area > missing.
- The `/approvals` alias audits `position:yes` / `position:no` in both modes (`review:approve` is no longer written); a request for changes needs a comment in both modes. Count-mode timeline events keep their names (`approval`, `request_changes`); areas-mode positions are `position` events naming their area.
- `GET /reviews(/:id).session` is the forthcoming session the review is listed on (open, then planned), else the one that declared it; `reviews.session_id` is set by every declaration made inside a session.
- Frozen (409) = declared in a session that is now closed **and** at a final stage; circulated items stay recordable for their missing areas, and a `no` in circulation moves the item back to `in_review` (event `circulation_objection`, audit `review:circulation_objection`).
- A fresh delegation by the same seat supersedes the earlier one; the chair, like the secretary, may record one on instruction and revoke. Observers cannot self-record attendance (the seat holds no capability); the secretary records them.
- `POST /sessions/:id/agenda/refresh { include_circulation: true }` pulls circulation items in before they are overdue.
- `POST /decisions/:id/status accepted|rejected` also settles `review_dependencies` (a decision accepted without a review releases its dependents).
- DA areas and areas-mode policies are applied when the demo is loaded (cast version 3, once); a non-demo instance stays in count mode with no areas until its chair configures them.
- Upgrade note: in-flight DA reviews keep their old count-mode approvals as positions with `area: null`; they do not count towards any area once the DA runs in areas mode — owners re-record per area.

## Smoke — `scripts/smoke-sessions.sh` (seeded instance, run after `smoke-boards.sh`)

Steps (every one acting as the right demo user; the default x-user `smoke-sessions` is a platform admin and must get 403 on every session/position action):
0. DA has 8 areas; m.hughes/p.osei own their areas; DA design policy mode=areas; PCB policy unchanged (count); `SES-0001` planned with ≥ 1 agenda item.
a. t.nguyen submits a design touching data + security + infrastructure (design_md sections + an app with SQL and VMs); areas derived; j.duduka (chair) `record_position` → 403 "chair has no vote" (in areas mode); t.nguyen → 403 own review; platform admin → 403; a.uditor → 403.
b. a.okafor (secretary) creates `SES-0002`; agenda contains the new review; p.osei marks present; m.hughes delegates to s.patel for the session → s.patel's attendance present on behalf of m.hughes; a.uditor as delegate → 400; t.nguyen (author of an item) as delegate → 400; chair opens; quorum: all areas covered.
c. s.patel (delegate) records `yes` on data, `conditional` on security ("needs a key-management decision"); p.osei `yes` on infrastructure; progress: open_conditionals=1, not satisfied; chair declare approved → 403 "conditional unresolved"; s.patel resolving → 403; chair resolves with `dependent_decision` + `create` → ADR created, decision review created and routed to DA, dependency linked; chair declares `approved` → stage `approved_pending_dependencies`, pending_outcome approved; item declared; event carries session id.
d. The dependency's review: j.duduka is chair, m.hughes/p.osei record yes on its areas (or `approvals` alias), chair declares approved → the dependent review becomes effective (`approved`), event `became_effective`, audit `review:effective`.
e. Circulation: s.patel submits a design touching cost; p.osei (owner of cost) is `apologies` in a new session; m.hughes present; chair declares `approved_subject_to_circulation` with `circulation_due` → stage; p.osei later records `yes` → effective.
f. Consent: a review whose areas are all `yes` before open lands on the consent agenda; `consent/declare` approves it; a `pull`ed item is not declared.
g. Defer + close: an item never called is auto-deferred on close with reason "not reached"; `deferred_count` increments; minutes exist, `minutes_hash` matches sha256 of canonical minutes; audit chain verifies; positions on declared items are frozen (409).
h. Count mode untouched: PCB policy review still works through `/approvals` (2 of chair/decision_maker, r.khan decides).
i. Legacy alias: `/approvals approve` by p.osei on a review touching only her areas → yes on those areas; by m.hughes on a review touching none of hers → 403.
j. Audit facets include the new actions; evidence pack lists the closed session with its hash.

Existing scripts that touch DA approvals (`smoke.sh` e/j, `smoke-auth.sh` c/d/e/j, `smoke-boards.sh` g) are updated to the areas model where needed (both decision makers record, or use reviews whose areas one of them owns).

## Assessments (v10)

Due diligence a board asks for on a review before it decides: a DPIA, a security or supplier assessment, a
clinical-safety case, an AI impact assessment (`review_assessments`; types dpia · security · supplier ·
clinical-safety · ai-impact · accessibility · other+title, optional area, assignee, due date).

- **Request** — a chair, decision maker or reviewer seat on the review's board (`POST /reviews/:id/assessments`),
  never the submitter: the board asks, the submitter provides (the submitter may be the assessor). Assignee must be
  a known user who is not an auditor or a service account. Reassign/move due date: `PUT /assessments/:id`, same seats.
- **Result** — only the assignee, as themselves (`POST /assessments/:id/result`): satisfactory ·
  satisfactory_with_remarks · unsatisfactory · not_applicable, a summary of at least 10 characters, an optional
  external `reference` (URL or document id — a pointer, never the document).
- **Blocking** — an open request blocks every approving outcome (approved, approved with conditions, subject to
  circulation): `canDecide` refuses with "assessments outstanding", `progress.ready` is false (so the item is not
  consent-eligible and not in the chair's declare queue), `progress.open_assessments` carries the count. An
  **unsatisfactory result does not hard-block** — boards decide; the product informs.
- **Waive** — the review's chair (or acting chair), reason of at least 10 characters
  (`POST /assessments/:id/waive`), mirroring conditional resolution.
- **Resubmission** marks completed results `stale` (they assessed the earlier version) and keeps open requests.
- **Records** — timeline events `assessment_requested|completed|waived`, audit actions
  `assessment:request|result|waive|reassign` on the review, the review's `assessments` in the evidence pack, and
  the assignee's open requests in `/me/work.assessments`. The platform admin gets 403 on every assessment route.
- Smoke: `smoke-sessions.sh` step k (request → block → result / waive → approve); unit tests in
  `server/test/assessments.test.ts`.
