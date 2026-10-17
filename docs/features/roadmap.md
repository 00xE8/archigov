# Roadmap built from records

## What it is

The **Roadmap** shows the architecture's direction and how far the estate has moved along it. It is built entirely from records archigov already holds:

- the decisions, and how far each has been realised;
- the planned changes under them;
- the conditions attached to approvals;
- end-of-support deadlines from the legacy register;
- expiring exceptions.

Every item sits in one of four lanes: **Now**, **Next**, **Later** or **Done**. Nothing on the roadmap is drawn by hand, so it moves when the records move.

## Why

Hand-drawn architecture roadmaps go stale as soon as they are published. They also show intent but not progress. The thesis is "derived, not authored": a decision with a checkable constraint can be measured against the estate, so the roadmap can say how far it has been realised, not only that someone means to do it.

The roadmap also connects the strands a head of architecture reports on:

- what was decided;
- what the delivery teams are doing about it;
- what the board made a condition;
- what the vendors' lifecycles force.

## Heuristics and AI

No AI. Every item, status and lane comes from fixed rules.

- **Decision realisation** applies to accepted decisions with a checkable constraint (`allowedTypes`). In the decision's scope (its applications, or every application when it lists none), the roadmap counts resources of an allowed type (*conforming*) and the open drift findings the decision raised:

  | Conforming | Drift | Status | Lane |
  |---|---|---|---|
  | some | none | realised | Done |
  | some | some | in progress, with a progress bar of conforming / (conforming + drift) | Now |
  | none | any | not started | Next, or Now when a linked change is active |

  Other decisions:
  - an accepted decision with no constraint is **not checkable**, and is never shown as progressing;
  - a proposed decision sits in **Next**.
- **Planned changes** that are linked to a decision are nested under it, not listed twice. An unlinked change is placed by its state:
  - Active → Now;
  - New or Proposed → Next;
  - Closed in the last 90 days → Done;
  - Removed, or closed earlier → left off.

  An epic, project, initiative or change with no review notes "No architecture decision yet."
- **Conditions** are placed by due date: overdue or due within 90 days → Now; within 180 days → Next; beyond that → Later. A condition met in the last 90 days → Done.
- **Lifecycle deadlines** come from each component group in the legacy register that is past or near the end of support. The due date is the end of support, or the end of extended support for a component in extended support. They are placed in the same date windows.
- **Exceptions** are placed by expiry date, because the remediation is due by then.

## Who can do what

The roadmap is read-only, and everyone who can read the model can read it, including the auditor and the platform admin. Its items change only through the records behind them:

- accepting a decision;
- remediating drift;
- closing a change;
- meeting a condition;
- upgrading a component;
- an exception expiring or being revoked.

## API

`GET /roadmap?application=<id>` returns:

```
{ generated_at, application, lanes: {now, next, later, done}, counts, kinds }
```

Each item is:

```
{ id, kind (decision | change | condition | lifecycle | exception), lane, title, code, status, due,
  progress {done, total} | null, applications[], link {kind, id}, detail, changes[] (decisions only) }
```

With an application, the roadmap keeps that application's items plus tenant-wide decisions. An unknown application returns 404.

## Data & audit

There is no migration and no new table: the roadmap is computed on read from:

- `decisions`;
- `findings` (`decision_id`, open drift);
- `work_items`;
- `conditions` (`due_at`, `status`, `closed_at`);
- the legacy register;
- `exceptions` (`expires_at`).

Nothing is written, so nothing is audited. The changes behind it are audited where they happen.

## UI

**Roadmap** sits in the Governance group, after Decision Log, at `/roadmap`, with a purple hero and the Timeline icon. The page has:

- **Hero counts** per lane.
- **Filters** for application (a Dropdown) and kind (a Select with counts).
- **Four lanes:** four columns on a wide screen, two on a laptop and one on a phone. Each lane names its rule.
- **Cards**, each a Carbon Tile, showing:
  - the kind, and a status tag (colour, icon and word) that explains itself on hover;
  - the title, linked to its record;
  - the code;
  - the due or ended date;
  - a progress bar labelled *Realisation*, for measurable decisions;
  - the applications;
  - nested planned changes;
  - a one-line detail.

## What it deliberately does not do

- It does not accept hand-drawn items or target dates. A plan that is not a record is not on the roadmap.
- It does not estimate. A decision without a checkable constraint is "not checkable", not 50 %.
- It does not reorder or prioritise items beyond their lane and date.

## Verification

- `server/test/roadmap.test.ts` has 5 tests:
  - decisions placed by realisation (in progress, realised, proposed, not checkable);
  - changes nested under their decision;
  - lifecycle and condition deadlines placed by date;
  - the roadmap moving with the records (resolved drift realises a decision; a met condition moves to Done);
  - the per-application view, the 404, and read access for the platform admin.
- `scripts/smoke-registers.sh` step `j`.
