# Write-back to Azure DevOps

## What it is

An optional way to show, on the work item itself, where a planned change stands in the decision lifecycle. When a platform admin turns it on, archigov adds to each Azure DevOps work item it covers:

- **Links**: a hyperlink to the decision and to the review that cover the item;
- **Lifecycle stage**: one tag naming where the change stands (for example `arch:in-review`), replaced as it moves;
- **Outcome comments**: a comment when a board declares an outcome on the review, and when the item changes after approval.

It is off by default, and each of the three is switched on separately. Nothing else on a work item is ever touched: not its state, assignee, title or description.

A fourth capability, also switched on separately and off even when write-back is turned on, lets a person raise a condition of an approval as a work item: see [Conditions as work items](ado-conditions-as-work-items.md). It is the only thing here that creates anything, and only on a person's click.

A fifth, [Review requests](ado-review-requests.md), listens the other way: a team asks for a review by putting a tag on a work item, and the work item is told when a review has been opened. It too is switched on separately and stays off when write-back is turned on.

The stage is one vocabulary, used identically on **Planned Changes** and as the tag:

| Stage | Tag (default prefix) | Means |
| --- | --- | --- |
| Needs decision | `arch:needs-decision` | an open epic, project, initiative or change with no decision and no review covering it (a withdrawn review covers nothing). Open means not Closed, Resolved, Done or Removed |
| Review requested | `arch:review-requested` | the delivery team asked for a review by tagging the work item, and no review has been opened for it yet. Only while [review requests](ado-review-requests.md) are switched on |
| Decision proposed | `arch:decision-proposed` | a decision covering it is proposed and not yet decided |
| In review | `arch:in-review` | the review covering it is with its board; an approval held on a dependency or on circulation counts as in review until it takes effect |
| Changes requested | `arch:changes-requested` | the board sent the review back to its submitter |
| Approved with conditions | `arch:approved-with-conditions` | approved, with conditions of that approval still open |
| Approved | `arch:approved` | approved (or its decision accepted), with no condition left open |
| Rejected | `arch:rejected` | the review or the decision was rejected. A rejected decision is not outweighed by an approval given to a review beside it; a review still open is the live word |
| Changed after approval | `arch:changed-after-approval` | the item's title or description changed after its design was approved, and nobody has acknowledged it yet. A change while the review is still open, or after it was rejected, is not this stage: the page flags it as "Changed since submission" and the stage stays with the review |
| Drift | `arch:drift` | the decision is accepted and conformance holds open findings against it |
| Built as approved | `arch:built-as-approved` | the decision is accepted, resources of the kind it allows are deployed, and nothing drifts from it |

## Why

The decision lifecycle runs through more than one system: the need and the work live in the backlog, the decision and its review live here, and what was built lives in the estate. Until now it read one way only. Work items came in as [planned changes](https://archigov.com/docs/guides/azure-devops), and what a board decided about them stayed in archigov unless someone went to look. The people planning the work are the ones who most need to know that a review came back with conditions, or that the epic they are about to start has no decision behind it.

The rule that keeps this simple is that **each fact has one home and is shown everywhere else**. archigov owns the decision, the review, its outcome and its conditions. Azure DevOps owns the work. Each shows the other's facts with a link to the source, and neither edits them, so there is no two-way synchronisation to reconcile and no place where the two can disagree.

It does not make the backlog a gate. "A feed, never a gate" was always about blocking, and nothing is blocked: a team that wants to enforce something on these tags does so with its own Azure DevOps rules.

## Heuristics and AI

Everything here is deterministic and derived on read.

- **The stage** is worked out from the records each time it is shown (`changeStage` in `server/src/stage.ts`) and never stored. What the board said comes first, then the bare decision, then the absence of either. On an approval, what happened afterwards takes over: the item changed, or conformance speaks about the accepted decision (drift, or built as approved).
- **Drift and built as approved** use the same measure as the [roadmap](roadmap.md): for an accepted decision with a checkable constraint, the resources of an allowed type against the open findings it raised. A decision without a constraint is never "built as approved"; it stays "approved".
- **What is written is a difference.** A sweep works out what each item should show, compares it with what was last written (`work_item_writeback`), and sends only what changed, as one JSON Patch document: one revision, and one notification at most. A second sweep with nothing new sends nothing.
- **One stage tag at a time, and only archigov's.** When the stage changes, the tag on record (the one archigov last wrote) is taken off and the new one put on, in one document. Nothing else is ever removed: a tag a person typed stays, even one spelled like a stage tag. There is one case where such a tag becomes archigov's: when it is exactly the stage tag archigov would put on that item at that moment, it is taken as already written, and follows the stage from then on. Because the team's tags under the prefix would be read beside archigov's, the Settings page says so when the prefix is already in use, before anything is turned on. Tags are set with `replace` and the complete list that should remain: on `System.Tags` the service merges on `add`, so an `add` could never take a tag off.
- **A comment is a dated fact, said once.** Each fact has a key: the outcome in effect on the review in this round of it (a resubmission starts another round, so a second "changes requested" is said again), and the change since the text the approval was given on (acknowledging moves that baseline, so a later change is a new fact; editing the text again meanwhile is not). Switching comments off and on again repeats nothing.
- **A write is sent once, and one that gets no answer is settled, not repeated.** Tags and links could be sent again harmlessly; a comment could not. So what a document carries is kept from just before it is sent until its answer comes (`pending_json`: the item's revision at that moment, the document's tags and links, the facts its comment states). If no answer comes, nothing is resent blind. The next sweep reads the item and settles the kept document against it:
  - the item is still at that revision: it was not saved, and is sent again whole. Within the first half minute the item is left alone instead, since a save can land behind an error already returned;
  - the item moved on and shows the document's tags and links: it was saved, comment included, and the record takes it;
  - the item moved on and does not show them: somebody else's revision; it was not saved;
  - the document was nothing but a comment and the item moved on: nothing tells the two apart. It is taken as saved, because a fact missing from the discussion is put right by the tag and the link, and one said twice is not.

  The kept document is judged by what it carried, never by what is wanted now, so a later fact is still said in its own right. A crash between sending and recording is settled the same way.
- **No AI.** Nothing an AI wrote crosses into Azure DevOps: not a pre-review, not a critique, not a summary. A comment states who declared what and when, with a link to the record. Inside archigov an AI finding carries its origin and its unverified state; pasted into a work item under archigov's name it would read as the board's view.

## Who can do what

- **Platform admin** (`manage_platform`): turns write-back on and off, chooses which of the three kinds are written, sets the tag prefix, previews what would be written, checks write access, and runs a sweep by hand. This is an operational switch, like the sources themselves.
- **Everyone who can read**: sees whether it is on (`GET /sources/ado/writeback`) and, on Planned Changes, the stage of every change and whether it is shown in Azure DevOps.
- **Authors, auditors and board seats**: 403 on every mutation. Nobody changes the stage by hand anywhere: it follows the review, the decision and conformance.
- **The Azure DevOps side**: the identity archigov uses needs permission to edit work items (`vso.work_write`, where the feed alone needs `vso.work`). Azure DevOps' own area permissions decide where it may write, so a customer can limit write-back to part of a project without any setting here. Whatever the backlog query reaches, nothing is written outside the configured project: a work item of another project is refused before anything is sent, and shows as a failed write. A work item names its project, so this holds when `ADO_PROJECT` is the project's name; given as an ID there is nothing to compare, and where the identity may write is left to its permissions.

## API

| Route | Capability | Does |
| --- | --- | --- |
| `GET /sources/ado/writeback` | read | the switches, whether each kind can work, the stage vocabulary with its tags, and counts: in scope, shown, tagged (a write still unanswered counts, since it may have left a tag), errors, and `prefix_in_use`, the work items carrying a tag under the prefix that archigov did not write |
| `POST /sources/ado/writeback` | manage_platform | `{enabled?, link?, stage?, comment?, raise?, request?, tag_prefix?, raise_type?, remove_tags?}` (`raise` and `raise_type` belong to [conditions as work items](ado-conditions-as-work-items.md), `request` to [review requests](ado-review-requests.md)). Turning it on (or changing what is shown) runs a sweep at once, and tries again now anything an earlier failure had put off. Turning it off is saved first, then takes the stage tags off unless `remove_tags` is `false`; the answer's `cleanup` says how many were removed and how many could not be reached. Already off, `remove_tags: true` tries again for the tags still out there. 409 for "on" without a connected backlog; 400 for a bad prefix or for "on" with nothing to write |
| `POST /sources/ado/writeback/test` | manage_platform | whether the identity may edit a work item, asked with `validateOnly` so nothing is saved |
| `GET /sources/ado/writeback/preview` | read | what would be written now and to which items, with the saved switches or with `?link=&stage=&comment=&tag_prefix=`, and `prefix_in_use` for that prefix; sends nothing |
| `POST /sources/ado/writeback/run` | manage_platform | a sweep now, failures put off included (the page's Try Again Now); 409 when write-back is off |
| `GET /work-items` | read | each row gains `lifecycle_stage` and `writeback` (`{tag, links, written_at, error}` or null); `needs_decision` follows the stage |

`GET /settings` carries the same status under `ado.writeback`.

## Data & audit

- **Setting** `ado.writeback`: `{enabled, link, stage, comment, tag_prefix}`. The prefix is 2 to 20 characters ending in `:`, `/` or `-`, so archigov's tags stay apart from the team's and can be taken off again.
- **Table** `work_item_writeback` (m023): one row per work item written to, holding the stage and tag last written, the links added, the outcome and change already commented, the last error and when to try again, and `pending_json`, the document on its way (kept from just before it is sent until its answer is known). It records what was shown elsewhere, not governance.
- **Audit**: `writeback:enable`, `writeback:disable`, `writeback:update`, `writeback:test` and `writeback:cleanup` on settings; `writeback:write` on the work item with the stage, the tag change, the number of links and which facts were commented (`confirmed_later` when the write got no answer and was found saved afterwards); `writeback:error` once per distinct failure, not at every retry.
- **When it runs**: every audit row schedules a sweep a moment later (`db.onAudit`), so whatever changed a stage is followed by a write without each route knowing about it; the scheduler sweeps after each collection; an admin can run one by hand. One thing at a time touches the source: a sweep, or the clean-up when write-back is turned off, and however many changes ask, one sweep waits its turn. A failed write is retried with a growing delay, up to an hour apart, and never blocks the other items; after three calls in a row that the source did not answer or throttled, the rest of that sweep (or clean-up) waits for the next. A sweep in flight stops at its next item once write-back is off, so the clean-up is not undone behind its back. The clean-up settles any document still unanswered first, so a tag written unseen is found and taken off too; one sent only moments before is left on record rather than judged early, and Remove Stage Tags settles it.
- **Out of the backlog**: an item whose state becomes Removed has no stage, and its stage tag is taken off. One deleted at the source (it answers 404) has nothing left to take a tag off: once its deletion has reached archigov, its record is simply closed.
- **What the clean-up lets go**: an item no longer in the configured project (nothing is written outside it, so its tag stays where it is), and an item the source no longer has while it still answers for others. Both would otherwise leave the clean-up unfinished for ever. When the source answers for no item at all, a 404 more likely means lost access, and the records are kept.
- **Evidence pack**: unchanged. What was shown in another tool is not evidence of governance; the records it points at already are, and the audit rows above are in the chain the pack records.
- **The echo**: a tag archigov writes comes back through the feed like any other tag. The content hash a review is approved against is the title and description only, so it is never mistaken for a change to the requirement.

## UI

- **Settings · Sources · Write Back to Azure DevOps**: the master toggle, a checkbox per kind with what it writes, the tag prefix with the resulting tags, **Test Write Access**, **Preview** (a table of what saving would write now) and **Save**. Turning it off opens a confirmation that offers to take the stage tags off, and names how many work items carry one; if some could not be reached the message says how many, the status line keeps counting them, and **Remove Stage Tags** tries again. While writes are failing, **Try Again Now** sends them without waiting out the delay. A warning names how many work items already carry a tag under the prefix that archigov did not write. With write-back on and the source no longer connected, the page says so and the toggle still turns it off. Everything is read-only for anyone but the platform admin.
- **Planned Changes**: the stage leads the Covered By cell as a status tag that explains itself on hover, with a "Changed since submission" tag beside it when the text moved under a review that has approved nothing yet. A line beneath says when it was shown in Azure DevOps (or linked, where only a link was written), or that the last write failed and will be tried again. The tag archigov wrote is not repeated among the team's tags.

## What it deliberately does not do

- **It does not gate.** No state transition is blocked, no policy is installed, and no status is required of anything.
- **It does not manage work.** It never changes a work item's state, assignee, title, description or iteration, and creates no work items on its own (a person may raise a condition as one: [Conditions as work items](ado-conditions-as-work-items.md)).
- **It does not carry reasoning.** Rationale, findings and conditions stay in archigov, reached by the link; a work item is visible to everyone who can see the backlog.
- **It does not write to manually logged changes.** They have no source to write to.
- **It does not remove links or comments** when it is turned off. They are history; only the stage tag, which claims to be current, is taken off.
- **It does not rewrite its links.** If `APP_BASE_URL` changes, links to the new address are added and the old ones stay where they are.
- **It does not write outside the configured project**, and it does not retry a write blind: one that got no answer is settled first.
- **It does not take off a tag it did not write**, with the one exception above: a tag that already was the stage tag archigov would have written.

## Verification

- `server/test/writeback.test.ts` (36 tests): the stage from every combination of review, decision, conditions and conformance; the demo backlog's stages; the patch built against the item as it stands; off by default; admin only; the preview and the access check write nothing; turning it on writes link, tag and comment; a second sweep sends nothing and the echo changes nothing; an outcome is commented once; acknowledging a change; failure, back-off and recovery; a stale revision retried; the switches are separate; turning it off removes the tags and keeps the history; the sweep follows an audit row on its own.
- Three independent review passes of the write path were run before this was merged, each on the fixes to the one before. What they found is pinned, each by a test: only a tag archigov wrote is ever taken off, and the prefix-in-use count; a withdrawn review is neither linked nor named; a change before approval is not "changed after approval"; comments off and on repeat nothing; a second "changes requested" with its own date; Run retries at once, and an error ends when nothing is left to send; a Removed item loses its tag and a deleted one is closed; an unanswered write is settled against what it carried (saved; saved while what is wanted moved on; not saved; not saved with somebody else's edit between); a save that lands after its error; a lost lone comment and the next fact after it; the rest of a sweep waits when the source stops answering or throttles; turning it off is not undone by a sweep in flight; a clean-up that could not reach the source says so and can be asked again; a tag written unseen is still taken off, and a deleted item does not hold the clean-up up; turned off moments after a write whose save is still landing, the item is not judged early and nothing is said twice; the clean-up lets go of an item deleted or moved out of the project, but not when the source answers for none; unanswered writes stop a sweep after three in a row even while reads answer; nothing is written outside a project given by name.
- The fixture behaves as the reference documents, not as the code would like: on `System.Tags`, `add` merges and `replace` sets (the "Add a tag" and "Update a tag" examples), and `remove` on a field is refused. The first version of this feature removed a stage tag with `add`, which the earlier, laxer fixture let pass.
- **Not yet verified against a live Azure DevOps organisation.** The read side of the integration has only been run on recorded fixtures, and the write side is built to Microsoft's REST 7.1 reference (`Work Items - Update`, with `validateOnly` and `suppressNotifications`) and exercised against a fixture that behaves as documented. To confirm on a live project before relying on it: `replace` on `System.Tags` with an empty string when the last tag goes (the reference empties a field that way, but shows no example on tags); the comment through `System.History`; the shape of the stale-revision refusal (`TF26071`); `suppressNotifications` under a PAT and under the Entra identity; that a deleted work item answers 404; and that the default backlog query stays inside the project (it carries no `[System.TeamProject]` clause; write-back refuses other projects' items when the project is given by name). Run **Test Write Access** and **Preview** before turning it on against a real project, and try it on one project first.
