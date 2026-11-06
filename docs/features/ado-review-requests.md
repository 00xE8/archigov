# Review requests from Azure DevOps

## What it is

A delivery team asks for an architecture review from where it works: it puts a tag on a work item in Azure DevOps (`arch:review`). archigov hears the ask, lists it for the people who submit reviews, and shows the change as **Review requested**. When one of them opens a review for it, the work item is told: that the review exists, which board it is with, what the automatic checks counted, and where to read more.

The tag makes a request. It never makes a review. A review is submitted by a named person who stands behind it, exactly as every other review is.

It is a capability of [write-back](ado-write-back.md), off by default and switched on separately by a platform admin.

## Why

Asking for a review used to mean leaving the backlog: finding the right person, or the right tool, and describing again something that already has a work item. So teams asked late, or did not ask. A tag is the smallest thing a team can do without leaving its tool, and it is something Azure DevOps boards, queries and rules already understand.

Two rules of the product shape what the tag is allowed to do:

- **People submit reviews.** A tag is not a person. If it created a review, a board would be looking at a design nobody proposed, with a submitter that is an integration. So the tag asks, and an author opens the review, with what they know of the change.
- **Each fact has one home.** The ask is the team's, in Azure DevOps: the tag is theirs to put on and take off, and archigov only reads it. The review is archigov's, and the work item hears about it by a link and a one-line fact.

Nothing is blocked while an ask is open, and nothing happens to the work item if nobody answers: the backlog stays a feed, never a gate.

## Heuristics and AI

Everything here is deterministic.

- **The tag** is the write-back prefix followed by `review` (`arch:review` by default). It is compared without regard to case. Changing the prefix changes the tag: asks made with the old one are withdrawn, and the team asks again with the new one. While the capability is off, `arch:review` is a tag of the team's like any other (and counts towards the prefix-in-use warning).
- **An ask is open** from the moment the tag is first seen on a work item until a review is opened for that item (answered) or the tag is taken off again (withdrawn).
  - Leaving the tag on after the answer is not a new ask. Taking it off and putting it back is.
  - An ask made while a review of the change is under way is answered by that review at once: the work item is told which review it is, and no second look is owed when the board decides.
  - An ask whose answering review is then withdrawn stands again, for as long as the tag does: it was not met after all. The next review opened for the item answers it in its own right.
  - A change a board has already spoken on can be asked about again (a second look). The board's outcome stays as its stage, the ask shows beside it, and the next review opened for the item answers it.
  - Finished or removed work is not asked about.
- **Any work item.** The backlog query covers epics and features. While asks are heard, the backfill also takes in the project's work items that carry the request tag, whatever their type, so a tagged story or bug becomes a planned change. The service hook already delivers every type.
- **The stage.** A change with an open ask and no review stands at **Review requested**, between Needs decision and In review. It is one more value of the [lifecycle stage](ado-write-back.md), so where the stage tag is written, the work item shows `arch:review-requested`: the team sees its ask was heard, without a comment and without a notification. An epic asked about still counts as needing a decision.
- **The answer** is a comment, said once per ask, when the review that answers it covers the item. It carries the review's code, the board it is with, and the automatic checks:
  - for a design review, the deterministic pre-review is run afresh, and the comment gives the number of points to address by severity and the codes cited. Only what is checked against the record is counted: a catalogue item's rule on the application's estate, or an accepted decision. What the design template finds missing in the text is left out, because when the answer is given the design may be no more than the work item's own words;
  - for a decision review, the number of deterministic checks passed, to look at, and failed.
- **No AI.** Whatever pre-review is stored on the review, including one an AI wrote, is not read for this. No finding's wording crosses either: counts and catalogue codes only, and a link.

## Who can do what

- **Platform admin** (`manage_platform`): turns the capability on and off under Settings · Sources. Opens no review.
- **Authors**: see open asks in their queue (`/me/work.requested`, the Overview, the bell) and on Planned Changes, and open the review with the existing action. Opening it is `submit_review`, unchanged.
- **Everyone who can read**: sees the stage and the ask on Planned Changes.
- **The delivery team**: needs nothing in archigov. Whoever may edit the work item's tags in Azure DevOps may ask, and may withdraw.
- **The Azure DevOps side**: reading the tag needs only the feed's read access. The answer and the stage tag are written like the rest of write-back (`vso.work_write`).

## API

| Route | Capability | Does |
| --- | --- | --- |
| `GET /work-items` | read | each row gains `review_requested` and `review_requested_at`; `lifecycle_stage` may be `review_requested`. `needs_decision` is unaffected by an ask |
| `GET /me/work` | read | new list `requested` for authors: `{work_item, requested_at, again_after}`, oldest first (`again_after` is the code of the review that had already covered the change) |
| `GET/POST /sources/ado/writeback` | read / manage_platform | settings gain `request` (default false); the status gains `request_tag` and `requests_open` |
| `GET /sources/ado/writeback/preview` | read | a pending answer shows among the comments as `review_opened` |
| `POST /hooks/ado`, `POST /sources/ado/sync`, `POST /sources/ado/writeback/run` | as before | each is followed by a reconciliation of the asks |

There is no route to make or answer an ask: it is made by the tag and answered by opening a review (`POST /reviews` with the work item, as Planned Changes does).

## Data & audit

- **Table** `review_requests` (m025): one row per ask: the work item, when it was first seen, the review that covered the item at that moment (if any), and how it ended (`answered_review_id` and `answered_at`, or `withdrawn_at`); `tag_gone_at` records that the tag has been absent since. `work_item_writeback.answered` is the answer already said on the work item.
- **Setting** `ado.writeback` gains `request`.
- **Audit**, on the work item: `request:seen` (with the tag, and the earlier review when it is a second look), `request:withdrawn`, `request:answered` (with the review). The answer itself is a `writeback:write` with `review_opened` among its comments.
- **When it is reconciled**: after a service hook, after a backfill, after each scheduled collection, on Run, when the capability is turned on, and at the end of any turn in which a work item was touched or a review was opened or declared, so an ask is answered the moment its review exists.
- **Turned off**: the tag is no longer looked for and an open ask is no longer shown; the stage falls back to what it would be without it, and the stage tag follows. An answer already given stays on the work item.

## UI

- **Settings · Sources · Write Back to Azure DevOps**: a checkbox, Review Requests, unticked even when write-back is turned on; its text names the tag. The tag prefix can be edited while any of the stage, the requests or the conditions is on, since all three use it.
- **Planned Changes**: the stage Review requested; a counted filter, Review Requested, there only while an ask is open; Open Review on the row. An ask made of a change a board has already spoken on shows as a tag beside the stage.
- **Overview and the bell**, for authors: "Reviews requested from the backlog".

## What it deliberately does not do

- **It does not create or submit a review.** No board is put in front of a design nobody proposed.
- **It does not touch the team's tag**: not when the ask is answered, and not when the capability is turned off.
- **It does not comment when an ask is heard.** That is the stage tag's job, where it is written; a comment is kept for the answer.
- **It does not chase.** An ask nobody answers stays in the authors' queue; nothing escalates and nothing in Azure DevOps is blocked.
- **It does not send findings.** Counts and catalogue codes cross; the wording, the evidence and anything an AI wrote stay behind the link.

## Verification

- `server/test/requests.test.ts` (11 tests): off, the tag is just a tag and a story the backlog does not reach is not fetched; only an admin turns it on, and asks already on the backlog are heard from then; the ask is in an author's queue and nobody else's; a tagged story comes in as a planned change; with the stage written the work item says the ask was heard and the team's tag is left alone; an author opens the review, the ask is answered and the work item is told once, with the deterministic counts and nothing of an AI pre-review stored on the review; taking the tag off withdraws and putting it back asks again; an ask made while a review is under way is answered by that review at once and owes no second look, and a change already decided can be asked about again; an ask whose answering review is withdrawn stands again and is answered by the next review in its own right; a tag arriving by service hook is heard at once on any type; turned off, asks are neither shown nor listened for and what was said stays.
- `scripts/smoke-integrations.sh` step o, in fixture mode: a tag by service hook is nothing while it is off; on, it is heard and in the author's queue only; withdrawn and asked again by tag; opened by an author and answered, with the stage moving on at the source; audited.
- Browser pass on a fixture instance: the admin's switch and the tag it names, the Overview and the bell for an author, the Review Requested filter and stage on Planned Changes, Open Review, and the answered state; axe clean.
- **Not yet verified against a live Azure DevOps organisation**, like the rest of the Azure DevOps integration. To confirm on a live project: the query that brings tagged work items in (`[System.TeamProject] = @project AND [System.Tags] CONTAINS 'arch:review'`), and that a service hook delivers a tag change with the full tag list.
