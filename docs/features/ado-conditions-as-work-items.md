# Conditions as work items in Azure DevOps

## What it is

A board approves a design with conditions; each condition is work somebody has to do. Where the delivery team plans its work in Azure DevOps, a person can raise a condition there with one click: it becomes one work item under the planned change the review covers, linked back to the review.

From that moment the work is the team's. archigov never changes the work item again; it reads its state back and shows it beside the condition. When the team closes it, the chair of the board is prompted, and confirms in archigov that the condition is met, or does not.

It is a capability of [write-back](ado-write-back.md), off by default and switched on separately by a platform admin. Nothing is ever raised on its own.

## Why

Without this the condition is retyped into the backlog by hand, or it is not, and the next anyone hears of it is an overdue flag. The board's record and the team's plan drift apart at exactly the point where one hands over to the other.

The same rule as the rest of write-back keeps it simple: **each fact has one home and is shown everywhere else**.

- **Whether the condition is met** is a board's judgment. It stays in archigov, recorded by the chair with Mark Met.
- **The work** (its state, assignee, text, sprint) is the team's. It lives in Azure DevOps, and archigov shows it and never edits it.

So a closed work item is evidence that the team considers the work done. It prompts the judgment; it does not make it. Nothing here blocks anything in Azure DevOps either: the backlog stays a feed, never a gate.

## Heuristics and AI

Everything here is deterministic, and nothing happens without a person.

- **A person's click, one condition at a time.** There is no automatic mode: a board that set five conditions gets five work items only if someone raises five.
- **Where it goes.** Under the planned change the review covers, when that change came from Azure DevOps: the work item is created as its child, in the same area path, so it lands on the backlog of the team that has the parent. A review covering several such changes asks which one. A review covering none cannot raise (the action says so): there is nowhere honest to put it.
- **What it says.** The title is offered as "Condition of REV-0006: …" and can be edited before creating. The description carries the condition in the board's own words, which board set it and when, its owner and due date, a link to the review, and one sentence on what closing does and does not mean. The tag is the write-back prefix plus `condition` (`arch:condition`), so a team can query every condition.
- **Created once.** Three things hold one condition to one work item:
  - only one request for a condition runs at a time, a person's or the read-back's settling of an earlier one, so two people clicking at the same moment make one work item and the second is told to wait;
  - the request is on record before anything is sent, and the work item carries a hyperlink back that only it has (the review's address with the condition's id, recognised by its path, so it survives the instance changing address). Before anything is created it is looked for: among the parent's children, and, for a request that was already sent once, among the project's work items carrying the tag that request went out with, in case the team has since moved it under another parent;
  - if Azure DevOps does not answer, the condition shows as asked for and not confirmed. Raising again looks first; within the first half minute it is refused instead, since the first request may still be landing. A request nobody asks after again is settled by the read-back after the next collection: found and confirmed, or, when it is nowhere to be found, let go so the condition can be raised afresh.

  What this cannot see: a work item that was made unseen and has since lost both its place under the parent and its condition tag.
- **Read back, never written again.** The service hook and the backfill leave the work items of conditions alone: they are not planned changes. What they say of one on record is taken as news of its state; a new work item carrying the condition tag, whose answer has not arrived yet, is kept out of the planned changes all the same. The tag claims nothing that already is a planned change, whoever put it there. The scheduler also asks for the state of every raised work item whose condition is still open, after each collection.
- **Done, as the team's process calls it.** Closed, Resolved and Done count as the team saying the work is finished. A reopened item withdraws that, and the prompt with it. An item taken out of the backlog (Removed) is said to be so, and is not taken for done.
- **Gone, only when that can be told.** A work item the source no longer returns is called gone only while the planned change it was raised under can still be read: an identity that lost its access gets the same silence, and that is not a deletion. It is asked after again on every pass, so one restored at the source is seen again.
- **No AI.** The condition is a person's text (a chair may have adopted a suggested condition when declaring; by then it is theirs). Nothing is generated for the work item.

## Who can do what

- **Platform admin** (`manage_platform`): turns the capability on and off under Settings · Sources and sets the work item type. Raises nothing: an identity that is the platform admin and nothing else gets 403, even when a condition names it as owner.
- **Raises a condition**: its owner, the review's submitter, and the chair or the secretary of the board the review is with. The right comes from that standing and from nothing else: an owner who holds no role and no seat can raise their own condition, and so can a submitter who holds only a board seat. The owner counts when the condition names a user of the instance: the field is free text and defaults to the submitter, and a name typed in by hand matches nobody.
- **Everyone else** (other authors, decision makers and reviewers of the board): 403, and no action on the page. An auditor and a service account change nothing, even when named as owner.
- **Marks the condition met**: unchanged, a chair (`close_condition`). Raising a condition, or closing its work item, never changes the condition's status.
- **The Azure DevOps side**: the same identity and permission as the rest of write-back (`vso.work_write`); creating a work item needs the right to create one in the parent's area. Test Write Access asks whether the configured type can be created, without creating one.

## API

| Route | Capability | Does |
| --- | --- | --- |
| `POST /conditions/:id/raise` | open at the route to anyone signed in; the handler lets through the owner, the submitter, and the board's chair or secretary, and refuses an auditor or a service account | `{work_item_id?, title?}`. 200 `{ok, raised}` with the work item it became. 202 `{unconfirmed, raised, error}` when Azure DevOps gave no answer. 409 when the capability is off, the review covers no Azure DevOps work item, the condition is not open, it is already raised (the answer carries `raised`), or a request for it is in flight or may still be landing (`waiting`). 400 when the review covers several work items and none is named. 502 when Azure DevOps refused |
| `GET /reviews/:id` | read | each condition gains `raised` (`{external_id, type, title, url, state, closed, closed_at, gone, parent_work_item_id, raised_by, raised_at, unconfirmed}` or null; `closed_at` is the source's change date when the closure was first seen) and `can_raise`; the review gains `raise` (`{available, connected, type, parents}` or `{available: false, connected, reason}`) |
| `GET /conformance` | read | open conditions carry `raised` |
| `GET /me/work` | read | `conditions` rows carry `raised`; new list `confirm`: open conditions on boards the caller chairs whose work item is closed |
| `GET/POST /sources/ado/writeback` | read / manage_platform | settings gain `raise` (default false) and `raise_type` (default `Task`); the status gains `raised`, the number of conditions raised |
| `POST /sources/ado/writeback/test` | manage_platform | with `raise` on, also `create: {type, ok, error?}`: whether a work item of that type can be created, asked with `validateOnly` |
| `POST /sources/ado/writeback/run` | manage_platform | also reads back the state of raised work items and settles requests that never got an answer |

## Data & audit

- **Table** `condition_work_items` (m024): one row per raised condition: the planned change it sits under, the work item's id, type, title and address, what the source last said (state, revision, when it closed, when last seen, whether it is gone), who raised it and when, and the create request while it is unanswered.
- **Setting** `ado.writeback` gains `raise` and `raise_type`.
- **Audit**: `writeback:raise` on the condition (the work item, its type, the parent, whether an existing one was found, and `found_later` when the read-back confirmed it); `writeback:raise_unanswered`; `writeback:raise_not_found` when an unanswered request is let go; `writeback:raised_closed`, `writeback:raised_reopened`, `writeback:raised_removed`, `writeback:raised_gone` and `writeback:raised_back` when the source says so.
- **Timeline**: the review gets `condition_raised` (by the person), and `condition_work_closed`, `condition_work_reopened`, `condition_work_removed`, `condition_work_gone` and `condition_work_back` (derived, from Azure DevOps).
- **Evidence pack**: a raised condition carries `work_item` (`source`, `id`, `type`, `state`, `closed_at`, `seen_at`): where the work was tracked and what the source last said. It is evidence of the work, beside the condition's own status, which remains the board's.
- **Turned off**: nothing more can be raised. What was raised stays, and goes on being read back: reading is the feed's side and needs no switch — each scheduled collection, a collection run by hand (`POST /sources/ado/sync`), the service hook and the write-back Run all read back. No work item is ever deleted or closed from here.

## UI

- **Settings · Sources · Write Back to Azure DevOps**: a fourth checkbox, Conditions as Work Items, unticked even when write-back is turned on; with it, the work item type. Test Write Access reports whether that type can be created.
- **Review page · Conditions**: under each open condition, a line headed Azure DevOps. For whoever may raise it: Raise in Azure DevOps, greyed with the reason while the capability is off or the review covers no Azure DevOps work item (and absent on an instance with no Azure DevOps at all). The confirmation says what will be created and under what, and what closing it does not mean, and lets the title be edited. Once raised, the line shows the work item as a link that opens Azure DevOps, its state, and when it was closed. The line sits under the row, so the table keeps its width.
- **Conformance · Open Conditions**: a Work Item column once any open condition has been raised.
- **Overview and the bell**: a chair sees "Conditions to confirm · work item closed"; an owner's own conditions show their work item's state.

## What it deliberately does not do

- **It does not raise anything automatically**, on approval or on any other event.
- **It does not meet a condition** when the work item is closed, and does not reopen one when the work item is reopened.
- **It does not write to the work item after creating it**: no state, no assignee, no comment, no tag. It does not delete it when the condition is met, waived or the capability turned off.
- **It does not copy the work item's content back**: only its state, title and type, to show where the work stands.
- **It does not raise a condition of a review that covers no Azure DevOps work item**, and it does not write outside the configured project.

## Verification

- `server/test/raise.test.ts` (25 tests): off by default with the reason; only an admin turns it on, and the type must be a type name; who may raise and who may not; what is created (title, description, tag, area, parent link, link back) and that it is on the audit chain, the timeline and the review's answer; asking again makes nothing; the feed leaves a raised work item alone and takes the hook's word as its state; closing is evidence and prompts the chair without meeting the condition, reopening withdraws it, and the chair's Mark Met ends the reading back; the evidence pack; no answer, then found instead of made twice; an answer that lands after its error; a refusal releases the condition, and a type the project does not have; several parents, and none; a work item deleted at the source; turned off, nothing more is raised and what was raised is still read back. And what an independent review of the raise path found, each pinned: two people at the same moment, and a slow first request, make one work item; a work item made unseen is found after the team moved it and after the instance changed address; a request nobody asks after is settled by the read-back, found or let go, and one whose parent left the backlog can still be asked again; lost access is not a deletion, and a restored or removed work item is seen for what it is; a hook quicker than the answer never makes a planned change; an owner with no role and no seat raises, and an auditor or an admin-only identity named as owner does not; the condition tag on an existing planned change claims nothing; a request is found under the tag it went out with after the prefix changed; the read-back's settling and a person asking again at the same moment leave one work item, on record. From the live check: the stored address follows the organisation the read-back's REST url names (an organisation renamed), and a collection run by hand reads back as the scheduler does.
- `scripts/smoke-integrations.sh` step n, in fixture mode: off with the reason, admin and onlooker refused, raised once, closed by a service hook, the chair prompted and marking it met, all audited.
- Browser pass on a fixture instance: the greyed action and its reason, the admin's switch and type, the confirmation, the raised line, the hook, the chair's Overview and bell, Mark Met; axe clean on four states.
- **Verified against a live Azure DevOps organisation on 7 Nov 2026** (a Scrum project, Task under an Epic, under a PAT), after being built to Microsoft's REST 7.1 reference (`Work Items - Create` with `validateOnly`, `Work Items - List` with `$expand=relations`) and exercised on a fixture that behaves as documented. Confirmed there: a child created with a `System.LinkTypes.Hierarchy-Reverse` relation is accepted and shows as the Epic's child; `_links.html.href` is the address a person opens (it names the project by **GUID**, not by name); a second click makes nothing (409); the raised Task is not a planned change after a backfill; the Task closed at the source (Scrum: `Done`) is read back as evidence and prompts the chair, who marks the condition met. Still to confirm: that a service hook subscribed to all work item updates delivers the state change as a field diff (no hook can reach a local instance). If the service refuses the query that looks for a moved work item (`[System.TeamProject] = @project AND [System.Tags] CONTAINS '…' AND [System.CreatedDate] >= '…'`), only the search under the parent applies. An organisation **renamed** moves every address: the stored address of a raised work item follows the organisation the service answers from on the next read-back (the REST `url` names it; neither the batch nor the list endpoint returns `_links`).
